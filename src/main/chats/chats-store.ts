// 聊天会话持久化存储
//
// 布局：<userData>/cyrene-chats/
//   index.json              — ChatSessionMeta[]，按 updatedAt desc 排序
//   sessions/<id>.json      — 完整 ChatSession（含 messages）
//
// 设计：
// - 列表读 index.json（轻），进入会话才读 sessions/<id>.json（重）；
// - 写时先写 .tmp 再 rename，避免 crash 中间态损坏文件；
// - index.json 在内存里有缓存（initialize() 时一次性加载），
//   后续 list 直接返回缓存的 deep clone；任何写操作后同步刷新缓存；
// - 删除文件夹整体可移植：用户拷贝 cyrene-chats/ 到新机器即可恢复。

import { app, shell } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  CHAT_SCHEMA_VERSION,
  type ChatMessage,
  type ChatSession,
  type ChatSessionRecord,
  type ChatSessionRecordV2,
  type ChatSessionMeta,
  type ChatSessionPurpose,
  type ConversationMode,
  type PendingChatAttachment,
  type PendingChatMessage,
  type PendingDispatchState,
  type PendingDispatchUserSnapshot,
  type PendingWithdrawalState,
} from "../../shared/chat-types";
import type { ContextUsageSnapshot } from "../../shared/context-usage";

const ROOT_DIR_NAME = "cyrene-chats";
const SESSIONS_SUBDIR = "sessions";
const INDEX_FILE = "index.json";
const LEGACY_MIGRATION_PROJECT_NAME = "迁移文件夹";

let rootDir = "";
let sessionsDir = "";
let indexPath = "";
let indexCache: ChatSessionMeta[] = [];
let initialized = false;

function isConversationMode(value: unknown): value is ConversationMode {
  return value === "chat" || value === "work" || value === "code"
    || value === "learn";
}

function normalizePersistedMode(value: unknown, purpose: ChatSessionPurpose | undefined): ConversationMode {
  if (value === "daily") return "work";
  return isConversationMode(value) ? value : inferLegacyMode(purpose);
}

function inferLegacyMode(purpose: ChatSessionPurpose | undefined): ConversationMode {
  return purpose === "proactive-chat" ? "chat" : "work";
}

function legacyMigrationBinding(): ConversationWorkspaceBinding {
  const workspaceRoot = path.join(app.getPath("userData"), LEGACY_MIGRATION_PROJECT_NAME);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  return {
    workspaceRoot,
    displayName: LEGACY_MIGRATION_PROJECT_NAME,
    boundAt: Date.now(),
  };
}

function ensureDirs(): void {
  if (!fs.existsSync(rootDir)) fs.mkdirSync(rootDir, { recursive: true });
  if (!fs.existsSync(sessionsDir)) fs.mkdirSync(sessionsDir, { recursive: true });
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(tmpPath, filePath);
}

function readIndexFromDisk(): ChatSessionMeta[] {
  if (!fs.existsSync(indexPath)) return [];
  try {
    const raw = fs.readFileSync(indexPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    let migrated = false;
    const normalized: ChatSessionMeta[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const meta = item as Partial<ChatSessionMeta>;
      const valid = (
        typeof meta.id === "string" &&
        typeof meta.title === "string" &&
        typeof meta.createdAt === "number" &&
        typeof meta.updatedAt === "number" &&
        typeof meta.messageCount === "number" &&
        (meta.purpose === undefined || meta.purpose === "proactive-chat")
      );
      if (!valid) continue;
      const session = readSessionRecordFile(meta.id!);
      const indexedMode = meta.mode;
      const mode = normalizePersistedMode(indexedMode ?? session?.mode, meta.purpose ?? session?.purpose);
      const workspaceRoot = typeof meta.workspaceRoot === "string"
        ? meta.workspaceRoot
        : session?.workspaceBinding?.workspaceRoot;
      const workspaceDisplayName = typeof meta.workspaceDisplayName === "string"
        ? meta.workspaceDisplayName
        : session?.workspaceBinding?.displayName;
      const pinned = Boolean(meta.pinned ?? session?.pinned);
      if (
        mode !== indexedMode
        || workspaceRoot !== meta.workspaceRoot
        || workspaceDisplayName !== meta.workspaceDisplayName
        || pinned !== meta.pinned
      ) migrated = true;
      normalized.push({
        id: meta.id!,
        title: meta.title!,
        identityId: meta.identityId ?? null,
        createdAt: meta.createdAt!,
        updatedAt: meta.updatedAt!,
        messageCount: meta.messageCount!,
        purpose: meta.purpose,
        mode,
        workspaceRoot,
        workspaceDisplayName,
        pinned,
      });
    }
    if (migrated) atomicWriteJson(indexPath, normalized);
    return normalized;
  } catch (err) {
    console.warn("[chats-store] index.json 解析失败，重置为空:", err);
    return [];
  }
}

function persistIndex(): void {
  // 排序按 updatedAt desc，最近的对话排前面
  indexCache.sort((a, b) => b.updatedAt - a.updatedAt);
  atomicWriteJson(indexPath, indexCache);
}

function sessionPath(id: string): string {
  return path.join(sessionsDir, id + ".json");
}

function readSessionRecordFile(id: string): ChatSessionRecord | null {
  const filePath = sessionPath(id);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as ChatSessionRecord;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.schemaVersion === 2) {
      if (Array.isArray((parsed as unknown as { messages?: unknown }).messages)
        || typeof (parsed as ChatSessionRecordV2).messageCount !== "number") return null;
    } else if (parsed.schemaVersion !== 1 || !Array.isArray((parsed as ChatSession).messages)) {
      return null;
    }
    parsed.mode = normalizePersistedMode(parsed.mode, parsed.purpose);
    delete (parsed as ChatSession & { codeSession?: unknown }).codeSession;
    return parsed;
  } catch (err) {
    console.warn("[chats-store] session 文件解析失败:", id, err);
    return null;
  }
}

