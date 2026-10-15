import type { VendorPresetDefaults } from "./model-types";
import type { Transport } from "./types";

/** 界面投影与证据维护共用实际预设协议的入口选择。 */
export function getPresetTransportUrl(preset: VendorPresetDefaults, transport: Transport): string {
  if (transport === "anthropic" && preset.anthropicBaseUrl) return preset.anthropicBaseUrl;
  if (transport === "responses" && preset.responsesBaseUrl) return preset.responsesBaseUrl;
  return preset.baseUrl;
}
