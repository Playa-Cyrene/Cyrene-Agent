import { t } from "../../../i18n";
import type {
  AgentRoundRecord,
  ProcessMessageRecord,
  ReasoningBlock,
  TaskDelegationDisplayRecord,
  ToolExecutionRecord,
} from "../../../../../shared/chat-types";

// 以下映射只存 i18n key（非译文，可安全放模块顶层）；展示文案统一在函数调用时经 t() 求值，
// 以响应运行时语言切换（t() 不能出现在模块顶层常量里）。

const LIVE_TOOL_LABEL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.liveListDir",
  read_file: "agentRounds.liveReadFile",
  write_file: "agentRounds.liveWriteFile",
  edit_file: "agentRounds.liveEditFile",
  search_code: "agentRounds.liveSearchCode",
  search_text: "agentRounds.liveSearchText",
  run_shell: "agentRounds.liveRunShell",
};

const TOOL_LABEL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.toolListDir",
  read_file: "agentRounds.toolReadFile",
  write_file: "agentRounds.toolWriteFile",
  edit_file: "agentRounds.toolEditFile",
  str_replace: "agentRounds.toolStrReplace",
  apply_patch: "agentRounds.toolApplyPatch",
  search_code: "agentRounds.toolSearchCode",
  search_text: "agentRounds.toolSearchText",
  run_shell: "agentRounds.toolRunShell",
  ask_user: "agentRounds.toolAskUser",
};

const SUMMARY_TOOL_KEYS: Record<string, string> = {
  list_dir: "agentRounds.summaryListDir",
  read_file: "agentRounds.summaryReadFile",
  write_file: "agentRounds.summaryWriteFile",
  edit_file: "agentRounds.summaryEditFile",
  search_code: "agentRounds.summarySearchCode",
  search_text: "agentRounds.summarySearchText",
  run_shell: "agentRounds.summaryRunShell",
};