function readSessionFile(id: string): ChatSession | null {
  const record = readSessionRecordFile(id);
  return record?.schemaVersion === 1 ? record : null;
}

function writeSessionFile(session: ChatSession): void {
  atomicWriteJson(sessionPath(session.id), session);
}

function writeSessionRecordFile(record: ChatSessionRecordV2): void {
  atomicWriteJson(sessionPath(record.id), record);
}

type WritableSession = ChatSession | ChatSessionRecordV2;

function writeWritableSession(session: WritableSession): void {
  if (session.schemaVersion === 2) writeSessionRecordFile(session);
  else writeSessionFile(session);
}

function sessionView(session: WritableSession): ChatSession {
  return session.schemaVersion === 2 ? composeSession(session, []) : session;
}

/**
 * 旧版会话没有 mode，也没有项目路径。升级时统一归入 Work，并绑定到
 * userData/迁移文件夹。旧版本曾把无模式会话回填成未绑定路径的 Work，
 * 因此这里同时识别“无合法 mode”和“Work 但无 workspaceBinding”两种形态。
 * 新版 Work 创建流程要求绑定路径，所以有明确项目的会话不会被误迁移。
 */
function migrateLegacySessions(): void {
  if (!fs.existsSync(indexPath)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return;
    let binding: ConversationWorkspaceBinding | null = null;
    let changed = false;
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const meta = item as Partial<ChatSessionMeta>;
      if (typeof meta.id !== "string" || meta.purpose === "proactive-chat") continue;
      const filePath = sessionPath(meta.id);
      if (!fs.existsSync(filePath)) continue;
      let session: ChatSession;
      try {
        session = JSON.parse(fs.readFileSync(filePath, "utf8")) as ChatSession;
      } catch {
        continue;
      }
      if (!session || !Array.isArray(session.messages)) continue;
      const sourceMode: unknown = session.mode ?? meta.mode;
      const isLegacyDaily = sourceMode === "daily";
      const nextMode = normalizePersistedMode(sourceMode, session.purpose ?? meta.purpose);
      const needsWorkspaceBinding = nextMode === "work" && !session.workspaceBinding
        && (!isConversationMode(sourceMode) || isLegacyDaily || sourceMode === "work");
      const hasCodeSession = "codeSession" in (session as ChatSession & { codeSession?: unknown });
      const needsMigration = sourceMode !== nextMode || needsWorkspaceBinding || hasCodeSession;
      if (!needsMigration) continue;
      if (needsWorkspaceBinding) {
        binding ??= legacyMigrationBinding();
        session.workspaceBinding = { ...binding };
      }
      session.mode = nextMode;
      delete (session as ChatSession & { codeSession?: unknown }).codeSession;
      writeSessionFile(session);
      meta.mode = nextMode;
      meta.workspaceRoot = session.workspaceBinding?.workspaceRoot;
      meta.workspaceDisplayName = session.workspaceBinding?.displayName;
      changed = true;
    }
    if (changed) atomicWriteJson(indexPath, parsed);
  } catch (err) {
    console.warn("[chats-store] 旧会话迁移失败，保留原数据:", err);
  }
}

function metaFromSession(session: ChatSession | ChatSessionRecordV2): ChatSessionMeta {
  return {
    id: session.id,
    title: session.title,
    identityId: session.identityId,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.schemaVersion === 2 ? session.messageCount : session.messages.length,
    purpose: session.purpose,
    mode: isConversationMode(session.mode) ? session.mode : inferLegacyMode(session.purpose),
    workspaceRoot: session.workspaceBinding?.workspaceRoot,
    workspaceDisplayName: session.workspaceBinding?.displayName,
    pinned: session.pinned,
  };
}

function upsertMeta(meta: ChatSessionMeta): void {
  const idx = indexCache.findIndex((m) => m.id === meta.id);
  if (idx === -1) indexCache.push(meta);
  else indexCache[idx] = meta;
  persistIndex();
}

function removeMetaById(id: string): void {
  indexCache = indexCache.filter((m) => m.id !== id);
  persistIndex();
}

// 从首条用户消息推导标题（前 30 字 / 单行）。
function deriveTitle(messages: ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.content.trim());
  if (!firstUser) return "新对话";
  const cleaned = firstUser.content.replace(/\s+/g, " ").trim();
  return cleaned.length > 30 ? cleaned.slice(0, 30) + "…" : cleaned;
}

// ── public API ──────────────────────────────────────────────

export function initialize(): void {
  if (initialized) return;
  rootDir = path.join(app.getPath("userData"), ROOT_DIR_NAME);
  sessionsDir = path.join(rootDir, SESSIONS_SUBDIR);
  indexPath = path.join(rootDir, INDEX_FILE);
  ensureDirs();
  migrateLegacySessions();
  indexCache = readIndexFromDisk();
  initialized = true;
}

export function getRootDir(): string {
  return rootDir;
}

export function listSessions(options?: { mode?: ConversationMode }): ChatSessionMeta[] {
  // 返回深拷贝，避免外部修改影响缓存；置顶项优先，其余按 updatedAt 倒序
  const sessions = options?.mode
    ? indexCache.filter((session) => session.mode === options.mode)
    : indexCache;
  return [...sessions]
    .sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return b.updatedAt - a.updatedAt;
    })
    .map((m) => ({ ...m }));
}

export function getSession(id: string): ChatSession | null {
  return readSessionFile(id);
}

/** 同步读取磁盘元数据；v2 记录没有正式 messages。 */
export function getSessionRecord(id: string): ChatSessionRecord | null {
  return readSessionRecordFile(id);
}

