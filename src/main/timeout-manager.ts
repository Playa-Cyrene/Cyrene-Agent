import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { DEFAULT_CHAT_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_SETTINGS, type TimeoutSettings } from "../shared/timeout-types";
import { normalizeModelRequestTimeoutMs, DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from "./orchestrator/config/model-timeout";

let cachedTimeoutSettings: TimeoutSettings | null = null;

function getTimeoutSettingsPath(): string {
  return path.join(app.getPath("userData"), "timeout-settings.json");
}

function normalizeTimeoutSettings(input: Partial<TimeoutSettings> | null | undefined): TimeoutSettings {
  return {
    testTimeout: input?.testTimeout || 15000,
    chatRequestTimeout: input?.chatRequestTimeout || DEFAULT_CHAT_REQUEST_TIMEOUT_MS,
    userChoiceTimeout: input?.userChoiceTimeout || 60000,
    // 审批等待默认 10 分钟：用户要通读计划再决定，60s 快问快答不够用
    planApprovalTimeout: input?.planApprovalTimeout || 600000,
    profileMinimumRemainingBudgetMs: input?.profileMinimumRemainingBudgetMs || -1,
    modelRequestTimeoutSec: input?.modelRequestTimeoutSec,
  };
}

function loadTimeoutSettings(): TimeoutSettings {
  try {
    const filePath = getTimeoutSettingsPath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_TIMEOUT_SETTINGS };
    const raw = fs.readFileSync(filePath, "utf8");
    return normalizeTimeoutSettings(JSON.parse(raw) as Partial<TimeoutSettings>);
  } catch (err) {
    console.error("[Cyrene] load settings failed:", err);
    return { ...DEFAULT_TIMEOUT_SETTINGS };
  }
}

export function getTimeoutSettings(): TimeoutSettings {
  if (cachedTimeoutSettings !== null) return cachedTimeoutSettings;
  return cachedTimeoutSettings = loadTimeoutSettings();
}

export function saveTimeoutSettings(settings: Partial<TimeoutSettings>): TimeoutSettings {
  const finalTimeoutSettings = getTimeoutSettings();
  Object.assign(finalTimeoutSettings, settings);
  const filePath = getTimeoutSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(finalTimeoutSettings, null, 2), "utf8");
  return finalTimeoutSettings;
}
