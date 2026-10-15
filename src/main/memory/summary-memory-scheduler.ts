import path from "node:path";
import fs from "node:fs/promises";
import type { ChatSessionRecord, SummaryMemoryPendingTurn, SummaryMemoryProgress } from "../../shared/chat-types";
import { isSummaryMemoryEnabled } from "./memory-mode";
import { resolveSummaryMemoryPaths } from "./summary-memory-paths";
import { readSummaryFile, writeSummaryFileAtomic } from "./summary-memory-store";
import { summarizeMemory } from "./summary-memory-llm";

export interface SummaryMemoryProgressStore {
  getSessionRecord(id: string): (ChatSessionRecord | null) | Promise<ChatSessionRecord | null>;
  getSummaryMemoryProgress(id: string): (SummaryMemoryProgress | undefined) | Promise<SummaryMemoryProgress | undefined>;
  appendSummaryMemoryTurn(id: string, turn: SummaryMemoryPendingTurn): (boolean) | Promise<boolean>;
  markSummaryMemoryProcessed(id: string, processedTurns: Array<{ assistantEntryId: string }>): (boolean) | Promise<boolean>;
  listSessions(): (Array<{ id: string }>) | Promise<Array<{ id: string }>>;
}

export interface SummaryMemorySchedulerOptions {
  userDataRoot: string;
  sessions: SummaryMemoryProgressStore;
  onError?: (conversationId: string, error: unknown) => void;
}

type QueueMap = Map<string, Promise<unknown>>;

export class SummaryMemoryScheduler {
  private enabled = false;
  private generation = 0;
  private readonly sessionQueues: QueueMap = new Map();
  private readonly workspaceQueues: QueueMap = new Map();
  private readonly abortControllers = new Set<AbortController>();
  private readonly cancelledSessions = new Set<string>();

