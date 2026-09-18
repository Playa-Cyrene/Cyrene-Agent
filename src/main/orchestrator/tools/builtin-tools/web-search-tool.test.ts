// web_search 工具缓存行为测试：同一查询 30 分钟内直接复用并标注新鲜度，
// 失败结果不进缓存。全部用 stub 的 fetch 桩，不发真实网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWebSearchCache, setSearchConfig, webSearchTool } from "./web-search-tool";

/** 构造博查 API 形状的 fetch 桩 */
function makeBochaResp(results: Array<{ name: string; url: string; snippet: string }>): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ webPages: { value: results } }),
  } as unknown as Response;
}

beforeEach(() => {
  clearWebSearchCache();
  setSearchConfig(() => "bocha", () => "test-key", () => "tavily-key", () => "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("web_search 结果缓存", () => {
  it("同一查询两次只搜一次，第二次带 cached/cachedAt 标注", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([
      { name: "结果一", url: "https://example.com/1", snippet: "摘要一" },
    ]));
    vi.stubGlobal("fetch", fetchMock);

    const first = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(first.cached).toBeUndefined();
    expect(first.resultCount).toBe(1);

    const second = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
    expect(typeof second.cachedAt).toBe("string");
    expect(second.resultCount).toBe(1);
  });

  it("不同查询各自请求", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "AI 新闻" });
    await webSearchTool.execute({ query: "游戏热点" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("关键词空白差异视为同一查询（压空白后同 key）", async () => {
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "AI  新闻" });
    const second = JSON.parse(await webSearchTool.execute({ query: "AI 新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.cached).toBe(true);
  });

  it("搜索失败不进缓存：第一次报错，第二次成功则正常返回", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) return { ok: false, status: 500, statusText: "Server Error" } as unknown as Response;
      return makeBochaResp([{ name: "恢复结果", url: "https://example.com/ok", snippet: "ok" }]);
    }));

    await expect(webSearchTool.execute({ query: "股价" })).rejects.toThrow("搜索失败");

    fail = false;
    const second = JSON.parse(await webSearchTool.execute({ query: "股价" })) as Record<string, unknown>;
    expect(second.cached).toBeUndefined();
    expect(second.resultCount).toBe(1);
  });

  it("超过 30 分钟缓存过期，重新搜索", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => makeBochaResp([]));
    vi.stubGlobal("fetch", fetchMock);

    await webSearchTool.execute({ query: "今日新闻" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(31 * 60_000);
    const second = JSON.parse(await webSearchTool.execute({ query: "今日新闻" })) as Record<string, unknown>;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(second.cached).toBeUndefined();
  });
});
