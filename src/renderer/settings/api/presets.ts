// 内置型号与端点由共享声明派生；图标和官网展示留在界面层。

import type { ApiTransport } from "../../../shared/api-endpoint";
import { VENDOR_REGISTRY, type BuiltinProviderId } from "../../../shared/vendor-registry";
import { getBuiltinModels } from "../../../shared/vendor-registry/catalog";
import { getPresetTransportUrl } from "../../../shared/vendor-registry/preset-defaults";
import type { VendorPresetDefaults } from "../../../shared/vendor-registry/model-types";
import type { ModelPreset } from "../shared/types";
import { CUSTOM_ENDPOINT_PROVIDERS } from "../custom-endpoint-state";

const PRESENTATION: Record<BuiltinProviderId, Pick<ModelPreset, "iconUrl" | "websiteUrl">> = {
  minimax: { iconUrl: "../icons/providers/minimax.svg", websiteUrl: "https://platform.minimaxi.com/" },
  deepseek: { iconUrl: "../icons/providers/deepseek.svg", websiteUrl: "https://platform.deepseek.com/" },
  doubao: { iconUrl: "../icons/providers/volcengine.svg", websiteUrl: "https://www.volcengine.com/product/ark" },
  glm: { iconUrl: "../icons/providers/glm.svg", websiteUrl: "https://open.bigmodel.cn/" },
  kimi: { iconUrl: "../icons/providers/kimi.svg", websiteUrl: "https://platform.moonshot.cn/" },
  qwen: { iconUrl: "../icons/providers/qwen.svg", websiteUrl: "https://bailian.console.aliyun.com/" },
  chatgpt: { iconUrl: "../icons/providers/openai.svg", websiteUrl: "https://platform.openai.com/" },
  claude: { iconUrl: "../icons/providers/claude.svg", websiteUrl: "https://console.anthropic.com/" },
  mimo: { iconUrl: "../icons/providers/xiaomimimo.svg", websiteUrl: "https://mimo.mi.com/" },
  grok: { iconUrl: "../icons/providers/grok.svg", websiteUrl: "https://console.x.ai/" },
  gemini: { iconUrl: "../icons/providers/gemini.svg", websiteUrl: "https://aistudio.google.com/" },
};

export const MODEL_PRESETS: ModelPreset[] = [
  ...VENDOR_REGISTRY.map((entry): ModelPreset => {
    const defaults: VendorPresetDefaults = entry.presetDefaults;
    const visionModels = getBuiltinModels(entry.capability.id, "vision");
    return {
      providerName: entry.capability.displayName,
      providerId: entry.capability.id,
      shortName: entry.shortName,
      ...defaults,
      ...PRESENTATION[entry.capability.id],
      mainModels: [...getBuiltinModels(entry.capability.id, "chat")],
      ...(visionModels.length ? { visionModels: [...visionModels] } : {}),
    };
  }),
{
    providerName: CUSTOM_ENDPOINT_PROVIDERS.cloud,
    providerId: "custom-cloud",
    shortName: "自定义",
    baseUrl: "",
    transport: "openai",
    mainModels: [],
    iconUrl: "../icons/providers/custom-endpoint.svg",
    customEndpointMode: "cloud",
  },
{
    providerName: CUSTOM_ENDPOINT_PROVIDERS.local,
    providerId: "custom-local",
    shortName: "本地模型",
    baseUrl: "",
    transport: "openai",
    mainModels: [],
    iconUrl: "../icons/providers/custom-endpoint.svg",
    customEndpointMode: "local",
    hiddenInPresetList: true,
  },
];

export function presetTransportUrl(preset: ModelPreset, transport: ApiTransport): string {
  return getPresetTransportUrl(preset, transport);
}
