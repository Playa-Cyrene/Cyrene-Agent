// 插件端口契约（编译期冻结）。
//
// 背景：plugins 框架是"库"，main 是"宿主"。plugin-runtime.ts 在信任边界处用
// 结构化类型把 PluginTool / PluginChannelAdapter 适配进 main 的注册表，
// 依赖两侧词汇表保持"插件 ⊆ 宿主"的子集关系。本文件用类型断言把该关系
// 锁死：任何一侧破坏契约（新增字面量 / 改字段类型）都会让 tsc 在此处报错，
// 而不是等运行时静默走错分支。
//
// 断言方向：
// - 字面量：插件可声明的每个 risk / effectKind / verificationPolicy /
//   mode / ledgerPolicy 必须被宿主侧类型接受（否则注册表会收到不认识的值）。
// - 结构：宿主必须能消费插件的能力声明（ChannelCapability）；
//   宿主的 ToolContext / IncomingMessage 必须能原样传给插件函数。
//
// 已知且刻意不锁的方向：PluginOutgoingMessage.parts 比宿主侧宽
// （允许自造 kind、无 replyContext）。该方向宿主只作观测（inbound-server
// 仅回 ack 不进入发送路径），放宽是插件开发体验所需，见 plugins/api.ts。
import type {
  PluginChannelCapability,
  PluginIncomingMessage,
  PluginTool,
  PluginToolContext,
} from "../plugins/types";
import type { ChannelCapability, IncomingMessage } from "./channels/types";
import type { ToolRiskLevel } from "./permission-policy";
import type { ToolContext } from "./orchestrator/tools/registry/tool-context";
import type {
  ToolDefinition,
  ToolEffectKind,
  VerificationPolicy,
} from "./orchestrator/tools/registry/tool-registry";
import type { ConversationMode } from "../shared/chat-types";

/** 编译期断言：参数必须解析为 true 字面量，否则 tsc 在此报错。 */
type Expect<T extends true> = T;

// ── 字面量子集 ──────────────────────────────────────────────

/** 插件可声明的每档 risk 在宿主权限策略里都有定义。 */
type PluginRiskSubset = Expect<
  NonNullable<PluginTool["risk"]> extends ToolRiskLevel ? true : false
>;

/** 插件可声明的每档 effectKind 宿主效果分类都认识。 */
type PluginEffectKindSubset = Expect<
  NonNullable<PluginTool["effectKind"]> extends ToolEffectKind ? true : false
>;

/** 插件可声明的每档 verificationPolicy 宿主验证策略都认识。 */
type PluginVerificationPolicySubset = Expect<
  NonNullable<PluginTool["verificationPolicy"]> extends VerificationPolicy ? true : false
>;

/** 插件可声明的每个 ledgerPolicy 与宿主记账策略一致。 */
type PluginLedgerPolicySubset = Expect<
  NonNullable<PluginTool["ledgerPolicy"]> extends NonNullable<ToolDefinition["ledgerPolicy"]>
    ? true
    : false
>;

/** 插件工具声明的会话模式必须是宿主 ConversationMode 的子集。 */
type PluginModesSubset = Expect<
  NonNullable<PluginTool["modes"]>[number] extends ConversationMode ? true : false
>;

// ── 结构子集 ────────────────────────────────────────────────

/** 插件的能力声明能被宿主 cap 降级逻辑原样消费。 */
type PluginCapabilityFits = Expect<
  PluginChannelCapability extends ChannelCapability ? true : false
>;

/** 宿主的 ToolContext 能原样传给插件工具的 execute（不缺字段、类型兼容）。 */
type HostContextFitsPlugin = Expect<
  ToolContext extends PluginToolContext ? true : false
>;

/** 宿主归一化的入站消息能原样交给插件渠道的 onMessage（不缺字段、类型兼容）。 */
type HostIncomingFitsPlugin = Expect<
  IncomingMessage extends PluginIncomingMessage ? true : false
>;
