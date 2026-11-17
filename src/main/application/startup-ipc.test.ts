import { expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

const electron = vi.hoisted(() => ({
  ipcRenderer: {
    invoke: vi.fn(), send: vi.fn(), on: vi.fn(), off: vi.fn(), removeListener: vi.fn(), listenerCount: vi.fn(),
  },
}));
vi.mock("electron", () => electron);

it("allows durable enqueue while claim and model dispatch wait for the runtime", async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  const { invoke } = electron.ipcRenderer;
  invoke.mockImplementation((channel) => channel === IPC.APP_RUNTIME_IPC_READY ? ready : Promise.resolve("ok"));
  const { startupIpc } = await import("../../preload/startup-ipc");
  const claim = startupIpc.invoke(IPC.CHATS_PENDING_CLAIM, "session");
  const run = startupIpc.invoke(IPC.AGUI_RUN, { runId: "run" });
  await expect(startupIpc.invoke(IPC.CHATS_PENDING_ENQUEUE, { sessionId: "session" })).resolves.toBe("ok");
  startupIpc.send(IPC.CHATS_REACT_READY);
  expect(electron.ipcRenderer.send).toHaveBeenCalledWith(IPC.CHATS_REACT_READY);
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([IPC.APP_RUNTIME_IPC_READY, IPC.CHATS_PENDING_ENQUEUE]);
  release();
  await Promise.all([claim, run]);
  expect(invoke.mock.calls.slice(2)).toEqual([[IPC.CHATS_PENDING_CLAIM, "session"], [IPC.AGUI_RUN, { runId: "run" }]]);
});
