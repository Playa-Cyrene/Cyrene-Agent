import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { negotiateQqApi, QQ_API_SUPPORT, QQ_RUNTIME_TIMEOUTS, validateRequestPayload, validateRuntimeConfig, validateSendRequest,
  type QqBackendStatus, type QqCapabilitySnapshot, type QqInboundAck, type QqInboundMessageV1, type QqInitialize,
  type QqRuntimeConfig, type QqSendRequestV1, type QqSendResultV1 } from "../../shared/qq-module";
import { isLoopbackHost } from "../channels/qq-listen-policy";
import type { MessageHandler, OutgoingMessage } from "../channels/types";
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
  authorized: boolean;
  seen: Set<string>;
  turns: Set<Promise<unknown>>;
  sends: Set<Promise<unknown>>;
}
interface TurnLease { generation: Generation; connectionEpoch: number; conversation: QqInboundMessageV1["conversation"] }
export interface QqModuleManagerOptions {
  /** null means explicitly disabled; no configuration is read during construction. */
  getConfiguration: () => QqInitialize | null;
  /** Supplied only by trusted host composition, never renderer input. Absent = not installed. */
  createTransport?: () => QqProcessTransport;
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
    // No broker exists in this increment, even if the module advertises media.
    return { messages: { ...cap.messages, image: false, audio: false, file: false, video: false, sticker: false, maxFileBytes: 0 }, backend: { napcatStream: false } };
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
      const runtime = new QqModuleRuntime(this.options.createTransport(), this.state.runtimeEpoch, this.options.requestTimeoutMs);
      gen = { runtime, config: initialize.config, policy: initialize.config, capabilities: null, highestConnectionEpoch: -1, startComplete: false, accepting: false, authorized: true, seen: new Set(), turns: new Set(), sends: new Set() };
      this.current = gen;
      const instance = gen;
      runtime.onClose(() => {
        instance.authorized = false; instance.accepting = false;
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
      gen.highestConnectionEpoch = status.connectionEpoch;
      gen.connectionEpoch = status.connectionEpoch;
      if (this.state.phase !== "draining") { gen.accepting = true; this.setPhase("running"); }
    } else {
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
    else if (message.attachments?.length) rejection = "unsupported";
    else if (gen.seen.has(message.eventId)) rejection = "duplicate";
    else if (!this.onMessage || gen.turns.size >= 16) rejection = "busy";
    if (rejection) { this.ack(gen, message.eventId, rejection); return; }
    gen.seen.add(message.eventId);
    if (gen.seen.size > 1024) gen.seen.delete(gen.seen.values().next().value!);
    const handler = this.onMessage!;
    const lease = { generation: gen, connectionEpoch: message.connectionEpoch, conversation };
    const incoming = {
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
    const turn = this.context.run(lease, () => Promise.resolve().then(() => handler(incoming))).catch(() => {});
    gen.turns.add(turn);
    void turn.finally(() => gen.turns.delete(turn));
    this.ack(gen, message.eventId, "accepted");
  }
  async send(message: OutgoingMessage): Promise<QqSendResultV1> {
    const gen = this.current;
    const lease = this.context.getStore();
    const operationId = randomUUID();
    const failure = (outcome: "failed" | "unknown", errorCode: "rejected" | "unsupported" | "disconnected" | "timeout" | "internal"): QqSendResultV1 => ({ operationId, outcome, parts: message.parts.map((_, partIndex) => ({ partIndex, outcome, errorCode })) });
    if (!gen || !gen.authorized || gen.connectionEpoch === undefined || message.channel !== "qq" || !message.chatType
      || (lease && (lease.generation !== gen || lease.connectionEpoch !== gen.connectionEpoch))
      || (this.state.phase === "draining" && !lease)) return failure("failed", "rejected");
    const conversation = message.chatType === "group" ? { type: "group" as const, groupId: message.targetId } : { type: "private" as const, peerId: message.targetId };
    if (lease && (conversation.type === "private"
      ? lease.conversation.type !== "private" || lease.conversation.peerId !== conversation.peerId
      : lease.conversation.type !== "group" || lease.conversation.groupId !== conversation.groupId)) return failure("failed", "rejected");
    if (conversation.type === "private" ? !gen.policy.allowedPrivateUserIds.includes(conversation.peerId) : !gen.policy.allowedGroupIds.includes(conversation.groupId)) return failure("failed", "rejected");
    const capabilities = this.getCapabilities().messages;
    if (message.parts.some((part) => part.kind === "text" ? !capabilities.text || part.text.length > capabilities.maxTextLength : part.kind === "card" ? !capabilities.card : true)
      || (message.replyContext && (!capabilities.reply || (message.replyContext.mentionUserId && !capabilities.mention)))) return failure("failed", "unsupported");
    const request: QqSendRequestV1 = { operationId, runtimeEpoch: gen.runtime.runtimeEpoch, connectionEpoch: gen.connectionEpoch, selfId: gen.config.expectedSelfId, conversation,
      parts: message.parts.filter((part) => part.kind === "text" || part.kind === "card"), ...(message.replyContext ? { replyContext: { ...message.replyContext } } : {}) };
    if (!validateSendRequest(request)) return failure("failed", "rejected");
    const operation = gen.runtime.request("send", request, undefined, this.options.sendTimeoutMs ?? QQ_RUNTIME_TIMEOUTS.sendResponseMs);
    gen.sends.add(operation);
    try { return await operation; }
    catch (error) {
      const uncertain = error instanceof QqRuntimeError && error.transmitted;
      return failure(uncertain ? "unknown" : "failed", error instanceof QqRuntimeError && error.code === "timeout" ? "timeout" : "disconnected");
    } finally { gen.sends.delete(operation); }
  }
  private async stopInternal(): Promise<void> {
    const gen = this.current;
    if (!gen) { this.state = { ...this.state, enabled: false, phase: "stopped" }; return; }
    gen.accepting = false;
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
