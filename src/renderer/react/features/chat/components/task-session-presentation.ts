import type { ChatMessageItem } from "./ChatMessageList";
import type { TaskSession, TaskTraceRecord, TaskTranscriptMessage } from "../../../../../shared/task-session";
import type { AgentRoundRecord, ProcessMessageRecord, ReasoningBlock, ToolExecutionRecord } from "../../../../../shared/chat-types";

function textContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : JSON.stringify(value) ?? String(value);
  return value.flatMap((part) => {
    if (!part || typeof part !== "object") return [];
    const item = part as { type?: unknown; text?: unknown };
    return item.type === "text" && typeof item.text === "string" ? [item.text] : [];
  }).join("");
}

/** 每次委派独立分组。旧轨迹靠重复的首轮边界识别续接，新轨迹使用运行标识。 */
function splitTrace(trace: TaskTraceRecord[]): TaskTraceRecord[][] {
  const groups: TaskTraceRecord[][] = [];
  let rounds = new Set<string>();
  for (const record of trace) {
    const current = groups.at(-1);
    const newRun = record.runId && current && record.runId !== current.at(-1)?.runId;
    const legacyRestart = !record.runId && record.kind === "round" && record.phase === "start"
      && record.label && rounds.has(record.label);
    if (!current || newRun || legacyRestart) {
      groups.push([]);
      rounds = new Set();
    }
    if (record.kind === "round" && record.phase === "start" && record.label) rounds.add(record.label);
    groups.at(-1)!.push(record);
  }
  return groups;
}

function invocationActivity(messages: TaskTranscriptMessage[], trace: TaskTraceRecord[], running: boolean) {
  const rounds = new Map<string, AgentRoundRecord>();
  const reasoning = new Map<string, ReasoningBlock>();
  const processMessages: ProcessMessageRecord[] = [];
  const candidates = new Map<string, string>();
  const discarded = new Set<string>();
  const starts: Array<{ record: TaskTraceRecord; seq: number }> = [];
  const ends = new Map<string, TaskTraceRecord>();
  let activeRoundId: string | undefined;

  trace.forEach((raw, seq) => {
    if (raw.kind === "round" && raw.label) {
      if (raw.phase === "start") {
        activeRoundId = raw.label;
        rounds.set(raw.label, { id: raw.label, status: "running", startedAt: raw.at });
      } else if (raw.phase === "end") {
        const round = rounds.get(raw.label);
        if (round) rounds.set(raw.label, { ...round, status: "completed", completedAt: raw.at });
        activeRoundId = undefined;
      }
      return;
    }
    const record = { ...raw, roundId: raw.roundId ?? activeRoundId };
    if (record.kind === "candidate" && record.label) {
      if (record.phase === "discard") discarded.add(record.label);
      else if (record.phase === "delta") candidates.set(record.label, (candidates.get(record.label) ?? "") + (record.content ?? ""));
    } else if (record.kind === "reasoning" && record.label) {
      const block = reasoning.get(record.label) ?? { id: record.label, content: "", seq, roundId: record.roundId, afterToolCount: starts.length };
      if (record.phase === "delta") block.content += record.content ?? "";
      block.streaming = running && record.phase !== "end";
      reasoning.set(record.label, block);
    } else if (record.kind === "progress" && record.content) {
      processMessages.push({ id: record.id, content: record.content, seq, roundId: record.roundId, afterToolCount: starts.length });
    } else if (record.kind === "tool" && record.phase === "start" && record.label) {
      starts.push({ record, seq });
    } else if (record.kind === "tool" && record.phase === "end" && record.label) {
      ends.set(record.label, record);
    }
  });

  const results = new Map(messages.filter((message) => message.role === "tool" && message.toolCallId)
    .map((message) => [message.toolCallId!, message]));
  const toolExecutions: ToolExecutionRecord[] = [];
  const usedStarts = new Set<number>();
  const usedProgress = new Set<string>();
  const assistantMessages = messages.filter((message) => message.role === "assistant");
  assistantMessages.forEach((message, messageIndex) => {
    let messageRoundId = message.presentation?.roundId;
    let messageSeq: number | undefined;
    for (const rawCall of message.toolCalls ?? []) {
      if (!rawCall || typeof rawCall !== "object") continue;
      const call = rawCall as { id?: unknown; name?: unknown; arguments?: unknown };
      if (typeof call.id !== "string" || typeof call.name !== "string") continue;
      const startIndex = starts.findIndex(({ record }, index) => !usedStarts.has(index) && record.toolCallId === call.id);
      const legacyIndex = startIndex >= 0 ? startIndex : starts.findIndex(({ record }, index) =>
        !usedStarts.has(index) && !record.toolCallId && record.label === call.name);
      const start = starts[legacyIndex];
      if (start) usedStarts.add(legacyIndex);
      const end = ends.get(call.id);
      const result = results.get(call.id);
      const roundId = message.presentation?.roundId ?? start?.record.roundId ?? end?.roundId;
      const outcome = result?.presentation?.outcome ?? end?.status;
      const seq = start?.seq ?? trace.length + messageIndex;
      messageRoundId ??= roundId;
      messageSeq ??= seq;
      toolExecutions.push({
        id: call.id, name: call.name, displayName: start?.record.displayName,
        status: outcome ? outcome === "success" ? "success" : "error" : running ? "running" : "error",
        argsText: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments ?? {}),
        ...(result !== undefined ? { result: textContent(result.content) } : {}), seq, roundId,
      });
    }
    const content = textContent(message.content);
    const final = !running && messageIndex === assistantMessages.length - 1 && !message.toolCalls?.length;
    // canonical 工具轮正文与 progress 事件是同一条过程说明，只展示一次。
    if (content.trim() && !final) {
      const existing = processMessages.find((item) => !usedProgress.has(item.id)
        && (messageRoundId ? item.roundId === messageRoundId : item.content === content));
      if (existing) {
        existing.content = content;
        usedProgress.add(existing.id);
      } else {
        processMessages.push({ id: `process-${messageIndex}`, content, seq: messageSeq !== undefined ? messageSeq - 0.5 : trace.length + messageIndex,
          roundId: messageRoundId, afterToolCount: Math.max(0, toolExecutions.length - (message.toolCalls?.length ?? 0)) });
      }
    }
  });
  starts.forEach(({ record, seq }, index) => {
    if (usedStarts.has(index)) return;
    const end = record.toolCallId ? ends.get(record.toolCallId) : undefined;
    const result = record.toolCallId ? results.get(record.toolCallId) : undefined;
    const outcome = result?.presentation?.outcome ?? end?.status;
    toolExecutions.push({
      id: record.toolCallId ?? `trace-${record.id}`, name: record.label!, displayName: record.displayName,
      status: outcome ? outcome === "success" ? "success" : "error" : running ? "running" : "error",
      ...(result ? { result: textContent(result.content) } : {}),
      seq, roundId: record.roundId,
    });
  });
  toolExecutions.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));

  // 旧快照没有事件关联信息时使用主聊天既有的平铺回退，避免终态分组吞掉工具。
  const records = [...processMessages, ...reasoning.values(), ...toolExecutions];
  const agentRounds = records.every((record) => record.roundId && rounds.has(record.roundId)) ? [...rounds.values()] : [];
  return {
    agentRounds, reasoningBlocks: [...reasoning.values()], processMessages, toolExecutions,
    candidateText: [...candidates.entries()].reverse().find(([id]) => !discarded.has(id))?.[1] ?? "",
  };
}

