// ToolContext —— 工具执行时调度层注入的上下文。
// 让工具能拿到"用户当前问题"，而不是自己去翻消息历史。
// 地基通用：当前只服务于 read_image（视觉），未来其他工具按需声明 needsContext 接入。

import type { ChatMessage } from "../../vendors";
import { ContextRefRegistry } from "../../context-ref-registry";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { ShellOutputUpdate } from "../../../../shared/shell-output";

export const contextRefRegistry = new ContextRefRegistry();

export type { ShellOutputUpdate } from "../../../../shared/shell-output";

/** 工具上下文。userQuery 是当前唯一稳定字段；metadata 留未来扩展（PDF/音频等），现在不填。 */
export interface ToolContext {
  /** 用户当前问题（最后一条 user 消息文本）。最核心字段。 */
  userQuery: string;
  /** 当前聊天会话 ID；需要跨轮隔离状态的工具必须使用该字段。 */
  conversationId?: string;
  /** One Agent execution; resolved-only candidates must not cross this boundary. */
  runId?: string;
  /** Tool Runtime-owned opaque reference registry. */
  contextRefs?: ContextRefRegistry;
  /** 父运行取消信号。工具应在长操作中检查 signal.aborted 并抛出 AbortError。
   *  子代理通过统一工具执行边界传入；直接调用的工具（主 Agent Loop）当前不传。 */
  signal?: AbortSignal;
  /**
   * 可信工作区根目录（来自 Conversation Workspace Binding）。
   *
   * 信任边界：这是唯一可信的 workspaceRoot 来源。
   * 以下来源都不能覆盖它：
   * - 用户消息中的路径
   * - Planner
   * - Native FC 生成的 workspaceRoot
   *
   * Work 工具和 run_verification 必须使用此目录。
   */
  resolvedWorkspaceRoot?: string;
  /** 当前会话的 UI 模式；工具可用它做模式隔离。 */
  mode?: ConversationMode;
  /** 本次 Run 允许加载的 Skill ID；缺失时仅兼容旧的非 bridge 调用。 */
  allowedSkillIds?: ReadonlySet<string>;
  /** 本轮工具执行权限策略；allow_all 仅用于用户显式开启的无审批渠道。 */
  permissionMode?: "normal" | "allow_all";
  /** 仅供前台 run_shell 观察输出；异常不得影响命令执行。 */
  onShellOutput?: (update: ShellOutputUpdate) => void;
  /** 未来扩展兜底；当前为空对象，不预设字段。遵循"地基通用，上层克制"。 */
  metadata?: Record<string, unknown>;
}

/**
 * 从对话历史取最后一条 role:"user" 消息的文本，作为工具的用户问题上下文。
 *
 * 边界规则：
 * - content 是字符串 → 直接用
 * - content 是数组（未来上传图片后的多模态消息）→ 拼接所有 type:"text" 块的文本
 * - 都不是或无 user 消息 → 返回空串
 *
 * 已知边界（不解决）：多轮 function-calling 后用户追问（如"那第二张呢？"），
 * 取到的是追问片段而非原始意图。视觉模型通常仍能结合图片+片段理解，所以不处理。
 */
export function extractLastUserQuery(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const content = m.content;
    if (typeof content === "string") return content;
    // 多模态数组：拼 text 块（未来用，当前 content 永远是 string）。
    // ChatMessage.content 当前类型只有 string，这里用 unknown 中转避免 TS 收窄成 never；
    // 未来 content 改成 string | ContentBlock[] 后可去掉断言。
    const arr = content as unknown;
    if (Array.isArray(arr)) {
      return (arr as Array<{ type?: string; text?: string }>)
        .filter(b => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")
        .map(b => b.text as string)
        .join(" ");
    }
    return "";
  }
  return "";
}
