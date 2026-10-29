import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyNodeRequestProxy, hasEnvProxy, PROXY_PROBE_URL, proxyEnvFromChromiumRules } from "./node-request-proxy";

describe("Chromium 代理规则转换", () => {
  it("PROXY 规则 → HTTP/HTTPS 代理，且本机地址直连", () => {
    expect(proxyEnvFromChromiumRules("PROXY 127.0.0.1:7890; DIRECT")).toEqual({
      env: { HTTP_PROXY: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1,::1" },
      proxy: "http://127.0.0.1:7890",
    });
  });

  it("HTTPS 规则使用 https 代理地址，用户已有的 NO_PROXY 保留", () => {
    expect(proxyEnvFromChromiumRules("HTTPS proxy.example.com:443", "corp.example.com")).toEqual({
      env: {
        HTTP_PROXY: "https://proxy.example.com:443",
        HTTPS_PROXY: "https://proxy.example.com:443",
        NO_PROXY: "corp.example.com,localhost,127.0.0.1,::1",
      },
      proxy: "https://proxy.example.com:443",
    });
  });

  it.each(["DIRECT", "", "  ;  "])("直连或空规则 %j → 不使用代理", (rules) => {
    expect(proxyEnvFromChromiumRules(rules)).toBeNull();
  });

  it.each(["SOCKS5 127.0.0.1:7891", "SOCKS 127.0.0.1:1080; DIRECT"])("只有 SOCKS 代理 %j → 不支持，不改动", (rules) => {
    expect(proxyEnvFromChromiumRules(rules)).toBe("unsupported");
  });
});

describe("启动时为 Node 请求配置代理", () => {
  it.each([
    [{ HTTPS_PROXY: "http://127.0.0.1:7890" }],
    [{ http_proxy: "http://127.0.0.1:7890" }],
  ])("已设置代理环境变量 %j → 直接使用，不查询系统代理", async (env) => {
    const resolveProxy = vi.fn(async () => "PROXY 10.0.0.1:8080");
    const setGlobalProxyFromEnv = vi.fn();
    const result = await applyNodeRequestProxy({ env, resolveProxy, setGlobalProxyFromEnv });
    expect(result).toMatchObject({ source: "env", proxy: "http://127.0.0.1:7890/" });
    expect(setGlobalProxyFromEnv).toHaveBeenCalledWith(env);
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

describe("真实的 http.setGlobalProxyFromEnv：全局 fetch 经过系统代理", () => {
  const servers: http.Server[] = [];
  let restore: (() => void) | undefined;

  afterEach(async () => {
    restore?.();
    restore = undefined;
    await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
  });

  const listen = (server: http.Server) => new Promise<number>((resolve) => {
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port));
  });

  it("按系统代理规则设置后，fetch 的请求先到达代理服务器", async () => {
    const proxied: string[] = [];
    // 最小的 HTTP 代理：undici 对 http 目标也走 CONNECT 隧道，隧道建立后直接扮演目标服务器回响应
    const proxyServer = http.createServer((_req, res) => res.end());
    proxyServer.on("connect", (req, socket) => {
      proxied.push(req.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => socket.end(
        "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 9\r\nconnection: close\r\n\r\nvia-proxy",
      ));
    });
    const proxyPort = await listen(proxyServer);

    const result = await applyNodeRequestProxy({
      env: {},
      resolveProxy: async () => `PROXY 127.0.0.1:${proxyPort}`,
      setGlobalProxyFromEnv: (env) => { restore = http.setGlobalProxyFromEnv(env); },
    });
    expect(result.source).toBe("system");

    // 用一个不存在的境外主机名：只有经过代理才可能拿到响应
    const response = await fetch("http://generativelanguage.example.invalid/v1/models");
    expect(await response.text()).toBe("via-proxy");
    expect(proxied).toEqual(["generativelanguage.example.invalid:80"]);
  });
});
