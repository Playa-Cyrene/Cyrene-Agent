import { randomUUID } from "node:crypto";
import { getConversationDatabase, type ConversationDatabaseClient } from "../storage/conversation-database-client";
import type {
  TaskSession,
  TaskSessionStatus,
  TaskSubagentType,
  TaskTraceRecord,
  TodoItem,
} from "../../shared/task-session";

export interface CreateTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  companionId?: string;
  mode: "work" | "code";
  resolvedWorkspaceRoot?: string;
}

export interface ResumeTaskSessionInput {
  parentConversationId: string;
  parentRunId: string;
  subagentType: TaskSubagentType;
  prompt: string;
  companionId?: string;
}

export interface TaskSessionCheckpoint {
  parentRunId?: string;
  childRunId?: string;
  status?: TaskSessionStatus;
  // messages 已退役：对话事实归 SQLite transcript 增量写入，
  // resume 的历史由 task-transcript-projection 重投影。字段仍留在
  // TaskSession 上（create/resume 的种子 + 旧文件回退读取），但不再随 checkpoint 更新。
  trace?: TaskTraceRecord[];
  todoItems?: TodoItem[];
  resultText?: string;
  error?: { code: string; message: string };
  completedAt?: number;
}

export interface TaskSessionStoreOptions {
  now?: () => number;
  createId?: () => string;
  createChildRunId?: () => string;
}

/**
 * Task 私有会话存储（SQLite facade）。
 *
 * 自 v5 迁移起，task_sessions / task_trace 与会话轨迹共用 cyrene.sqlite
 * （同一 worker 连接、同一迁移与对账机制）；旧 JSON 文件由 worker 启动时
 * 一次性只读导入，源文件保留。
 *
 * 注意：全部方法为 async（SQLite 调用在 worker 线程执行，主进程不得同步读写）。
 * 业务语义与退役的 JSON 实现一致；守卫错误码不变（TASK_PARENT_MISMATCH 等，
 * 由 ConversationStoreError 携带）。
 */
export class TaskSessionStore {
  private readonly database: ConversationDatabaseClient;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly createChildRunId: () => string;

  constructor(root: string, options: TaskSessionStoreOptions = {}) {
    this.database = getConversationDatabase(root);
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.createChildRunId = options.createChildRunId ?? randomUUID;
  }

  async create(input: CreateTaskSessionInput): Promise<TaskSession> {
    const now = this.now();
    const session: TaskSession = {
      schemaVersion: 1,
      id: this.createId(),
      parentConversationId: input.parentConversationId,
      parentRunId: input.parentRunId,
      childRunId: this.createChildRunId(),
      description: input.description,
      subagentType: input.subagentType,
      companionId: input.companionId,
      contextOpen: true,
      mode: input.mode,
      ...(input.resolvedWorkspaceRoot ? { resolvedWorkspaceRoot: input.resolvedWorkspaceRoot } : {}),
      status: "running",
      messages: [{ role: "user", content: input.prompt }],
      trace: [],
      todoItems: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.database.call<TaskSession>("tasks.insert", session);
  }

  async get(taskId: string): Promise<TaskSession | null> {
    return this.database.call<TaskSession | null>("tasks.get", taskId);
  }

  async findOpenByCompanion(parentConversationId: string, companionId: string): Promise<TaskSession | null> {
    return this.database.call<TaskSession | null>("tasks.findOpenByCompanion", parentConversationId, companionId);
  }

  async listOpenCompanions(parentConversationId: string): Promise<string[]> {
    return this.database.call<string[]>("tasks.listOpenCompanions", parentConversationId);
  }

  async closeByCompanion(parentConversationId: string, companionId: string): Promise<TaskSession> {
    return this.database.call<TaskSession>("tasks.closeByCompanion", parentConversationId, companionId, this.now());
  }

  async listForParent(parentConversationId: string): Promise<TaskSession[]> {
    return this.database.call<TaskSession[]>("tasks.listForParent", parentConversationId);
  }

  async resume(taskId: string, input: ResumeTaskSessionInput): Promise<TaskSession> {
    return this.database.call<TaskSession>("tasks.resume", taskId, input, this.createChildRunId(), this.now());
  }

  async checkpoint(taskId: string, patch: TaskSessionCheckpoint): Promise<TaskSession> {
    return this.database.call<TaskSession>("tasks.checkpoint", taskId, patch, this.now());
  }
}

// 类型再导出：退役前这些类型从此文件出发，消费方 import 路径不变。
export type {
  TaskSessionStatus,
  TaskSubagentType,
  TaskTraceRecord,
  TodoItem,
};

const storesByRoot = new Map<string, TaskSessionStore>();

export function getTaskSessionStore(root: string): TaskSessionStore {
  const key = root;
  let store = storesByRoot.get(key);
  if (!store) {
    store = new TaskSessionStore(root);
    storesByRoot.set(key, store);
  }
  return store;
}
