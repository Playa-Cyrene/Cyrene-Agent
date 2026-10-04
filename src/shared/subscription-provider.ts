/** Exact plugin-owned labels; do not promote arbitrary OpenAI-compatible providers. */
const SUBSCRIPTION_PROVIDERS: Readonly<Record<string, string>> = {
  "ChatGPT（OpenAI）订阅": "chatgpt",
  "Claude（Anthropic）订阅": "claude",
  "Grok（xAI）订阅": "grok",
};

export function subscriptionProviderId(provider: string): string | undefined {
  return Object.hasOwn(SUBSCRIPTION_PROVIDERS, provider) ? SUBSCRIPTION_PROVIDERS[provider] : undefined;
}

/** Local subscription proxy identity, not a blanket exception for all localhost APIs. */
export function isChatGPTSubscriptionProxy(config: { provider: string; baseUrl: string; apiKey: string }): boolean {
  if (subscriptionProviderId(config.provider) !== "chatgpt" || config.apiKey !== "oauth-subscription") return false;
  try {
    const url = new URL(config.baseUrl.trim());
    return ["http:", "https:"].includes(url.protocol)
      && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname.toLowerCase())
      && !url.username && !url.password && !url.search && !url.hash
      && /^\/v1(?:\/responses)?\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}