  constructor(private readonly options: SummaryMemorySchedulerOptions) {}

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (!enabled) {
      for (const controller of this.abortControllers) controller.abort();
      this.abortControllers.clear();
    }
  }

  async scheduleSummaryTurn(input: {
    conversationId: string;
    assistantEntryId: string;
    userTurnId?: string;
    userText: string;
    assistantText: string;
  }): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(input.conversationId) || !input.assistantEntryId) return;
    try {
      const recorded = (await this.options.sessions.appendSummaryMemoryTurn(input.conversationId, {
        assistantEntryId: input.assistantEntryId,
        ...(input.userTurnId ? { userTurnId: input.userTurnId } : {}),
        userText: input.userText,
        assistantText: input.assistantText,
      }));
      if (!recorded) return;
      const progress = (await this.options.sessions.getSummaryMemoryProgress(input.conversationId));
      if ((progress?.pendingTurns.length ?? 0) >= 10) {
        void this.flushSummary(input.conversationId).catch((error) => this.reportError(input.conversationId, error));
      }
    } catch (error) {
      this.reportError(input.conversationId, error);
    }
  }

  flushSummary(conversationId: string): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(conversationId)) return Promise.resolve();
    return this.enqueue(this.sessionQueues, conversationId, () => this.flushOne(conversationId));
  }

  async flushAll(): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled()) return;
    await Promise.all((await this.options.sessions.listSessions()).map(({ id }) => (
      this.flushSummary(id).catch((error) => this.reportError(id, error))
    )));
  }

  async cancelSession(conversationId: string): Promise<void> {
    this.cancelledSessions.add(conversationId);
    const active = [...this.abortControllers];
    // Session deletion invalidates the current generation only for this session.
    for (const controller of active) {
      if ((controller as AbortController & { __summarySessionId?: string }).__summarySessionId === conversationId) {
        controller.abort();
        this.abortControllers.delete(controller);
      }
    }
    await this.sessionQueues.get(conversationId)?.catch(() => undefined);
  }

  releaseSessionCancellation(conversationId: string): void {
    this.cancelledSessions.delete(conversationId);
  }

  dispose(): void {
    this.setEnabled(false);
  }

  private async flushOne(conversationId: string): Promise<void> {
    if (!this.enabled || !isSummaryMemoryEnabled() || this.cancelledSessions.has(conversationId)) return;
    const generation = this.generation;
    const session = (await this.options.sessions.getSessionRecord(conversationId));
    if (!session) return;
    const progress = (await this.options.sessions.getSummaryMemoryProgress(conversationId));
    const turns = progress?.pendingTurns ?? [];
    if (turns.length === 0) return;
    const paths = resolveSummaryMemoryPaths({ conversationId, userDataRoot: this.options.userDataRoot, session });
    const isCurrentTarget = () => this.isCurrentTarget(
      conversationId,
      generation,
      paths.sessionPath,
      paths.workspacePath,
    );
    const workspaceRoot = paths.workspacePath
      ? path.resolve(session.workspaceBinding!.workspaceRoot)
      : path.resolve(this.options.userDataRoot);
    const workspaceKey = paths.workspacePath
      ? await fs.realpath(session.workspaceBinding!.workspaceRoot)
        .then((root) => path.join(root, ".cyrene", "memory", "workspace.md"))
        .catch(() => path.resolve(paths.workspacePath!))
      : `session:${conversationId}`;
    await this.enqueue(this.workspaceQueues, workspaceKey, async () => {
      if (!this.isCurrent(conversationId, generation)) return;
      const sessionFile = await readSummaryFile(paths.sessionPath, 800, workspaceRoot);
      const workspaceFile = paths.workspacePath
        ? await readSummaryFile(paths.workspacePath, 1200, workspaceRoot)
        : { content: "", truncated: false };
      const controller = new AbortController() as AbortController & { __summarySessionId?: string };
      controller.__summarySessionId = conversationId;
      this.abortControllers.add(controller);
      let result: Awaited<ReturnType<typeof summarizeMemory>>;
      try {
        result = await summarizeMemory({
          sessionSummary: sessionFile.content,
          workspaceSummary: workspaceFile.content,
          turns: turns.map(({ userText, assistantText }) => ({ userText, assistantText })),
          hasWorkspace: Boolean(paths.workspacePath),
          signal: controller.signal,
        });
      } finally {
        this.abortControllers.delete(controller);
      }
      if (!(await isCurrentTarget())) return;

      // Write the project-level file first. Repeated retries replace complete summaries,
      // so a crash between file writes cannot duplicate source turns in either file.
      if (paths.workspacePath && result.workspaceSummary && result.workspaceSummary !== workspaceFile.content) {
        await writeSummaryFileAtomic(paths.workspacePath, result.workspaceSummary, 1200, workspaceRoot, isCurrentTarget);
      }
      if (!(await isCurrentTarget())) return;
      if (result.sessionSummary !== sessionFile.content) {
        await writeSummaryFileAtomic(paths.sessionPath, result.sessionSummary, 800, workspaceRoot, isCurrentTarget);
      }
      if (!(await isCurrentTarget())) return;
      (await this.options.sessions.markSummaryMemoryProcessed(conversationId, turns.map(({ assistantEntryId }) => ({ assistantEntryId }))));
    });
  }

  private async isCurrent(conversationId: string, generation: number): Promise<boolean> {
    return this.enabled && isSummaryMemoryEnabled() && generation === this.generation
      && !this.cancelledSessions.has(conversationId)
      && (await this.options.sessions.getSessionRecord(conversationId)) !== null;
  }

  private async isCurrentTarget(
    conversationId: string,
    generation: number,
    expectedSessionPath: string,
    expectedWorkspacePath?: string,
  ): Promise<boolean> {
    if (!this.isCurrent(conversationId, generation)) return false;
    const session = (await this.options.sessions.getSessionRecord(conversationId));
    if (!session) return false;
    try {
      const currentPaths = resolveSummaryMemoryPaths({
        conversationId,
        userDataRoot: this.options.userDataRoot,
        session,
      });
      return currentPaths.sessionPath === expectedSessionPath
        && currentPaths.workspacePath === expectedWorkspacePath;
    } catch {
      return false;
    }
  }

  private enqueue<T>(queues: QueueMap, key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(operation);
    const settled = next.finally(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    queues.set(key, settled);
    return next;
  }

  private reportError(conversationId: string, error: unknown): void {
    this.options.onError?.(conversationId, error);
    if (!this.options.onError) console.warn("[SummaryMemory] background update failed:", conversationId, error);
  }
}

let scheduler: SummaryMemoryScheduler | null = null;

export function initializeSummaryMemoryScheduler(options: SummaryMemorySchedulerOptions): SummaryMemoryScheduler {
  scheduler?.dispose();
  scheduler = new SummaryMemoryScheduler(options);
  return scheduler;
}

export function enableSummaryMemoryScheduler(enabled: boolean): void {
  scheduler?.setEnabled(enabled);
}

export function scheduleSummaryTurn(input: Parameters<SummaryMemoryScheduler["scheduleSummaryTurn"]>[0]): void {
  scheduler?.scheduleSummaryTurn(input);
}

export function flushSummaryMemory(conversationId: string): Promise<void> {
  return scheduler?.flushSummary(conversationId) ?? Promise.resolve();
}

export function flushAllSummaryMemory(): Promise<void> {
  return scheduler?.flushAll() ?? Promise.resolve();
}

export function cancelSummaryMemorySession(conversationId: string): Promise<void> {
  return scheduler?.cancelSession(conversationId) ?? Promise.resolve();
}

export function releaseSummaryMemorySessionCancellation(conversationId: string): void {
  scheduler?.releaseSessionCancellation(conversationId);
}

export async function disposeSummaryMemoryScheduler(): Promise<void> {
  scheduler?.dispose();
  scheduler = null;
}
