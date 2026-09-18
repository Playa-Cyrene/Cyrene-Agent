import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MARKET_ZIP_URL_PREFIXES,
  createPluginMarketplaceService,
  type MarketplaceFetch,
  type PluginMarketplaceDeps,
} from "./plugin-marketplace";

const REGISTRY_URL_A = "https://example.test/registry-a.json";
const REGISTRY_URL_B = "https://example.test/registry-b.json";
const ZIP_URL = `${MARKET_ZIP_URL_PREFIXES[0]}demo-1.0.0.zip`;
const GITEE_ZIP_URL = `${MARKET_ZIP_URL_PREFIXES[1]}demo-1.0.0.zip`;

let tmp = "";

afterEach(() => {
  vi.restoreAllMocks();
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = "";
  }
});

function cacheDir(): string {
  tmp = mkdtempSync(path.join(os.tmpdir(), "cyrene-market-"));
  return path.join(tmp, "cache");
}

function sha256Of(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function registryEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    description: "d",
    author: "a",
    zip: ZIP_URL,
    sha256: "0".repeat(64),
    downloads: 1,
    ...overrides,
  };
}

function registryJson(entries: unknown[], apiVersion = 1) {
  return { apiVersion, updatedAt: "2026-09-07", plugins: entries };
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });
}

function makeDeps(overrides: Partial<PluginMarketplaceDeps> = {}): PluginMarketplaceDeps {
  return {
    registryUrls: [REGISTRY_URL_A, REGISTRY_URL_B],
    zipUrlPrefixes: MARKET_ZIP_URL_PREFIXES,
    cacheDir: cacheDir(),
    installZip: vi.fn(async () => ({ ok: true, plugin: { id: "demo", name: "Demo", version: "1.0.0" }, overview: undefined })),
    ...overrides,
  };
}

