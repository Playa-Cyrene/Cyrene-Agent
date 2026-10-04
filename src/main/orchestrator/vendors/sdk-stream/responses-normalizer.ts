import { ProviderProtocolError, type UnifiedStreamDelta } from "./types";

// ── OpenAI Responses API 流式事件 → UnifiedStreamDelta ──
// 事件映射清单（docs/responses-transport-construction-plan.md「responses-normalizer」小节）：
//   response.output_text.delta              → text_delta
//   response.output_text.done               → 忽略（全量快照，delta 已流过）
//   response.reasoning_summary_text.delta   → reasoning_delta
//   response.reasoning_text.delta           → reasoning_delta
//   response.refusal.delta / done           → refusal
//   response.output_item.added(fn_call)     → tool_call_start（call_id/name）
//   response.function_call_arguments.delta  → tool_call_arguments_delta
//   response.function_call_arguments.done   → tool_call_end（携带参数快照）
//   response.output_item.done(fn_call)      → tool_call_end（携带完整快照）
//   response.completed                      → terminal tool snapshots + usage + finish
//   response.incomplete                     → terminal tool snapshots + usage + finish
//   response.failed / error                 → 抛 ProviderProtocolError（runtime catch 统一处理）
// 未列出的事件静默跳过（对齐 openai-normalizer 防御式写法）。
// 注：runtime 先用已明确结束的输出补齐 completed/incomplete 的 response，
// 再同时交给 normalizer 和 rawAssistant，保证执行调用与续答底稿一致。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function indexField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function assertCompletedToolItem(item: Record<string, unknown>, index: number): void {
  if (item.status === "incomplete" || item.status === "in_progress") {
    throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE",
      `Tool call at index ${index} has terminal status ${item.status}`);
  }
}

function usageFrom(response: unknown): UnifiedStreamDelta[] {
  if (!isRecord(response) || !isRecord(response.usage)) return [];
  const usage = response.usage;
  const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : undefined;
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined;
  const cachedInputTokens = details && typeof details.cached_tokens === "number"
    ? details.cached_tokens
    : undefined;
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined) return [];
  return [{
    type: "usage",
    inputTokens,
    outputTokens,
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
  }];
}

/**
 * Responses 的终态 response.output 是最完整的权威快照。某些兼容端点（包括
 * ChatGPT Codex）会在 output_item.added 阶段省略 function name/call_id，直到
 * output_item.done 或 response.completed 才补齐。转换这份终态快照，可在中间事件
 * 丢失或字段延迟时安全恢复工具调用。
 */
