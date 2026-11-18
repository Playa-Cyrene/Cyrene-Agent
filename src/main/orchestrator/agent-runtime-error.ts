/**
 * 结构化 Agent 运行时错误（修订第 3 点）。
 *
 * 用 `code` 字段区分错误类型，避免下游靠 `message.startsWith("E_...")` 解析文本。
 * AgUiBridge 据此把 `code` 透传给 renderer，renderer 据此显示不同文案。
 */
export type AgentErrorCode =
  | "E_AGENT_NO_PROGRESS"
  | "E_AGENT_GRAPH_ITERATION_LIMIT"
  | "E_MODEL_REQUEST_FAILED"
  | "E_MODEL_REQUEST_TIMEOUT"
  | "E_MODEL_HTTP_ERROR"
  | "E_MODEL_RESPONSE_PARSE_FAILED";

export class AgentRuntimeError extends Error {
  constructor(
    public readonly code: AgentErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AgentRuntimeError";
  }
}

export type ModelRetryReason = "quota" | "transient";

/** 保留可重试类型，原始模型错误只在本地诊断中使用。 */
export class RetryableModelRunError extends Error {
  constructor(message: string, public readonly reason: ModelRetryReason) {
    super(message);
  }
}

export function classifyModelRetry(error: unknown): ModelRetryReason | undefined {
  if (!(error instanceof AgentRuntimeError)) return;
  if (error.code === "E_MODEL_REQUEST_TIMEOUT") return "transient";
  if (error.code !== "E_MODEL_REQUEST_FAILED" && error.code !== "E_MODEL_HTTP_ERROR") return;

  const cause = error.cause as { status?: unknown; code?: unknown; cause?: { code?: unknown } } | undefined;
  const status = typeof cause?.status === "number"
    ? cause.status
    : Number(/HTTP\s+(\d{3})\b/.exec(error.message)?.[1]);
  if (status === 402 || status === 429) return "quota";
  if ([408, 500, 502, 503, 504].includes(status)) return "transient";
  const networkCode = cause?.code ?? cause?.cause?.code;
  if (!Number.isFinite(status) && (networkCode === "ECONNRESET" || networkCode === "ETIMEDOUT" || networkCode === "EAI_AGAIN")) {
    return "transient";
  }
}
