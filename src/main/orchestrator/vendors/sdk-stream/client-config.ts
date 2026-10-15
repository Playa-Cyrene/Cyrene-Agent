export interface OpenAIClientConfig {
  baseURL: string;
  apiKey: string;
  maxRetries: 0;
  fetch?: typeof fetch;
}

export interface AnthropicClientConfig {
  baseURL: string;
  apiKey?: string;
  authToken?: string;
  maxRetries: 0;
  fetch?: typeof fetch;
}

function withoutTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function endpointBase(endpoint: string, suffix: string): string | undefined {
  const url = new URL(endpoint);
  const pathname = withoutTrailingSlash(url.pathname);
  if (!pathname.endsWith(suffix)) return undefined;
  const basePath = pathname.slice(0, -suffix.length);
  return withoutTrailingSlash(`${url.origin}${basePath}`);
}

export function deriveOpenAIClientConfig(endpoint: string, apiKey: string): OpenAIClientConfig {
  const baseURL = endpointBase(endpoint, "/chat/completions");
  if (!baseURL) throw new Error("OpenAI SDK endpoint must end with /chat/completions");
  return { baseURL, apiKey, maxRetries: 0 };
}

/**
 * Responses API 客户端配置：endpoint 以 /responses 结尾，剥掉后缀得 baseURL
 * （SDK 内部固定向 {baseURL}/responses 发请求，与 deriveOpenAIClientConfig 同模式）。
 */
export function deriveResponsesClientConfig(endpoint: string, apiKey: string): OpenAIClientConfig {
  const baseURL = endpointBase(endpoint, "/responses");
  if (!baseURL) throw new Error("OpenAI SDK Responses endpoint must end with /responses");
  return { baseURL, apiKey, maxRetries: 0 };
}

export function createEndpointPinnedFetch(
  endpoint: string,
  delegate: typeof fetch = fetch,
): typeof fetch {
  return async (input, init) => {
    const original = new Request(input, init);
    const pinned = new Request(endpoint, original);
    return delegate(pinned);
  };
}

export function deriveAnthropicClientConfig(
  endpoint: string,
  apiKey: string,
  authStyle: "bearer" | "x-api-key",
  delegate: typeof fetch = fetch,
): AnthropicClientConfig {
  const standardBaseURL = endpointBase(endpoint, "/v1/messages");
  const endpointUrl = new URL(endpoint);
  const auth = authStyle === "bearer" ? { authToken: apiKey } : { apiKey };
  if (standardBaseURL) {
    return { baseURL: standardBaseURL, ...auth, maxRetries: 0 };
  }
  return {
    baseURL: endpointUrl.origin,
    ...auth,
    maxRetries: 0,
    fetch: createEndpointPinnedFetch(endpoint, delegate),
  };
}
