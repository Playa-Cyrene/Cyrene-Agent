// 厂商能力表 —— 聚合薄壳：数据事实源在 src/shared/vendor-registry/
// （一厂商一文件 entries/，本文件只是旧调用路径的门面）。
// 每条字段以 docs/vendors/tool-calling-matrix.md 为准；matrix 没核实的留保守默认值。
// displayName 必须与 renderer settings.ts 的 MODEL_PRESETS.providerName 完全一致。
import type { ProviderCapability } from "./types";
import { VENDOR_REGISTRY } from "../../../shared/vendor-registry";

// VENDOR_REGISTRY 保持旧能力表顺序（minimax 开头）——导出数组的顺序是可观察行为，
// 由 order-snapshot.test.ts 的 capability 顺序断言钉死。
export const PROVIDER_CAPABILITIES: readonly ProviderCapability[] =
  VENDOR_REGISTRY.map((entry) => entry.capability);

const byDisplayName = new Map(PROVIDER_CAPABILITIES.map(c => [c.displayName, c]));

export function getCapability(provider: string): ProviderCapability | undefined {
  return byDisplayName.get(provider);
}

/** 兜底：未知厂商按 OpenAI 兼容处理（保守可用），避免直接崩。 */
export function getCapabilityOrOpenAI(provider: string): ProviderCapability {
  return byDisplayName.get(provider) ?? {
    id: "unknown",
    displayName: provider,
    transport: "openai",
    baseUrl: "",
    authStyle: "bearer",
    defaultModel: "",
    supportsTools: true,
    supportsThinking: false,
    thinkingField: null,
    cacheStrategy: "none",
    testStrategy: "text",
    supportsVision: false,
  };
}