/** 迁移器的原子提交点：只接受 v1 → v2 的一次性元数据改写。 */
function recordsEqual(left: ChatSessionRecord, right: ChatSessionRecord): boolean {
  if (left.schemaVersion !== right.schemaVersion) return false;
  if (left.schemaVersion === 1 && right.schemaVersion === 1) {
    return JSON.stringify(left) === JSON.stringify(right);
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * 迁移提交的 compare-and-swap（比较并交换）边界：expected 存在时只有磁盘仍是
 * 同一份 v1 记录才允许瘦身为 v2；返回 null 表示期间已改变或被删除。
 */
export function writeMigratedSession(
  record: ChatSessionRecordV2,
  expected?: ChatSession,
): ChatSessionRecordV2 | null {
  const current = readSessionRecordFile(record.id);
  if (!current) return null;
  if (current.schemaVersion === 2) return current;
  if (expected && !recordsEqual(current, expected)) return null;
  writeSessionRecordFile(record);
  upsertMeta(metaFromSession(record));
  return record;
}

/** 将 v2 元数据与轨迹投影组合成既有 ChatSession 返回形状。 */
export function composeSession(record: ChatSessionRecord, messages: ChatMessage[]): ChatSession {
  if (record.schemaVersion === 1) return { ...record, messages: [...messages] };
  const { messageCount: _messageCount, schemaVersion: _schemaVersion, ...metadata } = record;
  const restoredMessages = messages.map((message) => {
    if (message.role !== "user") return message;
    if (message.id.startsWith("migration:v2:") && message.id.endsWith(":canonical")) {
      return {
        ...message,
        id: message.id.slice("migration:v2:".length, -":canonical".length),
      };
    }
    if (message.id.startsWith("user:v1:") && message.id.endsWith(":r1")) {
      return {
        ...message,
        id: message.id.slice("user:v1:".length, -":r1".length),
      };
    }
    return {
      ...message,
    };
  });
  return { ...metadata, messages: restoredMessages, schemaVersion: CHAT_SCHEMA_VERSION };
}

export function getSessionPage(id: string, before: number | null, limit: number): {
  session: Omit<ChatSession, "messages"> & { messageCount: number };
  messages: ChatMessage[];
  hasMore: boolean;
} | null {
  const session = readSessionFile(id);
  if (!session) return null;
  const end = Math.max(0, Math.min(before ?? session.messages.length, session.messages.length));
  const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 1, 200));
  const start = Math.max(0, end - safeLimit);
  const { messages: _messages, ...meta } = session;
  return {
    session: { ...meta, messageCount: session.messages.length },
    messages: session.messages.slice(start, end),
    hasMore: start > 0,
  };
}

export function createSession(opts?: {
  title?: string;
  identityId?: string | null;
  initialMessages?: ChatMessage[];
  purpose?: ChatSessionPurpose;
  mode?: ConversationMode;
  modelProfileId?: string;
}): ChatSession {
  const now = Date.now();
  const messages = opts?.initialMessages ?? [];
  const mode = opts?.mode ?? (opts?.purpose === "proactive-chat" ? "chat" : "work");
  const session: ChatSession = {
    id: randomUUID(),
    title: opts?.title?.trim() || (messages.length > 0 ? deriveTitle(messages) : "新对话"),
    identityId: opts?.identityId ?? null,
    messages,
    createdAt: now,
    updatedAt: now,
    schemaVersion: CHAT_SCHEMA_VERSION,
    purpose: opts?.purpose,
    titleIsCustom: opts?.purpose ? true : undefined,
    mode,
    modelProfileId: opts?.modelProfileId,
  };
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return session;
}

export function getSessionByPurpose(purpose: ChatSessionPurpose): ChatSession | null {
  const meta = indexCache.find((session) => session.purpose === purpose);
  const record = meta ? readSessionRecordFile(meta.id) : null;
  return record ? sessionView(record) : null;
}

/**
 * Electron 主进程内的 store API 是同步的：查询与创建之间没有 await，
 * 因此同一事件循环上的并发调用也无法穿插出两个同用途会话。
 */
export function getOrCreateSessionByPurpose(
  purpose: ChatSessionPurpose,
  opts?: { title?: string; identityId?: string | null },
): ChatSession {
  const existing = getSessionByPurpose(purpose);
  if (existing) return existing;
  return createSession({
    title: opts?.title,
    identityId: opts?.identityId ?? null,
    purpose,
  });
}

export function renameSession(id: string, title: string): ChatSession | null {
  const session = readSessionRecordFile(id);
  if (!session) return null;
  const trimmed = title.trim();
  if (!trimmed) return sessionView(session);
  session.title = trimmed.slice(0, 80);
  session.titleIsCustom = true;
  session.updatedAt = Date.now();
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}

export function setGeneratedTitle(id: string, firstUserMessageId: string, title: string): boolean {
  const session = readSessionFile(id);
  if (!session || session.titleIsCustom) return false;
  const firstUserMessage = session.messages.find(
    (message) => message.role === "user" && message.content.trim(),
  );
  if (firstUserMessage?.id !== firstUserMessageId) return false;
  const trimmed = title.trim();
  if (!trimmed) return false;
  session.title = trimmed.slice(0, 80);
  writeSessionFile(session);
  upsertMeta(metaFromSession(session));
  return true;
}

export function setSessionPinned(id: string, pinned: boolean): ChatSession | null {
  const session = readSessionRecordFile(id);
  if (!session) return null;
  session.pinned = Boolean(pinned);
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}

export function setSessionModelProfile(id: string, modelProfileId: string | undefined): ChatSession | null {
  const session = readSessionRecordFile(id);
  if (!session) return null;
  session.modelProfileId = modelProfileId;
  session.updatedAt = Date.now();
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}

/**
 * 会话级最新上下文容量快照写入（上下文环形图的唯一读取点）。
 * 手动压缩等不产生新 assistant 消息但改变上下文构成的操作走这里。
 */
