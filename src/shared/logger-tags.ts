/**
 * Canonical tag names used by the logger.
 *
 * Tags are 16-character columns. If a new tag exceeds that, it gets truncated
 * in log output, so keep names short.
 */
export const LogTag = {
  Runtime: "Runtime",
  Electron: "Electron",
  BuiltinTools: "BuiltinTools",
  FsTools: "FsTools",
  LifeTools: "LifeTools",
  TravelTools: "TravelTools",
  EmailTools: "EmailTools",
  Skills: "Skills",
  SkillTools: "SkillTools",
  TodoStore: "TodoStore",
  MCP: "MCP",
  Permission: "Permission",
  Cyrene: "Cyrene",
  Worldbook: "Worldbook",
  EntityGraph: "EntityGraph",
  RAG: "RAG",
  Reranker: "Reranker",
  InboundServer: "InboundServer",
  Channels: "Channels",
  Feishu: "Feishu",
  Wechat: "Wechat",
  StickerEmbed: "StickerEmbed",
  AgUiBridge: "AgUiBridge",
  Call: "Call",
  ASR: "ASR",
} as const;

export type LogTagKey = keyof typeof LogTag;
