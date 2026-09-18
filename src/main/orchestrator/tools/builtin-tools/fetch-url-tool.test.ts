// fetch_url 工具行为测试：正文提取 + GitHub 仓库主页特化。
// 全部用 stub 的 fetch 桩，不发真实网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFetchUrlCache, fetchUrlTool } from "./fetch-url-tool";

/** 构造 fetch Response 形状的桩（工具只用到 ok/status/statusText/headers/arrayBuffer/json） */
function makeResp(opts: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string;
  body?: string;
  json?: unknown;
}): Response {
  const body = opts.body ?? "";
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    statusText: opts.statusText ?? "OK",
    headers: {
      get: (name: string) => (name.toLowerCase() === "content-type" ? opts.contentType ?? "" : null),
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    json: async () => (opts.json !== undefined ? opts.json : JSON.parse(body)),
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// 每个用例清空抓取缓存：多个用例复用同一 URL 但期望不同的桩响应
beforeEach(() => {
  clearFetchUrlCache();
});

describe("GitHub 仓库主页特化", () => {
  it("github.com/{owner}/{repo} 走官方 API：元信息 + README，不抓页面 HTML", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/readme")) {
        return makeResp({ body: "# 项目标题\n\nREADME 正文内容。" });
      }
      if (url.startsWith("https://api.github.com/")) {
        return makeResp({
          json: {
            description: "一个测试仓库",
            stargazers_count: 123,
            forks_count: 45,
            language: "TypeScript",
            default_branch: "master",
            license: { spdx_id: "MIT" },
          },
        });
      }
      return makeResp({ contentType: "text/html", body: "<html><body>页面 HTML</body></html>" });
    }));

    const out = await fetchUrlTool.execute({ url: "https://github.com/foo/bar" });

    // 只应有两次 API 调用，没有对 github.com 页面本身的抓取
    expect(calls).toEqual([
      "https://api.github.com/repos/foo/bar",
      "https://api.github.com/repos/foo/bar/readme",
    ]);
    expect(out).toContain("来源: GitHub API（仓库元信息 + README 原文）");
    expect(out).toContain("# foo/bar");
    expect(out).toContain("> 一个测试仓库");
    expect(out).toContain("stars: 123");
    expect(out).toContain("license: MIT");
    expect(out).toContain("README 正文内容");
    expect(out).not.toContain("页面 HTML");
  });

  it(".git 后缀和结尾斜杠也能识别为仓库主页", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return url.endsWith("/readme")
        ? makeResp({ body: "README" })
        : makeResp({ json: { description: "" } });
    }));

    await fetchUrlTool.execute({ url: "https://github.com/foo/bar.git/" });
    expect(calls).toContain("https://api.github.com/repos/foo/bar/readme");
  });

  it("README 接口失败时回退普通网页抓取", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return makeResp({ ok: false, status: 404, statusText: "Not Found" });
      }
      return makeResp({
        contentType: "text/html",
        body: `<html><body><article><p>这是回退后从页面正文提取到的内容，为了超过最小文字量阈值这里需要足够长的文本，重复一次：这是回退后从页面正文提取到的内容，为了超过最小文字量阈值这里需要足够长的文本。</p></article></body></html>`,
      });
    }));

    const out = await fetchUrlTool.execute({ url: "https://github.com/foo/bar" });

    // 第三次调用是对原地址的普通抓取
    expect(calls[2]).toBe("https://github.com/foo/bar");
    expect(out).not.toContain("来源: GitHub API");
    expect(out).toContain("回退后从页面正文提取到的内容");
  });

  it("元信息接口失败但 README 成功时，仍输出 README", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/readme")) return makeResp({ body: "纯 README 内容" });
      return makeResp({ ok: false, status: 403, statusText: "Forbidden" });
    }));

    const out = await fetchUrlTool.execute({ url: "https://github.com/foo/bar" });
    expect(out).toContain("纯 README 内容");
  });

  it("topics 等保留路径不特化，按普通网页抓取", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return makeResp({ contentType: "text/html", body: "<html><body><div>topic 页面</div></body></html>" });
    }));

    await fetchUrlTool.execute({ url: "https://github.com/topics/react" });
    expect(calls).toEqual(["https://github.com/topics/react"]);
  });

  it("仓库子路径（如 /tree/main）不特化，按普通网页抓取", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return makeResp({ contentType: "text/html", body: "<html><body><div>tree 页面</div></body></html>" });
    }));

    await fetchUrlTool.execute({ url: "https://github.com/foo/bar/tree/main/src" });
    expect(calls).toEqual(["https://github.com/foo/bar/tree/main/src"]);
  });

  it("format=raw 时不特化，返回原始 HTML", async () => {
    const calls: string[] = [];
    const rawHtml = "<html><body><article>原始 HTML</article></body></html>";
    vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return makeResp({ contentType: "text/html", body: rawHtml });
    }));

    const out = await fetchUrlTool.execute({ url: "https://github.com/foo/bar", format: "raw" });
    expect(calls).toEqual(["https://github.com/foo/bar"]);
    expect(out).toContain(rawHtml);
  });
});