function terminalToolCallSnapshots(response: unknown): UnifiedStreamDelta[] {
  if (!isRecord(response) || !Array.isArray(response.output)) return [];
  const snapshots: UnifiedStreamDelta[] = [];
  for (let index = 0; index < response.output.length; index += 1) {
    const item = isRecord(response.output[index]) ? response.output[index] : undefined;
    if (!item || item.type !== "function_call") continue;
    assertCompletedToolItem(item, index);
    const id = nonEmptyString(item.call_id);
    const itemId = nonEmptyString(item.id);
    const name = nonEmptyString(item.name);
    const args = typeof item.arguments === "string" ? item.arguments : undefined;
    snapshots.push({
      type: "tool_call_end",
      index,
      terminalSnapshot: true,
      ...(id ? { id } : {}),
      ...(itemId ? { itemId } : {}),
      ...(name ? { name } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
    });
  }
  return snapshots;
}

export function normalizeResponsesEvent(event: unknown): UnifiedStreamDelta[] {
  if (!isRecord(event) || typeof event.type !== "string") return [];

  switch (event.type) {
    case "response.output_text.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "text_delta", delta }] : [];
    }

    case "response.output_text.done":
      return [];

    case "response.reasoning_summary_text.delta":
    case "response.reasoning_text.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "reasoning_delta", delta }] : [];
    }

    case "response.refusal.delta": {
      const delta = nonEmptyString(event.delta);
      return delta ? [{ type: "refusal", reason: delta }] : [];
    }

    case "response.refusal.done": {
      const reason = nonEmptyString(event.refusal);
      return reason ? [{ type: "refusal", reason }] : [];
    }

    case "response.output_item.added": {
      const item = isRecord(event.item) ? event.item : undefined;
      const index = indexField(event.output_index);
      if (!item || index === undefined) return [];
      if (item.type !== "function_call") return [];
      const id = nonEmptyString(item.call_id);
      const itemId = nonEmptyString(item.id);
      const name = nonEmptyString(item.name);
      return [{
        type: "tool_call_start",
        index,
        ...(id ? { id } : {}),
        ...(itemId ? { itemId } : {}),
        ...(name ? { nameDelta: name } : {}),
      }];
    }

    case "response.function_call_arguments.delta": {
      const index = indexField(event.output_index);
      const delta = nonEmptyString(event.delta);
      if (index === undefined || !delta) return [];
      const itemId = nonEmptyString(event.item_id);
      return [{ type: "tool_call_arguments_delta", index, ...(itemId ? { itemId } : {}), delta }];
    }

    case "response.function_call_arguments.done": {
      // arguments 是终态快照；accumulator 会覆盖而不是追加，因此不会重复。
      const index = indexField(event.output_index);
      if (index === undefined) return [];
      const args = typeof event.arguments === "string" ? event.arguments : undefined;
      const itemId = nonEmptyString(event.item_id);
      const name = nonEmptyString(event.name);
      const id = nonEmptyString(event.call_id);
      return [{
        type: "tool_call_end",
        index,
        ...(itemId ? { itemId } : {}),
        ...(id ? { id } : {}),
        ...(name ? { name } : {}),
        ...(args !== undefined ? { arguments: args } : {}),
      }];
    }

    case "response.output_item.done": {
      // function_call 终态快照；done 阶段 item 才完整（SDK 注释明确）。
      const item = isRecord(event.item) ? event.item : undefined;
      const index = indexField(event.output_index);
      if (!item || index === undefined || item.type !== "function_call") return [];
      assertCompletedToolItem(item, index);
      const id = nonEmptyString(item.call_id);
      const itemId = nonEmptyString(item.id);
      const name = nonEmptyString(item.name);
      const args = typeof item.arguments === "string" ? item.arguments : undefined;
      return [{
        type: "tool_call_end",
        index,
        ...(id ? { id } : {}),
        ...(itemId ? { itemId } : {}),
        ...(name ? { name } : {}),
        ...(args !== undefined ? { arguments: args } : {}),
      }];
    }

    case "response.completed":
      return [
        ...terminalToolCallSnapshots(event.response),
        ...usageFrom(event.response),
        { type: "finish", reason: "stop" },
      ];

    case "response.incomplete": {
      const response = isRecord(event.response) ? event.response : undefined;
      const reason = response && isRecord(response.incomplete_details)
        ? nonEmptyString(response.incomplete_details.reason)
        : undefined;
      return [
        ...terminalToolCallSnapshots(response),
        ...usageFrom(response),
        { type: "finish", reason: reason === "max_output_tokens" ? "length" : reason ?? "incomplete" },
      ];
    }

    case "response.failed": {
      const response = isRecord(event.response) ? event.response : undefined;
      const payload = response && isRecord(response.error) ? response.error : undefined;
      const message = payload ? nonEmptyString(payload.message) : undefined;
      throw new ProviderProtocolError(
        "E_UNSUPPORTED_STREAM_EVENT",
        message ?? "Responses stream returned response.failed",
        payload ? {
          vendorCode: nonEmptyString(payload.code),
          vendorType: nonEmptyString(payload.type),
          status: indexField(payload.status ?? response?.status_code),
          requestId: nonEmptyString(payload.request_id ?? response?.request_id ?? event.request_id),
        } : undefined,
      );
    }

    case "error": {
      const payload = isRecord(event.error) ? event.error : event;
      const message = nonEmptyString(payload.message);
      throw new ProviderProtocolError(
        "E_UNSUPPORTED_STREAM_EVENT",
        message ?? "Responses stream returned an error event",
        {
          vendorCode: nonEmptyString(payload.code),
          vendorType: nonEmptyString(payload.type),
          status: indexField(payload.status ?? event.status),
          requestId: nonEmptyString(payload.request_id ?? event.request_id),
        },
      );
    }

    default:
      return [];
  }
}
