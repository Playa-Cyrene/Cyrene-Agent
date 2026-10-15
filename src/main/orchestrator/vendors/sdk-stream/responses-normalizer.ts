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
//   response.function_call_arguments.done   → tool_call_end（携带终态参数）
//   response.output_item.done(fn_call)      → tool_call_end（携带完整工具项）
//   response.completed                      → 工具项快照 + usage + finish
//   response.incomplete                     → 工具项快照 + usage + finish（max_output_tokens → length）
//   response.failed / error                 → 抛 ProviderProtocolError（runtime catch 统一处理）
// 未列出的事件静默跳过（对齐 openai-normalizer 防御式写法）。
// 注：runtime 会先按稳定身份合并终态 output，再把它交给 normalizer 和 rawAssistant。

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function indexField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function assertToolCallComplete(item: Record<string, unknown>, index: number): void {
  if (item.status === "incomplete" || item.status === "in_progress") {
    throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE",
      `Tool call at index ${index} has terminal status ${item.status}`);
  }
}

function terminalToolCalls(response: unknown): UnifiedStreamDelta[] {
  if (!isRecord(response) || !Array.isArray(response.output)) return [];
  const snapshots: UnifiedStreamDelta[] = [];
  response.output.forEach((value, index) => {
    if (!isRecord(value) || value.type !== "function_call") return;
    assertToolCallComplete(value, index);
    const id = nonEmptyString(value.call_id);
    const itemId = nonEmptyString(value.id);
    const name = nonEmptyString(value.name);
    const args = typeof value.arguments === "string" ? value.arguments : undefined;
    snapshots.push({
      type: "tool_call_end",
      index,
      terminalSnapshot: true,
      ...(id ? { id } : {}),
      ...(itemId ? { itemId } : {}),
      ...(name ? { name } : {}),
      ...(args !== undefined ? { arguments: args } : {}),
    });
  });
  return snapshots;
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
      const id = nonEmptyString(event.call_id);
      const itemId = nonEmptyString(event.item_id);
      return [{ type: "tool_call_arguments_delta", index, ...(id ? { id } : {}), ...(itemId ? { itemId } : {}), delta }];
    }

    case "response.function_call_arguments.done": {
      // arguments 是完整快照；累积器会覆盖之前的增量，避免重复拼接。
      const index = indexField(event.output_index);
      if (index === undefined) return [];
      const id = nonEmptyString(event.call_id);
      const itemId = nonEmptyString(event.item_id);
      const name = nonEmptyString(event.name);
      const args = typeof event.arguments === "string" ? event.arguments : undefined;
      return [{
        type: "tool_call_end", index,
        ...(id ? { id } : {}), ...(itemId ? { itemId } : {}),
        ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}),
      }];
    }

    case "response.output_item.done": {
      // done 阶段的 function_call 是完整快照。
      const item = isRecord(event.item) ? event.item : undefined;
      const index = indexField(event.output_index);
      if (!item || index === undefined || item.type !== "function_call") return [];
      assertToolCallComplete(item, index);
      const id = nonEmptyString(item.call_id);
      const itemId = nonEmptyString(item.id);
      const name = nonEmptyString(item.name);
      const args = typeof item.arguments === "string" ? item.arguments : undefined;
      return [{
        type: "tool_call_end", index,
        ...(id ? { id } : {}), ...(itemId ? { itemId } : {}),
        ...(name ? { name } : {}), ...(args !== undefined ? { arguments: args } : {}),
      }];
    }

    case "response.completed":
      return [...terminalToolCalls(event.response), ...usageFrom(event.response), { type: "finish", reason: "stop" }];

    case "response.incomplete": {
      const response = isRecord(event.response) ? event.response : undefined;
      const reason = response && isRecord(response.incomplete_details)
        ? nonEmptyString(response.incomplete_details.reason)
        : undefined;
      return [
        ...terminalToolCalls(response),
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
          requestId: response ? nonEmptyString(response.id) : undefined,
        } : undefined,
      );
    }

    case "error": {
      const message = nonEmptyString(event.message);
      throw new ProviderProtocolError(
        "E_UNSUPPORTED_STREAM_EVENT",
        message ?? "Responses stream returned an error event",
        {
          vendorCode: nonEmptyString(event.code),
          vendorType: nonEmptyString(event.type),
          requestId: nonEmptyString(event.request_id),
        },
      );
    }

    default:
      return [];
  }
}
