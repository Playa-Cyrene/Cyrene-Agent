import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { registerQqModuleActionIpc, type QqModuleActionBinding } from "./action-ipc";
import { IPC } from "../../shared/ipc-channels";
import type { QqModuleActionCommand, QqModuleActionResult } from "../../shared/qq-module-actions";
const packageId = `pkg-${"a".repeat(64)}`;
class Sender extends EventEmitter {
  mainFrame = {};
  destroyed = false;
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit("destroyed"); }
}
const previewResult = (): QqModuleActionResult => ({ ok: true, state: "preview-install", preview: { operationId: "op-1", packageId, version: "0.1.0" } });
function setup(bound = true) {
  let invoke!: (event: any, input: unknown) => QqModuleActionResult | Promise<QqModuleActionResult>;
  const ipc = { handle: vi.fn((channel, handler) => { expect(channel).toBe(IPC.CHANNELS_QQ_MODULE_ACTION); invoke = handler; }) };
  const sender = new Sender(); const other = new Sender();
  const port = { execute: vi.fn(async (command: QqModuleActionCommand): Promise<QqModuleActionResult> =>
    command.action === "preview-install" ? previewResult()
      : command.action === "confirm-install" ? { ok: true, state: "installed" }
        : command.action === "cancel" ? { ok: true, state: "cancelled" } : { ok: true, state: "ready" }) };
  const binding: QqModuleActionBinding = { port, isTrustedSender: vi.fn((event) => event.sender === sender), shutdown: vi.fn(async () => {}) };
  registerQqModuleActionIpc(ipc as any, bound ? binding : undefined);
  const event = (source = sender, frame = source.mainFrame) => ({ sender: source, senderFrame: frame });
  return { sender, other, port, binding, ipc, event, invoke: (input: unknown, source = sender, frame = source.mainFrame) => invoke(event(source, frame), input), raw: (event: unknown, input: unknown) => invoke(event, input) };
}
it("unconfigured registration never touches the input or sender", async () => {
  const s = setup(false);
  const poison = { get action(): never { throw Error("must not read"); } };
  expect(await s.raw({ get sender(): never { throw Error("must not read sender"); } }, poison)).toEqual({ ok: false, error: "unconfigured" });
  expect(s.port.execute).not.toHaveBeenCalled(); expect(s.binding.isTrustedSender).not.toHaveBeenCalled();
});
it("accepts only the configured trusted live main frame", async () => {
  const s = setup();
  expect(await s.invoke({ action: "status" }, s.other)).toEqual({ ok: false, error: "unauthorized" });
  expect(await s.invoke({ action: "status" }, s.sender, {})).toEqual({ ok: false, error: "unauthorized" });
  // An unauthorized frame revokes that owner session; a real navigation creates a new one.
  s.sender.emit("did-start-navigation");
  expect(await s.invoke({ action: "status" })).toEqual({ ok: true, state: "ready" });
  expect(s.port.execute).toHaveBeenCalledOnce();
});
it("does not inspect commands from destroyed or policy-revoked senders", async () => {
  const s = setup(); s.sender.destroy();
  const poison = { get action(): never { throw Error("must not inspect"); } };
  expect(await s.invoke(poison)).toEqual({ ok: false, error: "unauthorized" });
  expect(s.port.execute).not.toHaveBeenCalled();
  const next = setup(); (next.binding.isTrustedSender as ReturnType<typeof vi.fn>).mockImplementation(() => { throw Error("policy unavailable"); });
  expect(await next.invoke(poison)).toEqual({ ok: false, error: "unauthorized" }); expect(next.port.execute).not.toHaveBeenCalled();
});
it("navigation cancels old preview and prevents confirming it in the new page", async () => {
  const s = setup(); expect(await s.invoke({ action: "preview-install" })).toEqual(previewResult());
  s.sender.emit("did-start-navigation");
  await vi.waitFor(() => expect(s.port.execute).toHaveBeenCalledWith({ action: "cancel", operationId: "op-1" }));
  await vi.waitFor(async () => expect(await s.invoke({ action: "status" })).toEqual({ ok: true, state: "ready" }));
  expect(await s.invoke({ action: "confirm-install", operationId: "op-1", userConfirmed: true })).toEqual({ ok: false, error: "stale" });
  expect(s.port.execute.mock.calls.filter(([c]) => c.action === "confirm-install")).toHaveLength(0);
});
it("destroying a window cleans its preview but does not pass ownership to another window", async () => {
  const s = setup(); await s.invoke({ action: "preview-install" });
  expect(await s.invoke({ action: "confirm-install", operationId: "op-1", userConfirmed: true }, s.other)).toEqual({ ok: false, error: "unauthorized" });
  s.sender.destroy();
  await vi.waitFor(() => expect(s.port.execute).toHaveBeenCalledWith({ action: "cancel", operationId: "op-1" }));
  expect(s.port.execute.mock.calls.filter(([c]) => c.action === "confirm-install")).toHaveLength(0);
});
it("discards and cancels a late preview when navigation happens during its request", async () => {
  const s = setup(); let resolve!: (result: QqModuleActionResult) => void;
  s.port.execute.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const pending = s.invoke({ action: "preview-install" });
  s.sender.emit("did-start-navigation"); resolve(previewResult());
  expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.port.execute).toHaveBeenCalledWith({ action: "cancel", operationId: "op-1" });
  expect(await s.invoke({ action: "confirm-install", operationId: "op-1", userConfirmed: true })).toEqual({ ok: false, error: "stale" });
});
it("destroying a window after confirmation does not cancel or replay the started operation", async () => {
  const s = setup(); await s.invoke({ action: "preview-install" });
  let resolve!: (result: QqModuleActionResult) => void;
  s.port.execute.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const pending = s.invoke({ action: "confirm-install", operationId: "op-1", userConfirmed: true });
  s.sender.destroy(); resolve({ ok: true, state: "installed" });
  expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.port.execute.mock.calls.map(([c]) => c.action)).toEqual(["preview-install", "confirm-install"]);
  expect(s.binding.shutdown).not.toHaveBeenCalled(); // app lifecycle, not window destruction, owns shutdown
});
it("registers navigation watchers once per sender and denies extra authority in IPC payload", async () => {
  const s = setup(); await s.invoke({ action: "status" }); await s.invoke({ action: "status" });
  expect(s.sender.listenerCount("did-start-navigation")).toBe(1); expect(s.sender.listenerCount("destroyed")).toBe(1);
  expect(await s.invoke({ action: "preview-install", trustedKey: "untrusted", path: "/tmp/payload" })).toEqual({ ok: false, error: "invalid" });
  expect(s.port.execute).toHaveBeenCalledTimes(2);
});
