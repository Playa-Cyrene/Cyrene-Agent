import { isWikiMemoryEnabled } from "./memory-mode";
import { extractWikiClaims } from "./wiki-memory-llm";
import type { WikiChatSourceReader, WikiChatSourceTurn } from "./wiki-source";
import { WikiStore } from "./wiki-store";
import { markWikiSourcesFresh, markWikiSourcesStale } from "./wiki-memory-health";

export interface WikiMemorySchedulerOptions {
  userDataRoot: string;
  sourceReader: WikiChatSourceReader;
  onError?: (conversationId: string, error: unknown) => void;
}

/** Extract in the background; one conversation queue and one global store writer. */
export class WikiMemoryScheduler {
  readonly store: WikiStore;
  private enabled = false;
  private generation = 0;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly completedTurns = new Map<string, number>();
  private readonly idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly cancelled = new Set<string>();

  constructor(private readonly options: WikiMemorySchedulerOptions) {
    this.store = new WikiStore(options.userDataRoot);
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.generation++;
    if (!enabled) {
      for (const timer of this.idleTimers.values()) clearTimeout(timer);
      this.idleTimers.clear();
      for (const controller of this.controllers.values()) controller.abort();
      await Promise.allSettled(this.queues.values());
      await this.store.close();
      return;
    }
    void this.backfill().catch((error) => this.reportError("backfill", error));
  }

  scheduleTurn(input: { conversationId: string; userText?: string }): void {
    if (!this.enabled || !isWikiMemoryEnabled() || this.cancelled.has(input.conversationId)) return;
    const count = (this.completedTurns.get(input.conversationId) ?? 0) + 1;
    this.completedTurns.set(input.conversationId, count);
    const priority = /记住|记一下|记下来|更新记忆|写入记忆|更新维基|保存到维基|之前说错|纠正|其实是|改成|搬到/.test(input.userText ?? "");
    const previousTimer = this.idleTimers.get(input.conversationId);
    if (previousTimer) clearTimeout(previousTimer);
    this.idleTimers.delete(input.conversationId);
    if (count >= 10 || priority) {
      this.completedTurns.set(input.conversationId, 0);
      void this.flushConversation(input.conversationId, true).catch((error) => this.reportError(input.conversationId, error));
    } else {
      void this.refreshSources(input.conversationId).catch((error) => this.reportError(input.conversationId, error));
      const timer = setTimeout(() => {
        this.idleTimers.delete(input.conversationId);
        this.completedTurns.set(input.conversationId, 0);
        void this.flushConversation(input.conversationId, true)
          .catch((error) => this.reportError(input.conversationId, error));
      }, 2 * 60_000);
      timer.unref?.();
      this.idleTimers.set(input.conversationId, timer);
    }
  }

  async flushConversation(conversationId: string, force = false): Promise<void> {
    if (!this.enabled || !isWikiMemoryEnabled() || this.cancelled.has(conversationId)) return;
    return this.enqueue(conversationId, () => this.processConversation(conversationId, force));
  }

  async refreshConversationSources(conversationId: string): Promise<void> {
    if (!this.enabled || !isWikiMemoryEnabled() || this.cancelled.has(conversationId)) return;
    try { await this.refreshSources(conversationId); }
    catch (error) { this.reportError(conversationId, error); }
  }

  async flushAll(): Promise<void> {
    if (!this.enabled || !isWikiMemoryEnabled()) return;
    for (const id of (await this.options.sourceReader.listConversationIds())) {
      try { await this.flushConversation(id, true); }
      catch (error) { this.reportError(id, error); }
    }
  }

  async cancelSession(conversationId: string): Promise<void> {
    this.cancelled.add(conversationId);
    const timer = this.idleTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(conversationId);
    this.controllers.get(conversationId)?.abort();
    await this.queues.get(conversationId)?.catch(() => undefined);
  }

  async releaseSessionCancellation(conversationId: string): Promise<void> {
    this.cancelled.delete(conversationId);
    if (!(await this.options.sourceReader.listConversationIds()).includes(conversationId)) markWikiSourcesFresh(conversationId);
  }

