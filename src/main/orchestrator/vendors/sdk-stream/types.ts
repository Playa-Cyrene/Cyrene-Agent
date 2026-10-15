export type UnifiedStreamDelta =
  | { type: "reasoning_delta"; delta: string }
  | { type: "text_delta"; delta: string }
  | { type: "tool_call_start"; index: number; id?: string; itemId?: string; nameDelta?: string }
  | { type: "tool_call_arguments_delta"; index: number; id?: string; itemId?: string; delta: string }
  | {
      type: "tool_call_end";
      index: number;
      id?: string;
      itemId?: string;
      terminalSnapshot?: boolean;
      name?: string;
      arguments?: string;
    }
  | { type: "usage"; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; cacheCreationTokens?: number }
  | { type: "finish"; reason: string }
  | { type: "refusal"; reason?: string };

export interface StreamAccumulatorSnapshot {
  text: string;
  thinking?: string;
  toolCalls: ReadonlyArray<{
    index: number;
    id?: string;
    itemId?: string;
    name: string;
    arguments: string;
    ended: boolean;
  }>;
  finishReason?: string;
  refusal?: string;
  usage?: { input: number; output: number; cachedInput?: number; cacheCreation?: number };
}

export interface StreamDiagnostic {
  code: "E_STREAM_TERMINAL_MISMATCH";
  transport: "anthropic";
  differences: string[];
  live: {
    text_length: number;
    reasoning_length: number;
    tool_call_ids: string[];
  };
  terminal: {
    text_length: number;
    reasoning_length: number;
    tool_call_ids: string[];
  };
}

export type ProviderProtocolErrorCode =
  | "E_TOOL_CALL_ID_CHANGED"
  | "E_TOOL_CALL_INCOMPLETE"
  | "E_STREAM_TERMINAL_MISMATCH"
  | "E_UNSUPPORTED_STREAM_EVENT";

export class ProviderProtocolError extends Error {
  constructor(
    readonly code: ProviderProtocolErrorCode,
    message: string,
    readonly providerDetails?: { vendorCode?: string; vendorType?: string; status?: number; requestId?: string },
  ) {
    super(message);
    this.name = "ProviderProtocolError";
  }
}
