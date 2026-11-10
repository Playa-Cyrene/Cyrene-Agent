import type { ChannelManager } from "./manager";
import type { OutgoingMessage } from "./types";

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

export interface ChannelDeliveryService {
  send(message: OutgoingMessage): Promise<DeliveryResult>;
}

export function createChannelDeliveryService(
  manager: Pick<ChannelManager, "getAdapter"> & Partial<Pick<ChannelManager, "getActivitySignal">>,
): ChannelDeliveryService {
  return {
    async send(message): Promise<DeliveryResult> {
      const adapter = manager.getAdapter(message.channel);
      if (!adapter) {
        return { ok: false, error: "adapter_not_found" };
      }
      const activity = manager.getActivitySignal?.(message.channel);
      if (message.signal?.aborted || activity?.aborted
        || (manager.getActivitySignal && !activity) || !adapter.getStatus().enabled) {
        return { ok: false, error: "channel_stopped" };
      }
      const signals = [message.signal, activity].filter((signal): signal is AbortSignal => !!signal);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;

      try {
        const result = await adapter.send({ ...message, ...(signal ? { signal } : {}) });
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
