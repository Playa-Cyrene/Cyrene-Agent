import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import {
  NeteaseOpenapiClient,
  buildSignString,
  wrapPkcs8Pem,
} from "./netease-openapi-client";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PK_B64 = privateKey.export({ type: "pkcs8", format: "pem" }).toString().replace(/-----(BEGIN|END) PRIVATE KEY-----|\n/g, "");
const PUB_KEY = publicKey.export({ type: "spki", format: "pem" });

function makeClient(overrides: Partial<ConstructorParameters<typeof NeteaseOpenapiClient>[0]> = {}) {
  const fetchImpl = vi.fn();
  const client = new NeteaseOpenapiClient({
    appId: "app-1",
    privateKey: PK_B64,
    deviceId: "dev-test",
    now: () => 1_700_000_000_000,
    fetchImpl: fetchImpl as unknown as typeof fetch,
    ...overrides,
  });
  return { client, fetchImpl };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Re-derive the canonical sign string from what the client actually sent (GET query). */
function paramsFromGetCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const url = fetchImpl.mock.calls[0][0] as string;
  return Object.fromEntries(new URL(url).searchParams.entries());
}

function paramsFromPostCall(fetchImpl: ReturnType<typeof vi.fn>) {
  const init = fetchImpl.mock.calls[0][1] as RequestInit;
  return JSON.parse(init.body as string) as Record<string, string>;
}

function verifySign(params: Record<string, string>): boolean {
  const { sign, ...rest } = params;
  expect(sign).toBeTruthy();
  const canonical = buildSignString(rest);
  return cryptoVerify("SHA256", Buffer.from(canonical), PUB_KEY, Buffer.from(sign, "base64"));
}

describe("buildSignString", () => {
  it("drops sign/null/undefined/empty values, sorts by key, joins with &", () => {
    expect(
      buildSignString({ sign: "x", b: "2", a: "1", n: null, u: undefined, e: "", c: "3" }),
    ).toBe("a=1&b=2&c=3");
  });
});

describe("wrapPkcs8Pem", () => {
  it("wraps bare base64 into 64-char lines", () => {
    const pem = wrapPkcs8Pem(PK_B64);
    expect(pem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(pem.endsWith("-----END PRIVATE KEY-----")).toBe(true);
  });
  it("passes pre-wrapped PEM through", () => {
    const pem = `-----BEGIN PRIVATE KEY-----\n${PK_B64}\n-----END PRIVATE KEY-----`;
    expect(wrapPkcs8Pem(pem)).toBe(pem);
  });
});

describe("NeteaseOpenapiClient transport", () => {
  it("allows placeholder construction with empty appId/privateKey (lazy config)", () => {
    // MusicService constructs the client with empty appId/privateKey before
    // config is loaded; configure() injects real creds later.
    const placeholder = new NeteaseOpenapiClient({ appId: "", privateKey: "" });
    expect(placeholder).toBeInstanceOf(NeteaseOpenapiClient);
  });

  it("configure() rejects empty appId / privateKey", () => {
    const client = new NeteaseOpenapiClient({ appId: "", privateKey: "" });
    expect(() => client.configure({ appId: "", privateKey: "k" })).toThrow(/E_CONFIG_MISSING/);
    expect(() => client.configure({ appId: "a", privateKey: "" })).toThrow(/E_CONFIG_MISSING/);
  });

  it("request() throws E_CONFIG_MISSING if client was never configured", async () => {
    const client = new NeteaseOpenapiClient({ appId: "", privateKey: "" });
    await expect(client.getUserProfile()).rejects.toThrow(/E_CONFIG_MISSING/);
  });

  it("sends GET with signed params in query and required headers", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { userId: 1 } }));
    await client.getUserProfile();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url).startsWith("https://openapi.music.163.com/openapi/music/basic/user/profile/get/v2?")).toBe(true);
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("ncm-0.1.6");
    expect((init.headers as Record<string, string>).Referer).toBe("https://music.163.com/");

    const params = paramsFromGetCall(fetchImpl) as Record<string, string>;
    expect(params.appId).toBe("app-1");
    expect(params.signType).toBe("RSA_SHA256");
    expect(params.timestamp).toBe("1700000000000");
    expect(JSON.parse(params.device).deviceId).toBe("dev-test");
    expect(JSON.parse(params.bizContent)).toEqual({});
    expect(verifySign(params)).toBe(true);
  });

  it("sends POST with signed params as JSON body", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: {} }));
    await client.addSongsToPlaylist("pl-enc", ["s1", "s2"]);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url).endsWith("/openapi/music/basic/playlist/song/batch/like")).toBe(true);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");

    const params = paramsFromPostCall(fetchImpl);
    expect(JSON.parse(params.bizContent)).toEqual({ playlistId: "pl-enc", songIdList: ["s1", "s2"] });
    expect(verifySign(params)).toBe(true);
  });

  it("includes and signs accessToken when set", async () => {
    const { client, fetchImpl } = makeClient();
    client.setAccessToken("tok-1");
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: [] }));
    await client.getDailyRecommendations();

    const params = paramsFromGetCall(fetchImpl);
    expect(params.accessToken).toBe("tok-1");
    expect(verifySign(params)).toBe(true);
  });

  it("loginAnonymous never carries a stale accessToken (login deadlock fix)", async () => {
    const { client, fetchImpl } = makeClient();
    // 模拟登录死锁现场：client 里残留失效的用户 token
    client.setAccessToken("stale-user-token");
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { accessToken: "anon", refreshToken: "r", expireTime: 86400 } }));

    await client.loginAnonymous();

    const params = paramsFromPostCall(fetchImpl);
    expect(params.accessToken).toBeUndefined();
    expect(verifySign(params)).toBe(true);
  });

  it("throws NeteaseOpenapiError on business error code", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 301, message: "未授权" }));
    await expect(client.searchSongs("k")).rejects.toThrow(/E_OPENAPI_301/);
  });

  it("throws on non-JSON body", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(new Response("<html>", { status: 502 }));
    await expect(client.getUserProfile()).rejects.toThrow(/non-JSON body/);
  });

  it("wraps network failures", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(client.getUserProfile()).rejects.toThrow(/E_OPENAPI_-1.*ECONNREFUSED/);
  });

  it.each([
    "http://openapi.music.163.com",
    "http://127.0.0.1:12345",
    "https://user:secret@openapi.music.163.com",
    "https://openapi.music.163.com/?accessToken=secret",
    "https://openapi.music.163.com/#secret",
    "https://openapi.music.163.com/?",
    "https://openapi.music.163.com/#",
    "not-a-url-secret",
  ])("rejects unsafe base URL before any request: %s", (baseUrl) => {
    const fetchImpl = vi.fn();
    expect(() => makeClient({ baseUrl, fetchImpl: fetchImpl as unknown as typeof fetch }))
      .toThrow(/^E_OPENAPI_BASE_URL_INVALID: credential-free HTTPS endpoint required$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps a custom HTTPS prefix and signed token after lazy configuration", async () => {
    const { client, fetchImpl } = makeClient({ appId: "", privateKey: "", baseUrl: "https://music.example.test/proxy///" });
    client.configure({ appId: "configured-app", privateKey: PK_B64 });
    client.setAccessToken("configured-token");
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { userId: 1 } }));

    await client.getUserProfile();

    const url = new URL(fetchImpl.mock.calls[0][0] as string);
    expect(url.origin).toBe("https://music.example.test");
    expect(url.pathname).toBe("/proxy/openapi/music/basic/user/profile/get/v2");
    const params = Object.fromEntries(url.searchParams);
    expect(params.appId).toBe("configured-app");
    expect(params.accessToken).toBe("configured-token");
    expect(verifySign(params)).toBe(true);
  });

  it.each([301, 302, 303, 307, 308])("rejects redirect response %s without forwarding credentials", async (status) => {
    const { client, fetchImpl } = makeClient();
    client.setAccessToken("user-token");
    fetchImpl.mockResolvedValue(new Response(JSON.stringify({ code: 200, data: {} }), {
      status,
      headers: { Location: "http://other.example.test/?accessToken=user-token" },
    }));

    await expect(client.getUserProfile()).rejects.toThrow(`E_OPENAPI_${status} /openapi/music/basic/user/profile/get/v2: redirects are not allowed`);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
  });
});

