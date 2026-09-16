import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DEFAULT_CONTEXT_WINDOW_TOKENS } from "../orchestrator/model-config";
import { foldReasoning, normalizeReasoningPreference, type ReasoningPreference } from "../../shared/reasoning";
import type { StickerSize } from "../../shared/sticker-types";
import { getSettingsPath } from "../settings-store";
import { migrateLegacyMinimaxDefaults } from "../orchestrator/vendors/minimax-defaults";
import { getCapabilityOrOpenAI } from "../orchestrator/vendors/capabilities";
import { addModelProfile, resolveDefaultModelProfile, updateModelProfile, type SavedModelProfile } from "./model-catalog";

/**
 * 统一模型配置入口：所有模块（包括 Code 模式）必须通过此函数读取。
 * 禁止在 Code 模块本地复制读取 JSON 逻辑。
 */
export interface PublicModelConfig {
  mode: "auto" | "manual";
  provider: string;
  // 用户自定义昵称；留空时状态栏用 shortName
  displayName?: string;
  // 厂商短名（去括号后缀），状态栏"正在喂养"的兜底显示
  shortName: string;
  model: string;
  connected: boolean;
  runtimeSync: "off" | "local" | "llm";
  stickerSize: StickerSize;
  rerankerMode: "standard" | "none";
}

// 单个厂商的可缓存配置：用户切到别的厂商再切回来，这三个字段从这里恢复。
export interface ProviderProfile {
  baseUrl: string;
  model: string;
  apiKey: string;
  displayName?: string;
  /**
   * 用户在 settings 显式选择的协议。"auto" 只用于读取旧配置，规范化后会固化为具体值。
   * "responses" = OpenAI Responses API（第三协议，2026-08 施工）。
   */
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  /**
   * 用户保存的推理偏好（source of truth）。顶层 ModelSettings.reasoning 是当前厂商镜像。
   * 当前模型不支持某个 effort 时仍保留 user preference，
   * 实际请求时由 resolveEffectiveReasoning 决定 effective config。
   */
  reasoning?: ReasoningPreference;
  /**
   * 上下文窗口（Token）。档案级字段；未定义 = 回退顶层 ModelSettings.contextWindowTokens。
   * 老档案（迁移前）不带此字段，行为与旧版一致。
   */
  contextWindowTokens?: number;
  /**
   * 主模型是否多模态。档案级字段；未定义 = 回退顶层 ModelSettings.multimodal。
   * true 时图片直发主模型（direct），false 走独立视觉模型转述（caption）。
   */
  multimodal?: boolean;
}

/**
 * 厂商名变更映射：旧 providerName → 新 providerName。
 *
 * 触发时机：UI 上为了对齐"英文名（中文公司名）"格式重命名了 preset 后，
 * 已存盘的 model-settings.json 里 provider 字段（以及 perProvider 字典的键）
 * 仍是旧名；normalize 阶段做一次性迁移，把旧名的 perProvider 数据搬到新名下，
 * provider 字段也改写为新名。迁移后写盘一次即清除痕迹。
 *
 * 后续如果再次重命名，**只追加键值对**，不要删除老条目，避免回归。
 */
const PROVIDER_RENAMES: Record<string, string> = {
  "MiniMax": "MiniMax（稀宇科技）",
  "DeepSeek": "DeepSeek（深度求索）",
  "智谱 GLM": "GLM（智谱）",
  "通义千问（DashScope）": "Qwen（通义千问）",
};

/**
 * 把 perProvider 字典 + currentProvider 字段一起套用 PROVIDER_RENAMES。
 * - 旧名 → 新名：直接搬数据；如果新名已存在数据，旧名的不覆盖（保护"已用新名存过"的情况）。
 * - 不在映射表里的键：原样保留。
 */
