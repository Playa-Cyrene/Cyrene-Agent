import path from "node:path";
import type { ChatMessage } from "../vendors/types";
import type { AgentState, HarnessCacheState, SideEffectKind } from "./types";
import type { ToolOutputRef } from "./tool-output/tool-output-store";
import { getConversationDatabase, type ConversationDatabaseClient } from "../../storage/conversation-database-client";
const LEGACY_SCHEMA_VERSION = 1;
const SCHEMA_VERSION = 2;
export type HarnessRunStatus = "running" | "interrupted" | "completed" | "cancelled" | "failed";
export type PersistedToolCallStatus = "planned" | "started" | "committed" | "unknown" | "not_executed";
export interface HarnessRequestSnapshot {
  provider: string;
  model: string;
  contextWindowTokens: number;
  reasoning?: string;
  mode?: string;
  promptFingerprint: string;
  toolSchemaFingerprint: string;
  enabledToolIds?: string[];
  workspaceRoot?: string;
}
export interface PersistedToolCall {
  toolCallId: string;
  toolName: string;
  sideEffect: SideEffectKind;
  status: PersistedToolCallStatus;
  updatedAt: number;
}
interface HarnessRunMetadataBase {
  conversationId: string;
  runId: string;
  status: HarnessRunStatus;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}
export interface HarnessRunMetadata extends HarnessRunMetadataBase {
  schemaVersion: typeof SCHEMA_VERSION;
}
export interface LegacyHarnessRunSession extends HarnessRunMetadataBase {
  schemaVersion: typeof LEGACY_SCHEMA_VERSION;
  messages: ChatMessage[];
  state: AgentState;
  toolOutputs: ToolOutputRef[];
  toolCalls: PersistedToolCall[];
  rounds: number;
  cache: HarnessCacheState;
  request: HarnessRequestSnapshot;
}
export type HarnessRunSession = HarnessRunMetadata | LegacyHarnessRunSession;
export interface CreateHarnessRunInput {
  conversationId: string;
  runId: string;
}
export interface HarnessRunCheckpoint {
  messages?: ChatMessage[];
  state?: AgentState;
  todoItems?: AgentState["todoItems"];
  toolOutputs?: ToolOutputRef[];
  rounds?: number;
  cache?: HarnessCacheState;
  request?: HarnessRequestSnapshot;
}
export interface HarnessRunStoreOptions {
  now?: () => number;
}
/** Read snapshots serve pure reducers; all write decisions belong to the database worker. */
export class HarnessRunStore {
  private readonly database: ConversationDatabaseClient;
  private readonly now: () => number;
  private records = new Map<string, HarnessRunSession>();
  readonly ready: Promise<void>;
  constructor(userDataRoot: string, options: HarnessRunStoreOptions = {}) {
    this.database = getConversationDatabase(userDataRoot);
    this.now = options.now ?? Date.now;
    this.ready = this.refresh();
    // The caller still awaits ready; an eager shared reader must not emit an unhandled rejection.
    void this.ready.catch(() => {});
  }
  async refresh(): Promise<void> {
    const records = await this.database.call<Array<HarnessRunSession | (Omit<HarnessRunMetadata, "status"> & {
      status: "prepared";
    })>>("runs.all");
    this.records = new Map(records.map(record => [record.runId, record.status === "prepared" ? { ...record, status: "running" as const } : record]));
  }
  async create(input: CreateHarnessRunInput): Promise<HarnessRunSession> {
    await this.ready;
    const record = await this.database.call<HarnessRunSession>("runs.create", input, this.now());
    this.records.set(record.runId, record);
    return structuredClone(record);
  }
  get(runId: string): HarnessRunSession | null {
    return structuredClone(this.records.get(runId) ?? null);
  }
  checkpoint(_runId: string, _patch: HarnessRunCheckpoint): never { throw new Error("HARNESS_RUN_CHECKPOINT_DISABLED"); }
  recordTool(_runId: string, _input: Omit<PersistedToolCall, "updatedAt">): never { throw new Error("HARNESS_RUN_TOOL_LIFECYCLE_DISABLED"); }
  recordCompaction(_runId: string, _input: {
    status: "started" | "committed";
    messageCountBefore: number;
    messageCountAfter?: number;
  }): void {
    // Compaction facts are already committed to the canonical transcript.
  }
  async markTerminal(runId: string, status: Exclude<HarnessRunStatus, "running" | "interrupted">): Promise<HarnessRunSession> {
    const record = await this.database.call<HarnessRunSession>("runs.terminal", runId, status, this.now());
    this.records.set(runId, record);
    return structuredClone(record);
  }
  async deleteConversation(conversationId: string): Promise<void> {
    await this.database.call("runs.delete", conversationId);
    for (const [id, record] of this.records)
      if (record.conversationId === conversationId)
        this.records.delete(id);
  }
  listInterruptedRuns(conversationId?: string): HarnessRunSession[] {
    return [...this.records.values()].filter(record => record.status === "interrupted" && (!conversationId || record.conversationId === conversationId))
      .sort((a, b) => a.createdAt - b.createdAt).map(record => structuredClone(record));
  }
}
const sharedStores = new Map<string, HarnessRunStore>();
export function getHarnessRunStore(userDataRoot: string): HarnessRunStore {
  const key = path.resolve(userDataRoot);
  let store = sharedStores.get(key);
  if (!store) {
    store = new HarnessRunStore(key);
    sharedStores.set(key, store);
  }
  return store;
}
