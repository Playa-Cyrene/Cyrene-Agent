import type { ConversationTranscriptCompactor } from "../orchestrator/conversation-transcript-compactor";

/**
 * 组合根使用的惰性单例入口：自动压缩与手动 CHATS_COMPACT 从同一引用取服务。
 * 惰性创建保留现有启动顺序，provider 仅在运行时真正请求摘要时读取配置。
 */
export function createTranscriptCompactorGetter(
  factory: () => ConversationTranscriptCompactor,
): () => ConversationTranscriptCompactor {
  let instance: ConversationTranscriptCompactor | undefined;
  return () => instance ??= factory();
}