describe("普通网页正文提取", () => {
  /** 足够长的正文段落（超过最小文字量阈值，避免被判成空壳容器） */
  const longText = "这是一段足够长的正文内容，用来通过正文区域的最小文字量校验。".repeat(8);

  it("剥掉导航/页头/页脚/侧栏，保留 article 正文", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResp({
      contentType: "text/html",
      body: `<html><body>
        <header>站点标题 登录 注册</header>
        <nav>首页 文档 社区</nav>
        <article><h1>正文标题</h1><p>${longText}</p></article>
        <aside>相关推荐 广告</aside>
        <footer>版权所有 备案号</footer>
      </body></html>`,
    })));

    const out = await fetchUrlTool.execute({ url: "https://example.com/post" });

    expect(out).toContain("正文标题");
    expect(out).toContain(longText.slice(0, 20));
    expect(out).not.toContain("登录");
    expect(out).not.toContain("首页");
    expect(out).not.toContain("相关推荐");
    expect(out).not.toContain("版权所有");
  });

  it("article 是空壳时改用 main", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResp({
      contentType: "text/html",
      body: `<html><body>
        <article>小挂件</article>
        <main><h1>主区域标题</h1><p>${longText}</p></main>
      </body></html>`,
    })));

    const out = await fetchUrlTool.execute({ url: "https://example.com/docs" });

    expect(out).toContain("主区域标题");
    expect(out).toContain(longText.slice(0, 20));
    expect(out).not.toContain("小挂件");
  });

  it("没有 article/main 时回退整页（骨架区块仍被剥掉）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResp({
      contentType: "text/html",
      body: `<html><body>
        <nav>导航链接</nav>
        <div><h1>div 里的正文</h1><p>${longText}</p></div>
      </body></html>`,
    })));

    const out = await fetchUrlTool.execute({ url: "https://example.com/page" });

    expect(out).toContain("div 里的正文");
    expect(out).not.toContain("导航链接");
  });

  it("纯文本内容原样返回，不做 HTML 清洗", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => makeResp({
      contentType: "text/plain",
      body: "plain text body",
    })));

    const out = await fetchUrlTool.execute({ url: "https://example.com/a.txt" });
    expect(out).toContain("plain text body");
  });
});

describe("fetch_url 结果缓存", () => {
  it("同一 URL 两次只抓一次，第二次带 [缓存] 标注直接复用", async () => {
    const fetchMock = vi.fn(async () => makeResp({
      contentType: "text/plain",
      body: "cached page body",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const first = await fetchUrlTool.execute({ url: "https://cache-test.example.com/page" });
    expect(first).toContain("cached page body");
    expect(first.startsWith("[缓存]")).toBe(false);

    const second = await fetchUrlTool.execute({ url: "https://cache-test.example.com/page" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.startsWith("[缓存]")).toBe(true);
    expect(second).toContain("cached page body");
  });

  it("同 URL 不同 format 分开缓存", async () => {
    const fetchMock = vi.fn(async () => makeResp({
      contentType: "text/plain",
      body: "raw or md body",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchUrlTool.execute({ url: "https://cache-test.example.com/dual" });
    await fetchUrlTool.execute({ url: "https://cache-test.example.com/dual", format: "raw" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("抓取失败的 [错误] 结果不进缓存", async () => {
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) return makeResp({ ok: false, status: 500, statusText: "Server Error" });
      return makeResp({ contentType: "text/plain", body: "recovered body" });
    }));

    const first = await fetchUrlTool.execute({ url: "https://cache-test.example.com/flaky" });
    expect(first.startsWith("[错误]")).toBe(true);

    fail = false;
    const second = await fetchUrlTool.execute({ url: "https://cache-test.example.com/flaky" });
    expect(second).toContain("recovered body");
    expect(second.startsWith("[缓存]")).toBe(false);
  });
});
