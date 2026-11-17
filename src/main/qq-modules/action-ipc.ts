import type { IpcMainInvokeEvent, WebContents } from "electron";
import type { IpcScope } from "../application/ipc-scope";
import { IPC } from "../../shared/ipc-channels";
import { QqModuleActionGateway, type QqModuleActionPort } from "./action-gateway";

/** Only reviewed main-process composition may supply the port and sender policy.
 * No default policy grants a renderer the ability to install/activate code. */
export interface QqModuleActionBinding {
  port: QqModuleActionPort;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
  /** Must block new actions, settle in-flight confirmed work and stop its route. */
  shutdown(): Promise<void>;
}
export function registerQqModuleActionIpc(ipc: IpcScope, binding?: QqModuleActionBinding): void {
  const gateway = new QqModuleActionGateway(binding?.port);
  const owners = new WeakMap<WebContents, object>();
  const watched = new WeakSet<WebContents>();
  ipc.handle(IPC.CHANNELS_QQ_MODULE_ACTION, (event: IpcMainInvokeEvent, input: unknown) => {
    if (!binding) return { ok: false, error: "unconfigured" };
    const sender = event?.sender;
    if (!sender || sender.isDestroyed()) return { ok: false, error: "unauthorized" };
    if (!watched.has(sender)) {
      watched.add(sender);
      const invalidate = () => {
        const key = owners.get(sender); owners.delete(sender);
        if (key) void gateway.invalidate(key);
      };
      // Re-navigation revokes old confirmation authority even if the window survives.
      sender.on("did-start-navigation", invalidate);
      sender.once("destroyed", invalidate);
    }
    let key = owners.get(sender);
    if (!key) { key = {}; owners.set(sender, key); }
    return gateway.execute(input, { key, isAuthorized: () =>
      !sender.isDestroyed() && event.senderFrame === sender.mainFrame && binding.isTrustedSender(event) === true });
  });
}
