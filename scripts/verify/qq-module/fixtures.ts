import type { QqCapabilitySnapshot, QqInitialize, QqInboundMessageV1, QqRequest } from "../../../src/shared/qq-module";
import type { QqProcessTransport } from "../../../src/main/qq-modules/runtime";
export const capabilities: QqCapabilitySnapshot = {
  messages: { text: true, image: false, audio: false, file: false, video: false, markdown: false, card: false, sticker: false, reply: true, mention: true, maxTextLength: 32768, maxFileBytes: 0 }, backend: { napcatStream: false },
};
export const configuration = (): QqInitialize => ({ config: { configRevision: 1, listen: { host: "127.0.0.1", port: 30001 }, expectedSelfId: "10000", allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true }, credentials: { accessToken: "test-only-token" } });
export const inbound = (eventId = "event-1"): QqInboundMessageV1 => ({ eventId, backendMessageId: "-123", selfId: "10000", connectionEpoch: 1, configRevision: 1, conversation: { type: "group", groupId: "20000" }, senderId: "30000", timestampMs: 1700000000000, text: "hello", mentions: [{ userId: "10000" }] });
export class FakeTransport implements QqProcessTransport {
  messages: QqRequest[] = [];
  killed = false;
  listeners = new Set<(message: unknown) => void>();
  exits = new Set<() => void>();
  behavior: (message: QqRequest) => void = (message) => this.reply(message, message.method === "hello" ? { moduleId: "qfca", moduleVersion: "0.1.0", apiSupport: { major: 1, minMinor: 0, maxMinor: 0 } }
    : message.method === "initialize" ? { capabilities }
      : message.method === "start" ? { phase: "running", selfId: "10000", connectionEpoch: 1 }
        : message.method === "send" ? { operationId: message.payload.operationId, outcome: "sent", parts: message.payload.parts.map((_, partIndex) => ({ partIndex, outcome: "sent", messageId: "999" })) } : {});
  postMessage(value: unknown): void { const message = value as QqRequest; this.messages.push(message); this.behavior(message); }
  onMessage(listener: (message: unknown) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onExit(listener: () => void): () => void { this.exits.add(listener); return () => { this.exits.delete(listener); }; }
  async terminate(): Promise<void> { this.killed = true; }
  crash(): void { for (const listener of this.exits) listener(); }
  emit(value: unknown): void { for (const listener of this.listeners) listener(value); }
  reply(request: QqRequest, payload: unknown): void { this.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch, kind: "response", responseTo: request.requestId, ok: true, payload }); }
  event(event: string, payload: unknown, overrides = {}): void {
    const request = this.messages[0];
    this.emit({ apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch, kind: "event", event, payload, ...overrides });
  }
}
