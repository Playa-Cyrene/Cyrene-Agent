import type { ChannelAdapter } from "./base";
import type { ChannelCapability, ChannelStatus, MessageHandler, OutgoingMessage } from "../types";
import { QqModuleManager } from "../../qq-modules/manager";

/** Fixed host-owned qq identity, not a generic plugin adapter or protocol backend.
 * Opt-in only: existing NapCatAdapter remains the active driver in init.ts. */
export class QqModuleAdapter implements ChannelAdapter {
  readonly id = "qq" as const;
  readonly displayName = "QQ（独立模块）";
  constructor(readonly manager: QqModuleManager) {}
  get onMessage(): MessageHandler | null { return this.manager.onMessage; }
  set onMessage(handler: MessageHandler | null) { this.manager.onMessage = handler; }
  get capability(): ChannelCapability { return this.manager.getCapabilities().messages; }
  start(): Promise<void> { return this.manager.start(); }
  stop(): Promise<void> { return this.manager.stop(); }
  async send(message: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    const result = await this.manager.send(message);
    // Preserve existing partial-success compatibility. Journal outcome expansion is
    // separate work; callers needing accurate outcome use manager.send directly.
    const ok = result.parts.some((part) => part.outcome === "sent");
    return ok ? { ok: true } : { ok: false, error: `QQ_MODULE_SEND_${result.outcome.toUpperCase()}` };
  }
  getStatus(): ChannelStatus {
    const state = this.manager.getState();
    const phase = state.phase === "running" ? "running"
      : ["starting", "waiting-backend", "draining"].includes(state.phase) ? "starting"
        : ["module-missing", "config-missing"].includes(state.phase) ? "config_missing"
          : ["disabled", "stopped"].includes(state.phase) ? "offline" : "error";
    return { enabled: state.enabled, phase, message: `QQ_MODULE_${state.phase.toUpperCase().replaceAll("-", "_")}` };
  }
}