describe("listMarket", () => {
  it("成功拉取并按下载量降序排序", async () => {
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        return jsonResponse(registryJson([
          registryEntry({ id: "low", name: "Low", downloads: 1 }),
          registryEntry({ id: "high", name: "High", downloads: 99 }),
        ]));
      }
      return jsonResponse(registryJson([registryEntry()]));
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.plugins.map((p) => p.id)).toEqual(["high", "low"]);
  });

  it("主源失败自动切兜底源", async () => {
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) throw new Error("network down");
      return jsonResponse(registryJson([registryEntry()]));
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.plugins).toHaveLength(1);
  });

  it("返回各源实时死活：优先级最高的可用源为数据源，其余可用源 standby", async () => {
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) return jsonResponse(registryJson([registryEntry()]));
      throw new Error("github down");
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.sources).toEqual([
      { url: REGISTRY_URL_A, ok: true, used: true },
      { url: REGISTRY_URL_B, ok: false, used: false },
    ]);
  });

  it("全部源失败时 sources 仍带回全死状态", async () => {
    const fetchImpl: MarketplaceFetch = async () => {
      throw new Error("network down");
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(false);
    expect(result.sources).toEqual([
      { url: REGISTRY_URL_A, ok: false, used: false },
      { url: REGISTRY_URL_B, ok: false, used: false },
    ]);
  });

  it("全部源失败时返回失败且快照被清空", async () => {
    const fetchImpl: MarketplaceFetch = async () => {
      throw new Error("network down");
    };
    const deps = makeDeps({ fetchImpl });
    const service = createPluginMarketplaceService(deps);
    const failed = await service.listMarket();
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("暂时无法获取插件列表");

    // 之前即使成功过，失败刷新也会清空快照
    const install = await service.installFromMarket("demo");
    expect(install).toMatchObject({ ok: false, error: expect.stringContaining("插件市场信息已失效") });
  });

  it("apiVersion 不兼容时提示版本不受支持", async () => {
    const fetchImpl: MarketplaceFetch = async () => jsonResponse(registryJson([], 2));
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("版本不受当前客户端支持");
  });

  it("重复插件 id 判整源失败", async () => {
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        return jsonResponse(registryJson([registryEntry(), registryEntry()]));
      }
      return jsonResponse(registryJson([registryEntry()]));
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.plugins).toHaveLength(1);
  });

  it("单条目字段不合法仅丢弃该条", async () => {
    const fetchImpl: MarketplaceFetch = async () => jsonResponse(registryJson([
      registryEntry({ id: "Bad ID" }),
      registryEntry({ id: "badver", version: "1.0" }),
      registryEntry({ id: "badzip", zip: "https://evil.test/demo.zip" }),
      registryEntry({ id: "badsha", sha256: "xyz" }),
      registryEntry({ id: "baddl", downloads: -5 }),
      registryEntry({ id: "badhome", homepage: "http://example.test" }),
      registryEntry({ id: "ok", name: "OK" }),
    ]));
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.plugins.map((p) => p.id)).toEqual(["ok"]);
  });

  it("zip 命中 GitHub 或 Gitee 任一前缀都通过校验", async () => {
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        return jsonResponse(registryJson([
          registryEntry({ id: "pkz-github", name: "Gh" }),
          registryEntry({ id: "pkz-gitee", name: "Gt", zip: GITEE_ZIP_URL }),
        ]));
      }
      return jsonResponse(registryJson([registryEntry()]));
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket();
    expect(result.ok).toBe(true);
    expect(result.plugins.map((p) => p.id)).toEqual(["pkz-github", "pkz-gitee"]);
  });

  it("listMarket(preferred) 把偏好源提到探测首位并作为数据源", async () => {
    const calls: string[] = [];
    const fetchImpl: MarketplaceFetch = async (input) => {
      calls.push(input);
      return jsonResponse(registryJson([registryEntry()]));
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.listMarket(REGISTRY_URL_B);
    expect(result.ok).toBe(true);
    // 偏好源被探测在最前
    expect(calls[0]).toBe(REGISTRY_URL_B);
    // 偏好源成为实际数据源，另一个可用源 standby
    expect(result.sources).toEqual([
      { url: REGISTRY_URL_B, ok: true, used: true },
      { url: REGISTRY_URL_A, ok: true, used: false },
    ]);
  });

  it("并发请求时只有最后一次请求的结果会落快照", async () => {
    const zipBytes = new Uint8Array([1, 2, 3, 4]);
    const sha = sha256Of(zipBytes);
    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => { releaseA = resolve; });
    let aCalls = 0;
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        aCalls += 1;
        // 第一次请求挂起模拟慢响应；第二次请求主源直接失败，走兜底源快速返回新数据
        if (aCalls === 1) {
          await gateA;
          return jsonResponse(registryJson([registryEntry({ id: "stale", name: "Stale", sha256: sha })]));
        }
        throw new Error("source A down");
      }
      if (input === ZIP_URL) return new Response(zipBytes);
      return jsonResponse(registryJson([registryEntry({ id: "fresh", name: "Fresh", sha256: sha })]));
    };
    const deps = makeDeps({ fetchImpl });
    const service = createPluginMarketplaceService(deps);

    const requestA = service.listMarket();
    const requestB = service.listMarket();
    await requestB;
    releaseA?.();
    const lateA = await requestA;

    // 过期响应的结果交还发起方，但快照保持最新请求的数据
    expect(lateA.plugins.map((p) => p.id)).toEqual(["stale"]);
    const install = await service.installFromMarket("fresh");
    expect(install).toMatchObject({ ok: true });
    expect(deps.installZip).toHaveBeenCalledWith(expect.any(String), {
      expectedIdentity: { id: "fresh", version: "1.0.0" },
      origin: "market",
    });
    const staleInstall = await service.installFromMarket("stale");
    expect(staleInstall).toMatchObject({ ok: false });
  });
});

