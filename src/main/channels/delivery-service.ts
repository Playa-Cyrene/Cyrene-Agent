import { isTermsExecutionAllowed } from "../terms/terms-runtime";
import type { ChannelManager } from "./manager";
import type { OutgoingMessage } from "./types";

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ChannelDeliveryService {
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}

export function createChannelDeliveryService(
  manager: Pick<ChannelManager, "getAdapter">,
): ChannelDeliveryService {
  return {
    async send(message): Promise<DeliveryResult> {
      if (!isTermsExecutionAllowed()) return { ok: false, error: "E_TERMS_CONSENT_REQUIRED" };
      const adapter = manager.getAdapter(message.channel);
      if (!adapter) {
        return { ok: false, error: "adapter_not_found" };
      }

      try {
        const result = await adapter.send(message);
        if (result.ok) return { ok: true };
        return { ok: false, error: result.error || "send_failed" };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}
