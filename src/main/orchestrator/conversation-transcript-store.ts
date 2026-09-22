/**
 * 会话轨迹权威存储（CTA Phase 1）。
 *
 * 两文件模式（与 runStore 的 session JSON + events JSONL 同构）：
 * - transcript.jsonl：逐行追加，每条目一行 JSON，追加即落盘；
 * - snapshot.json：物化检查点，temp + rename 原子写。
 *
 * 不变式：
 * - 每会话独立写队列串行化文件操作，seq 只在队列内分配；
 * - 追加前检测末行 JSON 完整性，半行（崩溃遗留）只修剪尾行，保留此前所有合法条目；
 * - 幂等：entryId 主键 first-write-wins；user (turnId, revision) 次级键
 *   语义等价吸收、内容冲突抛 TRANSCRIPT_IDEMPOTENCY_CONFLICT；
 * - 读取先等队列清空，再以快照 throughSeq 为基线重放 JSONL 增量并重建幂等索引。
 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  assertValidPresentationPatch,
  assertValidTranscriptDraft,
  userRevisionKey,
  type TranscriptAppendInput,
  type TranscriptEntry,
  type TranscriptSnapshotV2,
} from "./conversation-transcript-types";
import type { ChatMessage as CanonicalChatMessage } from "./vendors/types";
import { isContextUsageSnapshot } from "../../shared/context-usage";
import { normalizeMusicCardData } from "../../shared/music-card";

const ROOT_DIR_NAME = "transcripts";
const JSONL_FILE_NAME = "transcript.jsonl";
const SNAPSHOT_FILE_NAME = "snapshot.json";
const GENERATION_MANIFEST_FILE_NAME = "generation.json";
const SCHEMA_VERSION = 2;
const V1_SCHEMA_VERSION = 1;
const IDENTITY_FILE_NAME = "identity.json";

type TranscriptIdentity = { schemaVersion: 1; conversationId: string };
type TranscriptSnapshotV1OnDisk = {
  schemaVersion: 1;
  throughSeq: number;
  entries: TranscriptEntry[];
  seenEntryIds?: string[];
  seenUserRevisions?: string[];
};

export interface ConversationTranscriptStoreOptions {
  now?: () => number;
  syncFile?: (file: string) => Promise<void>;
}

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
  return (
    typeof conversationId === "string" &&
    conversationId.length > 0 &&
    !conversationId.includes("\u0000")
  );
}

/** Legacy raw-ID directories are considered only when their names are safe on every platform. */
function validLegacyConversationId(conversationId: string): boolean {
  return validConversationId(conversationId) &&
    conversationId !== "." &&
    conversationId !== ".." &&
    !/[<>:"|?*\\/\u0000-\u001f]/.test(conversationId);
}

export function transcriptStorageKey(conversationId: string): string {
  if (!validConversationId(conversationId)) throw new Error("TRANSCRIPT_INVALID_CONVERSATION_ID");
  return `v2-${createHash("sha256").update(conversationId, "utf8").digest("hex")}`;
}

/** 深度等价（键顺序无关），用于幂等语义比较。 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length || keysA.some((key, index) => key !== keysB[index])) return false;
  return keysA.every((key) =>
    deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/** 幂等语义比较：忽略信封的 seq / at / id（次级键场景 id 注定不同），其余全等。 */
function sameSemanticContent(input: TranscriptAppendInput, existing: TranscriptEntry): boolean {
  const { seq: _seq, at: _at, id: _id, ...existingRest } = existing;
  const { at: _inputAt, id: _inputId, ...inputRest } = input;
  return deepEqual(inputRest, existingRest);
}

export class ConversationTranscriptStore {
  private readonly root: string;
  private readonly now: () => number;
  private readonly syncFile: (file: string) => Promise<void>;
  /** 每会话写队列尾（settled promise），串行化所有文件操作。 */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(userDataRoot: string, options?: ConversationTranscriptStoreOptions) {
    this.root = path.join(userDataRoot, ROOT_DIR_NAME);
    this.now = options?.now ?? (() => Date.now());
    this.syncFile = options?.syncFile ?? syncFile;
  }

  append(conversationId: string, input: TranscriptAppendInput): Promise<TranscriptEntry> {
    // 入队前先做协议校验，非法草稿快速失败且不占队列
    assertValidTranscriptDraft(input);
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);

      // 幂等主键：entryId 已存在，first-write-wins，返回原条目
      const existingById = state.entries.find((entry) => entry.id === input.id);
      if (existingById) {
        if (existingById.kind !== input.kind) throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        return existingById;
      }
      // A generation's snapshot keeps the idempotency index for archived
      // rows. They cannot be returned from the hot log, so fail closed rather
      // than appending a duplicate with a new sequence number.
      if (state.seenEntryIds.has(input.id)) {
        throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
      }

      // user 次级键 (turnId, revision)：同键语义等价吸收返回持有者，内容不同抛冲突
      if (input.kind === "user" && input.turnId && input.revision) {
        const holder = state.entries.find(
          (entry) =>
            entry.kind === "user" && entry.turnId === input.turnId && entry.revision === input.revision,
        );
        if (holder) {
          if (sameSemanticContent(input, holder)) return holder;
          throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        }
        if (state.seenUserRevisions.has(userRevisionKey(input.turnId, input.revision))) {
          throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        }
      }

      // seq 只在队列内分配：现有最大 seq + 1（快照基线 + 已重放增量）
      const entry = { ...input, seq: state.maxSeq + 1, at: input.at ?? this.now() } as TranscriptEntry;
      validateLoadedTranscriptEntry(entry);
      await fs.promises.mkdir(state.dir, { recursive: true });
      await appendDurableLine(state.activeFile, `${JSON.stringify(entry)}\n`, this.syncFile);
      return entry;
    });
  }

  /**
   * CAS（比较并追加）compaction checkpoint：校验与 seq 分配/写入必须位于同一会话队列。
   * 允许普通 suffix 追加；任何会改变 source branch 的 checkpoint/rewind/tombstone
   * 会让本次压缩显式失败，避免两个摘要并发时 second writer 静默幂等成功。
   */
  appendCompactionCheckpoint(
    conversationId: string,
    input: TranscriptAppendInput,
  ): Promise<Extract<TranscriptEntry, { kind: "compaction_checkpoint" }>> {
    assertValidTranscriptDraft(input);
    if (input.kind !== "compaction_checkpoint") {
      return Promise.reject(new Error("TRANSCRIPT_INVALID_COMPACTION_CHECKPOINT"));
    }
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);
      const payload = input.payload;
      // Compaction digests are deliberately scoped to the hot entries used by
      // the compactor. Archived audit rows remain an independent idempotency
      // source and must not silently change this CAS range.
      const prefix = state.entries.filter((entry) => entry.seq <= payload.sourceThroughSeq);
      const competing = state.entries.some((entry) => entry.seq > payload.baseThroughSeq && (
        entry.kind === "compaction_checkpoint" || entry.kind === "turn_rewind" || entry.kind === "turn_tombstone"
      ));
      const prefixDigest = createHash("sha256").update(JSON.stringify(prefix), "utf8").digest("hex");
      if (competing || prefixDigest !== payload.sourceDigest) {
        throw new Error("TRANSCRIPT_COMPACTION_REQUIRED");
      }
      const entry = { ...input, seq: state.maxSeq + 1, at: input.at ?? this.now() } as Extract<TranscriptEntry, { kind: "compaction_checkpoint" }>;
      validateLoadedTranscriptEntry(entry);
      await fs.promises.mkdir(state.dir, { recursive: true });
      await appendDurableLine(state.activeFile, `${JSON.stringify(entry)}\n`, this.syncFile);
      return entry;
    });
  }

  /** Append a derived presentation patch with queue-assigned revision and stable idempotency. */
  appendPresentationNext(
    conversationId: string,
    messageId: string,
    mutationKey: string,
    patch: import("./conversation-transcript-types").TranscriptPresentationPatch,
  ): Promise<Extract<TranscriptEntry, { kind: "presentation_patch" }>> {
    if (!messageId || !mutationKey || /[\u0000-\u001f\u007f]/.test(mutationKey)) {
      return Promise.reject(new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH"));
    }
    assertValidPresentationPatch(patch);
    return this.enqueue<Extract<TranscriptEntry, { kind: "presentation_patch" }>>(conversationId, async () => {
      const state = await this.loadState(conversationId);
      const existing = state.entries.find((entry): entry is Extract<TranscriptEntry, { kind: "presentation_patch" }> => (
        entry.kind === "presentation_patch" && entry.payload.mutationKey === mutationKey
      ));
      if (existing) {
        if (existing.payload.messageId !== messageId || !deepEqual(existing.payload.patch, patch)) {
          throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
        }
        return existing;
      }
      const keyDigest = createHash("sha256").update(mutationKey, "utf8").digest("hex");
      const stableId = `presentation:${messageId}:m${keyDigest}`;
      if (state.seenEntryIds.has(stableId)) throw new Error("TRANSCRIPT_IDEMPOTENCY_CONFLICT");
      const nextRevision = state.entries
        .filter((entry): entry is Extract<TranscriptEntry, { kind: "presentation_patch" }> =>
          entry.kind === "presentation_patch" && entry.payload.messageId === messageId)
        .reduce((max, entry) => Math.max(max, entry.payload.patchRevision), 0) + 1;
      const input: TranscriptAppendInput = {
        kind: "presentation_patch",
        id: stableId,
        at: this.now(),
        payload: { messageId, patchRevision: nextRevision, mutationKey, patch },
      };
      const entry = { ...input, seq: state.maxSeq + 1 } as Extract<TranscriptEntry, { kind: "presentation_patch" }>;
      try {
        validateLoadedTranscriptEntry(entry);
      } catch (error) {
        if (error instanceof Error && error.message === "TRANSCRIPT_CORRUPT_ROW") {
          throw new Error("TRANSCRIPT_INVALID_PRESENTATION_PATCH");
        }
        throw error;
      }
      await fs.promises.mkdir(state.dir, { recursive: true });
      await fs.promises.appendFile(state.activeFile, `${JSON.stringify(entry)}\n`, "utf8");
      return entry;
    });
  }

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

  /**
   * Commit an immutable archive generation. The manifest rename is the sole
   * visibility point: files written before it are ignored by hot readers.
   * The optional hook exists only for crash-injection tests and runs while
   * the per-conversation queue is held.
   */
  archiveThrough(
    conversationId: string,
    throughSeq: number,
    beforeManifest?: () => Promise<void>,
  ): Promise<void> {
    return this.enqueue(conversationId, async () => {
      if (!Number.isInteger(throughSeq) || throughSeq < 1) {
        throw new Error("TRANSCRIPT_ARCHIVE_INVALID_BOUNDARY");
      }
      const state = await this.loadState(conversationId);
      const previousManifest = await this.readGenerationManifest(state.dir);
      const archivedThrough = previousManifest?.archives.reduce(
        (max, segment) => Math.max(max, segment.throughSeq), 0,
      ) ?? 0;
      if (throughSeq <= archivedThrough) return;

      const checkpoint = state.entries
        .filter((entry): entry is Extract<TranscriptEntry, { kind: "compaction_checkpoint" }> =>
          entry.kind === "compaction_checkpoint" &&
          entry.seq > throughSeq &&
          entry.payload.sourceThroughSeq >= throughSeq)
        .sort((left, right) => right.seq - left.seq)[0];
      if (!checkpoint) throw new Error("TRANSCRIPT_ARCHIVE_BOUNDARY_NOT_COMMITTED");

      const fromSeq = archivedThrough + 1;
      const segmentEntries = state.entries.filter(
        (entry) => entry.seq >= fromSeq && entry.seq <= throughSeq,
      );
      if (segmentEntries.length !== throughSeq - fromSeq + 1 ||
        segmentEntries.some((entry, index) => entry.seq !== fromSeq + index)) {
        throw new Error("TRANSCRIPT_ARCHIVE_BOUNDARY_NOT_CONTIGUOUS");
      }
      const activeEntries = state.entries.filter((entry) => entry.seq > throughSeq);
      const generation = `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}`;
      const segmentsDir = path.join(state.dir, "segments");
      const activeDir = path.join(state.dir, "active");
      await fs.promises.mkdir(segmentsDir, { recursive: true });
      await fs.promises.mkdir(activeDir, { recursive: true });

      const segmentFile = `segments/${fromSeq}-${throughSeq}.jsonl`;
      const activeFile = `active/${generation}.jsonl`;
      const segmentTmp = path.join(state.dir, `${segmentFile}.tmp`);
      const activeTmp = path.join(state.dir, `${activeFile}.tmp`);
      const segmentText = jsonlText(segmentEntries);
      const activeText = jsonlText(activeEntries);
      await writeDurableFile(segmentTmp, segmentText);
      await writeDurableFile(activeTmp, activeText);
      const segmentHash = sha256(segmentText);
      await fs.promises.rename(segmentTmp, path.join(state.dir, segmentFile));
      await fs.promises.rename(activeTmp, path.join(state.dir, activeFile));
      await syncDirectory(segmentsDir);
      await syncDirectory(activeDir);

      const manifest: TranscriptGenerationManifest = {
        schemaVersion: 1,
        activeFile,
        archives: [
          ...(previousManifest?.archives ?? []),
          { fromSeq, throughSeq, file: segmentFile, sha256: segmentHash },
        ],
        seenEntryIds: [...state.seenEntryIds],
        seenUserRevisions: [...state.seenUserRevisions],
      };
      const manifestTmp = path.join(state.dir, `${GENERATION_MANIFEST_FILE_NAME}.${process.pid}.tmp`);
      await writeDurableFile(manifestTmp, JSON.stringify(manifest));
      if (beforeManifest) await beforeManifest();
      await fs.promises.rename(manifestTmp, path.join(state.dir, GENERATION_MANIFEST_FILE_NAME));
      await syncDirectory(state.dir);

      // Persist the compact hot view only after the manifest is visible. If a
      // crash occurs in this step, the active generation remains authoritative
      // and the next checkpoint repairs this cache.
      const snapshot: TranscriptSnapshotV2 = {
        schemaVersion: SCHEMA_VERSION,
        throughSeq: state.maxSeq,
        entries: activeEntries,
        projection: state.projection,
        projectionDigest: digestProjection(state.projection),
        archives: manifest.archives,
        seenEntryIds: [...state.seenEntryIds],
        seenUserRevisions: [...state.seenUserRevisions],
      };
      await writeDurableFile(path.join(state.dir, `${SNAPSHOT_FILE_NAME}.${process.pid}.tmp`), JSON.stringify(snapshot));
      await fs.promises.rename(
        path.join(state.dir, `${SNAPSHOT_FILE_NAME}.${process.pid}.tmp`),
        path.join(state.dir, SNAPSHOT_FILE_NAME),
      );
      await syncDirectory(state.dir);
    });
  }

  /** Full audit view. Unlike read(), this intentionally scans immutable segments. */
  readAuditEntries(conversationId: string): Promise<TranscriptEntry[]> {
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);
      return this.readAuditEntriesLocked(state);
    });
  }

  private async readAuditEntriesLocked(state: LoadedConversationState): Promise<TranscriptEntry[]> {
    const manifest = await this.readGenerationManifest(state.dir);
    if (!manifest) return state.entries;
    const entries: TranscriptEntry[] = [];
    for (const segment of manifest.archives) {
      const file = safeSegmentManifestFile(state.dir, segment.file);
      const text = await fs.promises.readFile(file, "utf8");
      if (sha256(text) !== segment.sha256) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
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
      if (ids.has(entry.id)) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
      ids.add(entry.id);
      if (entry.kind === "user") {
        const key = userRevisionKey(entry.turnId as string, entry.revision as number);
        if (revisions.has(key)) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
        revisions.add(key);
      }
    }
    return entries;
  }

  /** Atomically persist a snapshot, optionally replacing only its projection. */
  checkpoint(
    conversationId: string,
    projection?: TranscriptSnapshotV2["projection"],
  ): Promise<TranscriptSnapshotV2> {
    return this.enqueue(conversationId, async () => {
      const state = await this.loadState(conversationId);
      const snapshot: TranscriptSnapshotV2 = {
        schemaVersion: SCHEMA_VERSION,
        throughSeq: state.maxSeq,
        entries: state.entries,
        projection: projection ?? state.projection,
        projectionDigest: digestProjection(projection ?? state.projection),
        archives: state.archives,
        seenEntryIds: [...state.seenEntryIds],
        seenUserRevisions: [...state.seenUserRevisions],
      };
      const dir = state.dir;
      await fs.promises.mkdir(dir, { recursive: true });
      // 原子写：temp + rename，JSONL 保持不动
      const tempFile = path.join(dir, `${SNAPSHOT_FILE_NAME}.${process.pid}.tmp`);
      await fs.promises.writeFile(tempFile, JSON.stringify(snapshot), "utf8");
      await fs.promises.rename(tempFile, path.join(dir, SNAPSHOT_FILE_NAME));
      return snapshot;
    });
  }

  waitForIdle(conversationId: string): Promise<void> {
    const pending = this.queues.get(conversationId);
    return pending ? pending.then(() => undefined) : Promise.resolve();
  }

  deleteConversation(conversationId: string): Promise<void> {
    return this.enqueue(conversationId, async () => {
      const dir = await this.resolveConversationDir(conversationId, false);
      await fs.promises.rm(dir, { recursive: true, force: true });
    });
  }

  /** 串行队列：同一会话的文件操作依次执行；前序失败不阻塞后续操作。 */
  private enqueue<T>(conversationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const current = previous.then(operation, operation);
    const settled = current.then(() => undefined, () => undefined);
    this.queues.set(conversationId, settled);
    return current.finally(() => {
      if (this.queues.get(conversationId) === settled) this.queues.delete(conversationId);
    });
  }

  /** 加载会话状态：尾行修复 + 快照基线 + seq > throughSeq 的 JSONL 增量重放。 */
  private async loadState(conversationId: string): Promise<LoadedConversationState> {
    const dir = await this.resolveConversationDir(conversationId, true);
    const generation = await this.readGenerationManifest(dir);
    const activeFile = generation ? safeActiveManifestFile(dir, generation.activeFile) : path.join(dir, JSONL_FILE_NAME);

    let text = "";
    try {
      text = await fs.promises.readFile(activeFile, "utf8");
    } catch (error) {
      if (generation) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    // 尾行容错：只修剪非空的未终止或不可解析的尾行，保留此前所有合法条目
    const { kept, lines } = repairTruncatedTail(text);
    if (kept !== text) {
      if (generation) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.truncate(activeFile, Buffer.byteLength(kept, "utf8"));
    }

    const snapshot = await this.readSnapshotFile(dir, Boolean(generation));
    // Once a generation manifest is committed, the active file is the hot
    // source. The old snapshot entries remain available as an idempotency
    // index/projection cache but are never replayed into the hot log.
    const throughSeq = generation ? 0 : snapshot?.throughSeq ?? 0;
    const entries: TranscriptEntry[] = generation ? [] : [...(snapshot?.entries ?? [])];
    for (const entry of entries) validateLoadedTranscriptEntry(entry);
    const seenEntryIds = new Set<string>([
      ...(snapshot?.seenEntryIds ?? []),
      ...(generation?.seenEntryIds ?? []),
    ]);
    const seenUserRevisions = new Set<string>([
      ...(snapshot?.seenUserRevisions ?? []),
      ...(generation?.seenUserRevisions ?? []),
    ]);

    for (const line of lines) {
      if (line.trim() === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // 中间行损坏属于数据损坏，显性失败（尾行已在修复步骤处理）
        throw new Error(generation ? "TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE" : "TRANSCRIPT_CORRUPT_ROW");
      }
      const entry = parsed as TranscriptEntry;
      try {
        validateLoadedTranscriptEntry(entry);
      } catch (error) {
        if (generation) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_ACTIVE");
        throw error;
      }
      if (entry.seq <= throughSeq) continue;
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
        if (
          !Number.isInteger(parsed.throughSeq) ||
          parsed.throughSeq < 0 ||
          !Array.isArray(parsed.entries) ||
          !Array.isArray(parsed.archives) ||
          !Array.isArray(parsed.seenEntryIds) ||
          !Array.isArray(parsed.seenUserRevisions) ||
          !parsed.seenEntryIds.every((id) => typeof id === "string") ||
          !parsed.seenUserRevisions.every((key) => typeof key === "string") ||
          !parsed.archives.every((archive) => (
            isRecord(archive) &&
            Number.isInteger(archive.fromSeq) && archive.fromSeq >= 0 &&
            Number.isInteger(archive.throughSeq) && archive.throughSeq >= archive.fromSeq &&
            typeof archive.file === "string" &&
            typeof archive.sha256 === "string"
          )) ||
          !snapshotEntriesAreConsistent(parsed.entries, parsed.throughSeq, parsed.seenEntryIds, parsed.seenUserRevisions, allowArchivedPrefix)
        ) throw new Error("TRANSCRIPT_CORRUPT_SNAPSHOT");
        return parsed;
      }
      if (parsed?.schemaVersion === V1_SCHEMA_VERSION) {
        if (!Array.isArray((parsed as unknown as TranscriptSnapshotV1OnDisk).entries)) {
          throw new Error("TRANSCRIPT_CORRUPT_ROW");
        }
        return parsed as unknown as TranscriptSnapshotV1OnDisk;
      }
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // A damaged snapshot is only a recoverable projection/cache failure:
      // canonical JSONL remains the source of truth and will be replayed.
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  private async readGenerationManifest(dir: string): Promise<TranscriptGenerationManifest | null> {
    try {
      const raw = await fs.promises.readFile(path.join(dir, GENERATION_MANIFEST_FILE_NAME), "utf8");
      const parsed = JSON.parse(raw) as Partial<TranscriptGenerationManifest>;
      if (parsed.schemaVersion !== 1 || typeof parsed.activeFile !== "string" ||
        !Array.isArray(parsed.archives) || parsed.archives.some((archive) => (
          !isRecord(archive) || !Number.isInteger(archive.fromSeq) || archive.fromSeq < 1 ||
          !Number.isInteger(archive.throughSeq) || archive.throughSeq < archive.fromSeq ||
          typeof archive.file !== "string" || !/^[a-f0-9]{64}$/.test(archive.sha256 as string)
        ))) {
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
          archive.fromSeq !== expectedFrom) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
        safeSegmentManifestFile(dir, archive.file);
        expectedFrom = archive.throughSeq + 1;
      }
      return parsed as TranscriptGenerationManifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof Error && error.message === "TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST") throw error;
      throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_MANIFEST");
    }
  }

  /** Resolve v2 hash directory first, then migrate a safe legacy raw-ID directory in this queue. */
  private async resolveConversationDir(conversationId: string, create: boolean): Promise<string> {
    const key = transcriptStorageKey(conversationId);
    const hashedDir = path.join(this.root, key);
    if (await pathExists(hashedDir)) {
      await this.validateIdentity(hashedDir, conversationId);
      return hashedDir;
    }

    const legacyDir = validLegacyConversationId(conversationId)
      ? path.join(this.root, conversationId)
      : null;
    if (legacyDir && await pathExists(legacyDir)) {
      await fs.promises.mkdir(this.root, { recursive: true });
      // Write the marker while the legacy directory is still authoritative. If this
      // write or the subsequent rename is interrupted, retrying can still find the
      // complete legacy directory and finish the migration without data loss.
      await this.writeIdentity(legacyDir, conversationId);
      await fs.promises.rename(legacyDir, hashedDir);
      return hashedDir;
    }

    if (create) {
      await fs.promises.mkdir(hashedDir, { recursive: true });
      await this.writeIdentity(hashedDir, conversationId);
    }
    return hashedDir;
  }

  private async writeIdentity(dir: string, conversationId: string): Promise<void> {
    const identity: TranscriptIdentity = { schemaVersion: 1, conversationId };
    await fs.promises.writeFile(path.join(dir, IDENTITY_FILE_NAME), JSON.stringify(identity), "utf8");
  }

  /**
   * 校验目录身份文件；identity 缺失或损坏时仅对"空目录"自愈补写。
   * 首次建库时 mkdir 成功但 identity 写入失败的目录会被下一次打开视为可自愈，
   * 避免该会话的哈希目录永久不可用；目录内已有任何轨迹数据则维持 fail-closed。
   */
  private async validateIdentity(dir: string, conversationId: string): Promise<void> {
    let raw: string | undefined;
    try {
      raw = await fs.promises.readFile(path.join(dir, IDENTITY_FILE_NAME), "utf8");
    } catch {
      raw = undefined; // identity 缺失或不可读：落入下方空目录自愈判断
    }
    if (raw !== undefined) {
      try {
        const identity = JSON.parse(raw) as Partial<TranscriptIdentity>;
        if (identity.schemaVersion === 1 && identity.conversationId === conversationId) return;
        // 身份文件可解析但不属于本会话：可能是散列碰撞或人工拷贝，失败即停止
        throw new Error("TRANSCRIPT_IDENTITY_MISMATCH");
      } catch (error) {
        if (error instanceof Error && error.message === "TRANSCRIPT_IDENTITY_MISMATCH") throw error;
        // JSON 损坏：落入下方空目录自愈判断
      }
    }
    if (await this.directoryHasTranscriptData(dir)) {
      throw new Error("TRANSCRIPT_IDENTITY_MISMATCH");
    }
    await this.writeIdentity(dir, conversationId);
  }

  /** 目录内除 identity.json 外是否还有任何文件（日志/快照/manifest/segments/active）。 */
  private async directoryHasTranscriptData(dir: string): Promise<boolean> {
    let names: string[];
    try {
      names = await fs.promises.readdir(dir);
    } catch {
      return true; // 无法确认目录内容时按有数据失败处理
    }
    return names.some((name) => name !== IDENTITY_FILE_NAME);
  }
}

