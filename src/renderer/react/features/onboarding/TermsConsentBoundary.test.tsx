// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import builtin from "../../../../shared/builtin-terms.json";
import type { TermsSnapshot } from "../../../../shared/terms-types";
import { TermsConsentBoundary } from "./TermsConsentBoundary";

let root: Root;
let host: HTMLDivElement;
let snapshot: TermsSnapshot;
let save: ReturnType<typeof vi.fn>;
const listeners = new Set<(next: TermsSnapshot) => void>();
function emit(next: TermsSnapshot) { snapshot = next; for (const listener of [...listeners]) listener(next); }
beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  listeners.clear();
  snapshot = { ...builtin, contentHash: "a".repeat(64), accepted: true, source: "builtin" } as TermsSnapshot;
  save = vi.fn().mockImplementation(async () => {
    emit({ ...snapshot, accepted: true });
    return { ok: true, snapshot };
  });
  window.terms = { get: vi.fn().mockImplementation(async () => snapshot), accept: save,
    onUpdated: callback => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<TermsConsentBoundary><input aria-label="draft" defaultValue="unsent draft" /></TermsConsentBoundary>));
});
afterEach(async () => { await act(async () => root.unmount()); delete window.terms; document.body.innerHTML = ""; });

it("keeps the workspace and unsent draft mounted while requiring new consent", async () => {
  const input = host.querySelector("input")!;
  input.value = "keep this edited draft";
  expect(host.querySelector("dialog")).toBeNull();
  await act(async () => emit({ ...snapshot, revision: 2, consentVersion: "2026-11-04", contentHash: "b".repeat(64), accepted: false }));
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("keep this edited draft");
  expect(host.querySelector(".cy-terms-workspace")?.hasAttribute("inert")).toBe(true);
  const dialog = host.querySelector("dialog")!;
  expect(dialog.open).toBe(true);
  expect(document.activeElement).toBe(dialog);
  const escape = new Event("cancel", { cancelable: true });
  expect(dialog.dispatchEvent(escape)).toBe(false);
  await act(async () => dialog.querySelector<HTMLButtonElement>(".cy-onboarding__welcome button")!.click());
  await act(async () => dialog.querySelector<HTMLButtonElement>(".cy-onboarding__actions .cy-onboarding__button--primary")!.click());
  expect(save).toHaveBeenCalledOnce();
  expect(host.querySelector("dialog")).toBeNull();
  expect(host.querySelector("input")).toBe(input);
  expect(input.value).toBe("keep this edited draft");
  expect(host.querySelector(".cy-terms-workspace")?.hasAttribute("inert")).toBe(false);
});

it("does not interrupt the UI for a non-substantive revision whose consent remains valid", async () => {
  await act(async () => emit({ ...snapshot, revision: 2, contentHash: "b".repeat(64) }));
  expect(host.querySelector("dialog")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});

it("removes all subscriptions when the boundary unmounts", async () => {
  await act(async () => emit({ ...snapshot, accepted: false }));
  await act(async () => root.render(<div />));
  expect(listeners.size).toBe(0);
});
