import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { isValidPluginVersion } from "../shared/version";
import type {
  MarketInstallResult,
  MarketListResult,
  MarketPluginEntry,
  MarketSourceStatus,
} from "../shared/plugin-management";
import type { PluginImportResult } from "../plugins/manager";

/** 官方插件市场索引源：GitHub 为主源、Gitee 兜底；市场面板会实时探测各源死活，并允许用户手动切换指定源 */
export const MARKET_REGISTRY_URLS = [
  "https://raw.githubusercontent.com/Playa-0v0/Cyrene-Plugins/main/registry.json",
  "https://gitee.com/playa0/cyrene-plugins/raw/main/registry.json",
] as const;

/** 插件包只允许来自官方仓库的直链（GitHub Releases + Gitee raw zips/ 双前缀），防止索引被篡改后下载任意来源的包 */
export const MARKET_ZIP_URL_PREFIXES: readonly string[] = [
  "https://github.com/Playa-0v0/Cyrene-Plugins/releases/download/",
  "https://gitee.com/playa0/cyrene-plugins/raw/main/zips/",
];

export const MARKET_REGISTRY_TIMEOUT_MS = 10_000;
export const MARKET_ZIP_DOWNLOAD_TIMEOUT_MS = 120_000;
export const MARKET_ZIP_MAX_BYTES = 50 * 1024 * 1024;

/** 渲染端只传插件 id，安装所需的 zip 地址与哈希全部来自主进程校验过的快照 */
interface MarketSnapshotEntry {
  id: string;
  version: string;
  zip: string;
  sha256: string;
}

export type MarketplaceFetch = (
  input: string,
  init?: { signal?: AbortSignal },
) => Promise<Response>;

export interface PluginMarketplaceDeps {
  registryUrls: readonly string[];
  zipUrlPrefixes: readonly string[];
  /** 下载的插件 zip 临时存放目录（如 userData/plugin-market-cache） */
  cacheDir: string;
  installZip: (
    zipPath: string,
    opts: { expectedIdentity: { id: string; version: string }; origin: "market" },
  ) => Promise<PluginImportResult>;
  fetchImpl?: MarketplaceFetch;
  /** 以下参数仅测试注入用 */
  registryTimeoutMs?: number;
  zipTimeoutMs?: number;
  zipMaxBytes?: number;
}

/** registry 整体性错误：invalid 表示数据坏了换下一个源，unsupported 表示协议版本不兼容 */
class RegistryFormatError extends Error {
  constructor(
    message: string,
    readonly kind: "invalid" | "unsupported",
  ) {
    super(message);
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isHttpsUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith("https://");
}

/** 单条目校验：不合法返回 null（调用方丢弃该条并记日志，不阻断整个列表） */
function validateEntry(raw: unknown, deps: PluginMarketplaceDeps): (MarketPluginEntry & { zip: string; sha256: string }) | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const { id, name, version, description, author, zip, sha256, downloads, homepage } = entry;
  if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
  if (!isNonEmptyString(name) || !isNonEmptyString(description) || !isNonEmptyString(author)) return null;
  if (typeof version !== "string" || !isValidPluginVersion(version)) return null;
  if (typeof zip !== "string" || !deps.zipUrlPrefixes.some((prefix) => zip.startsWith(prefix))) return null;
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) return null;
  if (typeof downloads !== "number" || !Number.isInteger(downloads) || downloads < 0) return null;
  if (homepage !== undefined && !isHttpsUrl(homepage)) return null;
  return {
    id,
    name,
    version,
    description,
    author,
    downloads,
    homepage: typeof homepage === "string" ? homepage : undefined,
    zip,
    sha256,
  };
}