  private async backfill(): Promise<void> {
    // Yield to startup and process old sessions one at a time. Progress is durable.
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    const liveIds = new Set((await this.options.sourceReader.listConversationIds()));
    for (const id of await this.store.listTombstonedConversations()) {
      if (!this.enabled || !isWikiMemoryEnabled()) return;
      // A crash between tombstoning and chat deletion leaves a live session.
      // Keep its sources hidden until the deletion flow explicitly rolls back.
      if (!liveIds.has(id)) await this.store.reconcileConversationSources(id, []);
    }
    for (const id of liveIds) {
      if (!this.enabled || !isWikiMemoryEnabled()) break;
      try { await this.flushConversation(id, true); }
      catch (error) { this.reportError(id, error); }
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }

  private async refreshSources(conversationId: string): Promise<void> {
    try {
      let completed = false;
      await this.enqueue(conversationId, async () => {
        if (!(await this.isCurrent(conversationId, this.generation))) return;
        const conversation = await this.options.sourceReader.readConversation(conversationId);
        if (conversation) {
          await this.store.reconcileConversationSources(conversationId, conversation.activeSourceIds);
          completed = true;
        }
      });
      if (completed) markWikiSourcesFresh(conversationId);
    } catch (error) {
      markWikiSourcesStale(conversationId);
      throw error;
    }
  }

  private async processConversation(conversationId: string, force: boolean): Promise<void> {
    const generation = this.generation;
    if (!(await this.isCurrent(conversationId, generation))) return;
    let conversation = await this.options.sourceReader.readConversation(conversationId);
    if (!conversation || !(await this.isCurrent(conversationId, generation))) return;
    try {
      await this.store.reconcileConversationSources(conversationId, conversation.activeSourceIds);
      markWikiSourcesFresh(conversationId);
    } catch (error) {
      markWikiSourcesStale(conversationId);
      throw error;
    }
    let processed = await this.store.getProcessedSeq(conversationId);
    const pending = conversation.turns
      .map((turn) => ({ turn, seq: Math.max(turn.user.seq, ...turn.assistants.map((assistant) => assistant.seq)) }))
      .filter((item) => item.seq > processed)
      .sort((a, b) => a.seq - b.seq);
    if (pending.length < 10 && !force) return;
    for (let start = 0; start < pending.length; start += 10) {
      if (!(await this.isCurrent(conversationId, generation))) return;
      const batch = pending.slice(start, start + 10);
      const turns: WikiChatSourceTurn[] = batch.map((item) => item.turn);
      const controller = new AbortController();
      this.controllers.set(conversationId, controller);
      let candidates;
      try {
        candidates = await extractWikiClaims({ conversation, turns, signal: controller.signal });
      } finally {
        if (this.controllers.get(conversationId) === controller) this.controllers.delete(conversationId);
      }
      if (!(await this.isCurrent(conversationId, generation))) return;
      const latest = await this.options.sourceReader.readConversation(conversationId);
      if (!latest || latest.workspaceRoot !== conversation.workspaceRoot || latest.mode !== conversation.mode) return;
      const active = new Set(latest.activeSourceIds);
      if (turns.some((turn) => !active.has(turn.user.sourceId) || turn.assistants.some((assistant) => !active.has(assistant.sourceId)))) {
        try {
          await this.store.reconcileConversationSources(conversationId, latest.activeSourceIds);
          markWikiSourcesFresh(conversationId);
        } catch (error) {
          markWikiSourcesStale(conversationId);
          throw error;
        }
        return;
      }
      await this.store.applyClaims(candidates, { shouldCommit: () => this.isCurrent(conversationId, generation) });
      if (!(await this.isCurrent(conversationId, generation))) return;
      processed = Math.max(processed, ...batch.map((item) => item.seq));
      await this.store.markProcessedSeq(conversationId, processed);
      conversation = latest;
    }
    if (pending.length === 0 && conversation.throughSeq > processed) {
      await this.store.markProcessedSeq(conversationId, conversation.throughSeq);
    }
  }

  private async isCurrent(conversationId: string, generation: number): Promise<boolean> {
    return this.enabled && isWikiMemoryEnabled() && generation === this.generation &&
      !this.cancelled.has(conversationId) && (await this.options.sourceReader.listConversationIds()).includes(conversationId);
  }

  private enqueue(conversationId: string, work: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.finally(() => {
      if (this.queues.get(conversationId) === settled) this.queues.delete(conversationId);
    });
    this.queues.set(conversationId, settled);
    return next;
  }

  private reportError(conversationId: string, error: unknown): void {
    this.options.onError?.(conversationId, error);
    if (!this.options.onError) console.warn("[WikiMemory] background update failed:", conversationId, error);
  }
}

let scheduler: WikiMemoryScheduler | null = null;

export function initializeWikiMemoryScheduler(options: WikiMemorySchedulerOptions): WikiMemoryScheduler {
  scheduler = new WikiMemoryScheduler(options);
  return scheduler;
}

export function getWikiMemoryStore(): WikiStore | null { return scheduler?.store ?? null; }
export function enableWikiMemoryScheduler(enabled: boolean): Promise<void> { return scheduler?.setEnabled(enabled) ?? Promise.resolve(); }
export function scheduleWikiTurn(input: Parameters<WikiMemoryScheduler["scheduleTurn"]>[0]): void { scheduler?.scheduleTurn(input); }
export function refreshWikiMemorySources(id: string): Promise<void> { return scheduler?.refreshConversationSources(id) ?? Promise.resolve(); }
export function flushAllWikiMemory(): Promise<void> { return scheduler?.flushAll() ?? Promise.resolve(); }
export function cancelWikiMemorySession(id: string): Promise<void> { return scheduler?.cancelSession(id) ?? Promise.resolve(); }
export function releaseWikiMemorySessionCancellation(id: string): void { scheduler?.releaseSessionCancellation(id); }