export function setSessionContextUsage(
  id: string,
  snapshot: ContextUsageSnapshot,
): ChatSession | null {
  const session = readSessionRecordFile(id);
  if (!session) return null;
  session.currentContextUsage = snapshot;
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}

// ── 会话级待发队列（运行中排队、未派发）──────────────────

/** 入队结果：enqueued=false 表示同标识同内容的幂等命中（未写盘）；ok=false 时绝不误报成功。 */
export type EnqueuePendingResult =
  | { ok: true; queue: PendingChatMessage[]; enqueued: boolean }
  | { ok: false; error: "session-not-found" | "empty-content" | "duplicate-id" | "invalid-attachments" | "write-failed" };

/** 删除结果：removed=false 表示条目本就不在（幂等成功，未写盘）。 */
export type RemovePendingResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: "session-not-found" | "already-adjusting" | "withdrawal-in-progress" | "write-failed"; queue?: PendingChatMessage[] };

export type PendingWithdrawalError =
  | "session-not-found"
  | "not-found"
  | "already-adjusting"
  | "withdrawal-in-progress"
  | "write-failed";

export type BeginPendingWithdrawalResult =
  | { ok: true; withdrawalId: string }
  | { ok: false; error: PendingWithdrawalError };

export type CommitPendingWithdrawalResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: PendingWithdrawalError };

export interface PendingWithdrawalRecord {
  sessionId: string;
  messageId: string;
  withdrawalId: string;
}

function pendingWithdrawalId(sessionId: string, messageId: string): string {
  return `withdrawal:${sessionId}:${messageId}`;
}

/** 原子标记 pending 撤回；重复 begin 返回原 withdrawal id，不刷新 startedAt。 */
export function beginPendingWithdrawal(
  sessionId: string,
  messageId: string,
): BeginPendingWithdrawalResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  const index = queue.findIndex((item) => item.id === messageId);
  if (index === -1) return { ok: false, error: "not-found" };
  const target = queue[index];
  if (target.withdrawal?.status === "withdrawing") {
    return { ok: true, withdrawalId: target.withdrawal.id };
  }
  if (target.adjustRunId) return { ok: false, error: "already-adjusting" };
  const withdrawal: PendingWithdrawalState = {
    id: pendingWithdrawalId(sessionId, messageId),
    status: "withdrawing",
    startedAt: Date.now(),
  };
  session.pendingMessages = queue.map((item, itemIndex) => (
    itemIndex === index ? { ...item, withdrawal } : item
  ));
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发撤回标记落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, withdrawalId: withdrawal.id };
}

/** 原子提交 pending 撤回；重复 commit 视为已移除，标识不匹配则拒绝覆盖其他状态。 */
export function commitPendingWithdrawal(
  sessionId: string,
  messageId: string,
  withdrawalId: string,
): CommitPendingWithdrawalResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  const target = queue.find((item) => item.id === messageId);
  if (!target) return { ok: true, removed: false };
  if (target.withdrawal?.id !== withdrawalId || target.withdrawal.status !== "withdrawing") {
    return { ok: false, error: "not-found" };
  }
  session.pendingMessages = queue.filter((item) => item.id !== messageId);
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发撤回提交落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, removed: true };
}

/** 列出所有可恢复撤回；仅由启动对账消费，不修改磁盘。 */
export function listPendingWithdrawals(): PendingWithdrawalRecord[] {
  const records: PendingWithdrawalRecord[] = [];
  for (const meta of indexCache) {
    const session = readSessionRecordFile(meta.id);
    for (const item of session?.pendingMessages ?? []) {
      if (item.withdrawal?.status !== "withdrawing") continue;
      records.push({ sessionId: meta.id, messageId: item.id, withdrawalId: item.withdrawal.id });
    }
  }
  return records;
}

/** 入队载荷：id 由页面生成（稳定标识）；enqueuedAt 由主进程写入。 */
export type PendingChatMessageInput = Omit<PendingChatMessage, "enqueuedAt">;

/**
 * 附件引用规范化：只保留可恢复的稳定字段（kind/name/filePath/mime/caption/hasAnnotations），
 * 丢弃 blob: 预览 URL、预处理状态等瞬态数据。字段不完整时返回 null（整条拒绝）。
 */
function normalizePendingAttachment(value: unknown): PendingChatAttachment | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<PendingChatAttachment>;
  const kind = raw.kind === "image" || raw.kind === "document" ? raw.kind : null;
  if (!kind || typeof raw.name !== "string" || !raw.name.trim()) return null;
  if (typeof raw.filePath !== "string" || !raw.filePath.trim()) return null;
  return {
    kind,
    name: raw.name.trim(),
    filePath: raw.filePath.trim(),
    ...(typeof raw.mime === "string" && raw.mime.trim() ? { mime: raw.mime.trim() } : {}),
    ...(typeof raw.caption === "string" && raw.caption.trim() ? { caption: raw.caption.trim() } : {}),
    ...(raw.hasAnnotations === true ? { hasAnnotations: true } : {}),
  };
}

/** 待发条目校验与规范化：内容、附件逐条检查，enqueuedAt 由主进程填当前时间。 */
function normalizePendingMessage(id: string, entry: PendingChatMessageInput): PendingChatMessage | "empty" | "invalid-attachments" {
  if (typeof id !== "string" || !id.trim()) return "empty";
  if (typeof entry?.rawContent !== "string" || !entry.rawContent.trim()) return "empty";
  const visibleContent = typeof entry.visibleContent === "string" ? entry.visibleContent : entry.rawContent;
  let attachments: PendingChatAttachment[] | undefined;
  if (entry.attachments !== undefined) {
    if (!Array.isArray(entry.attachments)) return "invalid-attachments";
    const normalized: PendingChatAttachment[] = [];
    for (const item of entry.attachments) {
      const next = normalizePendingAttachment(item);
      if (!next) return "invalid-attachments";
      normalized.push(next);
    }
    if (normalized.length > 0) attachments = normalized;
  }
  return {
    id: id.trim(),
    rawContent: entry.rawContent,
    visibleContent,
    ...(attachments ? { attachments } : {}),
    ...(typeof entry.userSticker === "string" && entry.userSticker.trim() ? { userSticker: entry.userSticker.trim() } : {}),
    ...(typeof entry.resumeFromRunId === "string" && entry.resumeFromRunId.trim() ? { resumeFromRunId: entry.resumeFromRunId.trim() } : {}),
    enqueuedAt: Date.now(),
  };
}

