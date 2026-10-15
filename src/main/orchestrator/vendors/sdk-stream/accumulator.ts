import type { ChatResponse, ToolCall } from "../types";
import {
  ProviderProtocolError,
  type StreamAccumulatorSnapshot,
  type UnifiedStreamDelta,
} from "./types";

interface MutableToolCall {
  index: number;
  id?: string;
  itemId?: string;
  name: string;
  arguments: string;
  ended: boolean;
}

export class CyreneStreamAccumulator {
  private text = "";
  private thinking = "";
  private readonly toolCalls = new Map<number, MutableToolCall>();
  private finishReason: string | undefined;
  private refusal: string | undefined;
  private inputTokens: number | undefined;
  private outputTokens: number | undefined;
  private cachedInputTokens: number | undefined;
  private cacheCreationTokens: number | undefined;

  apply(delta: UnifiedStreamDelta): void {
    switch (delta.type) {
      case "reasoning_delta":
        this.thinking += delta.delta;
        return;
      case "text_delta":
        this.text += delta.delta;
        return;
      case "tool_call_start": {
        const toolCall = this.getOrResolveToolCall(delta.index, delta.id, delta.itemId);
        this.assignStableId(toolCall, delta.id);
        this.assignStableItemId(toolCall, delta.itemId);
        toolCall.name += delta.nameDelta ?? "";
        return;
      }
      case "tool_call_arguments_delta": {
        const toolCall = this.getOrResolveToolCall(delta.index, delta.id, delta.itemId);
        this.assignStableId(toolCall, delta.id);
        this.assignStableItemId(toolCall, delta.itemId);
        toolCall.arguments += delta.delta;
        return;
      }
      case "tool_call_end": {
        const toolCall = this.getOrResolveToolCall(delta.index, delta.id, delta.itemId, delta.terminalSnapshot);
        this.assignStableId(toolCall, delta.id);
        this.assignStableItemId(toolCall, delta.itemId);
        // Responses 结束事件携带完整快照时，用快照补齐名称和参数，不重复追加参数。
        if (delta.name !== undefined) toolCall.name = delta.name;
        if (delta.arguments !== undefined) toolCall.arguments = delta.arguments;
        toolCall.ended = true;
        return;
      }
      case "usage":
        if (delta.inputTokens !== undefined) this.inputTokens = delta.inputTokens;
        if (delta.outputTokens !== undefined) this.outputTokens = delta.outputTokens;
        if (delta.cachedInputTokens !== undefined) this.cachedInputTokens = delta.cachedInputTokens;
        if (delta.cacheCreationTokens !== undefined) this.cacheCreationTokens = delta.cacheCreationTokens;
        return;
      case "finish":
        this.finishReason = delta.reason;
        return;
      case "refusal":
        this.refusal = delta.reason;
        return;
    }
  }

  snapshot(): StreamAccumulatorSnapshot {
    return {
      text: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      toolCalls: this.sortedToolCalls().map((toolCall) => ({ ...toolCall })),
      ...(this.finishReason !== undefined ? { finishReason: this.finishReason } : {}),
      ...(this.refusal !== undefined ? { refusal: this.refusal } : {}),
      ...(this.inputTokens !== undefined || this.outputTokens !== undefined || this.cachedInputTokens !== undefined || this.cacheCreationTokens !== undefined
        ? { usage: {
            input: this.inputTokens ?? 0,
            output: this.outputTokens ?? 0,
            ...(this.cachedInputTokens !== undefined ? { cachedInput: this.cachedInputTokens } : {}),
            ...(this.cacheCreationTokens !== undefined ? { cacheCreation: this.cacheCreationTokens } : {}),
          } }
        : {}),
    };
  }

  finalize(raw: unknown): ChatResponse {
    const toolCalls = this.sortedToolCalls().map((toolCall) => this.finalizeToolCall(toolCall));
    const assistantMessage = {
      role: "assistant" as const,
      content: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    return {
      assistantMessage,
      text: this.text,
      ...(this.thinking ? { thinking: this.thinking } : {}),
      ...(this.refusal !== undefined ? { refusal: this.refusal } : {}),
      toolCalls,
      finishReason: this.finishReason ?? "unknown",
      raw,
      ...(this.inputTokens !== undefined || this.outputTokens !== undefined || this.cachedInputTokens !== undefined || this.cacheCreationTokens !== undefined
        ? { usage: {
            input: this.inputTokens ?? 0,
            output: this.outputTokens ?? 0,
            ...(this.cachedInputTokens !== undefined ? { cachedInput: this.cachedInputTokens } : {}),
            ...(this.cacheCreationTokens !== undefined ? { cacheCreation: this.cacheCreationTokens } : {}),
          } }
        : {}),
    };
  }

  private getOrCreateToolCall(index: number): MutableToolCall {
    const existing = this.toolCalls.get(index);
    if (existing) return existing;

    const created: MutableToolCall = {
      index,
      name: "",
      arguments: "",
      ended: false,
    };
    this.toolCalls.set(index, created);
    return created;
  }

  private getOrResolveToolCall(index: number, id?: string, itemId?: string, terminalSnapshot = false): MutableToolCall {
    if (itemId) {
      const byItemId = this.sortedToolCalls().find((toolCall) => toolCall.itemId === itemId);
      if (byItemId) return byItemId;
    }
    if (id) {
      const byId = this.sortedToolCalls().find((toolCall) => toolCall.id === id);
      if (byId) return byId;
    }

    if (terminalSnapshot) {
      if (!id && !itemId && this.toolCalls.size > 0) {
        throw new ProviderProtocolError("E_TOOL_CALL_INCOMPLETE",
          "Cannot match a terminal tool call without call_id or item_id");
      }
      if (this.toolCalls.has(index)) {
        const nextIndex = Math.max(...this.toolCalls.keys()) + 1;
        return this.getOrCreateToolCall(nextIndex);
      }
    }

    return this.toolCalls.get(index) ?? this.getOrCreateToolCall(index);
  }

  private assignStableItemId(toolCall: MutableToolCall, itemId?: string): void {
    if (!itemId) return;
    if (toolCall.itemId && toolCall.itemId !== itemId) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_ID_CHANGED",
        `Tool call at index ${toolCall.index} changed its native item id`,
      );
    }
    toolCall.itemId = itemId;
  }

  private assignStableId(toolCall: MutableToolCall, id: string | undefined): void {
    if (!id) return;
    if (!toolCall.id) {
      toolCall.id = id;
      return;
    }
    if (toolCall.id !== id) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_ID_CHANGED",
        `Tool call at index ${toolCall.index} changed id from ${toolCall.id} to ${id}`,
      );
    }
  }

  private sortedToolCalls(): MutableToolCall[] {
    return [...this.toolCalls.values()].sort((left, right) => left.index - right.index);
  }

  private finalizeToolCall(toolCall: MutableToolCall): ToolCall {
    if (!toolCall.ended || !toolCall.id || !toolCall.name.trim()) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_INCOMPLETE",
        `Tool call at index ${toolCall.index} is missing its terminal marker, id, or name`,
      );
    }

    try {
      JSON.parse(toolCall.arguments);
    } catch (error) {
      throw new ProviderProtocolError(
        "E_TOOL_CALL_INCOMPLETE",
        `Tool call at index ${toolCall.index} has incomplete JSON arguments: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return {
      id: toolCall.id,
      name: toolCall.name,
      arguments: toolCall.arguments,
    };
  }
}
