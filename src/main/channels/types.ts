// channels 模块的统一数据类型。
//
// 设计原则：所有外部入口（微信/飞书/Discord/...）都必须先把消息归一化成
// IncomingMessage / OutgoingMessage 两种格式再交给 dispatcher。
// 这样 dispatcher 完全不知道任何具体平台 —— 加新渠道零改动 dispatcher。
//
// 命名规范：所有字段小驼峰、可空字段加 ?；时间戳统一 Date。
import type { WebContents } from "electron";

/** 渠道 id 联合类型。新增渠道时在此扩展。 */
export type ChannelId = "wechat" | "feishu" | "qq" | "qqbot";

export type ChannelChatType = "private" | "group";

export interface ChannelMention {
  userId: string;
  name?: string;
  isBot?: boolean;
}

export interface ChannelReplyContext {
  messageId: string;
  senderId?: string;
  senderName?: string;
  text?: string;
}

/** 渠道能力声明。Dispatcher 按 cap 做降级。 */
export interface ChannelCapability {
  /** 纯文本消息 */
  text: boolean;
  /** 图片消息 */
  image: boolean;
  /** TTS 音频消息 */
  audio: boolean;
  /** 文件附件 */
  file: boolean;
  /** 视频消息 */
  video: boolean;
  /** Markdown 富文本（部分渠道支持） */
  markdown: boolean;
  /** 富卡片（飞书 interactive / Discord embed） */
  card: boolean;
  /** 自定义表情包 */
  sticker: boolean;
  /** 单条文本最大长度。超出按 cap 截断 + 提示。 */
  maxTextLength: number;
}

/** 入站附件。adapters 负责下载到本地后填 filePath。 */
export interface ChannelAttachment {
  kind: "image" | "audio" | "file" | "video";
  /** 远程 URL（adapter 已下载到本地时为空） */
  url?: string;
  /** 本地路径（adapter 已下载时填这个） */
  filePath?: string;
  mime?: string;
  caption?: string;
}

/** 入站消息。adapters → dispatcher。 */
export interface IncomingMessage {
  channel: ChannelId;
  /** 私聊或群聊。旧渠道未声明时按 private 处理。 */
  chatType?: ChannelChatType;
  /** 平台原始消息 ID。 */
  messageId?: string;
  /** 平台原始 sender id。dispatcher 会 sha256 截断成 16 字符作为 sessionId。 */
  senderId: string;
  /** 显示名（昵称/open_id alias），用于日志/UI。 */
  senderName?: string;
  /** 会话 id。私聊时通常 = senderId。 */
  chatId: string;
  /** 群聊/话题 id。私聊时 undefined。 */
  threadId?: string;
  text: string;
  attachments?: ChannelAttachment[];
  mentions?: ChannelMention[];
  /** 最多展开一层的引用消息。 */
  reply?: ChannelReplyContext;
  at: Date;
  /** 原始 payload，调试用，不序列化。 */
  _raw?: unknown;
}

/** 出站消息的单个片段。多模态按 parts 数组，capability 降级在 dispatcher 做。 */
export type OutgoingPart =
  | { kind: "text"; text: string }
  | { kind: "image"; url?: string; filePath?: string; caption?: string }
  | { kind: "audio"; filePath: string; mime: string }
  | { kind: "file"; filePath: string; name?: string; mime?: string }
  | { kind: "video"; filePath: string; name?: string; mime?: string }
  | {
      kind: "card";
      title: string;
      markdown?: string;
      fields?: Array<{ key: string; value: string }>;
    }
  | { kind: "sticker"; stickerId: string; imagePath: string };

/** 出站消息。dispatcher → adapters。 */
export interface OutgoingMessage {
  channel: ChannelId;
  chatType?: ChannelChatType;
  /** 回复给谁（私聊 = senderId；群聊 = chatId） */
  targetId: string;
  threadId?: string;
  /** 群聊回复元数据，由平台 adapter 翻译为 reply / at 消息段。 */
  replyContext?: {
    messageId: string;
    mentionUserId?: string;
  };
  parts: OutgoingPart[];
}

/** 渠道状态（UI 展示用） */
export interface ChannelStatus {
  enabled: boolean;
  /** "running" / "offline" / "starting" / "config_missing" / "error" */
  phase: "running" | "offline" | "starting" | "config_missing" | "error";
  message?: string;
  /** 渠道专属的额外状态字段（如微信账号昵称、飞书 token 是否过期） */
  detail?: Record<string, unknown>;
}

/** 渠道适配器入站消息回调的签名。
 *  回调内部负责完整的智能体执行与响应发送；返回值仅供观测和测试，适配器不得再次发送。 */
export type MessageHandler = (
  msg: IncomingMessage,
) => Promise<OutgoingMessage | null>;

/** inbound-server 拿到入站请求后转交给 manager 路由时的回调签名 */
export interface InboundRouteContext {
  /** 用于推送 AG-UI 事件到桌面端 chatWindow（可选）。 */
  chatWindow?: WebContents | null;
  /** 用于把出站消息广播回桌面端镜像显示（可选）。 */
  broadcastChat?: (event: { type: "bot:message"; payload: unknown }) => void;
}
