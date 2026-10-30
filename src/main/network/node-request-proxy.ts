/**
 * 让主进程里 Node 自带的 fetch / http(s) 请求也走代理。
 *
 * 模型、嵌入、TTS 等请求用的是 Node 的 fetch（undici），默认既不读系统代理，
 * 也不读 HTTP(S)_PROXY 环境变量（需要 NODE_USE_ENV_PROXY=1 才读）；Electron 的
 * net.fetch 则跟随系统代理。用户开着全局代理时，Gemini 等境外接口会因此连不上。
 *
 * 启动时按以下顺序决定：
 * 1. 已设置 HTTP(S)_PROXY 环境变量 → 直接使用（等同用户手动设置 NODE_USE_ENV_PROXY=1）；
 * 2. 否则向 Chromium 查询系统代理（含 PAC），取第一个 HTTP / HTTPS 代理；
 * 3. 系统代理只有 SOCKS 或为直连时不改动。
 * 本机地址始终直连，避免本地模型（Ollama 等）被代理。
 */

/** 解析代理时用作探测地址；PAC 可能按地址分流，这里取典型的境外模型接口。 */
export const PROXY_PROBE_URL = "https://generativelanguage.googleapis.com/";

// 全局 fetch 的 IPv6 回环主机名是 "[::1]"，裸写 "::1" 匹配不到；两种都保留以兼容其他读取方。
const LOCAL_NO_PROXY = ["localhost", "127.0.0.1", "[::1]", "::1"];

export type NodeRequestProxySource = "env" | "system" | "none" | "unsupported";

export interface NodeRequestProxyResult {
  source: NodeRequestProxySource;
  /** 实际使用的代理地址（不含凭据）；未使用代理时为空。 */
  proxy?: string;
  /** Chromium 返回的原始代理规则，便于排查。 */
  rules?: string;
}

type ProxyEnv = Record<string, string | undefined>;

function readEnv(env: ProxyEnv, name: string): string | undefined {
  const value = env[name] ?? env[name.toLowerCase()];
  return value?.trim() ? value.trim() : undefined;
}

export function hasEnvProxy(env: ProxyEnv): boolean {
  return Boolean(readEnv(env, "HTTPS_PROXY") || readEnv(env, "HTTP_PROXY"));
}

/**
 * 合并用户已有的绕过列表（大小写两种变量都读）并追加本机地址。
 * Node 读取时小写 no_proxy 优先，所以返回值要同时写入两种变量，避免旧的小写列表盖掉合并结果。
 */
export function noProxyWithLocal(env: ProxyEnv): string {
  const entries = [env.no_proxy, env.NO_PROXY, ...LOCAL_NO_PROXY]
    .flatMap((value) => (value ?? "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
  // undici 只在整个值恰好为 "*" 时才全部直连；混进逗号列表里的 "*" 不再有通配含义
  if (entries.includes("*")) return "*";
  return [...new Set(entries)].join(",");
}

/**
 * 把 Chromium 的代理规则（如 "PROXY 127.0.0.1:7890; DIRECT"）转成 Node 可用的代理环境变量。
 * 只取第一条规则：Chromium 按顺序尝试，第一条就是系统期望使用的代理。
 */
export function proxyEnvFromChromiumRules(rules: string, env: ProxyEnv = {}): { env: ProxyEnv; proxy: string } | null | "unsupported" {
  const first = rules.split(";").map((part) => part.trim()).find(Boolean);
  if (!first) return null;
  const [scheme, hostPort] = first.split(/\s+/, 2);
  const kind = scheme.toUpperCase();
  if (kind === "DIRECT") return null;
  if (!hostPort) return null;
  if (kind !== "PROXY" && kind !== "HTTPS") return "unsupported";
  const proxy = `${kind === "HTTPS" ? "https" : "http"}://${hostPort}`;
  if (!URL.canParse(proxy)) return null;
  const noProxy = noProxyWithLocal(env);
  return {
    env: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: noProxy, no_proxy: noProxy },
    proxy,
  };
}

export async function applyNodeRequestProxy(deps: {
  env: ProxyEnv;
  resolveProxy: (url: string) => Promise<string>;
  setGlobalProxyFromEnv: (env: ProxyEnv) => unknown;
}): Promise<NodeRequestProxyResult> {
  if (hasEnvProxy(deps.env)) {
    // 原来没开 NODE_USE_ENV_PROXY 时本机请求一直直连；这里主动启用后也必须保证本机地址仍直连
    const noProxy = noProxyWithLocal(deps.env);
    deps.setGlobalProxyFromEnv({ ...deps.env, NO_PROXY: noProxy, no_proxy: noProxy });
    return { source: "env", proxy: redact(readEnv(deps.env, "HTTPS_PROXY") ?? readEnv(deps.env, "HTTP_PROXY")!) };
  }
  const rules = await deps.resolveProxy(PROXY_PROBE_URL);
  const parsed = proxyEnvFromChromiumRules(rules, deps.env);
  if (parsed === "unsupported") return { source: "unsupported", rules };
  if (!parsed) return { source: "none", rules };
  deps.setGlobalProxyFromEnv(parsed.env);
  return { source: "system", proxy: parsed.proxy, rules };
}

export interface NodeRequestProxyLogger {
  info(message: string): void;
  warn(message: string): void;
}

/**
 * 启动入口：配置代理并记日志，失败不阻断启动。
 * 失败时只记录错误码：Node 对无效代理地址抛出的 ERR_PROXY_INVALID_CONFIG 消息里就是完整代理 URL，
 * 可能带用户名和密码，而 warn 日志会写入 userData/logs，用户排查时可能分享出去。
 */
export async function configureNodeRequestProxy(deps: Parameters<typeof applyNodeRequestProxy>[0] & {
  log: NodeRequestProxyLogger;
}): Promise<void> {
  try {
    const result = await applyNodeRequestProxy(deps);
    if (result.source === "env" || result.source === "system") {
      deps.log.info(`network proxy (${result.source}): ${result.proxy}`);
    } else if (result.source === "unsupported") {
      deps.log.warn(`system proxy not applied to Node requests (only HTTP/HTTPS proxies are supported): ${result.rules}`);
    }
  } catch (error) {
    deps.log.warn(`failed to configure network proxy (${errorCode(error)}); check HTTP(S)_PROXY or the system proxy settings`);
  }
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "unknown error";
}

/** 日志里不输出代理凭据。 */
function redact(proxy: string): string {
  try {
    const url = new URL(proxy);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "";
    }
    return url.toString();
  } catch {
    return "(invalid)";
  }
}
