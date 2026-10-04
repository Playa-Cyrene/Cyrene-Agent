import { describe, expect, it } from "vitest";
import { ResponsesOutputTracker } from "./responses-output";

describe("ResponsesOutputTracker", () => {
  it("fills a nonempty partial terminal output with completed native context in stream order", () => {
    const tracker = new ResponsesOutputTracker();
    const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "opaque-test", summary: [] };
    const search = { type: "web_search_call", id: "ws-1", status: "completed", action: { type: "search", query: "reference" } };
    const call = { type: "function_call", id: "fc-1", call_id: "call-1", name: "generate_image", arguments: "{}" };
    for (const [index, item] of [reasoning, search, call].entries()) {
      tracker.observe({ type: "response.output_item.done", output_index: index + 16, item });
    }
    const terminal = { status: "completed", output: [reasoning, call] };
    const restored = tracker.reconcile(terminal, { text: "", toolCalls: [] }, true);
    expect(restored.output).toEqual([reasoning, search, call]);
    expect(terminal.output).toEqual([reasoning, call]);
    expect(tracker.reconcile(restored, { text: "", toolCalls: [] }, true).output).toEqual(restored.output);
  });

  it("keeps namespaces and full native metadata when recovering an arguments.done call", () => {
    const tracker = new ResponsesOutputTracker();
    tracker.observe({ type: "response.output_item.added", output_index: 18,
      item: { type: "function_call", id: "fc-1", call_id: "call-1", namespace: "image", status: "in_progress", arguments: "" } });
    const restored = tracker.reconcile({ output: [] }, { text: "", toolCalls: [{
      index: 18, itemId: "fc-1", id: "call-1", name: "generate", arguments: "{}", ended: true,
    }] }, true);
    expect(restored.output).toEqual([{
      type: "function_call", id: "fc-1", call_id: "call-1", namespace: "image", name: "generate", arguments: "{}",
    }]);
  });

  it("does not reconstruct unfinished native items or missing response.output", () => {
    const tracker = new ResponsesOutputTracker();
    tracker.observe({ type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs-1" } });
    tracker.observe({ type: "response.output_item.added", output_index: 18, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "image" } });
    const snapshot = { text: "", toolCalls: [{ index: 18, itemId: "fc-1", id: "call-1", name: "image", arguments: "{}", ended: false }] };
    expect(tracker.reconcile({ output: [] }, snapshot, true).output).toEqual([]);
    expect(tracker.reconcile({ status: "completed" }, snapshot, true)).toEqual({ status: "completed" });
    expect(tracker.reconcile({ output: [] }, { ...snapshot, toolCalls: [{ ...snapshot.toolCalls[0], ended: true }] }, false).output).toEqual([]);
  });

  it("does not overwrite explicit terminal arguments or an incomplete status", () => {
    const tracker = new ResponsesOutputTracker();
    tracker.observe({ type: "response.output_item.done", output_index: 18,
      item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "image", arguments: '{"prompt":"earlier"}' } });
    const finalItem = { type: "function_call", id: "fc-1", call_id: "call-1", name: "image", arguments: '{"prompt":', status: "incomplete" };
    expect(tracker.reconcile({ output: [finalItem] }, { text: "", toolCalls: [] }, true).output).toEqual([finalItem]);
  });

  it("does not overwrite native context when a known call arrives with a changed positional hint", () => {
    const tracker = new ResponsesOutputTracker();
    const reasoning = { type: "reasoning", id: "rs-1", encrypted_content: "opaque-test", summary: [] };
    const call = { type: "function_call", id: "fc-1", call_id: "call-1", name: "image", arguments: "{}" };
    tracker.observe({ type: "response.output_item.done", output_index: 0, item: reasoning });
    tracker.observe({ type: "response.output_item.added", output_index: 18, item: { ...call, arguments: "" } });
    tracker.observe({ type: "response.output_item.done", output_index: 0, item: call });
    expect(tracker.reconcile({ output: [] }, { text: "", toolCalls: [] }, true).output).toEqual([reasoning, call]);
  });
});
