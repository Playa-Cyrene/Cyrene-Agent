import { describe, expect, test } from "vitest";
import { normalizeResponsesEvent } from "./responses-normalizer";
import { ProviderProtocolError } from "./types";

describe("normalizeResponsesEvent", () => {
  test("response.output_text.delta → text_delta", () => {
    expect(normalizeResponsesEvent({ type: "response.output_text.delta", delta: "你好" }))
      .toEqual([{ type: "text_delta", delta: "你好" }]);
  });

  test("response.output_text.done → 忽略（全量快照，delta 已流过）", () => {
    expect(normalizeResponsesEvent({ type: "response.output_text.done", text: "你好" })).toEqual([]);
  });

  test("response.reasoning_summary_text.delta / response.reasoning_text.delta → reasoning_delta", () => {
    expect(normalizeResponsesEvent({ type: "response.reasoning_summary_text.delta", delta: "想" }))
      .toEqual([{ type: "reasoning_delta", delta: "想" }]);
    expect(normalizeResponsesEvent({ type: "response.reasoning_text.delta", delta: "考" }))
      .toEqual([{ type: "reasoning_delta", delta: "考" }]);
  });

  test("response.refusal.delta / done → refusal", () => {
    expect(normalizeResponsesEvent({ type: "response.refusal.delta", delta: "不能" }))
      .toEqual([{ type: "refusal", reason: "不能" }]);
    expect(normalizeResponsesEvent({ type: "response.refusal.done", refusal: "不能协助" }))
      .toEqual([{ type: "refusal", reason: "不能协助" }]);
  });

  test("response.output_item.added（function_call）→ tool_call_start（call_id/name）", () => {
    expect(normalizeResponsesEvent({
      type: "response.output_item.added",
      output_index: 2,
      item: { type: "function_call", call_id: "call_1", name: "get_weather" },
    })).toEqual([{
      type: "tool_call_start",
      index: 2,
      id: "call_1",
      nameDelta: "get_weather",
    }]);
  });

  test("response.output_item.added（非 function_call，如 message）→ 忽略", () => {
    expect(normalizeResponsesEvent({
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message" },
    })).toEqual([]);
  });

  test("response.function_call_arguments.delta → tool_call_arguments_delta", () => {
    expect(normalizeResponsesEvent({
      type: "response.function_call_arguments.delta",
      output_index: 2,
      delta: '{"city"',
    })).toEqual([{ type: "tool_call_arguments_delta", index: 2, delta: '{"city"' }]);
  });

  test("response.function_call_arguments.done → tool_call_end（携带完整参数快照）", () => {
    expect(normalizeResponsesEvent({
      type: "response.function_call_arguments.done",
      output_index: 2,
      arguments: '{"city":"BJ"}',
    })).toEqual([{ type: "tool_call_end", index: 2, arguments: '{"city":"BJ"}' }]);
  });

  test("response.output_item.done（function_call）→ 携带工具项快照闭合", () => {
    expect(normalizeResponsesEvent({
      type: "response.output_item.done",
      output_index: 2,
      item: { type: "function_call", call_id: "call_1", name: "get_weather", arguments: "{}" },
    })).toEqual([{
      type: "tool_call_end", index: 2, id: "call_1", name: "get_weather", arguments: "{}",
    }]);
  });

  test("response.completed → usage（含 cached）+ finish stop", () => {
    expect(normalizeResponsesEvent({
      type: "response.completed",
      response: {
        output: [],
        usage: {
          input_tokens: 5,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 3 },
        },
      },
    })).toEqual([
      { type: "usage", inputTokens: 5, outputTokens: 2, cachedInputTokens: 3 },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("response.incomplete（max_output_tokens）→ usage + finish length", () => {
    expect(normalizeResponsesEvent({
      type: "response.incomplete",
      response: {
        output: [],
        incomplete_details: { reason: "max_output_tokens" },
        usage: { input_tokens: 3, output_tokens: 1 },
      },
    })).toEqual([
      { type: "usage", inputTokens: 3, outputTokens: 1 },
      { type: "finish", reason: "length" },
    ]);
  });

  test("response.incomplete（其他 reason）→ finish 原样透传", () => {
    expect(normalizeResponsesEvent({
      type: "response.incomplete",
      response: { output: [], incomplete_details: { reason: "content_filter" } },
    })).toEqual([{ type: "finish", reason: "content_filter" }]);
  });

  test("response.incomplete（无 incomplete_details）→ finish incomplete", () => {
    expect(normalizeResponsesEvent({ type: "response.incomplete", response: {} }))
      .toEqual([{ type: "finish", reason: "incomplete" }]);
  });

  test("response.failed → 抛 ProviderProtocolError（带 error.message）", () => {
    expect(() => normalizeResponsesEvent({
      type: "response.failed",
      response: { error: { message: "server exploded" } },
    })).toThrowError(ProviderProtocolError);
    expect(() => normalizeResponsesEvent({
      type: "response.failed",
      response: { error: { message: "server exploded" } },
    })).toThrowError("server exploded");
  });

  test("独立 error 事件 → 抛 ProviderProtocolError", () => {
    expect(() => normalizeResponsesEvent({ type: "error", message: "bad request" }))
      .toThrowError(ProviderProtocolError);
    expect(() => normalizeResponsesEvent({ type: "error" }))
      .toThrowError("Responses stream returned an error event");
  });

  test("未知事件静默跳过（对齐 openai-normalizer 防御式写法）", () => {
    expect(normalizeResponsesEvent({ type: "response.reasoning_summary_part.added" })).toEqual([]);
    expect(normalizeResponsesEvent({ type: "response.created" })).toEqual([]);
    expect(normalizeResponsesEvent({ type: "response.in_progress" })).toEqual([]);
  });

  test("非对象事件 → 空数组", () => {
    expect(normalizeResponsesEvent(null)).toEqual([]);
    expect(normalizeResponsesEvent("response.output_text.delta")).toEqual([]);
    expect(normalizeResponsesEvent(42)).toEqual([]);
  });

  test("无 type 字段的事件 → 空数组", () => {
    expect(normalizeResponsesEvent({ delta: "text" })).toEqual([]);
  });
});