/**
 * 幂等判定：两条待发条目（规范化后）的业务内容是否完全一致。
 * enqueuedAt 不参与比较（主进程时钟每次不同）；附件逐字段比较。
 */
function pendingEntryEquals(a: PendingChatMessage, b: PendingChatMessage): boolean {
  if (a.rawContent !== b.rawContent || a.visibleContent !== b.visibleContent) return false;
  if ((a.userSticker ?? "") !== (b.userSticker ?? "")) return false;
  if ((a.resumeFromRunId ?? "") !== (b.resumeFromRunId ?? "")) return false;
  const aAtt = a.attachments ?? [];
  const bAtt = b.attachments ?? [];
  if (aAtt.length !== bAtt.length) return false;
  return aAtt.every((item, index) => {
    const other = bAtt[index];
    return item.kind === other.kind
      && item.name === other.name
      && item.filePath === other.filePath
      && (item.mime ?? "") === (other.mime ?? "")
      && (item.caption ?? "") === (other.caption ?? "")
      && (item.hasAnnotations ?? false) === (other.hasAnnotations ?? false);
  });
}

/**
 * 把一条待发消息追加到会话队列尾部（数组顺序即派发顺序）。
 * 同标识同内容：幂等成功，返回现有权威队列且不写盘（覆盖"首次成功但回复丢失后重试"场景）；
 * 同标识不同内容：duplicate-id 冲突。
 * 待发条目只写 pendingMessages，绝不进入正式 messages 历史；
 * 队列变化不刷新会话排序时间、不写 index.json（会话文件写失败才返回失败）。
 */
export function enqueuePendingMessage(sessionId: string, entry: PendingChatMessageInput): EnqueuePendingResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const normalized = normalizePendingMessage(entry?.id ?? "", entry);
  if (normalized === "empty") return { ok: false, error: "empty-content" };
  if (normalized === "invalid-attachments") return { ok: false, error: "invalid-attachments" };
  const queue = session.pendingMessages ?? [];
  const existing = queue.find((item) => item.id === normalized.id);
  if (existing) {
    return pendingEntryEquals(existing, normalized)
      ? { ok: true, queue: queue.map((item) => ({ ...item })), enqueued: false }
      : { ok: false, error: "duplicate-id" };
  }
  const nextQueue: PendingChatMessage[] = [...queue, normalized];
  session.pendingMessages = nextQueue;
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, queue: nextQueue, enqueued: true };
}

/** 读取会话待发队列（快照副本）；旧会话无字段视为空队列；会话不存在返回 null。 */
export function getPendingMessages(sessionId: string): PendingChatMessage[] | null {
  const session = readSessionRecordFile(sessionId);
  if (!session) return null;
  return (session.pendingMessages ?? []).map((item) => ({ ...item }));
}

/**
 * 按稳定标识移除一条待发消息（用户撤回/派发完成）。
 * 条目不存在时幂等成功（removed=false，不写盘）；会话文件写失败返回 write-failed。
 * 与入队同理：不动 updatedAt、不写 index.json。
 */
export function removePendingMessage(sessionId: string, messageId: string): RemovePendingResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  const target = queue.find((item) => item.id === messageId);
  if (!target) return { ok: true, removed: false };
  if (target.withdrawal?.status === "withdrawing") {
    return { ok: false, error: "withdrawal-in-progress", queue: queue.map((item) => ({ ...item })) };
  }
  // 已标记插入当前运行：双写可能进行到一半（轨迹已写、聊天历史未提交），
  // 此刻撤回会让权威轨迹留下 UI 不存在的隐藏 user——拒绝并附带最新权威队列，
  // 等运行终止复位标记或双写完成后再撤。
  if (target.adjustRunId) {
    return { ok: false, error: "already-adjusting", queue: queue.map((item) => ({ ...item })) };
  }
  session.pendingMessages = queue.filter((item) => item.id !== messageId);
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息删除落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, removed: true };
}

/** 认领结果：claimed=false 表示队列为空；ok=false 时队首保持原样（不丢消息）。 */
export type ClaimPendingResult =
  | {
      ok: true;
      claimed: true;
      /** 认领生成的正式用户消息（含附件快照映射，status=pending）。 */
      userMessage: ChatMessage;
      /** 队首展示内容（剥离表情包标记）：渲染端占位消息直接使用，避免回读 rawContent。 */
      visibleContent: string;
      /** 队首携带的恢复 run 标识（中断任务续跑）；无则省略。 */
      resumeFromRunId?: string;
      /** 认领后剩余的待发队列（权威快照，供页面投影对账）。 */
      remainingQueue: PendingChatMessage[];
      /** 认领后的完整会话（runModel 上下文输入）。 */
      session: ChatSession;
    }
  | { ok: true; claimed: false }
  | { ok: false; error: "session-not-found" | "already-dispatching" | "withdrawal-in-progress" | "write-failed" | "transcript-write-failed" };