describe("NeteaseOpenapiClient endpoint defaults (manifest hidden params)", () => {
  it("searchSongs sends trialScene cli", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { recordCount: 0, records: [] } }));
    await client.searchSongs("晴天", 10, 5);
    const biz = JSON.parse(paramsFromGetCall(fetchImpl).bizContent);
    expect(biz).toEqual({ keyword: "晴天", limit: 10, offset: 5, qualityFlag: false, trialScene: "cli" });
  });

  it("getDailyRecommendations sends trialScene cli", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: [] }));
    await client.getDailyRecommendations();
    expect(JSON.parse(paramsFromGetCall(fetchImpl).bizContent)).toEqual({
      limit: 30,
      qualityFlag: false,
      trialScene: "cli",
    });
  });

  it("getPlaylistSongs uses trialScene tui (NOT cli)", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: [] }));
    await client.getPlaylistSongs("pl");
    expect(JSON.parse(paramsFromGetCall(fetchImpl).bizContent)).toEqual({
      playlistId: "pl",
      limit: 30,
      offset: 0,
      qualityFlag: false,
      trialScene: "tui",
    });
  });

  it("getSongDetail defaults withUrl+bitrate+trialScene", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { name: "x" } }));
    await client.getSongDetail("AB".repeat(16));
    expect(JSON.parse(paramsFromGetCall(fetchImpl).bizContent)).toEqual({
      songId: "AB".repeat(16),
      withUrl: true,
      bitrate: 128,
      trialScene: "cli",
    });
  });

  it("getQrCodeKey sends expiredKey as STRING 300", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { qrCodeUrl: "https://163cn.tv/x", uniKey: "k" } }));
    await client.getQrCodeKey();
    expect(JSON.parse(paramsFromGetCall(fetchImpl).bizContent)).toEqual({ type: 2, expiredKey: "300" });
  });

  it("setSongLike rides the fixed isLike param", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: {} }));
    await client.setSongLike("s", false);
    expect(JSON.parse(paramsFromPostCall(fetchImpl).bizContent)).toEqual({ songId: "s", isLike: false });
  });

  it("getPlaylistDetail sends hidden originalCoverFlag", async () => {
    const { client, fetchImpl } = makeClient();
    fetchImpl.mockResolvedValue(jsonResponse({ code: 200, data: { name: "n" } }));
    await client.getPlaylistDetail("pl");
    expect(JSON.parse(paramsFromGetCall(fetchImpl).bizContent)).toEqual({
      playlistId: "pl",
      originalCoverFlag: false,
    });
  });
});
