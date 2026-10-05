import type { ChatMessage, VendorConfig } from "../../vendors/types";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { toolRegistry } from "../../tools/registry/tool-registry";
import { getHarnessRunStore } from "../run-store";
import type { CyreneRunOptions } from "../../cyrene-agent";
import type { PromptLayers } from "../../prompt-layers";
import type { ConversationMode } from "../../../../shared/chat-types";
import {
  buildHarnessPromptLayers,
  materializeHarnessStartTranscript,
} from "./prompt-builder";
import { preparePlanRunContext } from "./plan-lifecycle";
import { app } from "electron";

/**
 * 运行准备阶段：解析线程/运行 ID、计划上下文、恢复快照、提示词层和工具清单，
 * 最后创建唯一的 runStore 记录。它不运行 Harness，也不创建权限检查或任务执行器。
 */
const CODE_ONLY_GIT_TOOL_IDS = new Set([
  "git_status",
  "git_init",
  "git_commit",
  "git_switch_branch",
  "git_push",
  "git_revert",
]);

export function filterToolsForConversationMode(
  mode: ConversationMode | undefined,
  tools: ToolDefinition[],
): ToolDefinition[] {
  // 这是代码模式工具过滤的唯一事实来源；只返回新数组，不修改 registry 或传入数组。
  if (mode === "code") return tools;
  return tools.filter((tool) => !CODE_ONLY_GIT_TOOL_IDS.has(tool.id));
}

export interface PreparedHarnessRun {
  threadId: string;
  runId: string;
  messageId: string;
  planState: Awaited<ReturnType<typeof preparePlanRunContext>>["planState"];
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  promptLayers: ReturnType<typeof buildHarnessPromptLayers>;
  harnessPromptLayers: PromptLayers;
  systemPrompt: string;
  runMessages: ChatMessage[];
  runStore: ReturnType<typeof getHarnessRunStore>;
}

export async function prepareHarnessRun(
  options: CyreneRunOptions,
  signal: AbortSignal,
): Promise<PreparedHarnessRun> {
  const messageId = options.assistantTurnId ?? `msg-${Date.now()}`;
  const runId = options.runId;
  // 先校验 runId，避免产生无法关联到 RUN_FINISHED/恢复记录的孤儿执行。
  if (!runId) {
    throw new Error(
      "[HarnessAdapter] options.runId is required. CyreneAgent.runWithEvents must populate it before invoking the adapter.",
    );
  }
  const threadId = options.conversationId ?? "default";
  const { planState, planContextBlock } = await preparePlanRunContext({
    mode: options.conversationMode,
    threadId,
  });

  console.log(`${"[HarnessAdapter]"} starting harness run, mode=${options.conversationMode ?? "work"}${planState ? ` plan=${planState}` : ""}`);

  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
    manualReasoning: options.settings.manualReasoning,
    imageGeneration: options.settings.imageGeneration,
  };

  const tools = [...(options.capabilities?.tools ?? options.tools ?? toolRegistry.getEnabledTools())];
  const runStore = getHarnessRunStore(app.getPath("userData"));
  // 消息历史与待办/未决副作用均来自会话轨迹投影；这里只为旧入口保留兼容文本提示。
  const baseRunMessages = options.messages;
  const recoveryContext = [options.recoveryContext, planContextBlock]
    .filter(Boolean).join("\n\n");
  const promptLayers = buildHarnessPromptLayers(
    recoveryContext ? { ...options, recoveryContext } : options,
  );
  const runMessages = materializeHarnessStartTranscript({
    messages: baseRunMessages,
    runId,
    runtimeContext: promptLayers.runtimeContext,
    kind: "run_start",
  });
  // create 必须发生在 Harness 启动前；运行文件只承担启动对账、终态和 Review 时间戳。
  const harnessPromptLayers: PromptLayers = {
    stablePrefix: promptLayers.stablePrefix,
    ...(promptLayers.sessionPrefix ? { sessionPrefix: promptLayers.sessionPrefix } : {}),
    ...(promptLayers.mode ? { mode: promptLayers.mode } : {}),
  };
  const systemPrompt = harnessPromptLayers.stablePrefix;
  runStore.create({
    conversationId: threadId,
    runId,
  });

  return {
    threadId,
    runId,
    messageId,
    planState,
    vendorConfig,
    tools,
    promptLayers,
    harnessPromptLayers,
    systemPrompt,
    runMessages,
    runStore,
  };
}