function pendingUserMessageFromSnapshot(snapshot: PendingDispatchUserSnapshot): ChatMessage {
  return {
    id: snapshot.id,
    role: "user",
    content: snapshot.text,
    at: snapshot.at,
    ...(snapshot.sticker ? { sticker: snapshot.sticker } : {}),
    ...(snapshot.attachments && snapshot.attachments.length > 0 ? {
      attachments: snapshot.attachments.map((attachment) => attachment.kind === "image" ? {
        kind: "image" as const,
        name: attachment.name,
        filePath: attachment.filePath,
        mime: attachment.mime ?? "application/octet-stream",
        caption: attachment.caption,
        status: "pending" as const,
        ...(attachment.hasAnnotations === true ? { hasAnnotations: true } : {}),
      } : {
        kind: "document" as const,
        name: attachment.name,
        filePath: attachment.filePath,
        status: "pending" as const,
      }),
    } : {}),
  };
}

function pendingUserMessage(head: PendingChatMessage, at: number): ChatMessage {
  return pendingUserMessageFromSnapshot({
    id: head.id,
    at,
    text: head.rawContent,
    visibleContent: head.visibleContent,
    ...(head.attachments?.length ? { attachments: head.attachments } : {}),
    ...(head.userSticker ? { sticker: head.userSticker } : {}),
  });
}

/** 读取待恢复的认领意图；旧记录缺快照时仍原样返回，交由 async loader fail-closed。 */
export function getPendingDispatch(sessionId: string): PendingDispatchState | null {
  const session = readSessionRecordFile(sessionId);
  return session?.pendingDispatch ? { ...session.pendingDispatch } : null;
}

/**
 * 认领队首待发消息：在【一次会话文件写入】内完成——
 * 待发条目移出队列、转成正式用户消息追加进 messages、写入 pendingDispatch 派发状态。
 * 写盘失败时队首保留在队列中（绝不半途丢消息）；已有未完成的认领时拒绝（already-dispatching），
 * 调用方应先恢复该认领（续派不重复追加）再继续消费队列。
 * 认领等于真实历史消息入册（messageCount+1），与 legacy channel writer 一致地刷新 updatedAt 与索引。
 */
export function claimPendingMessage(sessionId: string): ClaimPendingResult {
  const record = readSessionRecordFile(sessionId);
  if (!record) return { ok: false, error: "session-not-found" };
  if (record.pendingDispatch) return { ok: false, error: "already-dispatching" };
  const queue = record.pendingMessages ?? [];
  if (queue.length === 0) return { ok: true, claimed: false };
  const head = queue[0];
  if (head.withdrawal?.status === "withdrawing") {
    return { ok: false, error: "withdrawal-in-progress" };
  }
  const claimedAt = Date.now();
  const userMessage = pendingUserMessage(head, claimedAt);
  const remaining = queue.slice(1);

  if (record.schemaVersion === 2) {
    record.pendingMessages = remaining;
    record.pendingDispatch = {
      messageId: head.id,
      claimedAt,
      userMessage: {
        id: head.id,
        at: claimedAt,
        text: head.rawContent,
        visibleContent: head.visibleContent,
        ...(head.attachments?.length ? { attachments: head.attachments } : {}),
        ...(head.userSticker ? { sticker: head.userSticker } : {}),
      },
    };
    try {
      writeSessionRecordFile(record);
    } catch (err) {
      console.warn("[chats-store] v2 待发消息认领落盘失败:", sessionId, err);
      return { ok: false, error: "write-failed" };
    }
    return {
      ok: true,
      claimed: true,
      userMessage,
      visibleContent: head.visibleContent,
      ...(head.resumeFromRunId ? { resumeFromRunId: head.resumeFromRunId } : {}),
      remainingQueue: remaining.map((item) => ({ ...item })),
      session: composeSession(record, [userMessage]),
    };
  }

  const session = record;
  session.messages = [...session.messages, userMessage];
  session.pendingMessages = remaining;
  session.pendingDispatch = { messageId: head.id, claimedAt };
  session.updatedAt = claimedAt;
  if (!session.titleIsCustom) session.title = deriveTitle(session.messages);
  try {
    writeSessionFile(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息认领落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  // 会话文件（权威数据）已写成功：认领即成立。index.json 只是列表缓存，
  // 写失败不推翻认领结果——若在此返回失败，调用方会误判"未认领"而重试，
  // 反被 already-dispatching 守卫拒绝。仅告警，列表计数待下次写盘自然追平。
  try {
    upsertMeta(metaFromSession(session));
  } catch (err) {
    console.warn("[chats-store] 待发消息认领后索引写入失败（会话列表计数可能滞后）:", sessionId, err);
  }
  return {
    ok: true,
    claimed: true,
    userMessage,
    visibleContent: head.visibleContent,
    ...(head.resumeFromRunId ? { resumeFromRunId: head.resumeFromRunId } : {}),
    remainingQueue: remaining.map((item) => ({ ...item })),
    session,
  };
}

/** 派发确认结果：cleared=false 表示状态本就不匹配（幂等成功，未写盘）。 */
export type CompleteDispatchResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: "session-not-found" | "write-failed" };

/**
 * 派发确认：run 已被主进程接受后清除 pendingDispatch。
 * messageId 不匹配（已被清除/认领了新条目）时幂等成功不写盘。
 * 纯派发簿记：不动 updatedAt、不写 index.json。
 */
export function completePendingDispatch(sessionId: string, messageId: string): CompleteDispatchResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  if (session.pendingDispatch?.messageId !== messageId) return { ok: true, cleared: false };
  delete session.pendingDispatch;
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发派发确认落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, cleared: true };
}

// ── 待发队列的修改与调整 ─────────────────────────────────

/** 编辑结果：冲突与失败时附带最新权威队列，调用方据此刷新投影、不覆盖新状态。 */
export type EditPendingResult =
  | { ok: true; queue: PendingChatMessage[] }
  | {
      ok: false;
      error: "session-not-found" | "not-found" | "already-claimed" | "already-adjusting" | "withdrawal-in-progress" | "empty-content" | "write-failed";
      queue?: PendingChatMessage[];
    };

