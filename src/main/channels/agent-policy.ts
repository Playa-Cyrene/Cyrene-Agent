import type { AgentExecutionMode, CyreneRunOptions } from "../orchestrator/cyrene-agent";
import { isDesktopBrowserTool } from "../browser/browser-tool-policy";
import type { ChannelToolSandbox } from "./settings-store";
import type { ChannelChatType, ChannelId } from "./types";

export interface ChannelAgentPolicy {
  executionMode: AgentExecutionMode;
  exposeTools: boolean;
  includeInteractiveTools: boolean;
  permissionMode: NonNullable<CyreneRunOptions["permissionMode"]>;
}

export function resolveChannelAgentPolicy(
  toolSandbox: ChannelToolSandbox,
  context?: { channel?: ChannelId; chatType?: ChannelChatType },
): ChannelAgentPolicy {
  // QQ 群聊（NapCat 与官方机器人同样处理）：共享群上下文，强制纯 Chat 模式、禁工具
  if ((context?.channel === "qq" || context?.channel === "qqbot") && context.chatType === "group") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    };
  }
  if (toolSandbox === "off") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    };
  }
  return {
    executionMode: "work",
    exposeTools: true,
    includeInteractiveTools: false,
    permissionMode: "allow_all",
  };
}

/**
 * 在 buildOptions 之后再次收紧策略，避免 Chat 工具开关已把工具目录写入
 * capabilities/toolSystemContent 时，QQ 群聊仍看到或意外启用这些工具。
 */
export function enforceChannelAgentPolicy(
  options: CyreneRunOptions,
  policy: ChannelAgentPolicy,
): void {
  options.channelRun = true;
  options.harnessInteractiveTools = policy.includeInteractiveTools;
  options.permissionMode = policy.permissionMode;
  const allowed = (tool: { id: string }) => policy.exposeTools && !isDesktopBrowserTool(tool.id);
  options.tools = (options.tools ?? options.capabilities?.tools ?? []).filter(allowed);
  if (!policy.exposeTools) {
    options.toolSystemContent = "";
    options.skillLayerContent = "";
  }
  if (options.capabilities) {
    const tools = options.capabilities.tools.filter(allowed);
    options.capabilities = {
      ...options.capabilities,
      tools,
      toolIds: new Set(tools.map((tool) => tool.id)),
    };
  }
}
