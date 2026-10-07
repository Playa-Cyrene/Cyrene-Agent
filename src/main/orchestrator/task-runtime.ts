import { DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS, type TaskAccessMode, type TaskSession, type TaskSessionStatus, type TaskSubagentType, type TaskTraceRecord } from "../../shared/task-session";
import { TaskSessionStore } from "../tasks/task-session-store";
import { projectTaskTraceEvent } from "./task-events";
import { getTaskAgentProfile, resolveTaskTools } from "./task-profiles";
import { runCyreneHarness } from "./harness/cyrene-harness";
import type { HarnessInput, HarnessResult } from "./harness/types";
import { getHarnessRunStore } from "./harness/run-store";
import { getConversationTranscriptStore } from "./conversation-transcript-store";
import { createTranscriptSink } from "./transcript-sink";
import { projectTaskTodoItems, projectTaskTranscriptMessages } from "./task-transcript-projection";
import type { ToolDefinition } from "./tools/registry/tool-registry";
import type { VendorConfig, ChatMessage } from "./vendors/types";
import type { ToolContext } from "./tools/registry/tool-context";
import { taskCharacterLeasePool, type TaskCharacterLeasePool } from "../tasks/task-character-pool";
import { loadPromptFile } from "../prompts/prompt-loader";
import { loadGeneralSettings } from "../settings/settings-facade";
import { listSavedModelProfiles, loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";
import type { TaskDelegationPresentation } from "../../shared/task-session";
import type { RunCapabilities } from "./run-capabilities";
import type { PromptLayers } from "./prompt-layers";
import type { ToolOutputStore } from "./harness/tool-output/tool-output-store";

const TASK_TRACE_CHECKPOINT_INTERVAL_MS = 500;
const TASK_TRACE_LIMIT = 2_000;

function appendTaskTraceRecord(trace: TaskTraceRecord[], next: TaskTraceRecord): void {
  const previous = trace.at(-1);
  const canMergeDelta = (next.kind === "candidate" || next.kind === "reasoning")
    && next.phase === "delta"
    && previous?.kind === next.kind
    && previous.phase === "delta"
    && previous.label === next.label
    && previous.roundId === next.roundId;
  if (canMergeDelta && previous) {
    previous.content = `${previous.content ?? ""}${next.content ?? ""}`;
    previous.at = next.at;
  } else {
    trace.push(next);
  }
  if (trace.length > TASK_TRACE_LIMIT) trace.splice(0, trace.length - TASK_TRACE_LIMIT);
}

export interface TaskExecuteRequest {
  description: string;
  prompt: string;
  subagentType: TaskSubagentType;
  companionId: string;
  accessMode?: TaskAccessMode;
  maxParallelToolCalls?: number;
  taskId?: string;
}

export interface TaskExecuteResult {
  taskId: string;
  status: TaskSessionStatus;
  text: string;
}

export interface TaskCloseRequest {
  companionId: string;
}

export interface TaskCloseResult {
  taskId: string;
  companionId: string;
  status: "closed";
}

export interface TaskRuntimeParentContext {
  parentConversationId: string;
  parentRunId: string;
  mode: "work" | "code";
  systemPrompt: string;
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  capabilities?: RunCapabilities;
  resolvedWorkspaceRoot?: string;
  signal?: AbortSignal;
  checkPermission?: HarnessInput["checkPermission"];
  includeInteractiveTools?: boolean;
  permissionMode?: import("./cyrene-agent").CyreneRunOptions["permissionMode"];
  toolOutputStore?: ToolOutputStore;
  /** 子任务 session 增量落库（SQLite transcript）的 userData 根。缺省时子任务不写轨迹（仅测试路径）。 */
  transcriptRoot?: string;
}

function taskStatus(result: HarnessResult): { status: Exclude<TaskSessionStatus, "running" | "interrupted">; error?: { code: string; message: string } } {
  const terminal = result.terminal?.status;
  if (terminal === "cancelled" || result.terminateReason === "cancelled") return { status: "cancelled" };
  if (terminal === "timeout" || result.terminateReason === "timeout") {
    return { status: "failed", error: { code: "TASK_TIMEOUT", message: "子任务超过执行时间上限" } };
  }
  if (terminal === "runtime_error" || result.terminateReason === "error") {
    return { status: "failed", error: { code: "TASK_RUNTIME_ERROR", message: result.finalAnswer || "子任务运行失败" } };
  }
  return { status: "completed" };
}

export function buildChildPromptLayers(
  parent: TaskRuntimeParentContext,
  profilePrompt: string,
  accessMode: TaskAccessMode = "write",
): PromptLayers {
  const workspace = parent.resolvedWorkspaceRoot
    ? `可信工作目录：${parent.resolvedWorkspaceRoot}`
    : "当前没有绑定工作目录。";
  return {
    stablePrefix: [
      profilePrompt,
      accessMode === "read_only"
        ? "本任务处于只读模式：只检查和读取信息，不修改文件、仓库或外部状态。你可用的工具也已按只读能力限制。"
        : "本任务允许按指令执行写入；若同一轮存在并行委派，只读子任务可并行，写入子任务会排队串行执行。",
    ].join("\n"),
    sessionPrefix: `${workspace}\n会话模式：${parent.mode}`,
    mode: parent.mode,
  };
}

function stripCharacterPromptFrontmatter(prompt: string): string {
  return prompt.replace(/^\uFEFF?---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "").trim();
}

function buildCharacterTaskPrompt(companionId: string): string {
  const personaEnabled = loadGeneralSettings().taskCharacterPersonaEnabled;
  const taskSystem = personaEnabled
    ? loadPromptFile("task/task_system.md")
    : loadPromptFile("task/task_system_nonesoul.md");
  const character = personaEnabled
    ? stripCharacterPromptFrontmatter(loadPromptFile(`task/${companionId}.md`))
    : "";
  const taskSystemPath = personaEnabled ? "task/task_system.md" : "task/task_system_nonesoul.md";
  if (!taskSystem) console.warn(`[TaskRuntime] Missing task system prompt: prompts/${taskSystemPath}`);
  if (personaEnabled && !character) console.warn(`[TaskRuntime] Missing character task prompt: prompts/task/${companionId}.md`);
  return [taskSystem, character].filter(Boolean).join("\n\n");
}

function resolveTaskModel(parentVendorConfig: VendorConfig): {
  vendorConfig: VendorConfig;
  contextWindowTokens?: number;
} {
  const settings = loadGeneralSettings();
  const profileId = settings.taskModelProfileId;
  const model = settings.taskModel;
  if (!profileId || !model) return { vendorConfig: parentVendorConfig };

  const modelSettings = loadModelSettings();
  const profile = listSavedModelProfiles(modelSettings).find((candidate) => candidate.id === profileId);
  if (!profile) return { vendorConfig: parentVendorConfig };
  const availableModels = profile.models?.length ? profile.models : [profile.model];
  if (!availableModels.includes(model)) return { vendorConfig: parentVendorConfig };

  const expanded = resolveModelSettingsProfile(modelSettings, profileId);
  const modelOption = profile.modelOptions?.[model];
  return {
    vendorConfig: {
      ...parentVendorConfig,
      provider: expanded.provider,
      baseUrl: expanded.baseUrl,
      model,
      apiKey: expanded.apiKey,
      explicitTransport: expanded.explicitTransport,
      reasoning: expanded.reasoning,
      manualReasoning: modelOption?.manualReasoning,
    },
    contextWindowTokens: modelOption?.contextWindowTokens
      ?? profile.contextWindowTokens
      ?? modelSettings.contextWindowTokens,
  };
}

export function createTaskExecutor(input: {
  parent: TaskRuntimeParentContext;
  store: TaskSessionStore;
  runHarness?: typeof runCyreneHarness;
  characterPool?: Pick<TaskCharacterLeasePool, "acquire">;
  onLifecycle?: (event: TaskDelegationPresentation) => void;
}): (request: TaskExecuteRequest) => Promise<TaskExecuteResult> {
  const runHarness = input.runHarness ?? runCyreneHarness;
  const characterPool = input.characterPool ?? taskCharacterLeasePool;
  // session 增量落库的 facade：transcript 管对话事实，runs 管 run 生命周期。
  // conversationId 用稳定的 session.id，runId 用每次 resume 换新的 childRunId——
  // 与主 agent 的 conversationId/runId 模型同构，复用同一套表与幂等约束。
  const transcript = input.parent.transcriptRoot
    ? {
        store: getConversationTranscriptStore(input.parent.transcriptRoot),
        runs: getHarnessRunStore(input.parent.transcriptRoot),
      }
    : undefined;
  let transcriptHistory: ReturnType<typeof projectTaskTranscriptMessages> | undefined;
  let transcriptTodoItems: ReturnType<typeof projectTaskTodoItems> | undefined;
  return async (request) => {
    const profile = getTaskAgentProfile(request.subagentType);
    const lease = characterPool.acquire(input.parent.parentConversationId, request.companionId);
    let session: TaskSession;
    try {
      const previous = request.taskId
        ? null
        : await input.store.findOpenByCompanion(input.parent.parentConversationId, request.companionId);
      const taskId = request.taskId ?? previous?.id;
      session = taskId
        ? await input.store.resume(taskId, {
            parentConversationId: input.parent.parentConversationId,
            parentRunId: input.parent.parentRunId,
            subagentType: request.subagentType,
            prompt: request.prompt,
            companionId: request.companionId,
          })
        : await input.store.create({
            parentConversationId: input.parent.parentConversationId,
            parentRunId: input.parent.parentRunId,
            description: request.description,
            prompt: request.prompt,
            subagentType: request.subagentType,
            companionId: request.companionId,
            mode: input.parent.mode,
            resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
          });
      if (transcript) {
        // run 记录先行：崩溃在对账时标记 interrupted（fail-closed），
        // user 条目随后；两步间的崩溃窗口只会留下孤儿 prompt 条目，可接受。
        await transcript.runs.create({ conversationId: session.id, runId: session.childRunId });
        await transcript.store.append(session.id, {
          id: `${session.childRunId}:prompt`,
          kind: "user",
          at: Date.now(),
          runId: session.childRunId,
          turnId: `${session.childRunId}:prompt`,
          revision: 1,
          payload: { text: request.prompt },
        });
        // 对话历史以 transcript 为唯一来源：checkpoint 全量快照退役后，
        // resume 的 harness 输入靠重投影（含当前 prompt，它刚追加为最后一个 user 条目）。
        const snapshot = await transcript.store.read(session.id);
        transcriptHistory = projectTaskTranscriptMessages(snapshot.entries);
        transcriptTodoItems = projectTaskTodoItems(snapshot.entries);
      }
    } catch (error) {
      lease.release();
      throw error;
    }

    const toolContext: ToolContext = {
      userQuery: request.prompt,
      conversationId: input.parent.parentConversationId,
      runId: session.childRunId,
      signal: input.parent.signal,
      resolvedWorkspaceRoot: input.parent.resolvedWorkspaceRoot,
      mode: input.parent.mode,
      allowedSkillIds: input.parent.capabilities?.skillIds,
      permissionMode: input.parent.permissionMode,
    };

    const presentation = {
      invocationId: session.childRunId,
      taskId: session.id,
      description: request.description,
      nickname: lease.nickname,
      assetFileName: lease.assetFileName,
    };
    let taskTrace = session.trace;
    let pendingTaskTrace: TaskTraceRecord[] = [];
    let taskTraceDirty = false;
    let taskTraceFlushTimer: ReturnType<typeof setTimeout> | undefined;
    const flushTaskTrace = async (): Promise<void> => {
      if (taskTraceFlushTimer !== undefined) {
        clearTimeout(taskTraceFlushTimer);
        taskTraceFlushTimer = undefined;
      }
      for (const record of pendingTaskTrace) appendTaskTraceRecord(taskTrace, record);
      if (pendingTaskTrace.length > 0) {
        pendingTaskTrace = [];
        taskTraceDirty = true;
      }
      if (!taskTraceDirty) return;
      await input.store.checkpoint(session.id, { trace: taskTrace });
      taskTraceDirty = false;
    };
    const scheduleTaskTraceFlush = () => {
      if (taskTraceFlushTimer !== undefined) return;
      taskTraceFlushTimer = setTimeout(() => {
        taskTraceFlushTimer = undefined;
        // Retain the dirty in-memory trace; the next batch or terminal flush retries it.
        void flushTaskTrace().catch((error) => console.error("[TaskRuntime] trace checkpoint failed", error));
      }, TASK_TRACE_CHECKPOINT_INTERVAL_MS);
    };
    input.onLifecycle?.({ ...presentation, status: "running" });

    try {
      const combinedTaskPrompt = buildCharacterTaskPrompt(request.companionId);
      const promptLayers = buildChildPromptLayers(input.parent, combinedTaskPrompt, request.accessMode ?? "write");
      const taskModel = resolveTaskModel(input.parent.vendorConfig);
      let activeRoundId: string | undefined;
      // entryId 由 (runId, 协议点) 确定性生成：resume 产生新 childRunId，重试不会写重复条目。
      const transcriptSink = transcript
        ? createTranscriptSink({
            store: transcript.store,
            conversationId: session.id,
            runId: session.childRunId,
            assistantTurnId: `${session.childRunId}:assistant`,
          })
        : undefined;
      const result = await runHarness({
        systemPrompt: promptLayers.stablePrefix,
        promptLayers,
        messages: (transcriptHistory ?? session.messages) as ChatMessage[],
        tools: resolveTaskTools(profile, input.parent.tools, request.accessMode ?? "write"),
        vendorConfig: taskModel.vendorConfig,
        config: {
          totalTimeoutMs: profile.timeoutMs,
          maxParallelToolCalls: request.maxParallelToolCalls ?? DEFAULT_TASK_MAX_PARALLEL_TOOL_CALLS,
          ...(taskModel.contextWindowTokens ? { contextWindowTokens: taskModel.contextWindowTokens } : {}),
        },
        initialState: {
          todoItems: transcriptTodoItems ?? session.todoItems,
          uncertainEffects: [],
        },
        ...(transcriptSink ? { transcriptSink } : {}),
        signal: input.parent.signal,
        toolContext,
        toolOutputStore: input.parent.toolOutputStore,
        checkPermission: input.parent.checkPermission,
        includeInteractiveTools: input.parent.includeInteractiveTools,
        onEvent: (event) => {
          if (event.type === "round_start") activeRoundId = event.roundId;
          const trace = projectTaskTraceEvent(event);
          if (trace) {
            if (event.type !== "round_start" && event.type !== "round_end" && activeRoundId) {
              trace.roundId = activeRoundId;
            }
            pendingTaskTrace.push(trace);
            scheduleTaskTraceFlush();
          }
          if (event.type === "round_end") activeRoundId = undefined;
        },
      });
      await flushTaskTrace();
      const mapped = taskStatus(result);
      // run 生命周期是元数据不是权威事实（权威在 transcript）；落库失败只记录，不改变任务结果。
      try {
        await transcript?.runs.markTerminal(session.childRunId, mapped.status === "completed" ? "completed" : "failed");
      } catch (terminalError) {
        console.error("[TaskRuntime] run terminal 记录失败:", terminalError);
      }
      await input.store.checkpoint(session.id, {
        status: mapped.status,
        resultText: result.finalAnswer,
        todoItems: result.finalState.todoItems,
        ...(mapped.error ? { error: mapped.error } : {}),
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: mapped.status });
      return { taskId: session.id, status: mapped.status, text: result.finalAnswer };
    } catch (error) {
      try {
        await flushTaskTrace();
      } catch (traceError) {
        console.error("[TaskRuntime] final trace checkpoint failed", traceError);
      }
      const message = error instanceof Error ? error.message : String(error);
      try {
        // 终态必须落库：run 行滞留 running 会触发 one_active 唯一索引，阻塞该任务的下次 resume。
        await transcript?.runs.markTerminal(session.childRunId, input.parent.signal?.aborted ? "cancelled" : "failed");
      } catch (terminalError) {
        console.error("[TaskRuntime] run terminal 记录失败（任务已失败）:", terminalError);
      }
      await input.store.checkpoint(session.id, {
        status: input.parent.signal?.aborted ? "cancelled" : "failed",
        error: { code: input.parent.signal?.aborted ? "TASK_CANCELLED" : "TASK_RUNTIME_ERROR", message },
        completedAt: Date.now(),
      });
      input.onLifecycle?.({ ...presentation, status: input.parent.signal?.aborted ? "cancelled" : "failed" });
      throw error;
    } finally {
      if (taskTraceFlushTimer !== undefined) clearTimeout(taskTraceFlushTimer);
      lease.release();
    }
  };
}

export function createTaskCloser(input: {
  store: TaskSessionStore;
  parentConversationId: string;
}): (request: TaskCloseRequest) => Promise<TaskCloseResult> {
  return async ({ companionId }) => {
    const session = await input.store.closeByCompanion(input.parentConversationId, companionId);
    return { taskId: session.id, companionId, status: "closed" };
  };
}