/** 实时执行中的工具动作名（"昔涟正在{{action}}"用）；优先主进程携带的中文展示名，未知名原样返回。 */
function liveToolLabel(name: string, displayName?: string): string {
  if (displayName) return displayName;
  const key = LIVE_TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

/** 工具执行卡片的标签；优先主进程携带的中文展示名，未知名原样返回。 */
function toolDisplayLabel(name: string, displayName?: string): string {
  if (displayName) return displayName;
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

/** 工具执行状态文案里的动作名；优先主进程携带的中文展示名，未知名回退"执行操作"。 */
function toolActionLabel(name: string, displayName?: string): string {
  if (displayName) return displayName;
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : t("agentRounds.fallbackAction");
}

export interface ToolExecutionPresentation {
  label: string;
  statusText: string;
  detail?: string;
}

function parseToolArgs(argsText?: string): Record<string, unknown> | undefined {
  if (!argsText) return undefined;
  try {
    const parsed: unknown = JSON.parse(argsText);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function firstStringArg(args: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/** 将底层工具调用转换为对用户有用且不泄露写入正文的执行摘要。 */
export function describeToolExecution(tool: ToolExecutionRecord): ToolExecutionPresentation {
  // ask_user 是用户交互而非文件操作：不走路径/命令提取，状态文案单独映射
  if (tool.name === "ask_user") {
    return {
      label: toolDisplayLabel(tool.name, tool.displayName),
      statusText: tool.status === "running"
        ? t("agentRounds.askUserWaiting")
        : tool.status === "error"
          ? t("agentRounds.askUserFailed")
          : t("agentRounds.askUserAnswered"),
      detail: undefined,
    };
  }
  const args = parseToolArgs(tool.argsText);
  const result = parseToolArgs(tool.result);
  const detail = tool.name === "run_shell"
    ? firstStringArg(args, ["command"])
    : firstStringArg(args, ["path", "filePath", "file_path", "directory", "dir"]);
  const label = toolDisplayLabel(tool.name, tool.displayName);
  const action = toolActionLabel(tool.name, tool.displayName);
  const statusText = tool.name === "run_shell" && tool.status === "error" && result?.timedOut === true
    ? t("agentRounds.commandTimeout")
    : tool.status === "running"
    ? t("agentRounds.statusRunning", { action })
    : tool.status === "error"
      ? t("agentRounds.statusFailed", { action })
      : t("agentRounds.statusDone", { action });
  return { label, statusText, detail };
}

export function createRoundProcessMessage(
  id: string,
  content: string,
  afterToolCount: number,
  roundId?: string,
  seq?: number,
): ProcessMessageRecord {
  return {
    id,
    content,
    afterToolCount,
    ...(roundId !== undefined ? { roundId } : {}),
    ...(seq !== undefined ? { seq } : {}),
  };
}

export function startAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  startedAt = Date.now(),
): AgentRoundRecord[] {
  if (rounds.some((round) => round.id === roundId)) return [...rounds];
  return [...rounds, { id: roundId, status: "running", startedAt }];
}

export function finishAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  completedAt = Date.now(),
): AgentRoundRecord[] {
  return rounds.map((round) => round.id === roundId
    ? { ...round, status: "completed", completedAt }
    : round);
}

export interface AgentRoundBoundaryState {
  rounds: AgentRoundRecord[];
  activeRoundId?: string;
}

export function applyAgentRoundBoundary(
  state: AgentRoundBoundaryState,
  action: "start" | "end",
  roundId: string,
  now = Date.now(),
): AgentRoundBoundaryState {
  if (action === "start") {
    return { rounds: startAgentRound(state.rounds, roundId, now), activeRoundId: roundId };
  }
  return {
    rounds: finishAgentRound(state.rounds, roundId, now),
    activeRoundId: state.activeRoundId === roundId ? undefined : state.activeRoundId,
  };
}

function completedSummary(tools: readonly ToolExecutionRecord[]): string[] {
  const successful = tools.filter((tool) => tool.status === "success");
  const counts = new Map<string, number>();
  for (const tool of successful) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  const facts = Object.entries(SUMMARY_TOOL_KEYS).flatMap(([name, key]) => {
    const count = counts.get(name) ?? 0;
    if (count === 0) return [];
    return [t(key, { count })];
  });
  if (facts.length === 0 && successful.length > 0) facts.push(t("agentRounds.summaryFallback", { count: successful.length }));
  return facts;
}

/** 本轮被改动的文件数（按路径去重）；用于完成态标题的粉色高亮提示。 */
export function countRoundChangedFiles(tools: readonly ToolExecutionRecord[]): number {
  const files = new Set<string>();
  for (const tool of tools) {
    for (const change of tool.changes ?? []) files.add(change.file);
  }
  return files.size;
}

export function resolveAgentRoundTitle(
  round: AgentRoundRecord,
  tools: readonly ToolExecutionRecord[],
  interrupted = false,
): string {
  const failures = tools.filter((tool) => tool.status === "error").length;
  if (interrupted) {
    return [t("agentRounds.interruptedTitle"), ...(failures ? [t("agentRounds.failureCount", { count: failures })] : [])].join(" · ");
  }
  if (round.status === "running") {
    const current = [...tools].reverse().find((tool) => tool.status === "running");
    return current
      ? t("agentRounds.runningLive", { action: liveToolLabel(current.name, current.displayName) })
      : t("agentRounds.runningThinking");
  }
  const facts = completedSummary(tools);
  if (failures) facts.push(t("agentRounds.failureCount", { count: failures }));
  return [t("agentRounds.completedTitle"), ...facts].join(" · ");
}

/** 平铺时间线条目：运行中所有可展示事件按实际发生顺序排列的最小载体。 */
export interface FlatRunTimelineEntry {
  kind: "reasoning" | "process" | "tool" | "task";
  key: string;
  /** 新记录的单调序号；缺失（旧记录/任务委派）排同组之后 */
  seq?: number;
  reasoning?: ReasoningBlock;
  process?: ProcessMessageRecord;
  tool?: ToolExecutionRecord;
  task?: TaskDelegationDisplayRecord;
}

interface FlatRunTimelineInput {
  processMessages: ProcessMessageRecord[];
  reasoningBlocks: ReasoningBlock[];
  tools: ToolExecutionRecord[];
  taskDelegations: TaskDelegationDisplayRecord[];
}

/**
 * 运行中的统一平铺时间线：推理、过程正文、工具卡、任务委派按实际发生顺序交错。
 * 顺序由 run 内单调递增的 seq 保证；旧记录（无 seq）回退 afterToolCount 分组排序，
 * 与历史恢复的既有顺序一致。终态归类不得重新排序——同一份数据只做一次分界。
 */
export function buildFlatRunTimeline({
  processMessages,
  reasoningBlocks,
  tools,
  taskDelegations,
}: FlatRunTimelineInput): FlatRunTimelineEntry[] {
  const hasSeq = [...processMessages, ...reasoningBlocks, ...tools].some((record) => record.seq !== undefined);
  if (!hasSeq) {
    // 旧记录回退：按 afterToolCount 分组，组内正文 → 推理，工具按原始顺序
    const entries: FlatRunTimelineEntry[] = [];
    for (let index = 0; index <= tools.length; index += 1) {
      for (const message of processMessages) {
        if ((message.afterToolCount ?? 0) !== index) continue;
        entries.push({ kind: "process", key: message.id, process: message });
      }
      for (const block of reasoningBlocks) {
        if ((block.afterToolCount ?? 0) !== index) continue;
        entries.push({ kind: "reasoning", key: block.id, reasoning: block });
      }
      if (index < tools.length) {
        entries.push({ kind: "tool", key: tools[index].id, tool: tools[index] });
      }
    }
    for (const delegation of taskDelegations) {
      entries.push({ kind: "task", key: `task-${delegation.invocationId}`, task: delegation });
    }
    return entries;
  }
  // 新记录：seq 单调排序；个别缺失 seq 的记录排在同组之后，不破坏已有顺序
  const entries: FlatRunTimelineEntry[] = [
    ...reasoningBlocks.map((block) => ({ kind: "reasoning" as const, key: block.id, seq: block.seq, reasoning: block })),
    ...processMessages.map((message) => ({ kind: "process" as const, key: message.id, seq: message.seq, process: message })),
    ...tools.map((tool) => ({ kind: "tool" as const, key: tool.id, seq: tool.seq, tool })),
    ...taskDelegations.map((delegation) => ({ kind: "task" as const, key: `task-${delegation.invocationId}`, seq: undefined, task: delegation })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const seqDiff = (a.entry.seq ?? Number.MAX_SAFE_INTEGER) - (b.entry.seq ?? Number.MAX_SAFE_INTEGER);
      return seqDiff !== 0 ? seqDiff : a.index - b.index;
    })
    .map(({ entry }) => entry as FlatRunTimelineEntry);
}

/** 从 ask_user 工具卡结果中拆出可读的问答行；非 ask_user 或无结果返回空。 */
export function buildAskUserQa(tool: ToolExecutionRecord): string[] {
  if (tool.name !== "ask_user" || !tool.result) return [];
  return tool.result
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.includes("→"));
}
