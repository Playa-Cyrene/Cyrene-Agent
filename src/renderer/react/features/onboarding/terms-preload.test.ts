import { beforeEach, expect, it, vi } from "vitest";
import { IPC } from "../../../../shared/ipc-channels";
import type { TermsApi, TermsSnapshot } from "../../../../shared/terms-types";

const state = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(), invoke: vi.fn(), on: vi.fn(), off: vi.fn(),
}));
vi.mock("electron", () => ({
  contextBridge: { exposeInMainWorld: (name: string, api: unknown) => state.exposed.set(name, api) },
  ipcRenderer: { invoke: state.invoke, on: state.on, off: state.off }, webUtils: {},
}));
let api: TermsApi;
beforeEach(async () => {
  await import("../../../../preload/index");
  api = state.exposed.get("terms") as TermsApi;
  state.invoke.mockReset(); state.on.mockReset(); state.off.mockReset();
});

it("passes the exact displayed consent tuple through the dedicated IPC", async () => {
  const request = { revision: 2, consentVersion: "2026-11-04", contentHash: "a".repeat(64) };
  const response = { ok: true };
  state.invoke.mockResolvedValue(response);
  expect(await api.get()).toBe(response);
  expect(state.invoke).toHaveBeenLastCalledWith(IPC.TERMS_GET);
  expect(await api.accept(request)).toBe(response);
  expect(state.invoke).toHaveBeenLastCalledWith(IPC.TERMS_ACCEPT, request);
});

it("removes exactly the subscribed update listener", () => {
  const callback = vi.fn();
  const dispose = api.onUpdated(callback);
  const listener = state.on.mock.calls[0][1] as (_event: unknown, snapshot: TermsSnapshot) => void;
  const snapshot = { revision: 2 } as TermsSnapshot;
  listener({}, snapshot);
  expect(callback).toHaveBeenCalledExactlyOnceWith(snapshot);
  dispose();
  expect(state.off).toHaveBeenCalledExactlyOnceWith(IPC.TERMS_UPDATED, listener);
});
