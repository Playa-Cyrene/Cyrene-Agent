// 角色运行态（状态 / 心情）的共享定义：类型、图标资源与文案 key。
// 枚举字面量与主进程 src/main/runtime-state.ts 保持一致，渲染端只读不写。
import 陪伴中图标 from "../../assets/status-moods/陪伴中.png";
import 思考中图标 from "../../assets/status-moods/思考中.png";
import 工作中图标 from "../../assets/status-moods/工作中.png";
import 聆听中图标 from "../../assets/status-moods/聆听中.png";
import 提醒中图标 from "../../assets/status-moods/提醒.png";
import 离线图标 from "../../assets/status-moods/离线.png";

import 平静图标 from "../../assets/status-moods/平静.png";
import 开心图标 from "../../assets/status-moods/开心.png";
import 温柔图标 from "../../assets/status-moods/温柔.png";
import 激动图标 from "../../assets/status-moods/激动.png";
import 撒娇图标 from "../../assets/status-moods/撒娇.png";
import 担心图标 from "../../assets/status-moods/担心.png";
import 难过图标 from "../../assets/status-moods/难过.png";
import 感动图标 from "../../assets/status-moods/感动.png";
import 害羞图标 from "../../assets/status-moods/害羞.png";

export type RuntimeStatus = "陪伴中" | "思考中" | "工作中" | "聆听中" | "提醒中" | "离线";
export type RuntimeFeeling = "平静" | "开心" | "温柔" | "激动" | "撒娇" | "担心" | "难过" | "感动" | "害羞";

export interface RuntimeState {
  status: RuntimeStatus;
  feeling: RuntimeFeeling;
  expression: number;
}

/** 主进程未推送运行态时的兜底值 */
export const DEFAULT_RUNTIME_STATE: RuntimeState = { status: "陪伴中", feeling: "平静", expression: 0 };

/** 状态 → 图标资源 */
export const STATUS_ICON: Record<RuntimeStatus, string> = {
  陪伴中: 陪伴中图标,
  思考中: 思考中图标,
  工作中: 工作中图标,
  聆听中: 聆听中图标,
  提醒中: 提醒中图标,
  离线: 离线图标,
};

/** 心情 → 图标资源 */
export const FEELING_ICON: Record<RuntimeFeeling, string> = {
  平静: 平静图标,
  开心: 开心图标,
  温柔: 温柔图标,
  激动: 激动图标,
  撒娇: 撒娇图标,
  担心: 担心图标,
  难过: 难过图标,
  感动: 感动图标,
  害羞: 害羞图标,
};

/** 状态 → 译文 key */
export const STATUS_LABEL_KEY: Record<RuntimeStatus, string> = {
  陪伴中: "character.status.companion",
  思考中: "character.status.thinking",
  工作中: "character.status.working",
  聆听中: "character.status.listening",
  提醒中: "character.status.reminding",
  离线: "character.status.offline",
};

/** 心情 → 译文 key */
export const FEELING_LABEL_KEY: Record<RuntimeFeeling, string> = {
  平静: "character.feeling.calm",
  开心: "character.feeling.happy",
  温柔: "character.feeling.gentle",
  激动: "character.feeling.excited",
  撒娇: "character.feeling.clingy",
  担心: "character.feeling.worried",
  难过: "character.feeling.sad",
  感动: "character.feeling.moved",
  害羞: "character.feeling.shy",
};

/** IPC 回传的状态值不可信，未知取值一律回落到兜底值。 */
export function normalizeRuntimeState(value: unknown): RuntimeState {
  if (!value || typeof value !== "object") return DEFAULT_RUNTIME_STATE;
  const raw = value as Partial<RuntimeState>;
  return {
    status: raw.status && raw.status in STATUS_ICON ? raw.status : DEFAULT_RUNTIME_STATE.status,
    feeling: raw.feeling && raw.feeling in FEELING_ICON ? raw.feeling : DEFAULT_RUNTIME_STATE.feeling,
    expression: typeof raw.expression === "number" ? raw.expression : 0,
  };
}

/** 模型连接态摘要：connected 决定在线 / 离线，runtimeSync 决定状态区是否可用。 */
export interface ModelConfigSummary {
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
}

/** runtimeSync 非 off 即表示运行态同步已开启 */
export function isRuntimeSyncEnabled(summary: ModelConfigSummary): boolean {
  return summary.runtimeSync === "local" || summary.runtimeSync === "llm";
}

export function normalizeModelConfig(value: unknown): ModelConfigSummary {
  const raw = (value ?? {}) as Partial<ModelConfigSummary>;
  return {
    connected: Boolean(raw.connected),
    runtimeSync: raw.runtimeSync === "local" || raw.runtimeSync === "llm" ? raw.runtimeSync : "off",
  };
}

interface RuntimeStateBridge {
  get: () => Promise<RuntimeState | null>;
  onChanged: (callback: (state: RuntimeState) => void) => () => void;
}

interface ModelConfigBridge {
  get: () => Promise<unknown>;
  onChanged: (callback: (config: unknown) => void) => () => void;
}

interface CharacterBridge {
  openCall: () => void;
}

// preload 把 runtimeState / modelConfig / character 都暴露在全局，这里按需取用；
// 与 chat-page-bridge.ts 的取用方式一致，不额外写全局声明。
export function runtimeStateBridge(): RuntimeStateBridge | undefined {
  return (window as typeof window & { runtimeState?: RuntimeStateBridge }).runtimeState;
}

export function modelConfigBridge(): ModelConfigBridge | undefined {
  return (window as typeof window & { modelConfig?: ModelConfigBridge }).modelConfig;
}

export function characterBridge(): CharacterBridge | undefined {
  return (window as typeof window & { character?: CharacterBridge }).character;
}
