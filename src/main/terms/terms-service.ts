import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import builtinJson from "../../shared/builtin-terms.json";
import type { TermsAcceptance, TermsAcceptResult, TermsBlock, TermsBundle, TermsDocument, TermsLocale, TermsSnapshot } from "../../shared/terms-types";

export const TERMS_URL = "https://gitee.com/playa0/cyrene-announcement/raw/main/terms/terms.json";
export const TERMS_MAX_BYTES = 256 * 1024;
const LOCALES: TermsLocale[] = ["zh-CN", "en", "ja-JP"];
const POLL_MS = 6 * 60 * 60 * 1000;
const TIMEOUT_MS = 10_000;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("条款数据必须是对象");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("条款包含未知字段");
}
function text(value: unknown, max = 16_384): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) {
    throw new Error("条款文字无效或过长");
  }
  return value;
}
function list(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error("条款列表无效");
  return value;
}
function version(value: unknown): string {
  const str = text(value, 64);
  const match = /^(\d{4}-\d{2}-\d{2})(?:\.([1-9]\d{0,5}))?$/.exec(str);
  if (!match || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`))
    || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) throw new Error("同意版本必须是有效日期及可选递增序号");
  return str;
}
function compareVersion(a: string, b: string): number {
  const [dateA, seqA = "0"] = a.split(".");
  const [dateB, seqB = "0"] = b.split(".");
  return dateA.localeCompare(dateB) || Number(seqA) - Number(seqB);
}

/** 在主进程白名单重建对象，渲染端不能接收到远程附加的可执行内容。 */
export function validateTermsBundle(value: unknown): TermsBundle {
  const input = object(value);
  keys(input, ["schemaVersion", "revision", "consentVersion", "locales"]);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new Error("条款格式或修订号不受支持");
  const rawLocales = object(input.locales);
  keys(rawLocales, LOCALES);
  const locales = {} as Record<TermsLocale, TermsDocument>;
  for (const locale of LOCALES) {
    const doc = object(rawLocales[locale]);
    keys(doc, ["heading", "sections"]);
    locales[locale] = {
      heading: text(doc.heading, 512),
      sections: list(doc.sections, 64).map(raw => {
        const section = object(raw);
        keys(section, ["title", "blocks"]);
        return {
          title: text(section.title, 512),
          blocks: list(section.blocks, 128).map(rawBlock => {
            const block = object(rawBlock);
            if (block.kind === "list") {
              keys(block, ["kind", "items"]);
              return { kind: "list", items: list(block.items, 128).map(item => text(item)) } as TermsBlock;
            }
            if (block.kind !== "paragraph" && block.kind !== "heading") throw new Error("条款段落类型不受支持");
            keys(block, ["kind", "text"]);
            return { kind: block.kind, text: text(block.text) } as TermsBlock;
          }),
        };
      }),
    };
  }
  const result: TermsBundle = { schemaVersion: 1, revision: input.revision as number, consentVersion: version(input.consentVersion), locales };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > TERMS_MAX_BYTES) throw new Error("条款数据过大");
  return result;
}
export function termsContentHash(bundle: TermsBundle): string {
  return createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
}
const BUILTIN = validateTermsBundle(builtinJson);
interface VerifiedBundle { bundle: TermsBundle; contentHash: string }
interface Receipt extends VerifiedBundle { acceptedAt: string }

/** 临时文件和目标同目录，写完整并 fsync 后 rename；失败不会推进内存版本。 */
export function writeTermsFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch { /* rename 成功或临时文件创建失败。 */ }
  }
}
function readVerified(file: string): VerifiedBundle | null {
  try {
    if (fs.statSync(file).size > TERMS_MAX_BYTES + 2048) return null;
    const record = object(JSON.parse(fs.readFileSync(file, "utf8")));
    const bundle = validateTermsBundle(record.bundle);
    const contentHash = termsContentHash(bundle);
    if (record.contentHash !== contentHash) return null;
    return { bundle, contentHash };
  } catch { return null; }
}
function canReplace(current: VerifiedBundle, next: VerifiedBundle): boolean {
  if (next.bundle.revision < current.bundle.revision || compareVersion(next.bundle.consentVersion, current.bundle.consentVersion) < 0) return false;
  return next.bundle.revision !== current.bundle.revision || next.contentHash === current.contentHash;
}

export type TermsFetch = (url: string, init: { signal: AbortSignal; redirect: "error"; credentials: "omit"; cache: "no-store" }) => Promise<{
  ok: boolean; status: number; url?: string;
  headers: { get(name: string): string | null };
  body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void>; releaseLock(): void } } | null;
}>;
const defaultFetch: TermsFetch = (url, init) => {
  const { net } = require("electron") as typeof import("electron");
  return net.fetch(url, init);
};
async function readRemote(fetchImpl: TermsFetch, signal: AbortSignal): Promise<TermsBundle> {
  const response = await fetchImpl(TERMS_URL, { signal, redirect: "error", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error(`条款 HTTP ${response.status}`);
  if (response.url && response.url !== TERMS_URL) throw new Error("条款来源已改变");
  const size = Number(response.headers.get("content-length"));
  if (size > TERMS_MAX_BYTES || !response.body) throw new Error("条款响应无效或过大");
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  try {
    for (;;) {
      if (signal.aborted) throw new Error("条款请求已取消");
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value?.byteLength ?? 0;
      if (bytes > TERMS_MAX_BYTES) throw new Error("条款响应过大");
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    return validateTermsBundle(JSON.parse(body));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface TermsServiceOptions {
  cachePath: string;
  consentPath: string;
  readLegacyConsent(): unknown;
  broadcast(snapshot: TermsSnapshot): void;
  fetchImpl?: TermsFetch;
  timeoutMs?: number;
  intervalMs?: number;
  /** 测试用故障注入；生产始终采用原子写。 */
  writeFile?: typeof writeTermsFile;
}
export function createTermsService(options: TermsServiceOptions) {
  const builtin: VerifiedBundle = { bundle: BUILTIN, contentHash: termsContentHash(BUILTIN) };
  let current = builtin;
  let source: TermsSnapshot["source"] = "builtin";
  const cache = readVerified(options.cachePath);
  let receipt = readVerified(options.consentPath);
  // 接受回执保存完整快照：主缓存损坏时仍能恢复用户曾实际阅读的正文。
  for (const candidate of [cache, receipt]) {
    if (candidate && canReplace(current, candidate)) {
      current = candidate;
      source = "cache";
    }
  }
  const receiptExists = fs.existsSync(options.consentPath);
  const write = options.writeFile ?? writeTermsFile;
  let timer: ReturnType<typeof setInterval> | null = null;
  let controller: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let disposed = false;

  function hasCurrentConsent(): boolean {
    return receipt
      ? receipt.bundle.consentVersion === current.bundle.consentVersion
      : !receiptExists && current.bundle.consentVersion === BUILTIN.consentVersion
        && options.readLegacyConsent() === BUILTIN.consentVersion;
  }
  function getSnapshot(): TermsSnapshot {
    const accepted = hasCurrentConsent();
    // 不让调用者修改服务持有的对象（IPC 外的主进程调用也遵守这个边界）。
    return structuredClone({ ...current.bundle, contentHash: current.contentHash, accepted, source });
  }
  function notify(): void {
    try { options.broadcast(getSnapshot()); } catch (error) { console.error("[Terms] broadcast failed:", error); }
  }
  function accept(request: unknown): TermsAcceptResult {
    const candidate = request && typeof request === "object" ? request as Partial<TermsAcceptance> : {};
    if (disposed || candidate.revision !== current.bundle.revision || candidate.consentVersion !== current.bundle.consentVersion
      || candidate.contentHash !== current.contentHash) return { ok: false, error: "changed", snapshot: getSnapshot() };
    try {
      const next: Receipt = { ...current, acceptedAt: new Date().toISOString() };
      write(options.consentPath, next);
      receipt = next;
      notify();
      return { ok: true, snapshot: getSnapshot() };
    } catch {
      return { ok: false, error: "saveFailed", snapshot: getSnapshot() };
    }
  }
  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (pending) return pending;
    const active = new AbortController();
    controller = active;
    const deadline = setTimeout(() => active.abort(), options.timeoutMs ?? TIMEOUT_MS);
    pending = (async () => {
      try {
        const bundle = await readRemote(options.fetchImpl ?? defaultFetch, active.signal);
        if (disposed || active.signal.aborted) return;
        const next = { bundle, contentHash: termsContentHash(bundle) };
        if (!canReplace(current, next) || next.contentHash === current.contentHash) return;
        write(options.cachePath, next);
        current = next;
        source = "remote";
        notify();
      } catch {
        // 失败不替换当前有效条款、不重复弹窗；下一周期重试。
      } finally {
        clearTimeout(deadline);
        if (controller === active) controller = null;
        pending = null;
      }
    })();
    return pending;
  }
  function start(): void {
    if (disposed || timer) return;
    void refresh();
    timer = setInterval(() => void refresh(), options.intervalMs ?? POLL_MS);
    timer.unref?.();
  }
  function dispose(): void {
    disposed = true;
    if (timer) clearInterval(timer);
    timer = null;
    controller?.abort();
  }
  return { getSnapshot, hasCurrentConsent, accept, refresh, start, dispose };
}
export type TermsService = ReturnType<typeof createTermsService>;
