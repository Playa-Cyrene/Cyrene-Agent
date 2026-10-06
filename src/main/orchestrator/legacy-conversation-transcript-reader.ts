import { validateLoadedTranscriptEntry, snapshotEntriesAreConsistent, isRecord } from "./conversation-transcript-validation";
/** Read-only importer for historical JSONL generations. Source files are never repaired in place. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { userRevisionKey, type TranscriptEntry, type TranscriptSnapshotV2, } from "./conversation-transcript-types";
const ROOT_DIR_NAME = "transcripts";
const JSONL_FILE_NAME = "transcript.jsonl";
const SNAPSHOT_FILE_NAME = "snapshot.json";
const GENERATION_MANIFEST_FILE_NAME = "generation.json";
const SCHEMA_VERSION = 2;
const V1_SCHEMA_VERSION = 1;
const IDENTITY_FILE_NAME = "identity.json";
type TranscriptIdentity = {
  schemaVersion: 1;
  conversationId: string;
};
type TranscriptSnapshotV1OnDisk = {
  schemaVersion: 1;
  throughSeq: number;
  entries: TranscriptEntry[];
  seenEntryIds?: string[];
  seenUserRevisions?: string[];
};
interface LoadedConversationState {
  dir: string;
  /** Manifest-selected active file. Legacy conversations use transcript.jsonl. */
  activeFile: string;
  entries: TranscriptEntry[];
  /** 快照基线（无快照为 0）。 */
  throughSeq: number;
  /** 全部条目中的最大 seq（快照条目 + 增量行）。 */
  maxSeq: number;
  seenEntryIds: Set<string>;
  seenUserRevisions: Set<string>;
  projection: TranscriptSnapshotV2["projection"];
  projectionDigest?: string;
  archives: TranscriptSnapshotV2["archives"];
}
interface TranscriptGenerationManifest {
  schemaVersion: 1;
  activeFile: string;
  archives: TranscriptSnapshotV2["archives"];
  seenEntryIds: string[];
  seenUserRevisions: string[];
}
function validConversationId(conversationId: string): boolean {
  return (typeof conversationId === "string" &&
    conversationId.length > 0 &&
    !conversationId.includes("\u0000"));
}
/** Legacy raw-ID directories are considered only when their names are safe on every platform. */
function validLegacyConversationId(conversationId: string): boolean {
  return validConversationId(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".." &&
    !/[<>:"|?*\\/\u0000-\u001f]/.test(conversationId);
}
export function transcriptStorageKey(conversationId: string): string {
  if (!validConversationId(conversationId))
    throw new Error("TRANSCRIPT_INVALID_CONVERSATION_ID");
  return `v2-${createHash("sha256").update(conversationId, "utf8").digest("hex")}`;
}
export class LegacyConversationTranscriptReader {
  private readonly root: string;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(root: string) { this.root = path.join(root, ROOT_DIR_NAME); }
  read(conversationId: string): Promise<TranscriptSnapshotV2> {
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);
      return {
        schemaVersion: SCHEMA_VERSION,
        throughSeq: state.maxSeq,
        entries: state.entries,
        projection: state.projection,
        projectionDigest: state.projectionDigest,
        archives: state.archives,
        seenEntryIds: [...state.seenEntryIds],
        seenUserRevisions: [...state.seenUserRevisions],
      };
    });
  }
  readAuditEntries(conversationId: string): Promise<TranscriptEntry[]> {
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);
      return this.readAuditEntriesLocked(state);
    });
  }
  private async readAuditEntriesLocked(state: LoadedConversationState): Promise<TranscriptEntry[]> {
    const manifest = await this.readGenerationManifest(state.dir);
    if (!manifest)
      return state.entries;
    const entries: TranscriptEntry[] = [];
    for (const segment of manifest.archives) {
      const file = safeSegmentManifestFile(state.dir, segment.file);
      const text = await fs.promises.readFile(file, "utf8");
      if (sha256(text) !== segment.sha256)
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
      entries.push(...parseJsonl(text));
    }
    entries.push(...parseJsonl(await readText(state.activeFile)));
    entries.sort((left, right) => left.seq - right.seq);
    if (entries.some((entry, index) => entry.seq !== index + 1)) {
      throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
    }
    const ids = new Set<string>();
    const revisions = new Set<string>();
    for (const entry of entries) {
      if (ids.has(entry.id))
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
      ids.add(entry.id);
      if (entry.kind === "user") {
        const key = userRevisionKey(entry.turnId as string, entry.revision as number);
        if (revisions.has(key))
          throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
        revisions.add(key);
      }
    }
    return entries;
  }
  private enqueue<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(() => undefined, () => undefined);
    this.queues.set(conversationId, settled);
    return current.finally(() => {
      if (this.queues.get(conversationId) === settled)
        this.queues.delete(conversationId);
    });
  }
  private async loadState(conversationId: string): Promise<LoadedConversationState> {
    const dir = await this.resolveConversationDir(conversationId, true);
    const generation = await this.readGenerationManifest(dir);
    const activeFile = generation ? safeActiveManifestFile(dir, generation.activeFile) : path.join(dir, JSONL_FILE_NAME);
    let text = "";
    try {
      text = await fs.promises.readFile(activeFile, "utf8");
    }
    catch (error) {
      if (generation)
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
    // 尾行容错：只修剪非空的未终止或不可解析的尾行，保留此前所有合法条目
    const { kept, lines } = repairTruncatedTail(text);
    if (kept !== text) {
      if (generation)
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
      // Import repairs the incomplete tail in memory; the backup is never rewritten.
    }
    const snapshot = await this.readSnapshotFile(dir, Boolean(generation));
    // Once a generation manifest is committed, the active file is the hot
    // source. The old snapshot entries remain available as an idempotency
    // index/projection cache but are never replayed into the hot log.
    const throughSeq = generation ? 0 : snapshot?.throughSeq ?? 0;
    const entries: TranscriptEntry[] = generation ? [] : [...(snapshot?.entries ?? [])];
    for (const entry of entries)
      validateLoadedTranscriptEntry(entry);
    const seenEntryIds = new Set<string>([
      ...(snapshot?.seenEntryIds ?? []),
      ...(generation?.seenEntryIds ?? []),
    ]);
    const seenUserRevisions = new Set<string>([
      ...(snapshot?.seenUserRevisions ?? []),
      ...(generation?.seenUserRevisions ?? []),
    ]);
    for (const line of lines) {
      if (line.trim() === "")
        continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      }
      catch {
        // 中间行损坏属于数据损坏，显性失败（尾行已在修复步骤处理）
        throw new Error(generation ? "TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE" : "TRANSCRIPT_CORRUPT_ROW");
      }
      const entry = parsed as TranscriptEntry;
      try {
        validateLoadedTranscriptEntry(entry);
      }
      catch (error) {
        if (generation)
          throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
        throw error;
      }
      if (entry.seq <= throughSeq)
        continue;
      entries.push(entry);
      seenEntryIds.add(entry.id);
      if (entry.kind === "user" && entry.turnId && typeof entry.revision === "number") {
        seenUserRevisions.add(userRevisionKey(entry.turnId, entry.revision));
      }
    }
    if (generation) {
      const expectedFirst = (generation.archives.at(-1)?.throughSeq ?? 0) + 1;
      if (lines.length === 0 || entries[0]?.seq !== expectedFirst ||
        entries.some((entry, index) => entry.seq !== expectedFirst + index)) {
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
      }
    }
    const maxSeq = entries.reduce((max, entry) => Math.max(max, entry.seq), throughSeq);
    return {
      dir,
      activeFile,
      entries,
      throughSeq,
      maxSeq,
      seenEntryIds,
      seenUserRevisions,
      projection: snapshot?.schemaVersion === SCHEMA_VERSION
        ? snapshot.projection
        : { throughSeq: 0, messages: [] },
      projectionDigest: snapshot?.schemaVersion === SCHEMA_VERSION ? snapshot.projectionDigest : undefined,
      archives: generation?.archives ?? (snapshot?.schemaVersion === SCHEMA_VERSION ? snapshot.archives : []),
    };
  }
  private async readSnapshotFile(dir: string, allowArchivedPrefix = false): Promise<TranscriptSnapshotV2 | TranscriptSnapshotV1OnDisk | null> {
    try {
      const raw = await fs.promises.readFile(path.join(dir, SNAPSHOT_FILE_NAME), "utf8");
      const parsed = JSON.parse(raw) as TranscriptSnapshotV2;
      if (parsed?.schemaVersion === SCHEMA_VERSION) {
        if (!Number.isInteger(parsed.throughSeq) ||
          parsed.throughSeq < 0 ||
          !Array.isArray(parsed.entries) ||
          !Array.isArray(parsed.archives) ||
          !Array.isArray(parsed.seenEntryIds) ||
          !Array.isArray(parsed.seenUserRevisions) ||
          !parsed.seenEntryIds.every((id) => typeof id === "string") ||
          !parsed.seenUserRevisions.every((key) => typeof key === "string") ||
          !parsed.archives.every((archive) => (isRecord(archive) &&
            Number.isInteger(archive.fromSeq) && archive.fromSeq >= 0 &&
            Number.isInteger(archive.throughSeq) && archive.throughSeq >= archive.fromSeq &&
            typeof archive.file === "string" &&
            typeof archive.sha256 === "string")) ||
          !snapshotEntriesAreConsistent(parsed.entries, parsed.throughSeq, parsed.seenEntryIds, parsed.seenUserRevisions, allowArchivedPrefix))
          throw new Error("TRANSCRIPT_CORRUPT_SNAPSHOT");
        return parsed;
      }
      if (parsed?.schemaVersion === V1_SCHEMA_VERSION) {
        if (!Array.isArray((parsed as unknown as TranscriptSnapshotV1OnDisk).entries)) {
          throw new Error("TRANSCRIPT_CORRUPT_ROW");
        }
        return parsed as unknown as TranscriptSnapshotV1OnDisk;
      }
      return null;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      // A damaged snapshot is only a recoverable projection/cache failure:
      // canonical JSONL remains the source of truth and will be replayed.
      if (error instanceof SyntaxError)
        return null;
      throw error;
    }
  }
  private async readGenerationManifest(dir: string): Promise<TranscriptGenerationManifest | null> {
    try {
      const raw = await fs.promises.readFile(path.join(dir, GENERATION_MANIFEST_FILE_NAME), "utf8");
      const parsed = JSON.parse(raw) as Partial<TranscriptGenerationManifest>;
      if (parsed.schemaVersion !== 1 || typeof parsed.activeFile !== "string" ||
        !Array.isArray(parsed.archives) || parsed.archives.some((archive) => (!isRecord(archive) || !Number.isInteger(archive.fromSeq) || archive.fromSeq < 1 ||
        !Number.isInteger(archive.throughSeq) || archive.throughSeq < archive.fromSeq ||
        typeof archive.file !== "string" || !/^[a-f0-9]{64}$/.test(archive.sha256 as string)))) {
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
      }
      if ((parsed.seenEntryIds !== undefined && (!Array.isArray(parsed.seenEntryIds) || !parsed.seenEntryIds.every((id) => typeof id === "string"))) ||
        (parsed.seenUserRevisions !== undefined && (!Array.isArray(parsed.seenUserRevisions) || !parsed.seenUserRevisions.every((key) => typeof key === "string")))) {
        throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
      }
      safeActiveManifestFile(dir, parsed.activeFile);
      let expectedFrom = 1;
      for (const archive of parsed.archives) {
        const match = /^segments\/(\d+)-(\d+)\.jsonl$/.exec(archive.file);
        if (!match || Number(match[1]) !== archive.fromSeq || Number(match[2]) !== archive.throughSeq ||
          archive.fromSeq !== expectedFrom)
          throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
        safeSegmentManifestFile(dir, archive.file);
        expectedFrom = archive.throughSeq + 1;
      }
      return parsed as TranscriptGenerationManifest;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return null;
      if (error instanceof Error && error.message === "TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST")
        throw error;
      throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
    }
  }
  private async resolveConversationDir(conversationId: string, _create: boolean): Promise<string> {
    const hashed = path.join(this.root, transcriptStorageKey(conversationId));
    if (await pathExists(hashed)) {
      await this.validateIdentity(hashed, conversationId);
      return hashed;
    }
    const raw = validLegacyConversationId(conversationId) ? path.join(this.root, conversationId) : null;
    return raw && await pathExists(raw) ? raw : hashed;
  }
  private async validateIdentity(dir: string, conversationId: string): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await fs.promises.readFile(path.join(dir, IDENTITY_FILE_NAME), "utf8");
    }
    catch {
      raw = undefined; // identity 缺失或不可读：落入下方空目录自愈判断
    }
    if (raw !== undefined) {
      try {
        const identity = JSON.parse(raw) as Partial<TranscriptIdentity>;
        if (identity.schemaVersion === 1 && identity.conversationId === conversationId)
          return;
        // 身份文件可解析但不属于本会话：可能是散列碰撞或人工拷贝，失败即停止
        throw new Error("TRANSCRIPT_IDENTITY_MISMATCH");
      }
      catch (error) {
        if (error instanceof Error && error.message === "TRANSCRIPT_IDENTITY_MISMATCH")
          throw error;
        // JSON 损坏：落入下方空目录自愈判断
      }
    }
    if (await this.directoryHasTranscriptData(dir)) {
      throw new Error("TRANSCRIPT_IDENTITY_MISMATCH");
    }
    // Empty directories need no identity rewrite during import.
  }
  private async directoryHasTranscriptData(dir: string): Promise<boolean> {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    }
    catch {
      return true; // 无法确认目录内容时按有数据失败处理
    }
    return names.some((name) => name !== IDENTITY_FILE_NAME);
  }
}
async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return false;
    throw error;
  }
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
async function readText(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, "utf8");
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return "";
    throw error;
  }
}
function parseJsonl(text: string): TranscriptEntry[] {
  const { kept, lines } = repairTruncatedTail(text);
  if (kept !== text)
    throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line.trim())
      continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      validateLoadedTranscriptEntry(entry);
      entries.push(entry);
    }
    catch {
      throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
    }
  }
  return entries;
}
function safeActiveManifestFile(dir: string, file: string): string {
  if (!/^active\/[A-Za-z0-9][A-Za-z0-9._-]*\.jsonl$/.test(file)) {
    throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
  }
  return path.resolve(dir, ...file.split("/"));
}
function safeSegmentManifestFile(dir: string, file: string): string {
  if (!/^segments\/\d+-\d+\.jsonl$/.test(file)) {
    throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
  }
  const resolved = path.resolve(dir, ...file.split("/"));
  return resolved;
}
/** 修剪截断尾行：返回保留文本与可用于解析的完整行。 */
function repairTruncatedTail(text: string): {
  kept: string;
  lines: string[];
} {
  if (text === "")
    return { kept: "", lines: [] };
  let kept = text;
  if (!kept.endsWith("\n")) {
    // 未终止尾行（半行是崩溃的合法遗留，即使凑巧可解析也不可信）：修剪到最后一个换行
    const lastNewline = kept.lastIndexOf("\n");
    kept = lastNewline === -1 ? "" : kept.slice(0, lastNewline + 1);
  }
  const lines = kept.split("\n");
  lines.pop(); // 去掉结尾空串
  // 尾部空行直接丢弃；最后一个非空行不可解析则修剪该行
  while (lines.length > 0) {
    const last = lines[lines.length - 1];
    if (last.trim() === "") {
      lines.pop();
      continue;
    }
    try {
      JSON.parse(last);
      break;
    }
    catch {
      lines.pop();
    }
  }
  const normalized = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return { kept: normalized, lines };
}