function migrateProviderRenames(
  currentProvider: string,
  perProvider: Record<string, ProviderProfile>,
): { provider: string; perProvider: Record<string, ProviderProfile> } {
  const next: Record<string, ProviderProfile> = {};
  for (const [key, value] of Object.entries(perProvider)) {
    const newKey = PROVIDER_RENAMES[key] ?? key;
    if (next[newKey]) {
      // 新名已经有数据（说明用户已经在新名下存过），旧名的本地副本保留为最近一次更新优先：
      // 这里取保守路线 → 不覆盖 next[newKey]，旧名直接丢弃。
      console.log("[Cyrene] provider rename: drop legacy", key, "→ kept", newKey);
      continue;
    }
    if (newKey !== key) {
      console.log("[Cyrene] provider rename:", key, "→", newKey);
    }
    next[newKey] = value;
  }
  const newProvider = PROVIDER_RENAMES[currentProvider] ?? currentProvider;
  return { provider: newProvider, perProvider: next };
}

export interface ModelSettings {
  mode: "auto" | "manual";
  /**
   * 配置文件 schema 版本。当前 2：multimodal 旧判定（syncWithMain / 无字段推断）已迁移落盘。
   * 旧文件（无此字段）首次加载时执行一次性迁移并写回，之后走干净路径。
   */
  schemaVersion?: number;
  provider: string;
  // 用户给模型起的自定义昵称，留空时状态栏用厂商 shortName。
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  /**
   * 当前厂商的 explicitTransport 镜像（顶层字段是 perProvider[currentProvider] 的视图）。
   * 详见 ProviderProfile.explicitTransport。
   */
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  /**
   * 当前厂商 reasoning 偏好的顶层镜像（与 explicitTransport 同思路）。
   * 真值在 perProvider[currentProvider].reasoning；顶层字段是 view。
   * 保存的是用户 preference（不覆盖）；effective config 由 capability 决定。
   */
  reasoning?: ReasoningPreference;
  // 按厂商缓存：currentProvider 之外的厂商配置也保留在这里，切回来时回填。
  // 真值（source of truth）是 perProvider；顶层 baseUrl/model/apiKey 是当前厂商那一份的展开镜像，
  // 仅为兼容现有 main 进程里大量直接读 settings.baseUrl 等代码而保留。
  perProvider: Record<string, ProviderProfile>;
  /** 用户保存的可选模型；默认项决定新对话和非对话任务的模型。 */
  modelProfiles?: SavedModelProfile[];
  defaultModelProfileId?: string;
  runtimeSync: "off" | "local" | "llm";
  stickerEnabled: boolean;
  stickerSize: StickerSize;
  stickerSimilarityThreshold: number;
  /** 整个聊天请求的总超时（秒）。30-1800，默认 300。 */
  chatRequestTimeoutSec: number;
  /** CITA 结构化输出重试总预算（秒）。4-30，默认 8。 */
  citaRepairBudgetSec: number;
  rerankerMode: "standard" | "none";
  embeddingModel: "bgem3";
  /**
   * Embedding 维度（可选，仅 cloud 模式有效）。
   * 留空 = 首次请求自动探测；填写 = 作为严格声明并与实际响应校验。
   */
  embeddingDimensions?: number;
  // 视觉模型配置（可选）。undefined 或未启用 = 不支持看图，read_image 诚实拒绝。
  vision?: VisionModelConfig;
  /** 主模型是否多模态。true 时图片直发主模型（direct），vision 配置保留但忽略。 */
  multimodal: boolean;
  thinkingOverride?: -1 | 0 | 1;
  disableMaxToken?: boolean;
  /** 上下文窗口大小（Token）。默认 256000，来自 DEFAULT_CONTEXT_WINDOW_TOKENS。唯一定义点。 */
  contextWindowTokens: number;
}

/** 视觉模型配置（独立视觉模型，非多模态直发场景）。全空 = 未启用。 */
export interface VisionModelConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** 当前配置文件 schema 版本。2 = multimodal 旧判定迁移完成标记。 */
const MODEL_SETTINGS_SCHEMA_VERSION = 2;

const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  mode: "auto",
  schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
  // 默认厂商改为 MiniMax（v1 vendor adapter 第一个落地的），DeepSeek 已从 v1 清单移除。
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "",
  explicitTransport: "anthropic",
  perProvider: {},
  runtimeSync: "off",
  stickerEnabled: true,
  stickerSize: "standard",
  stickerSimilarityThreshold: 0.55,
  chatRequestTimeoutSec: 300,
  citaRepairBudgetSec: 8,
  rerankerMode: "standard",
  embeddingModel: "bgem3",
  multimodal: true,
  contextWindowTokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
};

