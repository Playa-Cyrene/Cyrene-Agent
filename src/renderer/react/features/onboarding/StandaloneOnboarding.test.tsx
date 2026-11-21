// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import builtin from "../../../../shared/builtin-terms.json";
import type { TermsSnapshot } from "../../../../shared/terms-types";
import { StandaloneOnboarding } from "./StandaloneOnboarding";
import type { WelcomeGateProps } from "./WelcomeGate";

let gate: WelcomeGateProps;
vi.mock("./WelcomeGate", () => ({
  WelcomeGate: (props: WelcomeGateProps) => {
    gate = props;
    return <div role="alert">{props.error}</div>;
  },
}));
let root: Root;
let save: ReturnType<typeof vi.fn>;
let quit: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
let listener: (next: TermsSnapshot) => void;
let snapshot: TermsSnapshot;
let unmounted: boolean;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  snapshot = { ...builtin, contentHash: "a".repeat(64), accepted: false, source: "builtin" } as TermsSnapshot;
  save = vi.fn().mockImplementation(async () => ({ ok: true, snapshot: { ...snapshot, accepted: true } }));
  quit = vi.fn();
  unsubscribe = vi.fn();
  window.terms = { get: vi.fn().mockImplementation(async () => snapshot), accept: save,
    onUpdated: callback => { listener = callback; return unsubscribe; } };
  window.settings = { saveGeneral: vi.fn() } as unknown as typeof window.settings;
  window.cyrene = { quit } as unknown as typeof window.cyrene;
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  unmounted = false;
  await act(async () => root.render(<StandaloneOnboarding />));
});
afterEach(async () => {
  if (!unmounted) await act(async () => root.unmount());
  document.body.innerHTML = "";
  delete window.terms;
  delete window.settings;
  delete window.cyrene;
});

it("does not accept merely by viewing, going back, quitting, or calling accept before reading", async () => {
  await act(async () => gate.onAccept());
  await act(async () => gate.onViewDisclaimer());
  expect(gate.view).toBe("disclaimer");
  expect(gate.snapshot).toEqual(snapshot);
  await act(async () => gate.onBack());
  expect(gate.view).toBe("welcome");
  await act(async () => gate.onQuit());
  expect(quit).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
  expect(window.settings?.saveGeneral).not.toHaveBeenCalled();
});

it("accepts the displayed content once even for same-tick duplicate callbacks", async () => {
  let finish!: (value: unknown) => void;
  save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => gate.onViewDisclaimer());
  await act(async () => { gate.onAccept(); gate.onAccept(); });
  expect(save).toHaveBeenCalledExactlyOnceWith({ revision: snapshot.revision, consentVersion: snapshot.consentVersion, contentHash: snapshot.contentHash });
  expect(gate.accepting).toBe(true);
  await act(async () => finish({ ok: true, snapshot: { ...snapshot, accepted: true } }));
  expect(gate.error).toBe("");
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledOnce();
});

it.each([undefined, {}, { ok: false }, { ok: true, snapshot: { accepted: false } }])("allows retry when persistence does not confirm consent (%j)", async saved => {
  save.mockResolvedValueOnce(saved);
  await act(async () => gate.onViewDisclaimer());
  await act(async () => gate.onAccept());
  expect(gate.error).toBe("onboarding.saveFailed");
  expect(gate.accepting).toBe(false);
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledTimes(2);
  expect(gate.error).toBe("");
});

it("shows save failure and permits retry after a rejected IPC", async () => {
  save.mockRejectedValueOnce(new Error("disk full"));
  await act(async () => gate.onViewDisclaimer());
  await act(async () => gate.onAccept());
  expect(gate.accepting).toBe(false);
  expect(gate.error).toBe("onboarding.saveFailed");
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledTimes(2);
});

it("requires reopening newer content before accepting, including a same-tick stale click", async () => {
  await act(async () => gate.onViewDisclaimer());
  const staleClick = gate.onAccept;
  snapshot = { ...snapshot, revision: 2, contentHash: "b".repeat(64) };
  await act(async () => { listener(snapshot); staleClick(); });
  expect(save).not.toHaveBeenCalled();
  expect(gate.view).toBe("welcome");
  expect(gate.error).toBe("onboarding.termsChanged");
  await act(async () => gate.onViewDisclaimer());
  expect(gate.snapshot?.revision).toBe(2);
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledExactlyOnceWith({ revision: 2, consentVersion: snapshot.consentVersion, contentHash: snapshot.contentHash });
});

it("handles a main-process rejection when content changed before its update event arrived", async () => {
  const next = { ...snapshot, revision: 2, contentHash: "b".repeat(64) };
  save.mockImplementationOnce(async () => { snapshot = next; return { ok: false, error: "changed", snapshot: next }; });
  await act(async () => gate.onViewDisclaimer());
  await act(async () => gate.onAccept());
  expect(gate.view).toBe("welcome");
  expect(gate.error).toBe("onboarding.termsChanged");
  await act(async () => gate.onViewDisclaimer());
  expect(gate.snapshot).toEqual(next);
});

it("does not dismiss newer unaccepted terms for a delayed successful acceptance of older content", async () => {
  let finish!: (value: unknown) => void;
  const onAccepted = vi.fn();
  await act(async () => root.render(<StandaloneOnboarding onAccepted={onAccepted} />));
  save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => gate.onViewDisclaimer());
  const old = snapshot;
  await act(async () => gate.onAccept());
  snapshot = { ...snapshot, revision: 2, consentVersion: "2026-11-04", contentHash: "b".repeat(64) };
  await act(async () => listener(snapshot));
  await act(async () => finish({ ok: true, snapshot: { ...old, accepted: true } }));
  expect(onAccepted).not.toHaveBeenCalled();
  expect(gate.error).toBe("onboarding.termsChanged");
  expect(gate.accepting).toBe(false);
});

it("ignores late rejection and stale callbacks after unmount, and removes the subscription", async () => {
  let reject!: (reason: Error) => void;
  save.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => gate.onViewDisclaimer());
  await act(async () => gate.onAccept());
  const accept = gate.onAccept;
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => reject(new Error("window closed")));
  await act(async () => accept());
  expect(save).toHaveBeenCalledOnce();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

it("allows reading the fallback but never accepting without the terms API", async () => {
  await act(async () => root.unmount());
  delete window.terms;
  root = createRoot(document.createElement("div"));
  await act(async () => root.render(<StandaloneOnboarding />));
  expect(gate.error).toBe("onboarding.termsUnavailable");
  await act(async () => gate.onViewDisclaimer());
  expect(gate.acceptDisabled).toBe(true);
  expect(gate.snapshot).toBeNull();
  await act(async () => gate.onAccept());
  expect(save).not.toHaveBeenCalled();
});
