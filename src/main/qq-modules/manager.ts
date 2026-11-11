import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { negotiateQqApi, QQ_API_SUPPORT, QQ_RUNTIME_TIMEOUTS, validateRequestPayload, validateRuntimeConfig, validateSendRequest,
  type QqBackendStatus, type QqCapabilitySnapshot, type QqInboundAck, type QqInboundMessageV1, type QqInitialize,
  type QqRuntimeConfig, type QqSendRequestV1, type QqSendResultV1 } from "../../shared/qq-module";
import { isLoopbackHost } from "../channels/qq-listen-policy";
import type { IncomingMessage, MessageHandler, OutgoingMessage } from "../channels/types";
import { QqMediaBroker } from "./media-broker";
import { QqModuleRuntime, QqRuntimeError, type QqProcessTransport } from "./runtime";

export type QqModulePhase = "disabled" | "module-missing" | "config-missing" | "starting" | "waiting-backend" | "running" | "draining" | "stopped" | "incompatible" | "account-mismatch" | "crashed" | "failed";
export interface QqModuleState { phase: QqModulePhase; runtimeEpoch: number; enabled: boolean }
interface Generation {
  runtime: QqModuleRuntime;
  config: QqRuntimeConfig;
  policy: QqRuntimeConfig;
  capabilities: QqCapabilitySnapshot | null;
  connectionEpoch?: number;
  highestConnectionEpoch: number;
  startComplete: boolean;
  pendingStatus?: QqBackendStatus;
  accepting: boolean;
  mediaEpoch: number;
  mediaAbort: AbortController;
  authorized: boolean;
  seen: Set<string>;
  turns: Set<Promise<unknown>>;
  sends: Set<Promise<unknown>>;
}
interface TurnLease { active: boolean; generation: Generation; connectionEpoch: number; conversation: QqInboundMessageV1["conversation"] }
export interface QqModuleManagerOptions {
  /** null means explicitly disabled; no configuration is read during construction. */
  getConfiguration: () => QqInitialize | null;
  /** Supplied only by trusted host composition, never renderer input. Absent = not installed. */
  createTransport?: () => QqProcessTransport;
  /** Explicit trusted host composition; absence disables every media capability. */
  mediaBroker?: QqMediaBroker;
  requestTimeoutMs?: number;
  /** Dedicated delivery budget; control RPC timeout must not truncate text chunks. */
  sendTimeoutMs?: number;
  drainTimeoutMs?: number;
}
const NO_CAPABILITIES: QqCapabilitySnapshot = { messages: { text: false, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, reply: false, mention: false, maxTextLength: 0, maxFileBytes: 0 }, backend: { napcatStream: false } };

/** Exclusive QQ driver lifecycle. Does not own agents, session IDs, history or tools.
 * This opt-in runtime is intentionally not registered by initializeChannels yet. */
