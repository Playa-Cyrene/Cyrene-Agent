import type { ChatSessionMeta, ConversationMode } from "../../shared/chat-types";
import { reduceTranscriptProjection } from "../orchestrator/conversation-transcript-projection";
import type { ConversationTranscriptStore } from "../orchestrator/conversation-transcript-store";
import type { TranscriptEntry } from "../orchestrator/conversation-transcript-types";
import type { ChatMessageContent } from "../orchestrator/vendors/types";
import { wikiChatSourceId } from "./wiki-page";
import { workspaceScope } from "./wiki-paths";

type WikiSessionMeta = Pick<ChatSessionMeta, "id" | "mode" | "workspaceRoot" | "purpose">;
type WikiChatRole = "user" | "assistant";

/** A canonical, currently active transcript row. Source IDs identify exact revisions. */
export interface WikiChatSourceMessage {
  sourceId: string;
  /** Groups edits of the same user turn, or rounds of the same assistant turn. */
  logicalId: string;
  conversationId: string;
  entryId: string;
  turnId?: string;
  roundId?: string;
  revision: number;
  seq: number;
  at: number;
  role: WikiChatRole;
  text: string;
  /** An assistant row without tool calls; a complete turn still needs a visible reply. */
  isFinalReply?: boolean;
}

export interface WikiChatSourceTurn {
  user: WikiChatSourceMessage;
  assistants: WikiChatSourceMessage[];
}

export interface WikiChatSourceConversation {
  conversationId: string;
  mode: ConversationMode;
  /** Canonical bound workspace path; absent for unbound conversations. */
  workspaceRoot?: string;
  /** Stable local identity for a bound workspace, derived from its canonical path. */
  workspaceId?: string;
  throughSeq: number;
  /** Active, text-bearing user and assistant messages in conversation order. */
  messages: WikiChatSourceMessage[];
  /** Use this full set to invalidate sources lost to an edit, rewind, or tombstone. */
  activeSourceIds: string[];
  /** Only turns with a visible final assistant reply. */
  turns: WikiChatSourceTurn[];
}

export interface WikiChatSourceReaderDeps {
  transcriptStore: Pick<ConversationTranscriptStore, "readAuditEntries">;
  /** The session index is authoritative for existence and workspace binding. */
  listSessions: () => (readonly WikiSessionMeta[]) | Promise<readonly WikiSessionMeta[]>;
  /** Migrate unopened v1 sessions before historical backfill reads their journal. */
  ensureConversationMigrated: (conversationId: string) => Promise<unknown>;
}

function logicalId(conversationId: string, role: WikiChatRole, turnId: string): string {
  return JSON.stringify(["chat", conversationId, role, turnId]);
}

function contentToText(content: ChatMessageContent | undefined): string {
  if (typeof content === "string") return content;
  return content?.filter((part) => part.type === "text").map((part) => part.text).join("") ?? "";
}

function entryToMessage(conversationId: string, entry: TranscriptEntry): WikiChatSourceMessage | null {
  let role: WikiChatRole;
  let text: string;
  if (entry.kind === "user") {
    role = "user";
    text = entry.payload.text;
  } else if (entry.kind === "turn_rewind" && entry.payload.disposition === "replace_user") {
    role = "user";
    text = entry.payload.replacementUser?.text ?? "";
  } else if (entry.kind === "assistant" && entry.payload.role === "assistant" && entry.payload.visibility !== "internal") {
    role = "assistant";
    text = contentToText(entry.payload.content);
  } else {
    return null;
  }
  if (!text.trim()) return null;
  return {
    sourceId: wikiChatSourceId(conversationId, entry.id, entry.revision ?? 1),
    logicalId: logicalId(conversationId, role, entry.turnId ?? entry.id),
    conversationId,
    entryId: entry.id,
    ...(entry.turnId ? { turnId: entry.turnId } : {}),
    ...(entry.roundId ? { roundId: entry.roundId } : {}),
    revision: entry.revision ?? 1,
    seq: entry.seq,
    at: entry.at,
    role,
    text,
    ...(role === "assistant" ? { isFinalReply: entry.kind === "assistant" && !entry.payload.toolCalls?.length } : {}),
  };
}