function validateLoadedTranscriptEntry(entry: unknown): asserts entry is TranscriptEntry {
  if (!entry || typeof entry !== "object") throw new Error("TRANSCRIPT_CORRUPT_ROW");
  const candidate = entry as Partial<TranscriptEntry>;
  const kinds = new Set([
    "user", "assistant", "tool_result", "interruption", "turn_rewind",
    "backfill_boundary", "compaction_checkpoint", "presentation_patch",
    "turn_tombstone", "delivery_receipt",
  ]);
  if (
    typeof candidate.id !== "string" ||
    candidate.id.length === 0 ||
    candidate.id.includes("\n") ||
    typeof candidate.seq !== "number" ||
    !Number.isFinite(candidate.seq) ||
    !Number.isInteger(candidate.seq) ||
    candidate.seq < 1 ||
    typeof candidate.at !== "number" ||
    !Number.isFinite(candidate.at) ||
    !kinds.has(candidate.kind as string) ||
    (candidate.runId !== undefined && typeof candidate.runId !== "string") ||
    (candidate.turnId !== undefined && typeof candidate.turnId !== "string") ||
    (candidate.revision !== undefined && (!Number.isInteger(candidate.revision) || candidate.revision < 1)) ||
    (candidate.roundId !== undefined && typeof candidate.roundId !== "string") ||
    !isValidTranscriptPayload(candidate)
  ) throw new Error("TRANSCRIPT_CORRUPT_ROW");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isValidTranscriptPayload(entry: Partial<TranscriptEntry>): boolean {
  if (!isRecord(entry.payload)) return false;
  switch (entry.kind) {
    case "user":
      return typeof entry.turnId === "string" && entry.turnId.length > 0 &&
        Number.isInteger(entry.revision) && (entry.revision ?? 0) >= 1 &&
        typeof entry.payload.text === "string" &&
        (entry.payload.attachments === undefined || Array.isArray(entry.payload.attachments));
    case "assistant":
      return isValidCanonicalChatMessage(entry.payload, "assistant");
    case "tool_result":
      return typeof entry.payload.assistantEntryId === "string" &&
        typeof entry.payload.toolCallId === "string" &&
        ["success", "failure", "unknown", "not_executed"].includes(entry.payload.outcome as string) &&
        isValidCanonicalChatMessage(entry.payload.message, "tool") &&
        (entry.payload.fullRef === undefined || typeof entry.payload.fullRef === "string");
    case "interruption":
      return ["user_cancel", "runtime_error"].includes(entry.payload.reason);
    case "turn_rewind":
      return typeof entry.payload.anchorUserTurnId === "string" &&
        ["keep_user", "replace_user"].includes(entry.payload.disposition as string) &&
        ["edit", "regenerate"].includes(entry.payload.reason as string) &&
        (entry.payload.disposition !== "replace_user" || (
          typeof entry.turnId === "string" && entry.turnId.length > 0 &&
          Number.isInteger(entry.revision) && (entry.revision ?? 0) >= 1
        )) &&
        (entry.payload.replacementUser === undefined || (
          isRecord(entry.payload.replacementUser) &&
          typeof entry.payload.replacementUser.text === "string"
        )) &&
        (entry.payload.disposition !== "replace_user" || !!entry.payload.replacementUser);
    case "backfill_boundary":
      return typeof entry.payload.note === "string";
    case "compaction_checkpoint":
      return Number.isInteger(entry.payload.baseThroughSeq) && entry.payload.baseThroughSeq >= 0 &&
        Number.isInteger(entry.payload.sourceThroughSeq) && entry.payload.sourceThroughSeq >= 0 &&
        typeof entry.payload.sourceDigest === "string" &&
        isValidCanonicalChatMessage(entry.payload.replacement) &&
        ["automatic", "manual"].includes(entry.payload.trigger as string);
    case "presentation_patch":
      return typeof entry.payload.messageId === "string" &&
        Number.isInteger(entry.payload.patchRevision) && entry.payload.patchRevision >= 1 &&
        (entry.payload.mutationKey === undefined || (typeof entry.payload.mutationKey === "string" && entry.payload.mutationKey.length > 0)) &&
        isValidPresentationPatch(entry.payload.patch);
    case "turn_tombstone":
      return typeof entry.payload.targetUserTurnId === "string" && entry.payload.reason === "pending_withdrawn";
    case "delivery_receipt":
      return typeof entry.payload.assistantTurnId === "string" &&
        ["wechat", "feishu", "qq", "qqbot"].includes(entry.payload.channel as string) &&
        ["delivered", "failed"].includes(entry.payload.status as string) &&
        (entry.payload.errorCode === undefined || typeof entry.payload.errorCode === "string") &&
        (entry.payload.revision === undefined || (Number.isInteger(entry.payload.revision) && entry.payload.revision >= 1));
    default:
      return false;
  }
}

function snapshotEntriesAreConsistent(
  entries: TranscriptEntry[],
  throughSeq: number,
  seenEntryIds: string[],
  seenUserRevisions: string[],
  allowArchivedPrefix = false,
): boolean {
  let previousSeq = 0;
  const entryIds: string[] = [];
  const userRevisions: string[] = [];
  for (const entry of entries) {
    validateLoadedTranscriptEntry(entry);
    if (entry.seq <= previousSeq) return false;
    if (!allowArchivedPrefix && entry.seq !== entryIds.length + 1) return false;
    previousSeq = entry.seq;
    entryIds.push(entry.id);
    if (entry.kind === "user") {
      if (typeof entry.turnId !== "string" || !Number.isInteger(entry.revision)) {
        throw new Error("TRANSCRIPT_CORRUPT_ROW");
      }
      userRevisions.push(userRevisionKey(entry.turnId, entry.revision as number));
    }
  }
  if (entries.length === 0) return throughSeq === 0 && seenEntryIds.length === 0 && seenUserRevisions.length === 0;
  if ((!allowArchivedPrefix && previousSeq !== throughSeq) || (allowArchivedPrefix && previousSeq > throughSeq)) return false;
  if (!allowArchivedPrefix) return sameStringSet(entryIds, seenEntryIds) && sameStringSet(userRevisions, seenUserRevisions);
  const seenIds = new Set(seenEntryIds);
  const seenRevisions = new Set(seenUserRevisions);
  return new Set(entryIds).size === entryIds.length &&
    new Set(userRevisions).size === userRevisions.length &&
    entryIds.every((id) => seenIds.has(id)) &&
    userRevisions.every((key) => seenRevisions.has(key));
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length || new Set(left).size !== left.length || new Set(right).size !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function isValidPresentationPatch(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (Object.keys(value).length === 0) return false;
  const allowed = new Set([
    "content", "reasoning", "reasoningBlocks", "processMessages", "agentRounds",
    "taskDelegations", "channelSource", "sticker", "toolExecutions", "runActivity",
    "runSnapshot", "ttsCacheKey", "ttsCacheVersion", "musicCard", "contextUsage",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return false;
  for (const [key, field] of Object.entries(value)) {
    if (key === "content" || key === "reasoning" || key === "ttsCacheKey" || key === "ttsCacheVersion") {
      if (typeof field !== "string") return false;
    } else if (key === "sticker") {
      if (field !== null && typeof field !== "string") return false;
    } else if (key === "channelSource") {
      if (!isRecord(field) || !["wechat", "feishu", "qq", "qqbot"].includes(field.channel as string) ||
        (field.chatType !== undefined && !["private", "group"].includes(field.chatType as string)) ||
        (field.senderName !== undefined && typeof field.senderName !== "string")) return false;
    } else if (["reasoningBlocks", "processMessages", "agentRounds", "taskDelegations", "toolExecutions"].includes(key)) {
      if (!Array.isArray(field)) return false;
      if (key === "reasoningBlocks" && !field.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.content === "string" &&
        (item.streaming === undefined || typeof item.streaming === "boolean") && validOptionalSequenceFields(item))) return false;
      if (key === "processMessages" && !field.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.content === "string" &&
        (item.interrupted === undefined || typeof item.interrupted === "boolean") && validOptionalSequenceFields(item))) return false;
      if (key === "agentRounds" && !field.every((item) => isRecord(item) && typeof item.id === "string" &&
        ["running", "completed"].includes(item.status as string) && typeof item.startedAt === "number" && validOptionalNumber(item.completedAt))) return false;
      if (key === "taskDelegations" && !field.every((item) => isRecord(item) && typeof item.invocationId === "string" &&
        typeof item.taskId === "string" && typeof item.description === "string" && typeof item.nickname === "string" &&
        typeof item.assetFileName === "string" && ["running", "completed", "failed", "cancelled"].includes(item.status as string))) return false;
      if (key === "toolExecutions" && !field.every((item) => isRecord(item) && typeof item.id === "string" && typeof item.name === "string" &&
        ["running", "success", "error"].includes(item.status as string) &&
        (item.result === undefined || typeof item.result === "string") && (item.argsText === undefined || typeof item.argsText === "string"))) return false;
    } else if (key === "runActivity") {
      if (!isRecord(field) || typeof field.startedAt !== "number" || typeof field.reasoningMs !== "number" ||
        !validOptionalNumber(field.completedAt) || !validOptionalNumber(field.activeReasoningStartedAt) ||
        (field.keepExpanded !== undefined && typeof field.keepExpanded !== "boolean")) return false;
    } else if (key === "runSnapshot") {
      if (!isRecord(field) || !["running", "waiting_user", "interrupted", "terminal"].includes(field.status as string) ||
        typeof field.updatedAt !== "number" || (field.runId !== undefined && typeof field.runId !== "string") ||
        (field.terminalStatus !== undefined && !["success", "cancelled", "timeout", "runtime_error"].includes(field.terminalStatus as string))) return false;
    } else if (key === "musicCard") {
      if (!isRecord(field) || normalizeMusicCardData(field) === null) return false;
      const tracks = field.tracks;
      if (!Array.isArray(tracks) || !tracks.every((track) => isRecord(track) && typeof track.id === "string" && typeof track.name === "string" &&
        Array.isArray(track.artists) && track.artists.every((artist) => typeof artist === "string") &&
        (track.album === undefined || typeof track.album === "string") && (track.coverUrl === undefined || typeof track.coverUrl === "string"))) return false;
    } else if (key === "contextUsage") {
      if (!isContextUsageSnapshot(field)) return false;
    } else {
      return false;
    }
  }
  return true;
}

function validOptionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function validOptionalSequenceFields(value: Record<string, unknown>): boolean {
  return (value.afterToolCount === undefined || (typeof value.afterToolCount === "number" && Number.isInteger(value.afterToolCount))) &&
    (value.roundId === undefined || typeof value.roundId === "string") &&
    (value.seq === undefined || (typeof value.seq === "number" && Number.isInteger(value.seq)));
}

function isValidCanonicalChatMessage(value: unknown, expectedRole?: CanonicalChatMessage["role"]): value is CanonicalChatMessage {
  if (!isRecord(value) || typeof value.role !== "string" || !["system", "user", "assistant", "tool"].includes(value.role)) {
    return false;
  }
  if (expectedRole && value.role !== expectedRole) return false;
  if (value.content !== undefined && !isValidChatMessageContent(value.content)) return false;
  if (value.toolCalls !== undefined && (!Array.isArray(value.toolCalls) || !value.toolCalls.every((call) => (
    isRecord(call) && typeof call.id === "string" && typeof call.name === "string" && typeof call.arguments === "string"
  )))) return false;
  if (value.toolCallId !== undefined && typeof value.toolCallId !== "string") return false;
  if (value.name !== undefined && typeof value.name !== "string") return false;
  if (value.thinking !== undefined && typeof value.thinking !== "string") return false;
  if (value.visibility !== undefined && !["user", "internal"].includes(value.visibility as string)) return false;
  return true;
}

function isValidChatMessageContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return Array.isArray(value) && value.every((block) => {
    if (!isRecord(block) || typeof block.type !== "string") return false;
    if (block.type === "text") return typeof block.text === "string";
    return block.type === "image_url" && isRecord(block.image_url) && typeof block.image_url.url === "string";
  });
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.promises.access(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function jsonlText(entries: TranscriptEntry[]): string {
  return entries.length === 0 ? "" : `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function digestProjection(projection: TranscriptSnapshotV2["projection"]): string {
  return sha256(JSON.stringify(projection));
}

async function writeDurableFile(file: string, content: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, "utf8");
  const handle = await fs.promises.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function appendDurableLine(
  file: string,
  content: string,
  sync: (file: string) => Promise<void>,
): Promise<void> {
  await fs.promises.appendFile(file, content, "utf8");
  await sync(file);
}

async function syncFile(file: string): Promise<void> {
  const handle = await fs.promises.open(file, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(dir: string): Promise<void> {
  return syncDirectoryForPlatform(dir, process.platform);
}

export async function syncDirectoryForTests(dir: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  return syncDirectoryForPlatform(dir, platform);
}

async function syncDirectoryForPlatform(dir: string, platform: NodeJS.Platform): Promise<void> {
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch (error) {
    // Windows does not expose directory fsync. Only this directory-sync
    // operation accepts the platform-specific unsupported errors; file fsync
    // above remains fail-closed for all I/O failures.
    const code = (error as NodeJS.ErrnoException).code;
    if (platform !== "win32" || !["EPERM", "ENOTSUP", "EINVAL"].includes(code ?? "")) throw error;
  } finally {
    await handle?.close();
  }
}

async function readText(file: string): Promise<string> {
  try {
    return await fs.promises.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function parseJsonl(text: string): TranscriptEntry[] {
  const { kept, lines } = repairTruncatedTail(text);
  if (kept !== text) throw new Error("TRANSCRIPT_ARCHIVE_CORRUPT_SEGMENT");
  const entries: TranscriptEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TranscriptEntry;
      validateLoadedTranscriptEntry(entry);
      entries.push(entry);
    } catch {
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
function repairTruncatedTail(text: string): { kept: string; lines: string[] } {
  if (text === "") return { kept: "", lines: [] };
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
    } catch {
      lines.pop();
    }
  }
  const normalized = lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return { kept: normalized, lines };
}

const storeSingletons = new Map<string, ConversationTranscriptStore>();

/** 按 userDataRoot 取单例（同一根目录共享会话写队列）。 */
export function getConversationTranscriptStore(userDataRoot: string): ConversationTranscriptStore {
  const key = path.resolve(userDataRoot);
  let store = storeSingletons.get(key);
  if (!store) {
    store = new ConversationTranscriptStore(userDataRoot);
    storeSingletons.set(key, store);
  }
  return store;
}