/**
 * 编辑未认领待发条目的文字：更新原始文字、展示文字与表情标记；
 * 条目标识、入队时间、顺序与附件保持不变（内容由调用方按现有解析规则产出）。
 * 空文字拒绝；条目已被认领（进入派发流程）或已标记插入当前运行时明确报错，
 * 并返回最新权威队列，绝不覆盖新状态。
 */
export function editPendingMessage(
  sessionId: string,
  messageId: string,
  update: { rawContent: string; visibleContent: string; userSticker?: string },
): EditPendingResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  const snapshot = (): PendingChatMessage[] => queue.map((item) => ({ ...item }));
  // 写盘失败时返回写盘前的权威状态（磁盘未变，内存改动作废）
  const beforeWrite = snapshot();
  // 已认领：条目已转正式消息并进入派发流程，编辑会破坏派发一致性
  if (session.pendingDispatch?.messageId === messageId) {
    return { ok: false, error: "already-claimed", queue: beforeWrite };
  }
  const index = queue.findIndex((item) => item.id === messageId);
  if (index === -1) return { ok: false, error: "not-found", queue: beforeWrite };
  const target = queue[index];
  if (target.withdrawal?.status === "withdrawing") {
    return { ok: false, error: "withdrawal-in-progress", queue: beforeWrite };
  }
  // 已标记插入当前运行：条目正在注入流程中，编辑会造成注入内容与记录不一致
  if (target.adjustRunId) return { ok: false, error: "already-adjusting", queue: beforeWrite };
  if (typeof update?.rawContent !== "string" || !update.rawContent.trim()) {
    return { ok: false, error: "empty-content", queue: beforeWrite };
  }
  const next: PendingChatMessage = {
    ...target,
    rawContent: update.rawContent,
    visibleContent: typeof update.visibleContent === "string" && update.visibleContent
      ? update.visibleContent
      : update.rawContent,
  };
  if (typeof update.userSticker === "string" && update.userSticker.trim()) {
    next.userSticker = update.userSticker.trim();
  } else {
    delete next.userSticker;
  }
  queue[index] = next;
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息编辑落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed", queue: beforeWrite };
  }
  return { ok: true, queue: snapshot() };
}

/** 标记调整结果：失败时附带最新权威队列（条目保持原样留在普通队列）。 */
export type MarkPendingAdjustResult =
  | { ok: true; queue: PendingChatMessage[] }
  | {
      ok: false;
      error: "session-not-found" | "not-found" | "already-claimed" | "already-adjusting" | "withdrawal-in-progress" | "has-attachments" | "write-failed";
      queue?: PendingChatMessage[];
    };

/**
 * 把待发条目标记为"插入当前运行下一步"（绑定 runId）。
 * 同一 runId 重复标记幂等成功；已标记其他运行、已被认领、带附件（附件要走
 * 完整派发链路，无法只插文字安全注入）时明确拒绝并留队。
 */
export function markPendingAdjust(
  sessionId: string,
  messageId: string,
  runId: string,
): MarkPendingAdjustResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  const snapshot = (): PendingChatMessage[] => queue.map((item) => ({ ...item }));
  if (session.pendingDispatch?.messageId === messageId) {
    return { ok: false, error: "already-claimed", queue: snapshot() };
  }
  const index = queue.findIndex((item) => item.id === messageId);
  if (index === -1) return { ok: false, error: "not-found", queue: snapshot() };
  const target = queue[index];
  if (target.withdrawal?.status === "withdrawing") {
    return { ok: false, error: "withdrawal-in-progress", queue: snapshot() };
  }
  // 同一运行重复请求：幂等成功，不写盘
  if (target.adjustRunId === runId) return { ok: true, queue: snapshot() };
  if (target.adjustRunId) return { ok: false, error: "already-adjusting", queue: snapshot() };
  if (target.attachments && target.attachments.length > 0) {
    return { ok: false, error: "has-attachments", queue: snapshot() };
  }
  queue[index] = { ...target, adjustRunId: runId };
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息调整标记落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed", queue: snapshot() };
  }
  return { ok: true, queue: snapshot() };
}

/** 提交调整结果：ok=false 时条目保持标记态，等下个边界重试或运行结束复位。 */
export type CommitPendingAdjustResult =
  | { ok: true; userMessage: ChatMessage; remainingQueue: PendingChatMessage[] }
  | { ok: false; error: "session-not-found" | "not-found" | "run-mismatch" | "write-failed" };

/**
 * 提交一次调整注入：在【一次会话文件写入】内完成——条目移出队列、
 * 转成正式用户消息追加进 messages。与认领同构但不写 pendingDispatch：
 * 调整消息由当前运行直接消费，没有独立的派发 run。
 * 写盘失败时条目保留在队列中（绝不丢消息）。
 */
