import { describe, expect, it } from "vitest";
import { CyreneStreamAccumulator } from "./accumulator";
import { ProviderProtocolError } from "./types";

describe("CyreneStreamAccumulator", () => {
  it("keeps interleaved reasoning and text deltas in their own channels", () => {
    const accumulator = new CyreneStreamAccumulator();

    accumulator.apply({ type: "reasoning_delta", delta: "先分析" });
    accumulator.apply({ type: "text_delta", delta: "答案" });
    accumulator.apply({ type: "reasoning_delta", delta: "，再核对" });
    accumulator.apply({ type: "text_delta", delta: "完成" });
    accumulator.apply({ type: "finish", reason: "stop" });

    expect(accumulator.snapshot()).toMatchObject({
      text: "答案完成",
      thinking: "先分析，再核对",
      finishReason: "stop",
    });
    expect(accumulator.finalize({ requestId: "req-1" })).toMatchObject({
      text: "答案完成",
      thinking: "先分析，再核对",
      finishReason: "stop",
      assistantMessage: {
        role: "assistant",
        content: "答案完成",
        thinking: "先分析，再核对",
      },
      raw: { requestId: "req-1" },
    });
  });

  it("uses index while streaming and assigns the first non-empty tool id once", () => {
    const accumulator = new CyreneStreamAccumulator();

    accumulator.apply({ type: "tool_call_start", index: 1, nameDelta: "read_" });
    accumulator.apply({ type: "tool_call_start", index: 0, id: "call-0", nameDelta: "search" });
    accumulator.apply({ type: "tool_call_start", index: 1, id: "call-1", nameDelta: "file" });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 1, id: "call-1", delta: "{\"path\":" });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 0, id: "call-0", delta: "{\"q\":\"x\"}" });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 1, delta: "\"a.ts\"}" });
    accumulator.apply({ type: "tool_call_end", index: 1, id: "call-1" });
    accumulator.apply({ type: "tool_call_end", index: 0, id: "call-0" });
    accumulator.apply({ type: "finish", reason: "tool_calls" });

    expect(accumulator.snapshot().toolCalls).toEqual([
      { index: 0, id: "call-0", name: "search", arguments: "{\"q\":\"x\"}", ended: true },
      { index: 1, id: "call-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}", ended: true },
    ]);
    expect(accumulator.finalize(null).toolCalls).toEqual([
      { id: "call-0", name: "search", arguments: "{\"q\":\"x\"}" },
      { id: "call-1", name: "read_file", arguments: "{\"path\":\"a.ts\"}" },
    ]);
  });

  it("rejects a changed tool id instead of concatenating it", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 0, id: "call-a", nameDelta: "search" });

    expect(() =>
      accumulator.apply({ type: "tool_call_arguments_delta", index: 0, id: "call-b", delta: "{}" }),
    ).toThrowError(
      expect.objectContaining<Partial<ProviderProtocolError>>({
        name: "ProviderProtocolError",
        code: "E_TOOL_CALL_ID_CHANGED",
      }),
    );
  });

  it("backfills delayed terminal tool metadata without duplicating streamed arguments", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 8, id: "call-image" });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 8, delta: '{"prompt":' });
    accumulator.apply({
      type: "tool_call_end",
      index: 8,
      id: "call-image",
      name: "subscription-oauth_generate_image",
      arguments: '{"prompt":"Cyrene"}',
    });
    // Responses can report the same call at a compacted output-array index in
    // response.completed. The stable id must prevent a duplicate tool call.
    accumulator.apply({
      type: "tool_call_end",
      index: 1,
      id: "call-image",
      name: "subscription-oauth_generate_image",
      arguments: '{"prompt":"Cyrene"}',
    });

    expect(accumulator.finalize(null).toolCalls).toEqual([{
      id: "call-image",
      name: "subscription-oauth_generate_image",
      arguments: '{"prompt":"Cyrene"}',
    }]);
  });

  it.each([
    {
      name: "missing id",
      deltas: [
        { type: "tool_call_start", index: 0, nameDelta: "search" },
        { type: "tool_call_arguments_delta", index: 0, delta: "{}" },
        { type: "tool_call_end", index: 0 },
      ],
    },
    {
      name: "missing name",
      deltas: [
        { type: "tool_call_start", index: 0, id: "call-0" },
        { type: "tool_call_arguments_delta", index: 0, delta: "{}" },
        { type: "tool_call_end", index: 0 },
      ],
    },
    {
      name: "truncated arguments",
      deltas: [
        { type: "tool_call_start", index: 0, id: "call-0", nameDelta: "search" },
        { type: "tool_call_arguments_delta", index: 0, delta: "{\"q\":" },
        { type: "tool_call_end", index: 0 },
      ],
    },
    {
      name: "open tool state",
      deltas: [
        { type: "tool_call_start", index: 0, id: "call-0", nameDelta: "search" },
        { type: "tool_call_arguments_delta", index: 0, delta: "{}" },
      ],
    },
  ])("rejects an incomplete tool call: $name", ({ deltas }) => {
    const accumulator = new CyreneStreamAccumulator();
    for (const delta of deltas) {
      accumulator.apply(delta as Parameters<CyreneStreamAccumulator["apply"]>[0]);
    }
    accumulator.apply({ type: "finish", reason: "tool_calls" });

    expect(() => accumulator.finalize(null)).toThrowError(
      expect.objectContaining<Partial<ProviderProtocolError>>({
        name: "ProviderProtocolError",
        code: "E_TOOL_CALL_INCOMPLETE",
      }),
    );
  });

  it("does not substitute a native item ID for a missing call_id", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 18, itemId: "fc-only", nameDelta: "generate_image" });
    accumulator.apply({ type: "tool_call_end", index: 18, itemId: "fc-only", arguments: "{}" });
    expect(() => accumulator.finalize(null)).toThrowError("call_id=missing");
  });

  it("rejects ambiguous parallel terminal snapshots instead of pairing unidentified calls in order", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 0 });
    accumulator.apply({ type: "tool_call_start", index: 18 });
    expect(() => accumulator.apply({
      type: "tool_call_end", index: 0, terminalSnapshot: true,
      id: "call-second", name: "second", arguments: "{}",
    })).toThrowError("Cannot match parallel terminal tool calls");
  });

  it("rejects conflicting item IDs even when call_id remains the same", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 0, id: "call-1", itemId: "fc-1", nameDelta: "search" });
    expect(() => accumulator.apply({
      type: "tool_call_end", index: 0, id: "call-1", itemId: "fc-2", arguments: "{}",
    })).toThrowError("changed its native item id");
  });

  it("keeps argument fragments with their item ID even if a positional hint changes", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "tool_call_start", index: 18, itemId: "fc-1", id: "call-1", nameDelta: "search" });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 18, itemId: "fc-1", delta: '{"q":' });
    accumulator.apply({ type: "tool_call_arguments_delta", index: 0, itemId: "fc-1", delta: '"x"}' });
    accumulator.apply({ type: "tool_call_end", index: 0, itemId: "fc-1" });
    expect(accumulator.finalize(null).toolCalls).toEqual([{ id: "call-1", name: "search", arguments: '{"q":"x"}' }]);
  });

  it("exposes partial usage with missing fields filled as zero", () => {
    const accumulator = new CyreneStreamAccumulator();

    accumulator.apply({ type: "usage", inputTokens: 12 });
    expect(accumulator.snapshot().usage).toEqual({ input: 12, output: 0 });

    accumulator.apply({ type: "usage", outputTokens: 7 });
    expect(accumulator.snapshot().usage).toEqual({ input: 12, output: 7 });
  });

  it("preserves provider-reported cached input tokens with the final usage", () => {
    const accumulator = new CyreneStreamAccumulator();

    accumulator.apply({ type: "usage", inputTokens: 20, cachedInputTokens: 12 });
    accumulator.apply({ type: "usage", outputTokens: 7 });

    expect(accumulator.finalize(null).usage).toEqual({ input: 20, output: 7, cachedInput: 12 });
  });

  it("preserves refusal and terminal reason", () => {
    const accumulator = new CyreneStreamAccumulator();
    accumulator.apply({ type: "refusal", reason: "safety" });
    accumulator.apply({ type: "finish", reason: "content_filter" });

    expect(accumulator.finalize({})).toMatchObject({
      refusal: "safety",
      finishReason: "content_filter",
    });
  });
});