/** 只适配子任务数据，正文、活动折叠和工具卡均交给主聊天的 ChatMessageList。 */
export function toTaskChatMessages(session: TaskSession): ChatMessageItem[] {
  const invocations: TaskTranscriptMessage[][] = [];
  for (const message of session.messages) {
    if (message.role === "user" || invocations.length === 0) invocations.push([]);
    invocations.at(-1)!.push(message);
  }
  if (invocations.length === 0) invocations.push([]);
  const traces = splitTrace(session.trace);
  const visible: ChatMessageItem[] = [];
  invocations.forEach((messages, index) => {
    const latest = index === invocations.length - 1;
    const running = latest && session.status === "running";
    // 轨迹有数量上限：被截断的旧轮次不冒用最新轮次的事件。
    const user = messages.find((message) => message.role === "user");
    const runId = user?.presentation?.runId ?? (latest ? session.childRunId : undefined);
    const legacyTrace = traces[index - (invocations.length - traces.length)];
    const trace = traces.find((group) => group[0]?.runId === runId && runId)
      ?? (legacyTrace?.[0]?.runId ? [] : legacyTrace ?? []);
    if (user) visible.push({ id: user.presentation?.id ?? `${session.id}-${index}-prompt`, role: "user", content: textContent(user.content), at: user.presentation?.at });
    const activity = invocationActivity(messages, trace, running);
    const lastAssistant = messages.filter((message) => message.role === "assistant").at(-1);
    const finalText = lastAssistant && !lastAssistant.toolCalls?.length ? textContent(lastAssistant.content) : "";
    const content = running ? "" : latest ? session.resultText || session.error?.message || finalText : finalText;
    const { candidateText, ...details } = activity;
    visible.push({
      id: `${session.id}-${index}-assistant`, role: "assistant", content, ...details,
      at: running ? undefined : latest ? session.completedAt : lastAssistant?.presentation?.at,
      ...(running && candidateText ? { transientText: candidateText, streaming: true } : {}),
      runActivity: {
        startedAt: user?.presentation?.at ?? trace[0]?.at ?? session.createdAt,
        ...(!running ? { completedAt: latest ? session.completedAt ?? session.updatedAt : trace.at(-1)?.at ?? session.updatedAt } : {}),
        reasoningMs: 0,
        ...(latest && session.status === "interrupted" ? { keepExpanded: true } : {}),
      },
      ...(latest ? { taskPlan: {
        title: session.description,
        steps: session.todoItems.filter((item) => item.status !== "cancelled").map((item) => ({
          id: item.id, title: item.content,
          status: item.status === "in_progress" ? "running" : item.status === "completed" ? "completed" : "pending",
        })),
      } } : {}),
      loading: running,
    });
  });
  return visible;
}
