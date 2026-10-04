import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { MAX_REFERENCE_BYTES, downloadReferenceImage, prepareReferenceImages, normalizeReferenceImages, isPublicAddress } = require("../lib/reference-images.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const url = "https://images.example.com/reference.png";
const publicIp = { address: "93.184.215.14", family: 4 };

type Hop = { status?: number; headers?: Record<string, string>; chunks?: Buffer[]; stall?: boolean; error?: boolean };
function transport(hops: Hop[] = [{}]) {
  const responses: PassThrough[] = [];
  const requests: Array<EventEmitter & { end: () => void; destroy: ReturnType<typeof vi.fn> }> = [];
  const lookupImpl = vi.fn(async (_hostname: string, _options: unknown) => [publicIp]);
  const requestImpl = vi.fn((target: URL, options, callback) => {
    const hop = hops[requests.length] ?? {};
    const response = Object.assign(new PassThrough(), {
      statusCode: hop.status ?? 200,
      headers: hop.headers ?? { "content-type": "image/png" },
    });
    responses.push(response);
    const request = Object.assign(new EventEmitter(), {
      end: () => queueMicrotask(() => {
        callback(response);
        if (hop.error) { response.destroy(new Error("network error with private details")); return; }
        if (hop.stall || response.destroyed) return;
        for (const chunk of hop.chunks ?? [png]) if (!response.destroyed) response.write(chunk);
        if (!response.destroyed) response.end();
      }),
      destroy: vi.fn(() => response.destroy()),
    });
    requests.push(request);
    return request;
  });
  return { lookupImpl, requestImpl, responses, requests };
}

describe("safe subscription reference downloads", () => {
  it("pins a public DNS result and sends no credentials or pooled connections", async () => {
    const t = transport();
    expect(await downloadReferenceImage(url, t)).toEqual(png);
    const [target, options] = t.requestImpl.mock.calls[0];
    expect(target.hostname).toBe("images.example.com");
    expect(options).toMatchObject({ method: "GET", agent: false, autoSelectFamily: false });
    expect(Object.keys(options.headers).sort()).toEqual(["Accept", "Accept-Encoding", "User-Agent"]);
    expect(options.headers["Accept-Encoding"]).toBe("identity");
    const callback = vi.fn();
    options.lookup(target.hostname, {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, publicIp.address, 4);
    options.lookup(target.hostname, { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [publicIp]);
    options.lookup("other.example.com", {}, callback);
    expect(callback.mock.lastCall?.[0]).toBeInstanceOf(Error);
    expect(t.lookupImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    "0.0.0.0", "10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.100.100.200", "100.127.255.255", "192.0.0.1", "192.0.2.1", "192.88.99.1", "198.18.0.1", "198.19.255.255",
    "198.51.100.2", "203.0.113.1", "224.0.0.1", "255.255.255.255", "168.63.129.16",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "ff02::1", "64:ff9b::a00:1",
    "2001::1", "2001:100::1", "2001:db8::1", "2002:7f00:1::1", "3fff::1", "fe80::1%eth0", "not-an-ip",
  ])("blocks non-public DNS address %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(["8.8.8.8", "93.184.215.14", "100.128.0.1", "172.32.0.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])("accepts public address %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    "http://images.example.com/a.png", "https://127.0.0.1/a.png", "https://2130706433/a.png", "https://[::1]/a.png",
    "https://user:password@images.example.com/a.png", "https://images.example.com:8443/a.png", "https://image.local/a.png",
    "https://image.internal/a.png", "https://image.lan/a.png", "file:///C:/private.png", "https://images.example.com/with space.png",
  ])("rejects unsafe URL %s before any DNS/network activity", async (value) => {
    const t = transport();
    await expect(downloadReferenceImage(value, t)).rejects.toThrow("公网 HTTPS");
    expect(t.lookupImpl).not.toHaveBeenCalled();
    expect(t.requestImpl).not.toHaveBeenCalled();
  });

  it("blocks a public-looking domain with mixed private/public DNS results", async () => {
    const t = transport();
    t.lookupImpl.mockResolvedValueOnce([publicIp, { address: "127.0.0.1", family: 4 }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("内网或保留地址");
    expect(t.requestImpl).not.toHaveBeenCalled();
  });
  it("blocks IPv6-mapped private DNS results", async () => {
    const t = transport();
    t.lookupImpl.mockResolvedValueOnce([{ address: "::ffff:10.0.0.1", family: 6 }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("内网或保留地址");
    expect(t.requestImpl).not.toHaveBeenCalled();
  });
  it("verifies a proxy Fake-IP independently and pins the real CDN address, not 198.18/15", async () => {
    const answer = { Status: 0, Question: [{ name: "images.example.com.", type: 1 }], Answer: [{ type: 1, data: publicIp.address }] };
    const t = transport([{ headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from(JSON.stringify(answer))] }, {}]);
    t.lookupImpl.mockResolvedValueOnce([{ address: "198.18.0.100", family: 4 }]);
    expect(await downloadReferenceImage(`${url}?private-query=not-for-dns`, t)).toEqual(png);
    const [dnsUrl, dnsOptions] = t.requestImpl.mock.calls[0];
    expect(dnsUrl.hostname).toBe("cloudflare-dns.com");
    expect(dnsUrl.searchParams.get("name")).toBe("images.example.com");
    expect(dnsUrl.href).not.toContain("private-query");
    expect(dnsOptions.headers.Accept).toBe("application/dns-json");
    const callback = vi.fn();
    dnsOptions.lookup(dnsUrl.hostname, {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "1.1.1.1", 4);
    const [cdnUrl, cdnOptions] = t.requestImpl.mock.calls[1];
    cdnOptions.lookup(cdnUrl.hostname, {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, publicIp.address, 4);
  });
  it.each(["127.0.0.1", "198.18.0.100", "169.254.169.254"])("never permits Fake-IP fallback to non-public result %s", async (address) => {
    const answer = { Status: 0, Question: [{ name: "images.example.com.", type: 1 }], Answer: [{ type: 1, data: address }] };
    const t = transport([{ headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from(JSON.stringify(answer))] }]);
    t.lookupImpl.mockResolvedValueOnce([{ address: "198.18.0.100", family: 4 }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("内网或保留地址");
    expect(t.requestImpl).toHaveBeenCalledTimes(1);
  });
  it("does not override mixed private/public DNS, and rejects invalid, redirected, or oversized DoH responses", async () => {
    const mixed = transport();
    mixed.lookupImpl.mockResolvedValueOnce([publicIp, { address: "198.18.0.100", family: 4 }]);
    await expect(downloadReferenceImage(url, mixed)).rejects.toThrow("内网或保留地址");
    expect(mixed.requestImpl).not.toHaveBeenCalled();
    for (const hop of [
      { status: 302, headers: { location: "https://other.example.com/dns" } },
      { headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from("{}")] },
      { headers: { "content-type": "application/dns-json" }, chunks: [Buffer.alloc(32 * 1024 + 1)] },
      { headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from(JSON.stringify({ Status: 0, Question: [{ name: "other.example.com.", type: 1 }], Answer: [{ type: 1, data: publicIp.address }] }))] },
    ]) {
      const t = transport([hop]); t.lookupImpl.mockResolvedValueOnce([{ address: "198.18.0.100", family: 4 }]);
      await expect(downloadReferenceImage(url, t)).rejects.toThrow("公网核验失败");
      expect(t.requestImpl).toHaveBeenCalledTimes(1);
    }
  });
  it("can verify an IPv6-only public DNS response behind a Fake-IP proxy", async () => {
    const ipv6 = "2606:4700:4700::1111";
    const t = transport([
      { headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from(JSON.stringify({ Status: 0, Question: [{ name: "images.example.com.", type: 1 }], Answer: [] }))] },
      { headers: { "content-type": "application/dns-json" }, chunks: [Buffer.from(JSON.stringify({ Status: 0, Question: [{ name: "images.example.com.", type: 28 }], Answer: [{ type: 28, data: ipv6 }] }))] }, {},
    ]);
    t.lookupImpl.mockResolvedValueOnce([{ address: "198.18.0.100", family: 4 }]);
    expect(await downloadReferenceImage(url, t)).toEqual(png);
    const [target, options] = t.requestImpl.mock.calls[2];
    const callback = vi.fn(); options.lookup(target.hostname, {}, callback);
    expect(callback).toHaveBeenCalledWith(null, ipv6, 6);
  });
  it("follows public redirects with a fresh pinned DNS lookup per hop", async () => {
    const t = transport([{ status: 302, headers: { location: "https://cdn.example.com/image.png" } }, { status: 307, headers: { location: "/final.png" } }, {}]);
    expect(await downloadReferenceImage(url, t)).toEqual(png);
    expect(t.lookupImpl.mock.calls.map((call) => call[0])).toEqual(["images.example.com", "cdn.example.com", "cdn.example.com"]);
    expect(t.requestImpl.mock.calls[2][0].href).toBe("https://cdn.example.com/final.png");
    expect(t.responses.slice(0, 2).every((response) => response.destroyed)).toBe(true);
  });
  it.each(["https://127.0.0.1/private.png", "http://cdn.example.com/a.png", "https://user:secret@cdn.example.com/a.png"])("blocks unsafe redirect %s", async (location) => {
    const t = transport([{ status: 302, headers: { location } }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("已拦截");
    expect(t.requestImpl).toHaveBeenCalledTimes(1);
  });
  it("blocks a redirect whose domain resolves to a private address", async () => {
    const t = transport([{ status: 302, headers: { location: "https://cdn.example.com/a.png" } }]);
    t.lookupImpl.mockResolvedValueOnce([publicIp]).mockResolvedValueOnce([{ address: "10.1.2.3", family: 4 }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("内网或保留地址");
    expect(t.requestImpl).toHaveBeenCalledTimes(1);
  });
  it("limits redirect chains and rejects a missing redirect target", async () => {
    const t = transport(Array.from({ length: 4 }, () => ({ status: 302, headers: { location: "/next.png" } })));
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("跳转次数过多");
    expect(t.requestImpl).toHaveBeenCalledTimes(4);
    await expect(downloadReferenceImage(url, transport([{ status: 302, headers: {} }]))).rejects.toThrow("缺少有效目标");
  });
  it.each([403, 404, 429, 500])("reports HTTP %s without generating", async (status) => {
    const t = transport([{ status }]);
    await expect(downloadReferenceImage(url, t)).rejects.toThrow(`HTTP ${status}`);
    expect(t.responses[0].destroyed).toBe(true);
  });
  it("rejects HTML, MIME mismatch, and spoofed image bodies", async () => {
    await expect(downloadReferenceImage(url, transport([{ headers: { "content-type": "text/html" } }]))).rejects.toThrow("网页或登录页");
    await expect(downloadReferenceImage(url, transport([{ headers: { "content-type": "image/jpeg" } }]))).rejects.toThrow("响应类型不匹配");
    await expect(downloadReferenceImage(url, transport([{ chunks: [Buffer.from("<html>not an image</html>")] }]))).rejects.toThrow("不是 PNG");
  });
  it("accepts actual image bytes with an octet-stream or missing MIME header", async () => {
    expect(await downloadReferenceImage(url, transport([{ headers: { "content-type": "application/octet-stream" } }]))).toEqual(png);
    expect(await downloadReferenceImage(url, transport([{ headers: {} }]))).toEqual(png);
  });
  it("rejects large declared or streamed content and compressed transfer", async () => {
    const declared = transport([{ headers: { "content-length": String(MAX_REFERENCE_BYTES + 1) } }]);
    await expect(downloadReferenceImage(url, declared)).rejects.toThrow("10 MiB");
    expect(declared.responses[0].destroyed).toBe(true);
    const streaming = transport([{ chunks: [png, Buffer.alloc(MAX_REFERENCE_BYTES)] }]);
    await expect(downloadReferenceImage(url, streaming)).rejects.toThrow("10 MiB");
    expect(streaming.requests[0].destroy).toHaveBeenCalled();
    await expect(downloadReferenceImage(url, transport([{ headers: { "content-encoding": "gzip" } }]))).rejects.toThrow("压缩传输");
  });
  it("rejects incomplete downloads and sanitizes transport errors", async () => {
    await expect(downloadReferenceImage(url, transport([{ headers: { "content-length": String(png.length + 5) } }]))).rejects.toThrow("下载不完整");
    await expect(downloadReferenceImage(url, transport([{ error: true }]))).rejects.toThrow("参考图传输中断");
    const t = transport(); t.lookupImpl.mockRejectedValueOnce(new Error("private DNS diagnostic"));
    await expect(downloadReferenceImage(url, t)).rejects.toThrow("参考图域名解析失败");
  });
  it("honors cancellation before DNS, during DNS, and during body transfer", async () => {
    const controller = new AbortController(); controller.abort();
    const t = transport();
    await expect(downloadReferenceImage(url, { ...t, signal: controller.signal })).rejects.toThrow("已取消");
    expect(t.lookupImpl).not.toHaveBeenCalled();
    const resolving = transport();
    resolving.lookupImpl.mockImplementationOnce(() => new Promise(() => {}));
    const second = new AbortController();
    const dnsTask = downloadReferenceImage(url, { ...resolving, signal: second.signal });
    second.abort();
    await expect(dnsTask).rejects.toThrow("已取消");
    expect(resolving.requestImpl).not.toHaveBeenCalled();
    const stalled = transport([{ stall: true }]);
    const third = new AbortController();
    const bodyTask = downloadReferenceImage(url, { ...stalled, signal: third.signal });
    await vi.waitFor(() => expect(stalled.requestImpl).toHaveBeenCalledTimes(1));
    third.abort();
    await expect(bodyTask).rejects.toThrow("已取消");
    expect(stalled.requests[0].destroy).toHaveBeenCalled();
  });
  it("times out stalled DNS and body transfers without leaving a request running", async () => {
    const t = transport([{ stall: true }]);
    await expect(downloadReferenceImage(url, { ...t, timeoutMs: 10 })).rejects.toThrow("下载超时");
    expect(t.requests[0].destroy).toHaveBeenCalled();
    const resolving = transport();
    resolving.lookupImpl.mockImplementationOnce(() => new Promise(() => {}));
    await expect(downloadReferenceImage(url, { ...resolving, timeoutMs: 10 })).rejects.toThrow("下载超时");
    expect(resolving.requestImpl).not.toHaveBeenCalled();
  });
});

describe("reference-image preparation", () => {
  it("inlines a >900 KiB reference without recompressing its original bytes", async () => {
    const largePng = Buffer.concat([png, Buffer.alloc(1024 * 1024)]);
    const downloadImpl = vi.fn(async () => largePng);
    const onProgress = vi.fn();
    const [result] = await prepareReferenceImages([url], { downloadImpl, onProgress });
    expect(Buffer.from(result.split(",")[1], "base64")).toEqual(largePng);
    expect(result).not.toContain("https://");
    expect(onProgress.mock.calls.flat().join(" ")).toContain("无需上游下载外链");
  });
  it("keeps current image attachments and coalesces repeated URLs within one request", async () => {
    const downloadImpl = vi.fn(async () => png);
    expect(await prepareReferenceImages([dataUrl, url, url], { downloadImpl })).toEqual([dataUrl, dataUrl, dataUrl]);
    expect(downloadImpl).toHaveBeenCalledTimes(1);
    expect(normalizeReferenceImages([dataUrl])).toEqual([dataUrl]);
  });
  it("rejects invalid inline data, MIME mismatches, oversized data, and more than three references", () => {
    expect(() => normalizeReferenceImages(["data:image/png;base64,AAAA"])).toThrow("不是 PNG");
    expect(() => normalizeReferenceImages([dataUrl.replace("image/png", "image/jpeg")])).toThrow("不匹配");
    expect(() => normalizeReferenceImages([dataUrl.slice(0, -1)])).toThrow("图片编码无效");
    expect(() => normalizeReferenceImages([`data:image/png;base64,${"A".repeat(14 * 1024 * 1024)}`])).toThrow("10 MiB");
    expect(() => normalizeReferenceImages([url, url, url, url])).toThrow("最多提供 3");
  });
  it("marks preflight failure as not started and never silently drops a reference", async () => {
    const downloadImpl = vi.fn().mockRejectedValue(new Error("参考图下载超时"));
    await expect(prepareReferenceImages([url], { downloadImpl })).rejects.toMatchObject({ generationNotStarted: true });
    await expect(prepareReferenceImages([url], { downloadImpl })).rejects.toThrow("未丢弃参考图");
  });
  it("does not fail generation preparation when the progress observer throws", async () => {
    expect(await prepareReferenceImages([url], { downloadImpl: async () => png, onProgress: () => { throw new Error("UI error"); } })).toEqual([dataUrl]);
  });
});
