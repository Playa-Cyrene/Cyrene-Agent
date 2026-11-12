/** 专属 QQ 进程协议候选；不依赖普通插件或宿主渠道类型。 */
export interface QqApiVersion { major: number; minor: number }
export interface QqApiSupport { major: number; minMinor: number; maxMinor: number }
export type QqConversation =
  | { type: "private"; peerId: string }
  | { type: "group"; groupId: string };
export interface QqMention { userId: string; name?: string }
export interface QqReply {
  messageId: string;
  senderId?: string;
  senderName?: string;
  text?: string;
}
/** mediaId 是本次实例授权的 opaque handle，绝不是 URL 或本地文件路径。 */
export interface QqMedia {
  kind: "image" | "audio" | "file" | "video" | "sticker";
  mediaId: string;
  mime?: string;
  caption?: string;
  filename?: string;
  size?: number;
}
export interface QqInboundMessageV1 {
  eventId: string;
  backendMessageId: string;
  selfId: string;
  connectionEpoch: number;
  configRevision: number;
  conversation: QqConversation;
  senderId: string;
  senderName?: string;
  timestampMs: number;
  text: string;
  mentions?: QqMention[];
  reply?: QqReply;
  attachments?: QqMedia[];
}
export type QqOutboundPart =
  | { kind: "text"; text: string }
  | QqMedia
  | { kind: "card"; title: string; markdown?: string; fields?: { key: string; value: string }[] };
export interface QqSendRequestV1 {
  operationId: string;
  runtimeEpoch: number;
  selfId: string;
  conversation: QqConversation;
  parts: QqOutboundPart[];
  replyContext?: { messageId: string; mentionUserId?: string };
}
export type QqSendErrorCode = "backend-unavailable" | "unsupported" | "rejected" | "timeout" | "disconnected" | "internal";
export type QqPartResult =
  | { partIndex: number; outcome: "sent"; messageId?: string }
  | { partIndex: number; outcome: "failed" | "unknown"; errorCode: QqSendErrorCode };
/** 一项对应一个请求 part；unknown 优先于 partial，绝不能据此盲重试。 */
export interface QqSendResultV1 {
  operationId: string;
  outcome: "sent" | "partial" | "failed" | "unknown";
  parts: QqPartResult[];
}

/** 模块能力声明不授予任何权限；宿主发送前仍须核对当前实际能力。 */
export interface QqMessageCapabilities {
  text: boolean;
  image: boolean;
  audio: boolean;
  file: boolean;
  video: boolean;
  markdown: boolean;
  card: boolean;
  sticker: boolean;
  reply: boolean;
  mention: boolean;
  maxTextLength: number;
  maxFileBytes: number;
}
export interface QqCapabilitySnapshot {
  messages: QqMessageCapabilities;
  /** 仅描述后端专属特性，不允许透传任意 OneBot action。 */
  backend: { napcatStream: boolean };
}
