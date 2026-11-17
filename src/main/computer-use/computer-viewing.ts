import type { ComputerViewing } from "./computer-tools";

export type ComputerUseImageMode = "direct" | "relay";

/** 看图方式只依赖这几个字段；完整 ModelSettings 结构兼容。 */
export interface ComputerViewingSettings {
  model: string;
  multimodal?: boolean;
  vision?: { baseUrl: string; apiKey: string; model: string };
}

/**
 * 决定截图交给谁：用户选「直发」且主模型能看图 → 主模型；否则走视觉模型转述。
 * 主模型只支持文本时即使选了直发也走转述（#328），两条路都走不通时给出面向用户的原因。
 */
export function resolveComputerViewing(mode: ComputerUseImageMode, settings: ComputerViewingSettings): ComputerViewing {
  const vision = settings.vision;
  const visionReady = Boolean(vision?.baseUrl && vision.apiKey && vision.model);
  if (mode === "direct" && settings.multimodal !== false) {
    return { mode: "direct", recipient: `主模型 ${settings.model}` };
  }
  if (visionReady) return { mode: "relay", recipient: `视觉模型 ${vision!.model}` };
  return {
    mode: "unavailable",
    reason: mode === "relay"
      ? "桌面操作设置为「视觉模型转述」，但还没有配置视觉模型。请在「设置 → API 设置 → 视觉模型」中配置，或改为直发主模型。"
      : "当前主模型不能直接看图，且没有配置视觉模型。请在「设置 → API 设置 → 视觉模型」中配置，或切换到多模态主模型。",
  };
}
