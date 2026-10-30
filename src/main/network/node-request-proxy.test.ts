import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyNodeRequestProxy, configureNodeRequestProxy, hasEnvProxy, noProxyWithLocal, PROXY_PROBE_URL, proxyEnvFromChromiumRules } from "./node-request-proxy";

describe("Chromium 代理规则转换", () => {
  it("PROXY 规则 → HTTP/HTTPS 代理，且本机地址直连", () => {
    expect(proxyEnvFromChromiumRules("PROXY 127.0.0.1:7890; DIRECT")).toEqual({
      env: { HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1,[::1],::1", no_proxy: "localhost,127.0.0.1,[::1],::1" },
      proxy: "http://127.0.0.1:7890",
    });
  });

  it("HTTPS 规则使用 https 代理地址，用户已有的 NO_PROXY 保留", () => {
    expect(proxyEnvFromChromiumRules("HTTPS proxy.example.com:443", { NO_PROXY: "corp.example.com" })).toEqual({
      env: {
        HTTP_PROXY: "https://proxy.example.com:443",
        HTTPS_PROXY: "https://proxy.example.com:443",
        NO_PROXY: "corp.example.com,localhost,127.0.0.1,[::1],::1",
        no_proxy: "corp.example.com,localhost,127.0.0.1,[::1],::1",
      },
      proxy: "https://proxy.example.com:443",
    });
  });

  it.each(["DIRECT", "", "  ;  "])("直连或空规则 %j → 不使用代理", (rules) => {
    expect(proxyEnvFromChromiumRules(rules)).toBeNull();
  });

  it("合并大小写两种绕过列表并去重，本机地址含 fetch 使用的 [::1]", () => {
    expect(noProxyWithLocal({ no_proxy: "a.example.com, localhost", NO_PROXY: "b.example.com,a.example.com" }))
      .toBe("a.example.com,localhost,b.example.com,127.0.0.1,[::1],::1");
  });

  it.each([
    [{ NO_PROXY: "*" }],
    [{ no_proxy: "*" }],
    [{ no_proxy: "corp.example.com, *" }],
  ])("绕过列表含独立的 * %j → 保持 *（全部直连），不追加本机地址", (env) => {
    expect(noProxyWithLocal(env)).toBe("*");
  });

  it.each(["SOCKS5 127.0.0.1:7891", "SOCKS 127.0.0.1:1080; DIRECT"])("只有 SOCKS 代理 %j → 不支持，不改动", (rules) => {
    expect(proxyEnvFromChromiumRules(rules)).toBe("unsupported");
  });
});

describe("启动时为 Node 请求配置代理", () => {
  it.each([
    [{ HTTPS_PROXY: "http://127.0.0.1:7890" }],
    [{ http_proxy: "http://127.0.0.1:7890" }],
  ])("已设置代理环境变量 %j → 直接使用（追加本机绕过），不查询系统代理", async (env) => {
    const resolveProxy = vi.fn(async () => "PROXY 10.0.0.1:8080");
    const setGlobalProxyFromEnv = vi.fn();
    const result = await applyNodeRequestProxy({ env, resolveProxy, setGlobalProxyFromEnv });
    expect(result).toMatchObject({ source: "env", proxy: "http://127.0.0.1:7890/" });
    expect(setGlobalProxyFromEnv).toHaveBeenCalledWith({ ...env, NO_PROXY: "localhost,127.0.0.1,[::1],::1", no_proxy: "localhost,127.0.0.1,[::1],::1" });
    expect(resolveProxy).not.toHaveBeenCalled();
  });

  it("没有环境变量时按系统代理设置（全局代理工具只设系统代理的常见情况）", async () => {
    const resolveProxy = vi.fn(async () => "PROXY 127.0.0.1:7890");
    const setGlobalProxyFromEnv = vi.fn();
    const result = await applyNodeRequestProxy({ env: {}, resolveProxy, setGlobalProxyFromEnv });
    expect(resolveProxy).toHaveBeenCalledWith(PROXY_PROBE_URL);
    expect(result).toMatchObject({ source: "system", proxy: "http://127.0.0.1:7890" });
    expect(setGlobalProxyFromEnv).toHaveBeenCalledWith(expect.objectContaining({ HTTPS_PROXY: "http://127.0.0.1:7890" }));
  });

  it("系统直连或只有 SOCKS 代理时不改动全局设置", async () => {
    const setGlobalProxyFromEnv = vi.fn();
    expect((await applyNodeRequestProxy({ env: {}, resolveProxy: async () => "DIRECT", setGlobalProxyFromEnv })).source).toBe("none");
    expect((await applyNodeRequestProxy({ env: {}, resolveProxy: async () => "SOCKS5 127.0.0.1:7891", setGlobalProxyFromEnv })).source).toBe("unsupported");
    expect(setGlobalProxyFromEnv).not.toHaveBeenCalled();
  });

  it("日志用的代理地址不含凭据", async () => {
    const result = await applyNodeRequestProxy({
      env: { HTTPS_PROXY: "http://user:secret@127.0.0.1:7890" },
      resolveProxy: async () => "DIRECT",
      setGlobalProxyFromEnv: vi.fn(),
    });
    expect(result.proxy).not.toContain("secret");
  });

  it("hasEnvProxy 忽略空白值", () => {
    expect(hasEnvProxy({ HTTPS_PROXY: "  " })).toBe(false);
    expect(hasEnvProxy({ HTTP_PROXY: "http://127.0.0.1:7890" })).toBe(true);
  });
});

describe("真实的 http.setGlobalProxyFromEnv：全局 fetch 的代理与本机直连", () => {
  const servers: http.Server[] = [];
  let restore: (() => void) | undefined;
  let proxied: string[] = [];

  afterEach(async () => {
    restore?.();
    restore = undefined;
    proxied = [];
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const listen = (server: http.Server, host = "127.0.0.1") => new Promise<number>((resolve) => {
    servers.push(server);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });

  /** 最小的 HTTP 代理：undici 对 http 目标也走 CONNECT 隧道，隧道建立后直接扮演目标服务器回响应。 */
  async function startProxy(): Promise<number> {
    const proxyServer = http.createServer((_req, res) => res.end());
    proxyServer.on("connect", (req, socket) => {
      proxied.push(req.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia-proxy",
      ));
    });
    return listen(proxyServer);
  }

  /** 本机「模型服务」：直连时返回 DIRECT。 */
  const startLocalService = (host: string) => listen(http.createServer((_req, res) => res.end("DIRECT")), host);

  const fetchText = (url: string) => fetch(url, { signal: AbortSignal.timeout(4000) }).then((response) => response.text());

  /**
   * IPv6 回环请求：直连成功返回 "DIRECT"；所在环境禁止 IPv6 回环连接时返回连接错误码。
   * 两种结果都说明请求没有交给代理——走代理时会得到 "via-proxy"，代理也会记录 CONNECT [::1]。
   */
  const fetchIpv6 = (url: string) => fetchText(url).catch((error: { cause?: { code?: string } }) => error.cause?.code ?? "fetch-error");

  it("按系统代理规则设置后，境外请求先到达代理服务器", async () => {
    const proxyPort = await startProxy();
    const result = await applyNodeRequestProxy({
      env: {},
      resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
    });
    expect(result.source).toBe("system");

    // 用一个不存在的境外主机名：只有经过代理才可能拿到响应
    expect(await fetchText("http://generativelanguage.example.invalid/v1/models")).toBe("via-proxy");
    expect(proxied).toEqual(["generativelanguage.example.invalid:80"]);
  });

  it("系统代理分支：IPv4 与 IPv6 回环上的本机服务仍直连", async () => {
    const proxyPort = await startProxy();
    const v4 = await startLocalService("127.0.0.1");
    const v6 = await startLocalService("::1");
    await applyNodeRequestProxy({
      env: {},
      resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
    });

    expect(await fetchText(`http://127.0.0.1:${v4}/api/tags`)).toBe("DIRECT");
    expect(await fetchIpv6(`http://[::1]:${v6}/api/tags`)).not.toBe("via-proxy");
    expect(await fetchText(`http://localhost:${v4}/api/tags`)).toBe("DIRECT");
    expect(proxied).toEqual([]);
  });

  it.each([
    ["环境变量分支", (proxy: string) => ({ HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NO_PROXY: "*" }), "DIRECT"],
    ["系统代理分支", () => ({ no_proxy: "*" }), "PROXY"],
  ] as const)("%s：用户设置 NO_PROXY=* 时，全局 fetch 全部直连（含不在内置列表里的地址）", async (_label, envOf, rule) => {
    const proxyPort = await startProxy();
    // 127.0.0.2 不在内置本机列表里，只有通配 * 才会让它直连
    const target = await startLocalService("127.0.0.2");
    await applyNodeRequestProxy({
      env: envOf(`http://127.0.0.1:${proxyPort}`),
      resolveProxy: async () => (rule === "PROXY" ? `PROXY 127.0.0.1:${proxyPort}` : "DIRECT"),
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
    });

    expect(await fetchText(`http://127.0.0.2:${target}/v1/models`)).toBe("DIRECT");
    expect(proxied).toEqual([]);
  });

  it("配置失败的日志不含代理用户名和密码（真实 setGlobalProxyFromEnv 抛出含完整 URL 的错误）", async () => {
    const info = vi.fn();
    const warn = vi.fn();
    await configureNodeRequestProxy({
      env: { HTTPS_PROXY: "http://review-user:review-test-password@127.0.0.1:99999" },
      resolveProxy: async () => "DIRECT",
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
      log: { info, warn },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = [...info.mock.calls, ...warn.mock.calls].flat().join("\n");
    expect(logged).toContain("ERR_PROXY_INVALID_CONFIG");
    expect(logged).not.toContain("review-test-password");
    expect(logged).not.toContain("review-user");
  });

  it("配置成功的日志同样不含代理凭据", async () => {
    const proxyPort = await startProxy();
    const info = vi.fn();
    await configureNodeRequestProxy({
      env: { HTTPS_PROXY: `http://review-user:review-test-password@127.0.0.1:${proxyPort}` },
      resolveProxy: async () => "DIRECT",
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
      log: { info, warn: vi.fn() },
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls.flat().join("\n")).not.toContain("review-test-password");
  });

  it("环境变量分支：只设 HTTP(S)_PROXY、绕过列表只有公司域名时，本机服务仍直连，境外请求走代理", async () => {
    const proxyPort = await startProxy();
    const v4 = await startLocalService("127.0.0.1");
    const v6 = await startLocalService("::1");
    const proxy = `http://127.0.0.1:${proxyPort}`;
    await applyNodeRequestProxy({
      // 小写 no_proxy 在 Node 中优先：确认它不会盖掉追加的本机地址
      env: { HTTP_PROXY: proxy, HTTPS_PROXY: proxy, no_proxy: "corp.example.com" },
      resolveProxy: async () => "DIRECT",
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
    });

    expect(await fetchText(`http://127.0.0.1:${v4}/api/tags`)).toBe("DIRECT");
    expect(await fetchIpv6(`http://[::1]:${v6}/api/tags`)).not.toBe("via-proxy");
    expect(await fetchText("http://generativelanguage.example.invalid/v1/models")).toBe("via-proxy");
    expect(proxied).toEqual(["generativelanguage.example.invalid:80"]);
  });
});