/**
 * 兼容 v0 显式协议：旧 "minimax" | "openai" 值映射为新 schema。
 * "minimax" → "openai"（v1 adapter 统一用 openai 协议访问 MiniMax）。
 */
function migrateLegacyExplicitTransport(
  input: Partial<ProviderProfile> | null | undefined,
  provider = DEFAULT_MODEL_SETTINGS.provider,
): ProviderProfile["explicitTransport"] {
  if (input?.explicitTransport === "openai" || input?.explicitTransport === "anthropic" || input?.explicitTransport === "responses") {
    return input.explicitTransport;
  }

  // 仅用于把旧版 auto/缺失值一次性固化；运行时不会再根据 URL 猜协议。
  const baseUrl = typeof input?.baseUrl === "string"
    ? input.baseUrl.trim().replace(/\/+$/, "").toLowerCase()
    : "";
  if (/\/anthropic($|\/)|\/v1\/messages($|\?)/.test(baseUrl)) return "anthropic";
  if (/\/chat\/completions($|\?)|\/completions($|\?)|\/v1\/chat/.test(baseUrl)) return "openai";
  if (baseUrl.endsWith("/v1")) return "openai";
  return getCapabilityOrOpenAI(provider).transport;
}

function normalizeProviderProfile(
  input: Partial<ProviderProfile> | null | undefined,
  provider = DEFAULT_MODEL_SETTINGS.provider,
): ProviderProfile {
  const explicitTransport: ProviderProfile["explicitTransport"] =
    migrateLegacyExplicitTransport(input, provider);
  const rawContextWindow = (input as { contextWindowTokens?: unknown })?.contextWindowTokens;
  return {
    baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl.trim() : "",
    model: typeof input?.model === "string" ? input.model.trim() : "",
    apiKey: typeof input?.apiKey === "string" ? input.apiKey.trim() : "",
    displayName: typeof input?.displayName === "string" && input?.displayName.trim() ? input.displayName.trim() : undefined,
    explicitTransport,
    reasoning: normalizeReasoningPreference((input as { reasoning?: unknown })?.reasoning),
    // 非法值 → undefined（回退全局）；下限 4096，与 UI 输入框 min 一致
    contextWindowTokens: typeof rawContextWindow === "number" && Number.isFinite(rawContextWindow) && rawContextWindow >= 4096
      ? Math.round(rawContextWindow)
      : undefined,
    // 仅接受显式 true/false；undefined/其他值 → undefined（回退全局）
    multimodal: (input as { multimodal?: unknown })?.multimodal === true || (input as { multimodal?: unknown })?.multimodal === false
      ? (input as { multimodal: boolean }).multimodal
      : undefined,
  };
}

/** 清洗视觉模型配置。三字段全空 = 未启用，返回 undefined。 */
function normalizeVisionConfig(input: Partial<VisionModelConfig> | undefined): VisionModelConfig | undefined {
  if (!input || typeof input !== "object") return undefined;
  const baseUrl = typeof input.baseUrl === "string" ? input.baseUrl.trim() : "";
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  // 三项全空 = 未启用
  if (!baseUrl && !apiKey && !model) return undefined;
  return { baseUrl, apiKey, model };
}