function validateRegistry(data: unknown, deps: PluginMarketplaceDeps): {
  plugins: MarketPluginEntry[];
  snapshot: Map<string, MarketSnapshotEntry>;
} {
  if (typeof data !== "object" || data === null) {
    throw new RegistryFormatError("registry 不是合法的 JSON 对象", "invalid");
  }
  const record = data as Record<string, unknown>;
  if (record.apiVersion !== 1) {
    throw new RegistryFormatError(`插件市场协议版本不支持: ${String(record.apiVersion)}`, "unsupported");
  }
  if (!Array.isArray(record.plugins)) {
    throw new RegistryFormatError("registry 的 plugins 必须是数组", "invalid");
  }
  const plugins: MarketPluginEntry[] = [];
  const snapshot = new Map<string, MarketSnapshotEntry>();
  const seen = new Set<string>();
  for (const raw of record.plugins) {
    const entry = validateEntry(raw, deps);
    if (!entry) {
      console.warn("[plugins] 插件市场条目校验失败，已跳过:", JSON.stringify(raw));
      continue;
    }
    if (seen.has(entry.id)) {
      // 官方索引出现重复 id 属于构建产物错误，整源判失败而不是随机取舍
      throw new RegistryFormatError(`registry 存在重复插件 id: ${entry.id}`, "invalid");
    }
    seen.add(entry.id);
    plugins.push({
      id: entry.id,
      name: entry.name,
      version: entry.version,
      description: entry.description,
      author: entry.author,
      downloads: entry.downloads,
      homepage: entry.homepage,
    });
    snapshot.set(entry.id, { id: entry.id, version: entry.version, zip: entry.zip, sha256: entry.sha256 });
  }
  plugins.sort((a, b) => b.downloads - a.downloads || a.name.localeCompare(b.name, "zh-CN"));
  return { plugins, snapshot };
}

