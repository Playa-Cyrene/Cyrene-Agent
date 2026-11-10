import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry/tool-context";
import { clearFetchUrlCache, fetchUrlTool } from "./fetch-url-tool";

const LIMIT = 512 * 1024;
beforeEach(clearFetchUrlCache);
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function endlessResponse(headers?: Record<string, string>) {
  let bytes = 0;
  const cancel = vi.fn();
  const response = new Response(new ReadableStream<Uint8Array>({
    pull(controller) { bytes += 8192; controller.enqueue(new Uint8Array(8192).fill(65)); },
    cancel,
  }, { highWaterMark: 0 }), { headers });
  return { response, cancel, bytes: () => bytes };
}

describe("fetch_url 响应读取上限", () => {
  it.each([undefined, { "content-length": "1" }, { "content-length": "9999999999" }])("不依赖长度头，达到上限立即取消无限流：%j", async (headers) => {
    const stream = endlessResponse(headers);
    vi.stubGlobal("fetch", vi.fn(async () => stream.response));
    const result = await fetchUrlTool.execute({ url: "https://example.invalid/large", format: "raw" });
    expect(result).toContain("[已截断到 524288 字节]");
    expect(result.endsWith("A".repeat(LIMIT))).toBe(true);
    expect(stream.bytes()).toBe(LIMIT);
    expect(stream.cancel).toHaveBeenCalledOnce();
    expect(stream.response.body?.locked).toBe(false);
  });

  it("README 和元信息都受限，元信息超限不丢弃 README", async () => {
    const readme = endlessResponse();
    const metadata = endlessResponse();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => input.endsWith("/readme") ? readme.response : metadata.response));
    const result = await fetchUrlTool.execute({ url: "https://github.com/example/project" });
    expect(result).toContain("[README 已截断到 524288 字节]");
    expect(result.endsWith("A".repeat(LIMIT))).toBe(true);
    for (const stream of [readme, metadata]) {
      expect(stream.bytes()).toBe(LIMIT);
      expect(stream.cancel).toHaveBeenCalledOnce();
    }
  });

  it("保留跨块 UTF-8，截断时丢弃半个字符", async () => {
    const data = new TextEncoder().encode("中" + "A".repeat(LIMIT - 4) + "文尾部");
    const response = new Response(new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(data.subarray(0, 1)); c.enqueue(data.subarray(1, 2)); c.enqueue(data.subarray(2)); c.close();
    } }));
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const result = await fetchUrlTool.execute({ url: "https://example.invalid/utf8", format: "raw" });
    expect(result.endsWith("中" + "A".repeat(LIMIT - 4))).toBe(true);
    expect(result).not.toContain("\uFFFD");
  });

  it.each(["abort", "timeout"])("%s 中断等待中的响应且失败不进缓存", async (kind) => {
    if (kind === "timeout") vi.useFakeTimers();
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }));
    const fetched = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetched);
    const ac = new AbortController();
    const pending = fetchUrlTool.execute({ url: "https://example.invalid/stall" }, { signal: ac.signal } as ToolContext);
    await vi.waitFor(() => expect(response.body?.locked).toBe(true));
    if (kind === "abort") ac.abort(new Error("test cancelled"));
    else await vi.advanceTimersByTimeAsync(20_000);
    expect(await pending).toContain("[错误] fetch 失败");
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    fetched.mockImplementation(async () => new Response("retry succeeded"));
    expect(await fetchUrlTool.execute({ url: "https://example.invalid/stall" })).toContain("retry succeeded");
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it("响应流错误不会缓存半截结果", async () => {
    const fetched = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.error(new Error("stream failed")); } })));
    vi.stubGlobal("fetch", fetched);
    expect(await fetchUrlTool.execute({ url: "https://example.invalid/error" })).toContain("stream failed");
    fetched.mockImplementation(async () => new Response("retry"));
    expect(await fetchUrlTool.execute({ url: "https://example.invalid/error" })).toContain("retry");
    expect(fetched).toHaveBeenCalledTimes(2);
  });

  it.each([0, LIMIT - 1, LIMIT])("正确处理空体和边界长度 %i", async (size) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("B".repeat(size))));
    const result = await fetchUrlTool.execute({ url: "https://example.invalid/boundary", format: "raw" });
    expect(result.endsWith("B".repeat(size))).toBe(true);
    expect(result.includes("已截断")).toBe(size === LIMIT);
  });

  it("真实 HTTP 大响应在下载完成前断开，压缩体按解压后字节限制", async () => {
    const total = 8 * 1024 * 1024;
    let sent = 0;
    let closed!: () => void;
    const disconnected = new Promise<void>((resolve) => { closed = resolve; });
    const server = createServer((req, res) => {
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(gzipSync(Buffer.alloc(total, 67)));
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      const timer = setInterval(() => {
        sent += 64 * 1024;
        res.write(Buffer.alloc(64 * 1024, 68));
        if (sent >= total) { clearInterval(timer); res.end(); }
      }, 1);
      res.once("close", () => { clearInterval(timer); closed(); });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing port");
    try {
      const url = `http://127.0.0.1:${address.port}`;
      const result = await fetchUrlTool.execute({ url, format: "raw" });
      await disconnected;
      expect(result.endsWith("D".repeat(LIMIT))).toBe(true);
      expect(sent).toBeLessThan(total);
      const compressed = await fetchUrlTool.execute({ url: url + "/gzip", format: "raw" });
      expect(compressed.endsWith("C".repeat(LIMIT))).toBe(true);
      expect(compressed).toContain("已截断");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