export function normalizeModelSettings(input: Partial<ModelSettings> | null | undefined): ModelSettings {
  const mode: "auto" | "manual" = input?.mode === "manual" ? "manual" : "auto";
  let provider = typeof input?.provider === "string" && input.provider.trim()
    ? input.provider.trim()
    : DEFAULT_MODEL_SETTINGS.provider;

  // perProvider 清洗：跳过非对象、非法键
  const rawPerProvider = (input as ModelSettings | undefined)?.perProvider;
  let perProvider: Record<string, ProviderProfile> = {};
  if (rawPerProvider && typeof rawPerProvider === "object") {
    for (const [key, value] of Object.entries(rawPerProvider)) {
      if (typeof key !== "string" || !key.trim()) continue;
      const providerName = key.trim();
      const migrated = migrateLegacyMinimaxDefaults(providerName, value as Partial<ProviderProfile> & { baseUrl: string });
      perProvider[providerName] = normalizeProviderProfile(migrated, providerName);
    }
  }

  // 厂商重命名迁移：把旧 provider 名在字典里和当前 provider 字段一并改成新名。
  // 必须在"旧 schema 兼容回填"之前做，否则会用旧名先创建一份僵尸数据。
  ({ provider, perProvider } = migrateProviderRenames(provider, perProvider));
  // 旧 schema 兼容：v1 之前的 model-config.json 没有 perProvider 字段，
  // 但有顶层 baseUrl/model/apiKey 三件套。首次升级时把它们当作 currentProvider 那一份回填。
  if (!perProvider[provider]) {
    const legacyProfile = migrateLegacyMinimaxDefaults(provider, {
      baseUrl: typeof input?.baseUrl === "string" ? input.baseUrl : "",
      model: typeof input?.model === "string" ? input.model : "",
      apiKey: typeof input?.apiKey === "string" ? input.apiKey : "",
      explicitTransport: input?.explicitTransport,
    });
    perProvider[provider] = normalizeProviderProfile(legacyProfile, provider);
    // 如果迁移后这一份完全是空的（用户从来没配过），再给个默认 baseUrl/model（便于 UI 第一次显示）
    if (!perProvider[provider].baseUrl) perProvider[provider].baseUrl = DEFAULT_MODEL_SETTINGS.baseUrl;
    if (!perProvider[provider].model) perProvider[provider].model = DEFAULT_MODEL_SETTINGS.model;
  }

  // 顶层镜像：用 perProvider[provider] 展开
  const profile = perProvider[provider];

  // multimodal 判定：schemaVersion >= 2 的文件已迁移落盘，直接读字段（缺省 true）；
  // 旧文件（无 schemaVersion）首次加载走一次性迁移，结果随 schemaVersion: 2 写盘后不再进入。
  // 默认 true 的理由：直发判错有服务端仲裁 + caption 自动降级兜底，
  // 而默认 false 会让多模态模型的用户发图莫名降级/看不了图（比发错更迷惑）。
  let multimodal = input?.multimodal !== false;
  const rawVision = input?.vision as Partial<VisionModelConfig> & { syncWithMain?: boolean } | undefined;
  if ((input?.schemaVersion ?? 1) < MODEL_SETTINGS_SCHEMA_VERSION) {
    if (rawVision && rawVision.syncWithMain === true) {
      multimodal = true;
    } else if (
      // 旧版配置没有 multimodal 字段（那时只有独立视觉模型，没有直发开关）：
      // 已配好独立视觉模型且未声明与主模型同步的用户，升级后继续走独立视觉模型，
      // 不被默认 true 静默旁路
      typeof input?.multimodal !== "boolean"
      && rawVision
      && rawVision.baseUrl && rawVision.apiKey && rawVision.model
    ) {
      multimodal = false;
    }
  }

  const hasPersistedProfiles = Array.isArray(input?.modelProfiles);
  const modelProfiles: SavedModelProfile[] = hasPersistedProfiles
    ? input!.modelProfiles!.filter((item): item is SavedModelProfile => Boolean(item && typeof item === "object" && typeof item.id === "string" && typeof item.provider === "string"))
      .map((item) => ({ ...normalizeProviderProfile(item, item.provider), id: item.id, provider: item.provider }))
    : [];

  // 迁移补全：仅当 modelProfiles 字段从未持久化过（老版本配置首次升级）时执行。
  // 之后 modelProfiles 永远是数组（可为空），不再从 perProvider 补——
  // 否则用户删除档案后重启，perProvider 残留数据会把档案"复活"。
  // 迁移档案不写 contextWindowTokens/multimodal → 运行时回退全局值，行为与迁移前一致；
  // 用户在 UI 里编辑保存后才落档案级值。id 人类可读，不用 hash/时间戳。
  if (!hasPersistedProfiles) {
    for (const [providerName, providerProfile] of Object.entries(perProvider)) {
      if (!providerProfile.apiKey || !providerProfile.model) continue;
      const seq = modelProfiles.filter((item) => item.provider === providerName).length + 1;
      modelProfiles.push({
        ...providerProfile,
        id: `profile-${providerName}-${seq}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
        provider: providerName,
      });
    }
    // 兜底：perProvider 全空但顶层镜像有效（极老版本配置）时至少保住当前这一份
    if (modelProfiles.length === 0 && profile.apiKey && profile.model) {
      modelProfiles.push({ ...profile, id: `legacy-${provider}-${profile.model}`.replace(/[^a-zA-Z0-9_-]/g, "_"), provider });
    }
  }

  return {
    mode,
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    provider,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
    explicitTransport: profile.explicitTransport,
    reasoning: profile.reasoning,  // 顶层镜像：与 explicitTransport 同源（perProvider[currentProvider].reasoning）
    perProvider,
    modelProfiles,
    defaultModelProfileId: typeof input?.defaultModelProfileId === "string" ? input.defaultModelProfileId : modelProfiles[0]?.id,
    runtimeSync: input?.runtimeSync === "llm" ? "llm" : input?.runtimeSync === "local" ? "local" : "off",
    stickerEnabled: input?.stickerEnabled !== false,
    stickerSize: input?.stickerSize === "small" || input?.stickerSize === "large" ? input.stickerSize : "standard",
    stickerSimilarityThreshold: typeof input?.stickerSimilarityThreshold === "number"
      ? Math.max(0.3, Math.min(0.9, input.stickerSimilarityThreshold))
      : 0.55,
    chatRequestTimeoutSec: typeof input?.chatRequestTimeoutSec === "number"
      && Number.isFinite(input.chatRequestTimeoutSec)
      ? Math.max(30, Math.min(1800, Math.round(input.chatRequestTimeoutSec)))
      : 300,
    citaRepairBudgetSec: typeof input?.citaRepairBudgetSec === "number" && Number.isFinite(input.citaRepairBudgetSec)
      ? Math.max(4, Math.min(30, Math.round(input.citaRepairBudgetSec)))
      : 8,
    rerankerMode: input?.rerankerMode === "none" ? "none" : "standard",
    embeddingModel: "bgem3",
    embeddingDimensions: typeof input?.embeddingDimensions === "number"
      && Number.isFinite(input.embeddingDimensions)
      && input.embeddingDimensions > 0
      ? Math.round(input.embeddingDimensions)
      : undefined,
    vision: normalizeVisionConfig(rawVision),
    multimodal,
    thinkingOverride: input?.thinkingOverride,
    disableMaxToken: input?.disableMaxToken,
    contextWindowTokens: typeof input?.contextWindowTokens === "number" && Number.isFinite(input.contextWindowTokens)
      && input.contextWindowTokens > 0
      ? Math.round(input.contextWindowTokens)
      : DEFAULT_CONTEXT_WINDOW_TOKENS,
  };
}

export function listSavedModelProfiles(settings = loadModelSettings()): SavedModelProfile[] {
  return settings.modelProfiles ?? [];
}

export function getDefaultModelProfile(settings = loadModelSettings()): SavedModelProfile | undefined {
  return resolveDefaultModelProfile(listSavedModelProfiles(settings), settings.defaultModelProfileId);
}

/**
 * 为单次对话展开已保存的模型。
 * - id 提供 → 展开该档案；档案不存在 → 退回 settings 原样（保持旧行为）。
 * - id 缺省 → 展开**默认档案**（defaultModelProfileId，缺失时第一个档案）；无任何档案 → settings 原样。
 *
 * 不传 id 不能再退回顶层镜像：顶层镜像 = 当前 provider 的 perProvider 项，可能全空
 * （用户只在档案里配了模型）。channel bot / 定时任务等不带 profileId 的调用方曾因此
 * 拿到空 baseUrl 直接抛错——否则飞书/微信渠道会出现"消息看得到但不回复"。
 */
export function resolveModelSettingsProfile(settings: ModelSettings, id?: string): ModelSettings {
  const profiles = listSavedModelProfiles(settings);
  const profile = id
    ? profiles.find((item) => item.id === id)
    : resolveDefaultModelProfile(profiles, settings.defaultModelProfileId);
  if (!profile) return settings;
  return {
    ...settings,
    provider: profile.provider,
    displayName: profile.displayName,
    baseUrl: profile.baseUrl,
    model: profile.model,
    apiKey: profile.apiKey,
    explicitTransport: profile.explicitTransport,
    reasoning: profile.reasoning,
    // 档案级字段覆盖镜像；未定义时回退全局值（老档案 = 现行为）
    contextWindowTokens: profile.contextWindowTokens ?? settings.contextWindowTokens,
    multimodal: profile.multimodal ?? settings.multimodal,
  };
}

export function saveModelProfile(input: Omit<SavedModelProfile, "id"> & { id?: string }): { settings: ModelSettings; added: boolean } {
  const existing = loadModelSettings();
  const profile: SavedModelProfile = { ...normalizeProviderProfile(input, input.provider), id: input.id ?? randomUUID(), provider: input.provider };

  // 带 id 且档案存在 → 更新（字段全量覆盖，表单即全量，不走去重）
  if (input.id) {
    const updated = updateModelProfile(listSavedModelProfiles(existing), profile);
    if (updated) {
      const settings = saveModelSettings({ modelProfiles: updated });
      return { settings, added: true };
    }
    // id 不存在（档案已被删除等）→ 落到新增路径，用现有 id 保存
  }

  const result = addModelProfile(listSavedModelProfiles(existing), profile);
  if (!result.added) return { settings: existing, added: false };
  const settings = saveModelSettings({ modelProfiles: result.profiles, defaultModelProfileId: existing.defaultModelProfileId ?? profile.id });
  return { settings: existing.defaultModelProfileId ? settings : setDefaultModelProfile(profile.id), added: true };
}

export function setDefaultModelProfile(id: string): ModelSettings {
  const existing = loadModelSettings();
  const profile = listSavedModelProfiles(existing).find((item) => item.id === id);
  if (!profile) throw new Error("模型不存在");
  return saveModelSettings({ ...profile, defaultModelProfileId: id });
}

let modelSettingsCache: ModelSettings | null = null;

function loadModelSettings0(): ModelSettings {
  try {
    const filePath = getSettingsPath();
    if (!fs.existsSync(filePath)) return { ...DEFAULT_MODEL_SETTINGS };
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelSettings>;
    const normalized = normalizeModelSettings(parsed);
    // 一次性迁移落盘：旧文件（无 schemaVersion）迁移后立即写回 + 备份原文件，
    // 下次加载看到 schemaVersion >= 2 就跳过全部旧判定，走干净路径。
    if ((parsed?.schemaVersion ?? 1) < MODEL_SETTINGS_SCHEMA_VERSION) {
      try {
        fs.copyFileSync(filePath, `${filePath}.bak`);
        fs.writeFileSync(filePath, JSON.stringify(normalized, null, 2), "utf8");
      } catch (writeErr) {
        // 写盘失败不阻塞启动：内存里已是迁移后的配置，下次启动会再试一次
        console.error("[Cyrene] model settings migration persist failed:", writeErr);
      }
    }
    return normalized;
  } catch (err) {
    console.error("[Cyrene] load settings failed:", err);
    return { ...DEFAULT_MODEL_SETTINGS };
  }
}

export function loadModelSettings(): ModelSettings {
  if (modelSettingsCache !== null) return modelSettingsCache;
  return modelSettingsCache = loadModelSettings0();
}

/**
 * 保存逻辑：
 *   - 渲染端发来的 settings 既可能带顶层 baseUrl/model/apiKey（旧调用方式），
 *     也可能带 perProvider（新调用方式，未来可扩展）。
 *   - 写盘前先把"顶层那三件套"折叠回 perProvider[provider]，保证真值落到字典里。
 *   - normalizeModelSettings 再把 perProvider[provider] 展开成顶层镜像，写盘 = 双视图一致。
 */
export function saveModelSettings(settings: Partial<ModelSettings>): ModelSettings {
  const existing = loadModelSettings();
  const merged: Partial<ModelSettings> = { ...existing, ...settings };

  // currentProvider 优先取传入的、再取已有的
  const currentProvider = (typeof settings.provider === "string" && settings.provider.trim())
    ? settings.provider.trim()
    : existing.provider;

  // 起点：复制现有 perProvider，再 merge 传入的 perProvider
  const perProvider: Record<string, ProviderProfile> = { ...(existing.perProvider ?? {}) };
  if (settings.perProvider && typeof settings.perProvider === "object") {
    for (const [key, value] of Object.entries(settings.perProvider)) {
      perProvider[key] = normalizeProviderProfile(value as Partial<ProviderProfile>, key);
    }
  }

  // 把传入的顶层三件套折叠到 currentProvider 下（这是渲染端目前主要的写入路径）
  const incomingProfile = perProvider[currentProvider] ?? normalizeProviderProfile(null, currentProvider);
  // 协议只接受用户明确选择的 OpenAI / Anthropic；旧 auto 不再进入运行时。
  const incomingExplicitTransport: ProviderProfile["explicitTransport"] =
    settings.explicitTransport === "openai" || settings.explicitTransport === "anthropic" || settings.explicitTransport === "responses"
      ? settings.explicitTransport
      : incomingProfile.explicitTransport;
  // reasoning 折叠（用户第三轮修订 #4）：优先级 perProvider > 顶层 > existing
  const incomingProfileForReasoning = (settings.perProvider ?? {})[currentProvider];
  const hasProfileReasoning = incomingProfileForReasoning
    && Object.prototype.hasOwnProperty.call(incomingProfileForReasoning, "reasoning");
  const hasTopLevelReasoning = Object.prototype.hasOwnProperty.call(settings, "reasoning");
  let chosenReasoningRaw: unknown;
  let chosenReasoningHasKey: boolean;
  if (hasProfileReasoning) {
    chosenReasoningRaw = (incomingProfileForReasoning as { reasoning?: unknown }).reasoning;
    chosenReasoningHasKey = true;
  } else if (hasTopLevelReasoning) {
    chosenReasoningRaw = settings.reasoning;
    chosenReasoningHasKey = true;
  } else {
    chosenReasoningRaw = undefined;
    chosenReasoningHasKey = false;
  }
  const foldedReasoning = foldReasoning(chosenReasoningRaw, incomingProfile.reasoning, chosenReasoningHasKey);

  perProvider[currentProvider] = {
    baseUrl: typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : incomingProfile.baseUrl,
    model: typeof settings.model === "string" ? settings.model.trim() : incomingProfile.model,
    apiKey: typeof settings.apiKey === "string" ? settings.apiKey.trim() : incomingProfile.apiKey,
    displayName: typeof settings.displayName === "string" && settings.displayName.trim()
      ? settings.displayName.trim()
      : incomingProfile.displayName,
    explicitTransport: incomingExplicitTransport,
    reasoning: foldedReasoning,
  };

  merged.provider = currentProvider;
  merged.perProvider = perProvider;

  const final = normalizeModelSettings(merged);
  const filePath = getSettingsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(final, null, 2), "utf8");
  Object.assign(existing, final);
  return final;
}

// 厂商短名映射（与 settings.ts 的 MODEL_PRESETS.shortName 镜像，需手动同步）。
// 状态栏"正在喂养"在用户没填昵称时用这个兜底。
const PROVIDER_SHORT_NAMES: Record<string, string> = {
  "MiniMax（稀宇科技）": "MiniMax",
  "DeepSeek（深度求索）": "DeepSeek",
  "豆包（火山方舟）": "豆包",
  "GLM（智谱）": "GLM",
  "Kimi（月之暗面）": "Kimi",
  "Qwen（通义千问）": "Qwen",
  "ChatGPT（OpenAI）": "ChatGPT",
  "Claude（Anthropic）": "Claude",
};

export function getPublicModelConfig(settings = loadModelSettings()): PublicModelConfig {
  // 状态面板表达“是否已有可用的已保存模型”，不能只看顶层默认镜像。
  // 打包版首次启动时镜像可能未回填，但 modelProfiles 已经持久化。
  const hasSavedModel = listSavedModelProfiles(settings).some((profile) => (
    Boolean(profile.model?.trim()) && Boolean(profile.apiKey?.trim())
  ));
  return {
    mode: settings.mode,
    provider: settings.provider,
    displayName: settings.displayName,
    shortName: PROVIDER_SHORT_NAMES[settings.provider] ?? settings.provider,
    model: settings.model,
    connected: hasSavedModel,
    runtimeSync: settings.runtimeSync,
    stickerSize: settings.stickerSize,
    rerankerMode: settings.rerankerMode,
  };
}