export function createPluginMarketplaceService(deps: PluginMarketplaceDeps) {
  const fetchImpl: MarketplaceFetch = deps.fetchImpl
    ?? ((input, init) => {
      // electron 在单测环境不可用，延迟到运行时加载
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { net } = require("electron") as typeof import("electron");
      return net.fetch(input, init);
    });
  const registryTimeoutMs = deps.registryTimeoutMs ?? MARKET_REGISTRY_TIMEOUT_MS;
  const zipTimeoutMs = deps.zipTimeoutMs ?? MARKET_ZIP_DOWNLOAD_TIMEOUT_MS;
  const zipMaxBytes = deps.zipMaxBytes ?? MARKET_ZIP_MAX_BYTES;

  /** 最近一次成功拉取并通过校验的条目快照；刷新失败即清空，安装只信快照 */
  let snapshot: Map<string, MarketSnapshotEntry> | null = null;
  /** 列表请求序号：并发时只有最后一次发起的请求可以更新快照，防止过期响应覆盖新数据 */
  let listSeq = 0;
  let installInFlight = false;

  async function fetchRegistryJson(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), registryTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
    }
  }

  async function listMarket(preferred?: string): Promise<MarketListResult> {
    const seq = ++listSeq;
    // 若调用方指定偏好源且在候选里，就把它提前到探测队首，其余保持原优先级顺序
    const ordered = preferred && deps.registryUrls.includes(preferred)
      ? [preferred, ...deps.registryUrls.filter((url) => url !== preferred)]
      : [...deps.registryUrls];
    // 并发探测所有源：拿到每个源的死活状态供面板展示，数据取优先级最高的可用源
    const probes = await Promise.all(
      ordered.map(async (url) => {
        try {
          return { url, data: await fetchRegistryJson(url) } as const;
        } catch (error) {
          return { url, failure: errorMessage(error) } as const;
        }
      }),
    );
    const sources: MarketSourceStatus[] = [];
    const failures: string[] = [];
    let sawUnsupported = false;
    let chosen: { plugins: MarketPluginEntry[]; snapshot: Map<string, MarketSnapshotEntry> } | null = null;
    for (const probe of probes) {
      if ("failure" in probe) {
        sources.push({ url: probe.url, ok: false, used: false });
        failures.push(`${probe.url}: ${probe.failure}`);
        continue;
      }
      try {
        const parsed = validateRegistry(probe.data, deps);
        // 第一个通过校验的源作为数据源，其余可用源仅作展示（standby）
        const used = chosen === null;
        sources.push({ url: probe.url, ok: true, used });
        if (used) chosen = parsed;
      } catch (error) {
        sources.push({ url: probe.url, ok: false, used: false });
        failures.push(`${probe.url}: ${errorMessage(error)}`);
        if (error instanceof RegistryFormatError && error.kind === "unsupported") {
          sawUnsupported = true;
        }
      }
    }
    if (chosen) {
      if (seq === listSeq) {
        // 只有最新一次请求才能落快照；过期响应的结果直接交还发起方但不改变状态
        snapshot = chosen.snapshot;
      }
      return { ok: true, plugins: chosen.plugins, sources };
    }
    // 刷新失败清空快照：只有当前 UI 成功看到的列表才允许触发安装
    if (seq === listSeq) snapshot = null;
    const error = sawUnsupported
      ? "插件市场版本不受当前客户端支持，请更新应用"
      : `暂时无法获取插件列表: ${failures.join("；")}`;
    return { ok: false, error, plugins: [], sources };
  }

  async function sha256File(file: string): Promise<string> {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    for await (const chunk of stream) hash.update(chunk);
    return hash.digest("hex");
  }

  /** 流式下载到临时文件：逐块累计字节数，超上限立即中止，不依赖 Content-Length 也不整包进内存 */
  async function downloadZip(url: string, tempPath: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("下载插件包超时")), zipTimeoutMs);
    // 超时信号转成下载各环节竞速的拒绝方：即使对端流挂死不结束，也能在超时后被中断
    const timeoutPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(controller.signal.reason instanceof Error ? controller.signal.reason : new Error("下载插件包超时"));
      });
    });
    try {
      const response = await Promise.race([fetchImpl(url, { signal: controller.signal }), timeoutPromise]);
      if (!response.ok) throw new Error(`下载插件包失败（HTTP ${response.status}）`);
      if (!response.body) throw new Error("下载插件包失败（响应无内容）");
      const reader = response.body.getReader();
      const file = createWriteStream(tempPath);
      // 提前挂好关闭信号：超时/超限提前 destroy 时，流要等延迟的 open 完成后才真正关闭 fd，
      // 不等 close 就清理临时文件会赶在文件创建之前执行，留下一个空文件
      const fileClosed = new Promise<void>((resolve) => file.once("close", resolve));
      let received = 0;
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
          if (done) break;
          received += value.byteLength;
          if (received > zipMaxBytes) {
            controller.abort();
            throw new Error("插件包超过 50 MiB 限制");
          }
          if (!file.write(value)) await once(file, "drain");
        }
        await new Promise<void>((resolve, reject) => {
          file.end((streamError: Error | null | undefined) => {
            if (streamError) reject(streamError);
            else resolve();
          });
        });
        await fileClosed;
      } catch (streamError) {
        file.destroy();
        await fileClosed;
        throw streamError;
      } finally {
        // 中断或读完后都释放读取器，避免挂死的流占着连接
        reader.cancel().catch(() => {});
      }
    } finally {
      clearTimeout(timer);
    }
  }

  async function installFromMarket(id: string): Promise<MarketInstallResult> {
    if (installInFlight) {
      return { ok: false, error: "已有插件安装任务进行中，请稍候" };
    }
    installInFlight = true;
    try {
      const entry = snapshot?.get(id);
      if (!entry) {
        return { ok: false, error: "插件市场信息已失效，请刷新后重试" };
      }
      await mkdir(deps.cacheDir, { recursive: true });
      const tempPath = path.join(deps.cacheDir, `${id}-${Date.now()}.zip`);
      try {
        await downloadZip(entry.zip, tempPath);
        const actual = await sha256File(tempPath);
        if (actual !== entry.sha256.toLowerCase()) {
          throw new Error("插件包校验失败（SHA-256 不匹配）");
        }
        const result = await deps.installZip(tempPath, {
          expectedIdentity: { id: entry.id, version: entry.version },
          origin: "market",
        });
        if (!result.ok) {
          return { ok: false, error: result.error ?? "安装插件失败" };
        }
        return {
          ok: true,
          plugin: result.plugin ?? { id: entry.id, name: entry.id, version: entry.version },
          overview: result.overview,
        };
      } finally {
        // 成功、失败、异常路径都要清理临时文件
        await rm(tempPath, { force: true });
      }
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    } finally {
      installInFlight = false;
    }
  }

  return { listMarket, installFromMarket };
}