export class QqModuleManager {
  onMessage: MessageHandler | null = null;
  private state: QqModuleState = { phase: "disabled", runtimeEpoch: 0, enabled: false };
  private current?: Generation;
  private sequence = Promise.resolve();
  private readonly context = new AsyncLocalStorage<TurnLease>();
  constructor(private readonly options: QqModuleManagerOptions) {}
  getState(): QqModuleState { return { ...this.state }; }
  getCapabilities(): QqCapabilitySnapshot {
    const cap = this.current?.capabilities ?? NO_CAPABILITIES;
    const media = Boolean(this.options.mediaBroker);
    return { messages: { ...cap.messages, image: media && cap.messages.image, audio: media && cap.messages.audio, file: media && cap.messages.file, video: media && cap.messages.video, card: false, sticker: false, maxFileBytes: media ? Math.min(cap.messages.maxFileBytes, 100 * 1024 * 1024) : 0 }, backend: { napcatStream: false } };
  }
  private serialize(action: () => Promise<void>): Promise<void> {
    const next = this.sequence.then(action, action);
    this.sequence = next.catch(() => {});
    return next;
  }
  start(): Promise<void> { return this.serialize(() => this.startInternal()); }
  stop(): Promise<void> { return this.serialize(() => this.stopInternal()); }
  restart(): Promise<void> { return this.serialize(async () => { await this.stopInternal(); await this.startInternal(); }); }
  private setPhase(phase: QqModulePhase): void { this.state = { ...this.state, phase }; }
  private async startInternal(): Promise<void> {
    if (this.current) {
      if (!this.current.runtime.isClosed) return;
      if (!this.current.runtime.hasExited && !await this.current.runtime.close()) { this.setPhase("failed"); return; }
    }
    const input = this.options.getConfiguration();
    this.state = { ...this.state, enabled: input !== null };
    if (input === null) { this.setPhase("disabled"); return; }
    if (!validateRequestPayload("initialize", input) || (!isLoopbackHost(input.config.listen.host) && !input.credentials.accessToken.trim())) { this.setPhase("config-missing"); return; }
    if (!this.options.createTransport) { this.setPhase("module-missing"); return; }
    this.state = { enabled: true, phase: "starting", runtimeEpoch: this.state.runtimeEpoch + 1 };
    let gen: Generation | undefined;
    try {
      // Snapshot host policy before invoking untrusted/async process work.
      const initialize: QqInitialize = JSON.parse(JSON.stringify(input));
      // Media is an explicit host capability, never a module/default assumption.
      if (this.options.mediaBroker) initialize.mediaTransfer = "chunked-v1";
      else delete initialize.mediaTransfer;
      const runtime = new QqModuleRuntime(this.options.createTransport(), this.state.runtimeEpoch, this.options.requestTimeoutMs);
      gen = { runtime, config: initialize.config, policy: initialize.config, capabilities: null, highestConnectionEpoch: -1, startComplete: false, mediaEpoch: 0, mediaAbort: new AbortController(), accepting: false, authorized: true, seen: new Set(), turns: new Set(), sends: new Set() };
      this.current = gen;
      const instance = gen;
      runtime.onClose(() => {
        instance.authorized = false; instance.accepting = false; instance.mediaAbort.abort();
        if (this.current === instance && !["draining", "incompatible", "account-mismatch", "failed"].includes(this.state.phase)) this.setPhase("crashed");
      });
      runtime.onEvent((event) => {
        if (this.current !== instance || !instance.authorized) return;
        if (event.event === "status") {
          // No pre-initialize event may authorize inbound or sending.
          if (instance.capabilities) {
            if (instance.startComplete) this.applyStatus(instance, event.payload);
            else instance.pendingStatus = event.payload;
          }
        } else if (event.event === "capability-changed") {
          if (instance.capabilities) instance.capabilities = event.payload;
        } else { this.acceptInbound(instance, event.payload); }
      });
      const hello = await runtime.request("hello", {});
      const agreement = negotiateQqApi(QQ_API_SUPPORT, hello.apiSupport);
      if (!agreement.ok) { this.setPhase("incompatible"); runtime.close(); return; }
      const initialized = await runtime.request("initialize", initialize);
      instance.capabilities = initialized.capabilities;
      const status = await runtime.request("start", {});
      if (this.current === instance && instance.authorized) {
        instance.startComplete = true;
        this.applyStatus(instance, instance.pendingStatus ?? status);
        instance.pendingStatus = undefined;
      }
    } catch {
      if (!["incompatible", "account-mismatch", "crashed"].includes(this.state.phase)) this.setPhase("failed");
      gen?.runtime.close();
    }
  }
  private applyStatus(gen: Generation, status: QqBackendStatus): void {
    if (status.phase === "running") {
      if (status.selfId !== gen.config.expectedSelfId) { this.setPhase("account-mismatch"); gen.runtime.close(); return; }
      if (status.connectionEpoch < gen.highestConnectionEpoch) return;
      // Reusing a disconnected epoch would reactivate old turn leases.
      if (gen.connectionEpoch === undefined && status.connectionEpoch <= gen.highestConnectionEpoch) { gen.runtime.close("protocol"); return; }
      if (gen.connectionEpoch !== status.connectionEpoch) { gen.mediaAbort.abort(); gen.mediaAbort = new AbortController(); gen.mediaEpoch++; }
      gen.highestConnectionEpoch = status.connectionEpoch;
      gen.connectionEpoch = status.connectionEpoch;
      if (this.state.phase !== "draining") { gen.accepting = true; this.setPhase("running"); }
    } else {
      gen.mediaAbort.abort(); gen.mediaEpoch++;
      gen.connectionEpoch = undefined; gen.accepting = false;
      if (this.state.phase !== "draining") this.setPhase("waiting-backend");
    }
  }
  /** Immediate host-side revocation, even while module still holds its old snapshot.
   * Address/account changes require restart and a newly confirmed pin. */
  updateAccessPolicy(config: QqRuntimeConfig): void {
    const gen = this.current;
    if (!gen || !validateRuntimeConfig(config) || config.configRevision <= gen.policy.configRevision
      || config.expectedSelfId !== gen.config.expectedSelfId || config.listen.host !== gen.config.listen.host || config.listen.port !== gen.config.listen.port) throw new Error("QQ_MODULE_INVALID_POLICY_UPDATE");
    gen.policy = JSON.parse(JSON.stringify(config));
    gen.mediaAbort.abort(); gen.mediaAbort = new AbortController(); gen.mediaEpoch++;
  }
  private ack(gen: Generation, eventId: string, outcome: QqInboundAck["outcome"]): void {
    void gen.runtime.request("ackInbound", { eventId, outcome }).catch(() => {});
  }
  private acceptInbound(gen: Generation, message: QqInboundMessageV1): void {
    let rejection: QqInboundAck["outcome"] | undefined;
    const conversation = message.conversation;
    const allowed = conversation.type === "private"
      ? message.senderId === conversation.peerId && gen.policy.allowedPrivateUserIds.includes(conversation.peerId)
      : gen.policy.allowedGroupIds.includes(conversation.groupId) && (!gen.policy.groupRequireMention || message.mentions?.some((m) => m.userId === gen.config.expectedSelfId));
    if (!gen.accepting || !gen.authorized || message.selfId !== gen.config.expectedSelfId || message.connectionEpoch !== gen.connectionEpoch || message.configRevision !== gen.config.configRevision) rejection = "stale-instance";
    else if (!allowed || message.senderId === gen.config.expectedSelfId) rejection = "rejected-policy";
    else if (message.attachments?.length && !this.options.mediaBroker) rejection = "unsupported";
    else if (gen.seen.has(message.eventId)) rejection = "duplicate";
    else if (!this.onMessage || gen.turns.size >= 16) rejection = "busy";
    if (rejection) { this.ack(gen, message.eventId, rejection); return; }
    gen.seen.add(message.eventId);
    if (gen.seen.size > 1024) gen.seen.delete(gen.seen.values().next().value!);
    const handler = this.onMessage!;
    const lease = { active: true, generation: gen, connectionEpoch: message.connectionEpoch, conversation };
    const incoming: IncomingMessage = {
      channel: "qq" as const, chatType: conversation.type, messageId: message.backendMessageId,
      senderId: message.senderId, ...(message.senderName !== undefined ? { senderName: message.senderName } : {}),
      chatId: conversation.type === "private" ? conversation.peerId : conversation.groupId,
      ...(conversation.type === "group" ? { threadId: conversation.groupId } : {}),
      text: message.text, at: new Date(message.timestampMs),
      ...(message.mentions ? { mentions: message.mentions.map((m) => ({ ...m, isBot: m.userId === gen.config.expectedSelfId })) } : {}),
      ...(message.reply ? { reply: { ...message.reply } } : {}),
    };
    // Track the FULL dispatcher promise, not just receipt of this event. The handler
    // owns delivery; its returned OutgoingMessage must never be sent a second time.
    const mediaEpoch = gen.mediaEpoch;
    const check = () => {
      const allowedNow = conversation.type === "private" ? gen.policy.allowedPrivateUserIds.includes(conversation.peerId)
        : gen.policy.allowedGroupIds.includes(conversation.groupId) && (!gen.policy.groupRequireMention || message.mentions?.some((m) => m.userId === gen.config.expectedSelfId));
      if (this.current !== gen || !gen.authorized || gen.connectionEpoch !== message.connectionEpoch || !lease.active || !allowedNow
        || (message.attachments?.length && mediaEpoch !== gen.mediaEpoch)) throw new Error("QQ_MEDIA_REVOKED");
    };
    const turn = this.context.run(lease, async () => {
      const attachments = [];
      let dispatched = false;
      try {
        for (const media of message.attachments ?? []) {
          try { check(); attachments.push(await this.options.mediaBroker!.download({ runtime: gen.runtime, connectionEpoch: message.connectionEpoch, signal: gen.mediaAbort.signal, assertAuthorized: check }, message.eventId, media)); }
          catch { incoming.text += `${incoming.text ? "\n" : ""}[附件加载失败]`; }
        }
        check(); if (attachments.length) incoming.attachments = attachments;
        if (message.attachments?.length) this.ack(gen, message.eventId, "accepted");
        dispatched = true;
        return await handler(incoming);
      } finally {
        if (!dispatched && message.attachments?.length) {
          await Promise.all(attachments.map((attachment) => this.options.mediaBroker!.discard(attachment)));
          this.ack(gen, message.eventId, "stale-instance");
        }
      }
    }).catch(() => {}).finally(() => { lease.active = false; });
    gen.turns.add(turn);
    void turn.finally(() => gen.turns.delete(turn));
    if (!message.attachments?.length) this.ack(gen, message.eventId, "accepted");
  }
  async send(input: OutgoingMessage): Promise<QqSendResultV1> {
    const message: OutgoingMessage = structuredClone(input);
    const gen = this.current;
    const lease = this.context.getStore();
    const operationId = randomUUID();
    const failure = (outcome: "failed" | "unknown", errorCode: "rejected" | "unsupported" | "disconnected" | "timeout" | "internal"): QqSendResultV1 => ({ operationId, outcome, parts: message.parts.map((_, partIndex) => ({ partIndex, outcome, errorCode })) });
    if (!gen || !gen.authorized || gen.connectionEpoch === undefined || message.channel !== "qq" || !message.chatType
      || (lease && (!lease.active || lease.generation !== gen || lease.connectionEpoch !== gen.connectionEpoch))
      || (this.state.phase === "draining" && !lease)) return failure("failed", "rejected");
    const conversation = message.chatType === "group" ? { type: "group" as const, groupId: message.targetId } : { type: "private" as const, peerId: message.targetId };
    if (lease && (conversation.type === "private"
      ? lease.conversation.type !== "private" || lease.conversation.peerId !== conversation.peerId
      : lease.conversation.type !== "group" || lease.conversation.groupId !== conversation.groupId)) return failure("failed", "rejected");
    if (conversation.type === "private" ? !gen.policy.allowedPrivateUserIds.includes(conversation.peerId) : !gen.policy.allowedGroupIds.includes(conversation.groupId)) return failure("failed", "rejected");
    const epoch = gen.connectionEpoch;
    const mediaEpoch = gen.mediaEpoch;
    const hasMedia = message.parts.some((part) => !["text", "card", "sticker"].includes(part.kind));
    const check = () => {
      if (this.current !== gen || !gen.authorized || gen.connectionEpoch !== epoch || (lease && !lease.active)
        || (hasMedia && (gen.mediaEpoch !== mediaEpoch || this.state.phase === "draining"))
        || (conversation.type === "private" ? !gen.policy.allowedPrivateUserIds.includes(conversation.peerId) : !gen.policy.allowedGroupIds.includes(conversation.groupId))) throw new Error("QQ_MEDIA_REVOKED");
    };
    const supported = (part: QqSendRequestV1["parts"][number] | OutgoingMessage["parts"][number]): boolean => {
      const capabilities = this.getCapabilities().messages;
      return part.kind === "text" ? capabilities.text && part.text.length <= capabilities.maxTextLength
        : part.kind === "card" || part.kind === "sticker" ? false
          : capabilities[part.kind] && (!("mediaId" in part) || (part.size ?? Infinity) <= capabilities.maxFileBytes);
    };
    const replySupported = () => {
      const capabilities = this.getCapabilities().messages;
      return !message.replyContext || capabilities.reply && (!message.replyContext.mentionUserId || capabilities.mention);
    };
    try { check(); } catch { return failure("failed", "rejected"); }
    if (!replySupported()) return failure("failed", "unsupported");
    const context = { runtime: gen.runtime, connectionEpoch: epoch, signal: gen.mediaAbort.signal, maxFileBytes: this.getCapabilities().messages.maxFileBytes, assertAuthorized: check };
    const handles: string[] = [];
    const operation = (async (): Promise<QqSendResultV1> => {
      const results: QqSendResultV1["parts"] = message.parts.map((_, partIndex) => ({ partIndex, outcome: "failed", errorCode: "rejected" }));
      const aggregate = (): QqSendResultV1 => ({ operationId, parts: results,
        outcome: results.some((part) => part.outcome === "unknown") ? "unknown"
          : results.length > 0 && results.every((part) => part.outcome === "sent") ? "sent"
            : results.some((part) => part.outcome === "sent") ? "partial" : "failed" });
      try {
        const prepared: { part: QqSendRequestV1["parts"][number]; originalIndex: number }[] = [];
        for (const [originalIndex, part] of message.parts.entries()) {
          check();
          if (!supported(part)) { results[originalIndex] = { partIndex: originalIndex, outcome: "failed", errorCode: "unsupported" }; continue; }
          if (part.kind === "text") prepared.push({ part: { ...part }, originalIndex });
          else if (part.kind !== "card" && part.kind !== "sticker") {
            try {
              const media = await this.options.mediaBroker!.upload(context, operationId, conversation, part);
              handles.push(media.mediaId); check();
              prepared.push({ part: media, originalIndex });
            } catch {
              // File/transfer failures affect only this part. Authorization failure
              // must escape to the whole-message rejection before any send occurs.
              check();
            }
          }
        }
        check();
        if (!replySupported()) return failure("failed", "unsupported");
        const selected = prepared.filter(({ part, originalIndex }) => {
          if (supported(part)) return true;
          results[originalIndex] = { partIndex: originalIndex, outcome: "failed", errorCode: "unsupported" }; return false;
        });
        if (!selected.length) return aggregate();
        const request: QqSendRequestV1 = { operationId, runtimeEpoch: gen.runtime.runtimeEpoch, connectionEpoch: epoch, selfId: gen.config.expectedSelfId, conversation,
          parts: selected.map(({ part }) => part), ...(message.replyContext ? { replyContext: { ...message.replyContext } } : {}) };
        if (!validateSendRequest(request)) return failure("failed", "rejected");
        // Only uncertainty of the final send may mean a backend side effect.
        // Translate compact backend indices back to the original host parts.
        try {
          const result = await gen.runtime.request("send", request, undefined, this.options.sendTimeoutMs ?? QQ_RUNTIME_TIMEOUTS.sendResponseMs);
          for (const part of result.parts) {
            const originalIndex = selected[part.partIndex].originalIndex;
            results[originalIndex] = { ...part, partIndex: originalIndex };
          }
        } catch (error) {
          const uncertain = error instanceof QqRuntimeError && error.transmitted;
          for (const { originalIndex } of selected) results[originalIndex] = { partIndex: originalIndex, outcome: uncertain ? "unknown" : "failed", errorCode: error instanceof QqRuntimeError && error.code === "timeout" ? "timeout" : "disconnected" };
        }
        return aggregate();
      } catch { return failure("failed", "rejected"); }
      finally { await Promise.all(handles.map((id) => this.options.mediaBroker!.release(context, id))); }
    })();
    gen.sends.add(operation);
    try { return await operation; } finally { gen.sends.delete(operation); }
  }

  private async stopInternal(): Promise<void> {
    const gen = this.current;
    if (!gen) { this.state = { ...this.state, enabled: false, phase: "stopped" }; return; }
    gen.accepting = false; gen.mediaEpoch++; gen.mediaAbort.abort();
    this.setPhase("draining");
    // One overall deadline covers quiesce, active turns/sends and graceful stop.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, this.options.drainTimeoutMs ?? 5000); });
    const drain = async () => {
      try {
        await gen.runtime.request("quiesce", {});
        await Promise.allSettled([...gen.turns, ...gen.sends]);
        if (gen.authorized) await gen.runtime.request("stop", {});
      } catch { /* bounded shutdown; pending sends retain unknown */ }
    };
    await Promise.race([drain(), deadline]);
    clearTimeout(timer);
    gen.authorized = false;
    const exited = await gen.runtime.close();
    if (!exited && !gen.runtime.hasExited) {
      this.state = { ...this.state, enabled: false, phase: "failed" };
      return;
    }
    if (this.current === gen) this.current = undefined;
    this.state = { ...this.state, enabled: false, phase: "stopped" };
  }
}