/**
 * Reads the full audit stream (including archives), then applies the same
 * branch reducer as chat UI. The model-context reader drops archived history
 * and inserts recovery notes, so it cannot serve as a wiki source reader.
 */
export class WikiChatSourceReader {
  constructor(private readonly deps: WikiChatSourceReaderDeps) {}

  async listConversationIds(): Promise<string[]> {
    return (await this.deps.listSessions()).map((session) => session.id);
  }

  async readConversation(conversationId: string): Promise<WikiChatSourceConversation | null> {
    if (!(await this.sessionMeta(conversationId))) return null;
    if (await this.deps.ensureConversationMigrated(conversationId) === null) return null;
    const entries = await this.deps.transcriptStore.readAuditEntries(conversationId);
    // A deletion may race the audit read; do not return data from a removed session.
    const session = await this.sessionMeta(conversationId);
    if (!session) return null;

    const projection = reduceTranscriptProjection(entries);
    if (!projection.state) throw new Error("WIKI_SOURCE_PROJECTION_STATE_MISSING");
    const activeEntryIds = new Set(projection.state.nodes.map((node) => node.entryId));
    const byEntryId = new Map<string, TranscriptEntry>();
    for (const entry of entries) {
      if (activeEntryIds.has(entry.id)) byEntryId.set(entry.id, entry);
    }
    const selectedMessages: (WikiChatSourceMessage | null)[] = [];
    const assistantIndexes = new Map<string, number>();
    let currentUserId: string | undefined;
    for (const node of projection.state.nodes) {
      if (node.kind === "compaction") continue;
      const entry = byEntryId.get(node.entryId);
      if (!entry) throw new Error("WIKI_SOURCE_ACTIVE_ENTRY_MISSING");
      const message = entryToMessage(conversationId, entry);
      if (node.kind === "user") {
        // Even an attachment-only user turn separates adjacent assistant turns.
        currentUserId = node.entryId;
        if (message?.role === "user") selectedMessages.push(message);
        continue;
      }
      if (entry.kind !== "assistant") throw new Error("WIKI_SOURCE_ACTIVE_ENTRY_KIND_MISMATCH");
      // Multiple canonical assistant rounds share one assistant turn. Match the
      // UI's latest-round semantics so obsolete intermediate text is not learned.
      const groupKey = JSON.stringify([currentUserId ?? "", entry.turnId ?? entry.id]);
      const existingIndex = assistantIndexes.get(groupKey);
      if (existingIndex === undefined) {
        assistantIndexes.set(groupKey, selectedMessages.length);
        selectedMessages.push(message?.role === "assistant" ? message : null);
      } else {
        selectedMessages[existingIndex] = message?.role === "assistant" ? message : null;
      }
    }
    const messages = selectedMessages.filter((message): message is WikiChatSourceMessage => message !== null);

    const turns: WikiChatSourceTurn[] = [];
    let pending: WikiChatSourceTurn | undefined;
    for (const message of messages) {
      if (message.role === "user") {
        if (pending?.assistants.some((assistant) => assistant.isFinalReply)) turns.push(pending);
        pending = { user: message, assistants: [] };
      } else if (pending) {
        pending.assistants.push(message);
      }
    }
    if (pending?.assistants.some((assistant) => assistant.isFinalReply)) turns.push(pending);

    return {
      conversationId,
      mode: session.mode,
      ...(session.workspaceRoot ? {
        workspaceRoot: session.workspaceRoot,
        workspaceId: workspaceScope(session.workspaceRoot).workspaceId,
      } : {}),
      throughSeq: projection.throughSeq,
      messages,
      activeSourceIds: messages.map((message) => message.sourceId),
      turns,
    };
  }

  /** Resolve a quoted chat source only while its exact revision stays active. */
  async readSource(conversationId: string, id: string): Promise<WikiChatSourceMessage | null> {
    const conversation = await this.readConversation(conversationId);
    return conversation?.messages.find((message) => message.sourceId === id) ?? null;
  }

  private async sessionMeta(conversationId: string): Promise<WikiSessionMeta | undefined> {
    return (await this.deps.listSessions()).find((session) => session.id === conversationId);
  }
}

export function createWikiChatSourceReader(deps: WikiChatSourceReaderDeps): WikiChatSourceReader {
  return new WikiChatSourceReader(deps);
}
