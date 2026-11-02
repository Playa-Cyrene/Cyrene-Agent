// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CURRENT_DISCLAIMER_VERSION } from "../../../../shared/disclaimer";
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
let unmounted: boolean;

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  save = vi.fn().mockResolvedValue({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  quit = vi.fn();
  window.settings = { saveGeneral: save } as unknown as typeof window.settings;
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
  delete window.settings;
  delete window.cyrene;
});

it("does not accept merely by viewing, going back, or quitting", async () => {
  await act(async () => gate.onViewDisclaimer());
  expect(gate.view).toBe("disclaimer");
  await act(async () => gate.onBack());
  expect(gate.view).toBe("welcome");
  await act(async () => gate.onQuit());
  expect(quit).toHaveBeenCalledOnce();
  expect(save).not.toHaveBeenCalled();
});

it("persists explicit current consent once even for same-tick duplicate callbacks", async () => {
  let finish!: (value: unknown) => void;
  save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => { gate.onAccept(); gate.onAccept(); });
  expect(save).toHaveBeenCalledExactlyOnceWith({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
  expect(gate.accepting).toBe(true);
  await act(async () => finish({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION }));
  expect(gate.error).toBe("");
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledOnce();
});

it.each([undefined, {}, { disclaimerAcceptedVersion: "2026-09-27" }])("allows retry when persistence does not confirm current consent (%j)", async saved => {
  save.mockResolvedValueOnce(saved);
  await act(async () => gate.onAccept());
  expect(gate.error).toBe("onboarding.saveFailed");
  expect(gate.accepting).toBe(false);
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledTimes(2);
  expect(gate.error).toBe("");
});

it("shows save failure and permits retry after a rejected IPC", async () => {
  save.mockRejectedValueOnce(new Error("disk full"));
  await act(async () => gate.onAccept());
  expect(gate.accepting).toBe(false);
  expect(gate.error).toBe("onboarding.saveFailed");
  await act(async () => gate.onAccept());
  expect(save).toHaveBeenCalledTimes(2);
});

it("ignores late rejection and stale callbacks after unmount", async () => {
  let reject!: (reason: Error) => void;
  save.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
  await act(async () => gate.onAccept());
  const accept = gate.onAccept;
  await act(async () => root.unmount());
  unmounted = true;
  await act(async () => reject(new Error("window closed")));
  await act(async () => accept());
  expect(save).toHaveBeenCalledOnce();
});