describe("installFromMarket", () => {
  async function serviceWithZip(
    zipBytes: Uint8Array,
    entryOverrides: Record<string, unknown> = {},
    depsOverrides: Partial<PluginMarketplaceDeps> = {},
  ) {
    const sha = sha256Of(zipBytes);
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        return jsonResponse(registryJson([registryEntry({ sha256: sha, ...entryOverrides })]));
      }
      if (input === ZIP_URL) return new Response(zipBytes);
      throw new Error("unexpected source");
    };
    const deps = makeDeps({ fetchImpl, ...depsOverrides });
    const service = createPluginMarketplaceService(deps);
    await service.listMarket();
    return { service, deps };
  }

  it("下载校验后安装并传递期望身份", async () => {
    const zipBytes = new Uint8Array([1, 2, 3, 4, 5]);
    const { service, deps } = await serviceWithZip(zipBytes);
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: true, plugin: { id: "demo", version: "1.0.0" } });
    expect(deps.installZip).toHaveBeenCalledWith(
      expect.any(String),
      { expectedIdentity: { id: "demo", version: "1.0.0" }, origin: "market" },
    );
    // 临时文件已清理
    expect(readdirSync(deps.cacheDir)).toEqual([]);
  });

  it("未成功拉取列表时拒绝安装", async () => {
    const fetchImpl: MarketplaceFetch = async () => {
      throw new Error("network down");
    };
    const service = createPluginMarketplaceService(makeDeps({ fetchImpl }));
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("插件市场信息已失效") });
  });

  it("SHA-256 不匹配时拒绝安装并清理临时文件", async () => {
    const zipBytes = new Uint8Array([9, 9, 9]);
    const { service, deps } = await serviceWithZip(zipBytes, { sha256: "f".repeat(64) });
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("SHA-256 不匹配") });
    expect(readdirSync(deps.cacheDir)).toEqual([]);
  });

  it("下载超过大小上限时中止并清理临时文件", async () => {
    const zipBytes = new Uint8Array(100);
    const { service, deps } = await serviceWithZip(zipBytes, {}, { zipMaxBytes: 10 });
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("50 MiB") });
    expect(readdirSync(deps.cacheDir)).toEqual([]);
  });

  it("下载超时中止并清理临时文件", async () => {
    const zipBytes = new Uint8Array([1, 2, 3]);
    const sha = sha256Of(zipBytes);
    // 挂一个永不结束的下载流，验证超时能中断读取而不是永远等待
    const hangingStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        // 不 close，让读取一直挂着直到超时中止
      },
    });
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) return jsonResponse(registryJson([registryEntry({ sha256: sha })]));
      if (input === ZIP_URL) return new Response(hangingStream);
      throw new Error("unexpected source");
    };
    const deps = makeDeps({ fetchImpl, zipTimeoutMs: 80 });
    const service = createPluginMarketplaceService(deps);
    await service.listMarket();
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("超时") });
    expect(readdirSync(deps.cacheDir)).toEqual([]);
  });

  it("installZip 失败时透传错误并清理临时文件", async () => {
    const zipBytes = new Uint8Array([1, 2, 3]);
    const { service, deps } = await serviceWithZip(zipBytes);
    (deps.installZip as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "插件已存在" });
    const result = await service.installFromMarket("demo");
    expect(result).toMatchObject({ ok: false, error: "插件已存在" });
    expect(readdirSync(deps.cacheDir)).toEqual([]);
  });

  it("已有安装任务进行中时第二个请求立即失败", async () => {
    const zipBytes = new Uint8Array([1, 2, 3]);
    let releaseInstall: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { releaseInstall = resolve; });
    const fetchImpl: MarketplaceFetch = async (input) => {
      if (input === REGISTRY_URL_A) {
        return jsonResponse(registryJson([registryEntry({ sha256: sha256Of(zipBytes) })]));
      }
      if (input === ZIP_URL) return new Response(zipBytes);
      throw new Error("unexpected");
    };
    const deps = makeDeps({
      fetchImpl,
      installZip: vi.fn(async () => {
        await gate;
        return { ok: true, plugin: { id: "demo", name: "Demo", version: "1.0.0" }, overview: undefined };
      }),
    });
    const service = createPluginMarketplaceService(deps);
    await service.listMarket();

    const first = service.installFromMarket("demo");
    const second = await service.installFromMarket("demo");
    expect(second).toMatchObject({ ok: false, error: expect.stringContaining("已有插件安装任务进行中") });
    releaseInstall?.();
    expect(await first).toMatchObject({ ok: true });
  });
});
