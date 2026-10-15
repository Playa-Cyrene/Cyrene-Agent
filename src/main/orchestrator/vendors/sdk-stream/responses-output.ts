import type { StreamAccumulatorSnapshot } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameItem(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  if (left.type !== right.type) return false;
  if (typeof left.id === "string" && left.id && left.id === right.id) return true;
  return left.type === "function_call" && right.type === "function_call"
    && typeof left.call_id === "string" && !!left.call_id && left.call_id === right.call_id;
}

function backfillItem(item: Record<string, unknown>, earlier: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "function_call" || earlier.type !== "function_call") return item;
  const merged = { ...item };
  for (const field of ["id", "call_id", "name"] as const) {
    if (typeof merged[field] !== "string" || !merged[field]) merged[field] = earlier[field];
    if (merged[field] === undefined) delete merged[field];
  }
  if (typeof merged.arguments !== "string" && typeof earlier.arguments === "string") {
    merged.arguments = earlier.arguments;
  }
  return merged;
}

/** Tracks native output items so completed tool calls survive partial terminal snapshots. */
export class ResponsesOutputTracker {
  private readonly items = new Map<number, { item: Record<string, unknown>; done: boolean }>();

  observe(event: unknown): void {
    if (!isRecord(event)) return;
    const item = event.item;
    if (!isRecord(item) || !Number.isInteger(event.output_index)) return;
    const done = event.type === "response.output_item.done";
    if (!done && (event.type !== "response.output_item.added" || item.type !== "function_call")) return;

    const byIdentity = [...this.items.entries()].find(([, tracked]) => sameItem(item, tracked.item));
    const index = byIdentity?.[0] ?? event.output_index as number;
    const previous = this.items.get(index);
    if (previous?.done && !done) return;
    this.items.set(index, {
      item: previous ? backfillItem(item, previous.item) : item,
      done,
    });
  }

  reconcile(
    response: Record<string, unknown>,
    snapshot: StreamAccumulatorSnapshot,
    completed: boolean,
  ): Record<string, unknown> {
    if (!Array.isArray(response.output)) return response;
    const output = [...response.output];
    const candidates = new Map<number, Record<string, unknown>>();
    for (const [index, tracked] of this.items) {
      if (tracked.done) candidates.set(index, tracked.item);
    }

    if (completed) {
      for (const call of snapshot.toolCalls) {
        if (!call.ended || !call.id || !call.name.trim()) continue;
        const tracked = [...this.items.values()].find(({ item }) => item.type === "function_call"
          && ((call.itemId && item.id === call.itemId) || item.call_id === call.id))?.item;
        if (tracked?.status === "incomplete" || tracked?.status === "in_progress") continue;
        candidates.set(call.index, {
          ...(tracked ?? {}),
          type: "function_call",
          ...(call.itemId ? { id: call.itemId } : {}),
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    }

    const knownIndex = (value: unknown): number | undefined => {
      if (!isRecord(value)) return undefined;
      for (const [index, tracked] of this.items) {
        if (sameItem(value, tracked.item)) return index;
      }
      for (const call of snapshot.toolCalls) {
        if ((call.itemId && value.id === call.itemId) || (call.id && value.call_id === call.id)) return call.index;
      }
      return undefined;
    };

    for (const [index, item] of [...candidates.entries()].sort(([a], [b]) => a - b)) {
      const existing = output.findIndex((value) => isRecord(value) && sameItem(value, item));
      if (existing >= 0) {
        output[existing] = backfillItem(output[existing] as Record<string, unknown>, item);
        continue;
      }
      // If a nonempty response has no stable identity, its position is ambiguous.
      if (output.length > 0 && !item.id && !(item.type === "function_call" && item.call_id)) continue;
      const following = output.findIndex((value) => {
        const position = knownIndex(value);
        return position !== undefined && position > index;
      });
      output.splice(following < 0 ? output.length : following, 0, item);
    }
    return { ...response, output };
  }
}
