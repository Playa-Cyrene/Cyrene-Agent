// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import builtin from "../../../shared/builtin-terms.json";
import type { TermsSnapshot } from "../../../shared/terms-types";
import { useTermsSnapshot } from "./useTermsSnapshot";

let root: Root;
let state: ReturnType<typeof useTermsSnapshot>;
let listener: (next: TermsSnapshot) => void;
let get: ReturnType<typeof vi.fn>;
let unsubscribe: ReturnType<typeof vi.fn>;
const initial = { ...builtin, contentHash: "a".repeat(64), accepted: false, source: "builtin" } as TermsSnapshot;
function Probe() { state = useTermsSnapshot(); return null; }
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  get = vi.fn().mockResolvedValue(initial);
  unsubscribe = vi.fn();
  window.terms = { get, accept: vi.fn(), onUpdated: callback => { listener = callback; return unsubscribe; } };
});
afterEach(async () => { await act(async () => root.unmount()); delete window.terms; });

it("registers a fresh GET after a push and ignores the older initial response", async () => {
  let finish!: (snapshot: TermsSnapshot) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe />));
  const next = { ...initial, revision: 2, contentHash: "b".repeat(64) };
  get.mockResolvedValue(next);
  await act(async () => listener(next));
  expect(get).toHaveBeenCalledTimes(2);
  expect(state.snapshot).toEqual(next);
  await act(async () => finish(initial));
  expect(state.snapshot).toEqual(next);
  expect(state.loading).toBe(false);
});

it("honors authoritative consent changes even when the text itself is unchanged", async () => {
  const accepted = { ...initial, accepted: true };
  get.mockResolvedValue(accepted);
  await act(async () => root.render(<Probe />));
  expect(state.snapshot?.accepted).toBe(true);
  get.mockResolvedValue(initial);
  await act(async () => listener(initial));
  expect(state.snapshot?.accepted).toBe(false);
  expect(state.loading).toBe(false);
});

it("fails closed for unavailable or invalid GET results", async () => {
  get.mockResolvedValue(undefined);
  await act(async () => root.render(<Probe />));
  expect(state.snapshot).toBeNull();
  expect(state.failed).toBe(true);
  expect(state.loading).toBe(false);
});

it("ignores late requests and events after disposal", async () => {
  let finish!: (snapshot: TermsSnapshot) => void;
  get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  await act(async () => root.render(<Probe />));
  await act(async () => root.render(<div />));
  await act(async () => { listener(initial); finish(initial); });
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(state.snapshot).toBeNull();
});
