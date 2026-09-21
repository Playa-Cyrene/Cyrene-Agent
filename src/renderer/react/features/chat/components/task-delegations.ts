import type { TaskDelegationDisplayRecord } from "../../../../../shared/chat-types";
import type { TaskDelegationPresentation } from "../../../../../shared/task-session";

const TASK_CHARACTER_ASSETS: Readonly<Record<string, string>> = {
  风堇: "风堇.png", 刻律德菈: "刻律德菈.png", 长夜月: "长夜月.png", 遐蝶: "遐蝶.png", 缇宝: "缇宝.png",
  阿格莱雅: "阿格莱雅.png", 白厄: "白厄.png", 丹恒: "丹恒.png", 海瑟音: "海瑟音.png",
  那刻夏: "那刻夏.png", 赛飞儿: "赛飞儿.png", 万敌: "万敌.png",
};

export function normalizeTaskDelegationEvent(value: unknown): TaskDelegationPresentation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as Partial<TaskDelegationPresentation>;
  if (typeof event.invocationId !== "string" || !event.invocationId
    || typeof event.taskId !== "string" || !event.taskId
    || typeof event.description !== "string" || !event.description.trim()
    || typeof event.nickname !== "string"
    || TASK_CHARACTER_ASSETS[event.nickname] !== event.assetFileName
    || (event.status !== "running" && event.status !== "completed" && event.status !== "failed" && event.status !== "cancelled")) return undefined;
  return {
    invocationId: event.invocationId,
    taskId: event.taskId,
    description: event.description.trim(),
    nickname: event.nickname,
    assetFileName: event.assetFileName,
    status: event.status,
  };
}

export function applyTaskDelegationEvent(
  records: readonly TaskDelegationDisplayRecord[],
  event: TaskDelegationPresentation,
  roundId?: string,
): TaskDelegationDisplayRecord[] {
  const index = records.findIndex((record) => record.invocationId === event.invocationId);
  if (index < 0) return [...records, { ...event, ...(roundId !== undefined ? { roundId } : {}) }];
  return records.map((record, recordIndex) => {
    if (recordIndex !== index) return record;
    const { roundId: existingRoundId, ...recordWithoutRound } = record;
    const nextRoundId = existingRoundId ?? roundId;
    return {
      ...recordWithoutRound,
      ...event,
      ...(nextRoundId !== undefined ? { roundId: nextRoundId } : {}),
    };
  });
}
