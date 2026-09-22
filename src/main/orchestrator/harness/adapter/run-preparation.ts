import { createHash } from "node:crypto";
import type { ChatMessage, VendorConfig } from "../../vendors/types";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { toolRegistry } from "../../tools/registry/tool-registry";
import { prepareHarnessRecoveryState } from "../run-recovery";
import { getHarnessRunStore, type HarnessRequestSnapshot } from "../run-store";
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshotHarnessRequest(
  options: CyreneRunOptions,
  promptLayers: PromptLayers,
  tools: ToolDefinition[],
): HarnessRequestSnapshot {
  return {
    provider: options.settings.provider,
    model: options.settings.model,
    contextWindowTokens: options.settings.contextWindowTokens,
    ...(options.settings.reasoning ? { reasoning: JSON.stringify(options.settings.reasoning) } : {}),
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    promptFingerprint: fingerprint(promptLayers.stablePrefix),
    toolSchemaFingerprint: fingerprint(tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      schema: tool.inputSchema,
    })).sort((left, right) => left.id.localeCompare(right.id))),
    enabledToolIds: tools.map((tool) => tool.id).sort(),
    ...(options.resolvedWorkspaceRoot ? { workspaceRoot: options.resolvedWorkspaceRoot } : {}),
  };
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
  recovered?: ReturnType<typeof prepareHarnessRecoveryState>;
  runStore: ReturnType<typeof getHarnessRunStore>;
}

export async function prepareHarnessRun(
  options: CyreneRunOptions,
  signal: AbortSignal,
): Promise<PreparedHarnessRun> {
  const messageId = `msg-${Date.now()}`;
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
  };

  const tools = [...(options.capabilities?.tools ?? options.tools ?? toolRegistry.getEnabledTools())];
  const runStore = getHarnessRunStore(app.getPath("userData"));
  // 恢复校验必须使用当前稳定前缀与工具目录指纹；恢复上下文本身只进入 runtimeContext，
  // 因而先用未附加恢复说明的稳定前缀计算一次，不把 run recovery 变成循环依赖。
  const preRecoveryPromptLayers = options.resumeFromRunId
    ? buildHarnessPromptLayers(
      [options.recoveryContext, planContextBlock].filter(Boolean).length > 0
        ? {
          ...options,
          recoveryContext: [options.recoveryContext, planContextBlock].filter(Boolean).join("\n\n"),
        }
        : options,
    )
    : undefined;
  const preRecoveryHarnessPromptLayers: PromptLayers | undefined = preRecoveryPromptLayers
    ? {
      stablePrefix: preRecoveryPromptLayers.stablePrefix,
      ...(preRecoveryPromptLayers.sessionPrefix ? { sessionPrefix: preRecoveryPromptLayers.sessionPrefix } : {}),
      ...(preRecoveryPromptLayers.mode ? { mode: preRecoveryPromptLayers.mode } : {}),
    }
    : undefined;
  const currentRequestFingerprint = preRecoveryHarnessPromptLayers
    ? snapshotHarnessRequest(options, preRecoveryHarnessPromptLayers, tools)
    : undefined;
  const recovered = options.resumeFromRunId
    ? (() => {
      const previous = runStore.get(options.resumeFromRunId!);
      if (!previous || previous.conversationId !== threadId) throw new Error("HARNESS_RECOVERY_NOT_FOUND");
      return prepareHarnessRecoveryState(previous, {
        conversationId: threadId,
        workspaceRoot: options.resolvedWorkspaceRoot,
        provider: options.settings.provider,
        model: options.settings.model,
        enabledToolIds: tools.map((tool) => tool.id),
        promptFingerprint: currentRequestFingerprint?.promptFingerprint,
        toolSchemaFingerprint: currentRequestFingerprint?.toolSchemaFingerprint,
      });
    })()
    : undefined;

  // 消息历史始终来自 Task 6 journal；resume 只带回执行状态，不能覆盖权威轨迹。
  const baseRunMessages = options.messages;
  const recoveryContext = [options.recoveryContext, recovered?.recoveryContext, planContextBlock]
    .filter(Boolean).join("\n\n");
  const promptLayers = buildHarnessPromptLayers(
    recoveryContext ? { ...options, recoveryContext } : options,
  );
  const runMessages = materializeHarnessStartTranscript({
    messages: baseRunMessages,
    runId,
    runtimeContext: promptLayers.runtimeContext,
    initialState: recovered?.state,
    kind: recovered ? "recovery" : "run_start",
  });
  // create 必须发生在 Harness 启动前，并使用最终消息/提示词/工具指纹，供 checkpoint 和恢复校验复用。
  const harnessPromptLayers: PromptLayers = {
    stablePrefix: promptLayers.stablePrefix,
    ...(promptLayers.sessionPrefix ? { sessionPrefix: promptLayers.sessionPrefix } : {}),
    ...(promptLayers.mode ? { mode: promptLayers.mode } : {}),
  };
  const systemPrompt = harnessPromptLayers.stablePrefix;
  runStore.create({
    conversationId: threadId,
    runId,
    messages: runMessages,
    request: snapshotHarnessRequest(options, harnessPromptLayers, tools),
    ...(recovered ? { state: recovered.state, cache: recovered.cacheState } : {}),
    ...(options.resumeFromRunId ? { resumedFromRunId: options.resumeFromRunId } : {}),
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
    ...(recovered ? { recovered } : {}),
    runStore,
  };
}
