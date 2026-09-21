// ProactiveChat 状态持久化（从原 opener/desire-engine 搬出 + 剃除 opener 专属字段）
// 文件名改用 "proactive-state.json"，避免与历史 opener-state.json 残留冲突。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import type { ProactiveCandidate, ProactiveCommitIntent, ProactiveState } from "./proactive-types";

export function defaultProactiveState(): ProactiveState {
  return {
    proactiveEpoch: 0,
    unansweredCount: 0,
    lastProactiveAt: null,
    lastProactiveScene: null,
    lastNormalConversationEndedAt: null,
    globalDesire: 0,
    affinity: {},
    lastFiredAt: {},
  };
}

function getStatePath(): string {
  return path.join(app.getPath("userData"), "proactive-state.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizePendingCommitIntent(value: unknown): ProactiveCommitIntent | undefined {
  if (!isRecord(value) || typeof value.intentId !== "string" || !value.intentId
    || !Number.isInteger(value.sequence) || (value.sequence as number) < 1
    || !Number.isInteger(value.generationEpoch) || (value.generationEpoch as number) < 0
    || typeof value.intentAt !== "number" || !Number.isFinite(value.intentAt)
    || typeof value.text !== "string" || !value.text
    || (value.source !== "model" && value.source !== "fallback")
    || !isRecord(value.candidate)
    || typeof value.candidate.sceneId !== "string"
    || typeof value.candidate.score !== "number" || !Number.isFinite(value.candidate.score)
    || typeof value.candidate.sceneCooldownMs !== "number" || !Number.isFinite(value.candidate.sceneCooldownMs)) return undefined;
  const candidate: ProactiveCandidate = {
    sceneId: value.candidate.sceneId,
    score: value.candidate.score,
    sceneCooldownMs: value.candidate.sceneCooldownMs,
  };
  return {
    intentId: value.intentId,
    sequence: value.sequence as number,
    candidate,
    generationEpoch: value.generationEpoch as number,
    intentAt: value.intentAt,
    text: value.text,
    source: value.source,
    ...(Object.prototype.hasOwnProperty.call(value, "fallbackPayload") ? { fallbackPayload: value.fallbackPayload } : {}),
  };
}

export function loadProactiveState(): ProactiveState {
  try {
    const p = getStatePath();
    if (!fs.existsSync(p)) return defaultProactiveState();
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Partial<ProactiveState>;
    const base = defaultProactiveState();
    const {
      pendingCommitIntent: _pendingCommitIntent,
      proactiveCommitSequence: _proactiveCommitSequence,
      ...legacyFields
    } = raw;
    const proactiveCommitSequence = typeof raw.proactiveCommitSequence === "number"
      && Number.isInteger(raw.proactiveCommitSequence)
      && raw.proactiveCommitSequence >= 0
      ? raw.proactiveCommitSequence
      : undefined;
    const pendingCommitIntent = normalizePendingCommitIntent(raw.pendingCommitIntent);
    return {
      ...base,
      ...legacyFields,
      affinity: { ...base.affinity, ...(raw.affinity ?? {}) },
      lastFiredAt: { ...(raw.lastFiredAt ?? {}) },
      ...(proactiveCommitSequence !== undefined ? { proactiveCommitSequence } : {}),
      ...(pendingCommitIntent !== undefined ? { pendingCommitIntent } : {}),
    };
  } catch {
    return defaultProactiveState();
  }
}

export function saveProactiveState(state: ProactiveState): void {
  const filePath = getStatePath();
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath); } catch { /* best effort cleanup */ }
    throw error;
  }
}