export function commitPendingAdjust(
  sessionId: string,
  messageId: string,
  runId: string,
): CommitPendingAdjustResult {
  const record = readSessionRecordFile(sessionId);
  if (!record) return { ok: false, error: "session-not-found" };
  const queue = record.pendingMessages ?? [];
  const index = queue.findIndex((item) => item.id === messageId);
  if (index === -1) return { ok: false, error: "not-found" };
  const target = queue[index];
  if (target.adjustRunId !== runId) return { ok: false, error: "run-mismatch" };
  const committedAt = Date.now();
  const userMessage = pendingUserMessage(target, committedAt);
  if (record.schemaVersion === 2) {
    record.pendingMessages = queue.filter((item) => item.id !== messageId);
    try {
      writeSessionRecordFile(record);
    } catch (err) {
      console.warn("[chats-store] v2 待发消息调整提交落盘失败:", sessionId, err);
      return { ok: false, error: "write-failed" };
    }
    return {
      ok: true,
      userMessage,
      remainingQueue: record.pendingMessages.map((item) => ({ ...item })),
    };
  }
  const session = record;
  session.messages = [...session.messages, userMessage];
  session.pendingMessages = queue.filter((item) => item.id !== messageId);
  session.updatedAt = committedAt;
  try {
    writeSessionFile(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息调整提交落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  // 与认领同理：会话文件已写成功即成立，索引失败只告警不推翻结果
  try {
    upsertMeta(metaFromSession(session));
  } catch (err) {
    console.warn("[chats-store] 待发消息调整提交后索引写入失败（会话列表计数可能滞后）:", sessionId, err);
  }
  return {
    ok: true,
    userMessage,
    remainingQueue: session.pendingMessages.map((item) => ({ ...item })),
  };
}

/** 复位结果：reset 为清掉标记的条目数（0 表示无匹配，未写盘）。 */
export type ResetPendingAdjustResult =
  | { ok: true; reset: number }
  | { ok: false; error: "session-not-found" | "write-failed" };

/**
 * 运行终态复位：把标记插入该运行但尚未注入的条目清除标记，
 * 回普通队列按序派发（不改变顺序与内容）。写盘失败时标记保留，
 * 认领派发不依赖该标记，消息不会丢失。
 */
export function resetPendingAdjustByRun(sessionId: string, runId: string): ResetPendingAdjustResult {
  const session = readSessionRecordFile(sessionId);
  if (!session) return { ok: false, error: "session-not-found" };
  const queue = session.pendingMessages ?? [];
  let reset = 0;
  const nextQueue = queue.map((item) => {
    if (item.adjustRunId !== runId) return item;
    const restored = { ...item };
    delete restored.adjustRunId;
    reset++;
    return restored;
  });
  if (reset === 0) return { ok: true, reset: 0 };
  session.pendingMessages = nextQueue;
  try {
    writeWritableSession(session);
  } catch (err) {
    console.warn("[chats-store] 待发消息调整复位落盘失败:", sessionId, err);
    return { ok: false, error: "write-failed" };
  }
  return { ok: true, reset };
}

/**
 * 启动清扫：进程重启后没有任何存活运行，磁盘上遗留的调整标记都是陈旧的，
 * 统一清回普通队列（避免陈旧标记永久阻塞编辑与再次调整）。
 * 由应用启动时的 IPC 注册入口调用一次。
 */
export function clearStalePendingAdjustMarks(): void {
  for (const meta of [...indexCache]) {
    try {
      const session = readSessionRecordFile(meta.id);
      if (!session?.pendingMessages?.some((item) => item.adjustRunId)) continue;
      let changed = false;
      session.pendingMessages = session.pendingMessages.map((item) => {
        if (!item.adjustRunId) return item;
        changed = true;
        const restored = { ...item };
        delete restored.adjustRunId;
        return restored;
      });
      if (changed) writeWritableSession(session);
    } catch (err) {
      console.warn("[chats-store] 清理陈旧调整标记失败:", meta.id, err);
    }
  }
}

export function deleteSession(id: string): boolean {
  const filePath = sessionPath(id);
  let fileExisted = false;
  if (fs.existsSync(filePath)) {
    try {
      fs.unlinkSync(filePath);
      fileExisted = true;
    } catch (err) {
      console.warn("[chats-store] 删除 session 文件失败:", id, err);
    }
  }
  const inIndex = indexCache.some((m) => m.id === id);
  if (inIndex) removeMetaById(id);
  return fileExisted || inIndex;
}

// 返回最新一条会话的 id（按 updatedAt 排）；列表为空返回 null。
export function getLatestSessionId(): string | null {
  if (indexCache.length === 0) return null;
  // indexCache 已按 updatedAt desc 持久化，但保险起见再排一次
  const sorted = [...indexCache].sort((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0].id;
}

// 一次性迁移：从聊天窗口 localStorage 拿来的旧 Message[] 包成单个 session。
// 已经迁移过（再次调用且数据相同）时返回 null 让调用方决定是否提示。
export function migrateLegacyMessages(messages: ChatMessage[]): ChatSession | null {
  if (!messages || messages.length === 0) return null;
  // 过滤掉无意义条目（空 content / 占位）
  const cleaned = messages.filter(
    (m) => m && (m.role === "user" || m.role === "model") && typeof m.content === "string" && m.content.trim(),
  );
  if (cleaned.length === 0) return null;
  const session = createSession({
    title: "历史对话",
    identityId: null,
    initialMessages: cleaned,
    mode: "work",
  });
  return setWorkspaceBinding(session.id, legacyMigrationBinding());
}

// 在系统文件管理器中打开存储目录。
export async function openStorageFolder(): Promise<void> {
  ensureDirs();
  await shell.openPath(rootDir);
}

// ── 对话工作区绑定 ────────────────────────────────────────

import type { ConversationWorkspaceBinding } from "../../shared/chat-types";

/**
 * 设置对话的工作区绑定。
 * 返回更新后的 session，失败返回 null。
 */
export function setWorkspaceBinding(
  sessionId: string,
  binding: ConversationWorkspaceBinding,
): ChatSession | null {
  const session = readSessionRecordFile(sessionId);
  if (!session) return null;
  session.workspaceBinding = binding;
  session.updatedAt = Date.now();
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}

/**
 * 获取对话的工作区绑定。
 * 未绑定返回 undefined。
 */
export function getWorkspaceBinding(sessionId: string): ConversationWorkspaceBinding | undefined {
  const session = readSessionRecordFile(sessionId);
  return session?.workspaceBinding;
}

/**
 * 清除对话的工作区绑定。
 * 返回更新后的 session，失败返回 null。
 */
export function clearWorkspaceBinding(sessionId: string): ChatSession | null {
  const session = readSessionRecordFile(sessionId);
  if (!session) return null;
  session.workspaceBinding = undefined;
  session.updatedAt = Date.now();
  writeWritableSession(session);
  upsertMeta(metaFromSession(session));
  return sessionView(session);
}
