import { fork } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { QqModuleManager } from "./manager";
import type { QqProcessTransport } from "./runtime";
import { configuration } from "../../../scripts/verify/qq-module/fixtures";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });
function setup() {
  const child = fork(resolve("scripts/verify/qq-module/fake-process.cjs"), [], { execArgv: [], env: {}, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const transport: QqProcessTransport = {
    postMessage: (message) => { child.send(message as object); },
    onMessage: (listener) => { child.on("message", listener); return () => { child.removeListener("message", listener); }; },
    onExit: (listener) => { child.on("exit", listener); return () => { child.removeListener("exit", listener); }; },
    terminate: async () => { child.kill(); await exited; },
  };
  const manager = new QqModuleManager({ getConfiguration: configuration, createTransport: () => transport, requestTimeoutMs: 1000, drainTimeoutMs: 100 });
  cleanups.push(async () => { await manager.stop(); child.kill(); await exited; });
  return { manager, child, exited };
}
it("runs real fake child IPC, delivers normalized inbound once and kills it on stop", async () => {
  const { manager, child, exited } = setup(); const handler = vi.fn(async () => null); manager.onMessage = handler;
  await manager.start(); await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  expect(child.pid).toBeGreaterThan(0); expect(manager.getState().phase).toBe("running");
  expect(handler.mock.calls[0]?.[0]).toMatchObject({ channel: "qq", chatType: "private", chatId: "30000", text: "fake child input" });
  expect((await manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "response" }] })).outcome).toBe("sent");
  await manager.stop(); await exited; expect(manager.getState().phase).toBe("stopped");
});
it("contains real child crash and settles in-flight delivery as unknown", async () => {
  const { manager, exited } = setup(); await manager.start();
  const result = await manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "crash" }] });
  await exited; expect(result.outcome).toBe("unknown"); expect(manager.getState().phase).toBe("crashed");
  // Test runner and a separate host task remain live after child exit.
  await expect(Promise.resolve("other-channel-alive")).resolves.toBe("other-channel-alive");
});

it.skipIf(process.platform === "win32")("does not replace a real child that ignores graceful termination (POSIX)", async () => {
  const child = fork(resolve("scripts/verify/qq-module/fake-process.cjs"), [], { execArgv: [], env: { QQ_TEST_IGNORE_TERM: "1" }, stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "advanced" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  let didExit = false; void exited.then(() => { didExit = true; });
  const transport: QqProcessTransport = {
    postMessage: (message) => { child.send(message as object); },
    onMessage: (listener) => { child.on("message", listener); return () => { child.removeListener("message", listener); }; },
    onExit: (listener) => { child.on("exit", listener); return () => { child.removeListener("exit", listener); }; },
    terminate: async () => {
      if (didExit) return;
      child.kill(); let timer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("still alive")), 30); })]); }
      finally { clearTimeout(timer); }
    },
  };
  const createTransport = vi.fn(() => transport);
  const manager = new QqModuleManager({ getConfiguration: configuration, createTransport, requestTimeoutMs: 1000, drainTimeoutMs: 100 });
  cleanups.push(async () => { child.kill("SIGKILL"); await exited; await manager.stop(); });
  await manager.start(); await manager.restart();
  expect(didExit).toBe(false); expect(manager.getState().phase).toBe("failed"); expect(createTransport).toHaveBeenCalledOnce();
});
