import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  AutoComplete,
  Button,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Modal,
  Radio,
  Select,
  Spin,
  Tag,
} from "antd";
import {
  Anthropic,
  DeepSeek,
  Doubao,
  Gemini,
  Grok,
  Minimax,
  Kimi,
  OpenAI,
  Qwen,
  XiaomiMiMo,
  Zhipu,
} from "@lobehub/icons";
import {
  ChevronDown,
  Cpu,
  ExternalLink,
  Eye,
  Image as ImageIcon,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ApiTransport } from "../../../../shared/api-endpoint";
import { resolveApiEndpoint } from "../../../../shared/api-endpoint";
import type { ReasoningEffort, ReasoningPreference } from "../../../../shared/reasoning";
import { normalizeManualReasoningConfig, type ManualReasoningConfig, type ManualReasoningStyle } from "../../../../shared/manual-reasoning";
import type { TimeoutSettings } from "../../../../shared/timeout-types";
import { DEFAULT_TIMEOUT_SETTINGS } from "../../../../shared/timeout-types";
import { CUSTOM_ENDPOINT_PROVIDERS, getCustomEndpointMode, type CustomEndpointMode } from "../../../settings/custom-endpoint-state";
import { MODEL_PRESETS } from "../../../settings/api/presets";
import type { ModelPreset } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsPasswordInput, SettingsSwitch } from "../../components/ui/SettingsControls";
import { Card } from "../../components/ui/Card";

type ProviderIcon = (props: { size?: number | string; style?: CSSProperties }) => ReactNode;

interface ProviderIconSet {
  mono: ProviderIcon;
  color?: ProviderIcon;
}

interface ModelProfile {
  id: string;
  provider: string;
  displayName?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: ApiTransport;
  reasoning?: ReasoningPreference;
  contextWindowTokens?: number;
  multimodal?: boolean;
  modelOptions?: Record<string, { contextWindowTokens?: number; multimodal?: boolean; manualReasoning?: ManualReasoningConfig }>;
  /** 档案内可切换的模型清单；缺省 = 单模型档案 */
  models?: string[];
}

interface RuntimeValues {
  modelRequestTimeoutSec: number | null;
  userChoiceTimeoutSec: number | null;
  maxParallelToolCalls: number | null;
  testTimeout: number | null;
}

interface VisionValues {
  baseUrl: string;
  apiKey: string;
  model: string;
}

const LOCAL_ENDPOINT_AUTH_FALLBACK = "__CYRENE_LOCAL_NO_AUTH__";
const iconByProvider: Record<string, ProviderIconSet> = {
  minimax: { mono: Minimax, color: Minimax.Color },
  deepseek: { mono: DeepSeek, color: DeepSeek.Color },
  doubao: { mono: Doubao, color: Doubao.Color },
  glm: { mono: Zhipu, color: Zhipu.Color },
  kimi: { mono: Kimi },
  qwen: { mono: Qwen, color: Qwen.Color },
  chatgpt: { mono: OpenAI },
  claude: { mono: Anthropic },
  mimo: { mono: XiaomiMiMo },
  // Grok 官方即黑白标（无 Color 变体）；Gemini 用四色渐变的 Color 变体
  grok: { mono: Grok },
  gemini: { mono: Gemini, color: Gemini.Color },
};

const runtimeDefaults: RuntimeValues = {
  modelRequestTimeoutSec: 60,
  userChoiceTimeoutSec: DEFAULT_TIMEOUT_SETTINGS.userChoiceTimeout / 1000,
  maxParallelToolCalls: 4,
  testTimeout: DEFAULT_TIMEOUT_SETTINGS.testTimeout,
};

function findPreset(provider: string): ModelPreset {
  return MODEL_PRESETS.find((preset) => preset.providerName === provider) ?? MODEL_PRESETS[0];
}

function providerIcon(provider: string, size = 22): ReactNode {
  const shortName = findPreset(provider).shortName;
  const providerKey = provider.toLowerCase();
  const iconKey = providerKey.includes("minimax") ? "minimax"
    : providerKey.includes("deepseek") ? "deepseek"
      : providerKey.includes("豆包") || providerKey.includes("volcengine") ? "doubao"
        : providerKey.includes("glm") || providerKey.includes("智谱") ? "glm"
          : providerKey.includes("kimi") || providerKey.includes("月之暗面") ? "kimi"
            : providerKey.includes("qwen") || providerKey.includes("通义") ? "qwen"
              : providerKey.includes("chatgpt") || providerKey.includes("openai") ? "chatgpt"
                : providerKey.includes("claude") || providerKey.includes("anthropic") ? "claude"
                  : providerKey.includes("mimo") || providerKey.includes("小米") ? "mimo"
                    : providerKey.includes("grok") ? "grok"
                      : providerKey.includes("gemini") ? "gemini" : "";
  const icon = iconByProvider[iconKey];
  const Logo = icon?.color ?? icon?.mono;
  return Logo
    ? <Logo size={size} style={iconKey === "kimi" ? { color: "var(--rb-text-primary)" } : icon.color ? undefined : { color: "#141413" }} />
    : <span className="cy-model-provider-fallback" aria-hidden="true">{shortName.slice(0, 1)}</span>;
}

function profilePreset(provider: string): ModelPreset {
  return findPreset(provider);
}

function transportUrl(preset: ModelPreset, transport: ApiTransport): string {
  if (transport === "anthropic" && preset.anthropicBaseUrl) return preset.anthropicBaseUrl;
  return preset.baseUrl;
}

// 编辑视图不变量：旧档案（无 models）进编辑页 = 以当前模型构成的单元素清单，不能显示空列表
function editableModelsOf(profile: ModelProfile): string[] {
  if (profile.models?.length) return [...profile.models];
  return profile.model ? [profile.model] : [];
}

// 新建档案预填：默认模型（mainModels[0]）置于清单首位去重，杜绝默认值不在清单里被改写
function presetModelsOf(preset: ModelPreset): string[] {
  const first = preset.mainModels[0];
  const candidates = first ? [first, ...preset.mainModels] : preset.mainModels;
  return [...new Set(candidates)];
}

interface ModelOptionDraft {
  multimodal: boolean;
  contextWindowTokens: string;
  manualReasoning?: ManualReasoningConfig;
}

const MANUAL_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = Math.round(tokens / 10_000) / 100;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}M`;
  }
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function parseContextWindow(value: string): number | undefined {
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const tokens = Number(normalized);
  return Number.isSafeInteger(tokens) && tokens >= 4096 ? tokens : undefined;
}

function defaultModelOption(): ModelOptionDraft {
  return { multimodal: true, contextWindowTokens: "256000" };
}

export function ModelSettingsPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>();
  const [activeId, setActiveId] = useState<string>();
  const [provider, setProvider] = useState(MODEL_PRESETS[0].providerName);
  const [displayName, setDisplayName] = useState(MODEL_PRESETS[0].shortName);
  const [baseUrl, setBaseUrl] = useState(MODEL_PRESETS[0].baseUrl);
  const [model, setModel] = useState(MODEL_PRESETS[0].mainModels[0] ?? "");
  // 档案内可切换的模型清单（编辑态）；model 只作"新对话默认模型"的单选标记
  const [models, setModels] = useState<string[]>(presetModelsOf(MODEL_PRESETS[0]));
  const [modelOptions, setModelOptions] = useState<Record<string, ModelOptionDraft>>(() =>
    Object.fromEntries(presetModelsOf(MODEL_PRESETS[0]).map((item) => [item, defaultModelOption()])),
  );
  const [newModel, setNewModel] = useState("");
  const [modelOptionModalOpen, setModelOptionModalOpen] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string>();
  const [modelOptionModelId, setModelOptionModelId] = useState("");
  const [modelOptionMultimodal, setModelOptionMultimodal] = useState(true);
  const [modelOptionContextWindow, setModelOptionContextWindow] = useState("256K");
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualStyle, setManualStyle] = useState<ManualReasoningStyle>("openai-effort");
  const [manualEfforts, setManualEfforts] = useState<ReasoningEffort[]>(["low", "medium", "high"]);
  const [manualDefaultEffort, setManualDefaultEffort] = useState<ReasoningEffort>("medium");
  const [manualSupportsDisable, setManualSupportsDisable] = useState(true);
  const [manualBodies, setManualBodies] = useState<Record<string, string>>({});
  const [manualPreviewLevel, setManualPreviewLevel] = useState("medium");
  const [manualPreview, setManualPreview] = useState<string>();
  const [manualChecking, setManualChecking] = useState(false);
  const [manualCheckResult, setManualCheckResult] = useState<string>();
  const [modelOptionError, setModelOptionError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [transport, setTransport] = useState<ApiTransport>(MODEL_PRESETS[0].transport);
  const [reasoning, setReasoning] = useState<ReasoningPreference>();
  const [vision, setVision] = useState<VisionValues>({ baseUrl: "", apiKey: "", model: "" });
  const [thinkingOverride, setThinkingOverride] = useState<-1 | 0 | 1>(0);
  const [disableMaxToken, setDisableMaxToken] = useState(false);
  const [runtime, setRuntime] = useState(runtimeDefaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testingVision, setTestingVision] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [status, setStatus] = useState<{ kind: "success" | "error" | "info"; text: string }>();
  const [visionStatus, setVisionStatus] = useState("");

  const preset = useMemo(() => findPreset(provider), [provider]);
  const customMode = getCustomEndpointMode(provider);
  const endpointPreview = baseUrl.trim() ? resolveApiEndpoint(baseUrl, transport).url : "";
  const providerOptions = MODEL_PRESETS.filter((item) => !item.hiddenInPresetList).map((item) => ({
    value: item.providerName,
    label: <span className="cy-model-provider-option">{providerIcon(item.providerName, 20)}<span>{item.shortName}</span></span>,
  }));

  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        if (!window.settings) throw new Error("Settings API unavailable");
        const [catalog, config, timeout, general] = await Promise.all([
          window.settings.listModelProfiles(),
          window.settings.getConfig(),
          window.settings.getTimeoutSettings(),
          window.settings.getGeneral(),
        ]);
        if (disposed) return;
        const loadedProfiles = catalog.profiles as ModelProfile[];
        setProfiles(loadedProfiles);
        setDefaultProfileId(catalog.defaultModelProfileId);
        setVision(config.vision ?? { baseUrl: "", apiKey: "", model: "" });
        setThinkingOverride(config.thinkingOverride ?? 0);
        setDisableMaxToken(Boolean(config.disableMaxToken));
        const generalValues = general && typeof general === "object" ? general as Record<string, unknown> : {};
        setRuntime({
          modelRequestTimeoutSec: timeout.modelRequestTimeoutSec ?? runtimeDefaults.modelRequestTimeoutSec,
          userChoiceTimeoutSec: Math.round(timeout.userChoiceTimeout / 1000),
          maxParallelToolCalls: typeof generalValues.maxParallelToolCalls === "number" ? generalValues.maxParallelToolCalls : runtimeDefaults.maxParallelToolCalls,
          testTimeout: timeout.testTimeout ?? runtimeDefaults.testTimeout,
        });
        if (loadedProfiles.length > 0) {
          const selected = loadedProfiles.find((item) => item.id === catalog.defaultModelProfileId) ?? loadedProfiles[0];
          setActiveId(selected.id);
          applyProfile(selected);
        }
      } catch {
        if (!disposed) setStatus({ kind: "error", text: t("settingsPage.modelSettings.loadFailed") });
      } finally {
        if (!disposed) setLoading(false);
      }
    }
    void load();
    return () => { disposed = true; };
  // Initial load only; applyProfile is intentionally stable for this effect.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyProfile(profile: ModelProfile) {
    const nextPreset = profilePreset(profile.provider);
    const nextTransport = profile.explicitTransport ?? nextPreset.transport;
    setProvider(profile.provider);
    setDisplayName(profile.displayName ?? nextPreset.shortName);
    setBaseUrl(profile.baseUrl || transportUrl(nextPreset, nextTransport));
    const nextModels = editableModelsOf(profile);
    setModels(nextModels);
    setModelOptions(Object.fromEntries(nextModels.map((item) => {
      const option = profile.modelOptions?.[item];
      return [item, {
        multimodal: option?.multimodal ?? profile.multimodal ?? true,
        contextWindowTokens: String(option?.contextWindowTokens ?? profile.contextWindowTokens ?? 256000),
        manualReasoning: option?.manualReasoning,
      }];
    })));
    setModel(profile.model ?? "");
    setApiKey(profile.apiKey === LOCAL_ENDPOINT_AUTH_FALLBACK ? "" : profile.apiKey ?? "");
    setTransport(nextTransport);
    setReasoning(profile.reasoning);
    setNewModel("");
    setStatus(undefined);
  }

  function startNewDraft(nextProvider = MODEL_PRESETS[0].providerName) {
    const nextPreset = findPreset(nextProvider);
    setActiveId(undefined);
    setProvider(nextProvider);
    setDisplayName(nextPreset.shortName);
    setBaseUrl(nextPreset.baseUrl);
    setModels(presetModelsOf(nextPreset));
    setModelOptions(Object.fromEntries(presetModelsOf(nextPreset).map((item) => [item, defaultModelOption()])));
    setModel(nextPreset.mainModels[0] ?? "");
    setApiKey("");
    setTransport(nextPreset.transport);
    setReasoning(undefined);
    setNewModel("");
    setStatus(undefined);
  }

  function changeProvider(nextProvider: string) {
    const nextPreset = findPreset(nextProvider);
    const nextMode = getCustomEndpointMode(nextProvider);
    setProvider(nextProvider);
    setDisplayName(nextPreset.shortName);
    setBaseUrl(nextPreset.baseUrl);
    setModels(presetModelsOf(nextPreset));
    setModelOptions(Object.fromEntries(presetModelsOf(nextPreset).map((item) => [item, defaultModelOption()])));
    setModel(nextPreset.mainModels[0] ?? "");
    setApiKey("");
    setTransport(nextPreset.transport);
    setNewModel("");
    if (nextMode === "local") setApiKey("");
    setStatus(undefined);
  }

  function changeTransport(nextTransport: ApiTransport) {
    const knownUrls = [preset.baseUrl, preset.anthropicBaseUrl].filter((item): item is string => Boolean(item));
    const currentIsPreset = knownUrls.some((item) => item.replace(/\/$/, "") === baseUrl.trim().replace(/\/$/, ""));
    if (currentIsPreset) setBaseUrl(transportUrl(preset, nextTransport));
    setTransport(nextTransport);
  }

  function changeCustomMode(mode: CustomEndpointMode) {
    const target = mode === "cloud" ? CUSTOM_ENDPOINT_PROVIDERS.cloud : CUSTOM_ENDPOINT_PROVIDERS.local;
    setProvider(target);
    setDisplayName(mode === "cloud" ? t("settingsPage.modelSettings.customCloud") : t("settingsPage.modelSettings.customLocal"));
    setApiKey("");
    setStatus(undefined);
  }

  function openModelOptionModal(modelValue = newModel) {
    setEditingModelId(undefined);
    setModelOptionModelId(modelValue.trim());
    setModelOptionMultimodal(true);
    setModelOptionContextWindow("256000");
    loadManualOption(undefined);
    setModelOptionError("");
    setModelOptionModalOpen(true);
  }

  function openEditModelOptionModal(modelId: string) {
    const option = modelOptions[modelId] ?? defaultModelOption();
    setEditingModelId(modelId);
    setModelOptionModelId(modelId);
    setModelOptionMultimodal(option.multimodal);
    setModelOptionContextWindow(option.contextWindowTokens);
    loadManualOption(option.manualReasoning);
    setModelOptionError("");
    setModelOptionModalOpen(true);
  }

  function loadManualOption(config: ManualReasoningConfig | undefined) {
    setManualEnabled(Boolean(config));
    setManualStyle(config?.style ?? "openai-effort");
    setManualEfforts(config?.supportedEfforts ?? ["low", "medium", "high"]);
    setManualDefaultEffort(config?.defaultEffort ?? "medium");
    setManualSupportsDisable(config?.supportsDisable ?? true);
    setManualBodies(Object.fromEntries(Object.entries(config?.customBodies ?? {}).map(([level, body]) => [level, JSON.stringify(body, null, 2)])));
    setManualPreviewLevel(config?.defaultEffort ?? (config?.supportedEfforts.length ? config.supportedEfforts[0] : "on"));
    setManualPreview(undefined);
    setManualCheckResult(undefined);
  }

  function currentManualConfig(): ManualReasoningConfig | undefined {
    if (!manualEnabled) return undefined;
    const efforts = manualStyle === "qwen-enable-thinking" ? [] : manualEfforts;
    const bodies: Record<string, Record<string, unknown>> = {};
    if (manualStyle === "custom") {
      for (const level of [...(efforts.length ? efforts : ["on"]), ...(manualSupportsDisable ? ["off"] : [])]) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(manualBodies[level] ?? "{}");
        } catch {
          throw new Error(t("settingsPage.modelSettings.manualJsonError"));
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(t("settingsPage.modelSettings.manualJsonError"));
        bodies[level] = parsed as Record<string, unknown>;
      }
    }
    const config = normalizeManualReasoningConfig({
      style: manualStyle,
      supportedEfforts: efforts,
      defaultEffort: efforts.includes(manualDefaultEffort) ? manualDefaultEffort : efforts[0],
      supportsDisable: manualSupportsDisable,
      ...(manualStyle === "custom" ? { customBodies: bodies } : {}),
    });
    if (!config) throw new Error(t("settingsPage.modelSettings.manualInvalid"));
    return config;
  }

  function draftReasoningPreference(): ReasoningPreference {
    return manualPreviewLevel === "off" ? { mode: "off" }
      : manualPreviewLevel === "on" ? { mode: "on" }
        : { mode: "on", effort: manualPreviewLevel as ReasoningEffort };
  }

  async function previewManualRequest(checkConnection = false) {
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      const config = currentManualConfig();
      const request = { provider, baseUrl: baseUrl.trim(), model: modelOptionModelId.trim(), apiKey: currentApiKey(), explicitTransport: transport, reasoning: draftReasoningPreference(), manualReasoning: config };
      if (checkConnection) {
        setManualChecking(true);
        const result = await window.settings.testConnection?.(request);
        setManualCheckResult(result?.ok
          ? t("settingsPage.modelSettings.manualCheckOk")
          : t("settingsPage.modelSettings.testFailed", { error: result?.error ?? t("settingsPage.modelSettings.unknownError") }));
      } else {
        const body = await window.settings.previewReasoning?.(request);
        setManualPreview(JSON.stringify(body, null, 2));
      }
      setModelOptionError("");
    } catch (error) {
      setModelOptionError(error instanceof Error ? error.message : String(error));
    } finally {
      setManualChecking(false);
    }
  }

  // 新增或修改时都在统一弹窗中配置，列表只负责展示配置结果。
  function saveModelOption() {
    const value = modelOptionModelId.trim();
    if (!value) {
      setModelOptionError(t("settingsPage.modelSettings.validationModelId"));
      return;
    }
    if (!editingModelId && models.some((item) => item === value)) {
      setModelOptionError(t("settingsPage.modelSettings.modelListDuplicate"));
      return;
    }
    const contextWindowTokens = parseContextWindow(modelOptionContextWindow);
    if (contextWindowTokens === undefined) {
      setModelOptionError(t("settingsPage.modelSettings.validationContextWindow"));
      return;
    }
    let manualReasoning: ManualReasoningConfig | undefined;
    try {
      manualReasoning = currentManualConfig();
    } catch (error) {
      setModelOptionError(error instanceof Error ? error.message : String(error));
      return;
    }
    const nextOption = { multimodal: modelOptionMultimodal, contextWindowTokens: String(contextWindowTokens), manualReasoning };
    if (editingModelId) {
      setModelOptions((current) => ({ ...current, [editingModelId]: nextOption }));
    } else {
      setModels((current) => [...current, value]);
      setModelOptions((current) => ({ ...current, [value]: nextOption }));
      if (!model) setModel(value);
      setNewModel("");
    }
    setStatus(undefined);
    setEditingModelId(undefined);
    setModelOptionModalOpen(false);
  }

  // 删除模型：最后一条禁删（UI 层禁止 + normalize 防御双保险）；删默认时默认顺位首项
  function removeModel(value: string) {
    if (models.length <= 1) return;
    const next = models.filter((item) => item !== value);
    setModels(next);
    setModelOptions((current) => Object.fromEntries(Object.entries(current).filter(([name]) => next.includes(name))));
    if (model === value) setModel(next[0] ?? "");
  }

  function currentApiKey() {
    return customMode === "local" && !apiKey.trim() ? LOCAL_ENDPOINT_AUTH_FALLBACK : apiKey.trim();
  }

  function validateProfile(): string | null {
    if (models.some((item) => parseContextWindow(modelOptions[item]?.contextWindowTokens ?? "") === undefined)) {
      return t("settingsPage.modelSettings.validationContextWindow");
    }
    if (customMode) {
      if (!baseUrl.trim()) return t("settingsPage.modelSettings.validationUrl");
      try {
        const parsed = new URL(baseUrl.trim());
        if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return t("settingsPage.modelSettings.validationUrl");
      } catch {
        return t("settingsPage.modelSettings.validationUrl");
      }
      if (!model.trim()) return t("settingsPage.modelSettings.validationModel");
      if (customMode === "cloud" && !apiKey.trim()) return t("settingsPage.modelSettings.validationApiKey");
    } else {
      if (!baseUrl.trim()) return t("settingsPage.modelSettings.validationUrl");
      if (!model.trim()) return t("settingsPage.modelSettings.validationModel");
    }
    return null;
  }

  async function saveProfile() {
    const validationMessage = validateProfile();
    if (validationMessage) {
      setStatus({ kind: "error", text: validationMessage });
      return;
    }
    if (!window.settings) return;
    const savedModelOptions = Object.fromEntries(models.map((item) => [item, {
      multimodal: modelOptions[item]?.multimodal ?? true,
      contextWindowTokens: parseContextWindow(modelOptions[item]?.contextWindowTokens ?? "") ?? 256000,
      manualReasoning: modelOptions[item]?.manualReasoning,
    }]));
    const defaultOption = savedModelOptions[model.trim()] ?? Object.values(savedModelOptions)[0] ?? { multimodal: true, contextWindowTokens: 256000 };
    setSaving(true);
    setStatus({ kind: "info", text: t("settingsPage.modelSettings.saving") });
    try {
      await window.settings.saveTimeoutSettings({ testTimeout: runtime.testTimeout ?? DEFAULT_TIMEOUT_SETTINGS.testTimeout });
      const result = await window.settings.saveModelProfile({
        id: activeId,
        provider,
        displayName: displayName.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        // 清单随档案全量保存；单元素清单由主进程 normalize 剥除（旧档案零变化）
        models: models.map((item) => item.trim()).filter(Boolean),
        apiKey: currentApiKey(),
        explicitTransport: transport,
        reasoning,
        // 新字段按模型保存；兼容字段镜像默认模型值，确保旧版读取时保持合理行为。
        modelOptions: savedModelOptions,
        contextWindowTokens: defaultOption.contextWindowTokens,
        multimodal: defaultOption.multimodal,
      });
      if (!activeId && !result.added) {
        setStatus({ kind: "error", text: t("settingsPage.modelSettings.duplicate") });
        return;
      }
      await window.settings.saveConfig({
        vision: { baseUrl: vision.baseUrl.trim(), apiKey: vision.apiKey.trim(), model: vision.model.trim() },
        thinkingOverride,
        disableMaxToken,
      });
      const catalog = await window.settings.listModelProfiles();
      const refreshed = catalog.profiles as ModelProfile[];
      const match = activeId
        ? refreshed.find((item) => item.id === activeId)
        : [...refreshed].reverse().find((item) => item.provider === provider && item.model === model.trim());
      setProfiles(refreshed);
      setDefaultProfileId(catalog.defaultModelProfileId);
      if (match) {
        setActiveId(match.id);
        applyProfile(match);
      }
      setStatus({ kind: "success", text: t("settingsPage.modelSettings.saved") });
    } catch {
      setStatus({ kind: "error", text: t("settingsPage.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  async function testConnection() {
    const validationMessage = validateProfile();
    if (validationMessage) {
      setStatus({ kind: "error", text: validationMessage });
      return;
    }
    if (!window.settings) return;
    setTesting(true);
    setStatus({ kind: "info", text: t("settingsPage.modelSettings.testing") });
    try {
      await window.settings.saveTimeoutSettings({ testTimeout: runtime.testTimeout ?? DEFAULT_TIMEOUT_SETTINGS.testTimeout });
      const result = await window.settings.testConnection({
        provider,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        apiKey: currentApiKey(),
        explicitTransport: transport,
        reasoning,
        manualReasoning: modelOptions[model.trim()]?.manualReasoning,
      });
      setStatus(result.ok
        ? { kind: "success", text: t("settingsPage.modelSettings.testOk", { latency: result.latency ?? 0, sample: result.sample ?? "" }) }
        : { kind: "error", text: t("settingsPage.modelSettings.testFailed", { error: result.error ?? t("settingsPage.modelSettings.unknownError") }) });
    } catch (error) {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.testFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setTesting(false);
    }
  }

  async function testVision() {
    if (!vision.baseUrl.trim() || !vision.model.trim()) {
      setVisionStatus(t("settingsPage.modelSettings.visionRequired"));
      return;
    }
    if (!window.settings) return;
    setTestingVision(true);
    setVisionStatus(t("settingsPage.modelSettings.testing"));
    try {
      const result = await window.settings.testVision({ baseUrl: vision.baseUrl.trim(), apiKey: vision.apiKey.trim(), model: vision.model.trim() });
      setVisionStatus(result.ok
        ? t("settingsPage.modelSettings.testOk", { latency: result.latency ?? 0, sample: result.sample ?? "" })
        : t("settingsPage.modelSettings.testFailed", { error: result.error ?? t("settingsPage.modelSettings.unknownError") }));
    } catch (error) {
      setVisionStatus(t("settingsPage.modelSettings.testFailed", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setTestingVision(false);
    }
  }

  async function deleteProfile() {
    if (!activeId || !window.settings) return;
    setDeleting(true);
    try {
      await window.settings.deleteModelProfile(activeId);
      const catalog = await window.settings.listModelProfiles();
      const refreshed = catalog.profiles as ModelProfile[];
      setProfiles(refreshed);
      setDefaultProfileId(catalog.defaultModelProfileId);
      const next = refreshed.find((item) => item.id === catalog.defaultModelProfileId) ?? refreshed[0];
      if (next) {
        setActiveId(next.id);
        applyProfile(next);
      } else {
        startNewDraft();
      }
      setStatus({ kind: "success", text: t("settingsPage.modelSettings.deleted") });
    } catch {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.deleteFailed") });
    } finally {
      setDeleting(false);
    }
  }

  async function setAsDefault() {
    if (!activeId || !window.settings) return;
    try {
      await window.settings.setDefaultModelProfile(activeId);
      setDefaultProfileId(activeId);
      setStatus({ kind: "success", text: t("settingsPage.modelSettings.defaultUpdated") });
    } catch {
      setStatus({ kind: "error", text: t("settingsPage.saveFailed") });
    }
  }

  async function saveRuntime() {
    if (!window.settings) return;
    const requestTimeout = runtime.modelRequestTimeoutSec;
    const userWait = Number(runtime.userChoiceTimeoutSec);
    const parallel = Number(runtime.maxParallelToolCalls);
    const testTimeout = Number(runtime.testTimeout);
    if (requestTimeout !== null && (!Number.isInteger(requestTimeout) || requestTimeout < 10 || requestTimeout > 600)) {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.requestTimeoutRange") });
      return;
    }
    if (!Number.isInteger(userWait) || userWait < 1) {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.userWaitRange") });
      return;
    }
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 8) {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.parallelRange") });
      return;
    }
    if (!Number.isInteger(testTimeout) || testTimeout < 1) {
      setStatus({ kind: "error", text: t("settingsPage.modelSettings.testTimeoutRange") });
      return;
    }
    setSaving(true);
    try {
      await window.settings.saveTimeoutSettings({
        modelRequestTimeoutSec: requestTimeout ?? undefined,
        userChoiceTimeout: userWait * 1000,
        testTimeout,
      } as Partial<TimeoutSettings>);
      await window.settings.saveGeneral({ maxParallelToolCalls: parallel });
      setStatus({ kind: "success", text: t("settingsPage.modelSettings.runtimeSaved") });
    } catch {
      setStatus({ kind: "error", text: t("settingsPage.saveFailed") });
    } finally {
      setSaving(false);
    }
  }

  const runtimePanel = (
    <div className="cy-model-runtime">
      <div className="cy-model-runtime__grid">
        <label className="cy-model-field">
          <span>{t("settingsPage.modelSettings.requestTimeout")}</span>
          <InputNumber min={10} max={600} step={5} value={runtime.modelRequestTimeoutSec} onChange={(value) => setRuntime((current) => ({ ...current, modelRequestTimeoutSec: value }))} addonAfter={t("settingsPage.modelSettings.seconds")} />
          <small>{t("settingsPage.modelSettings.requestTimeoutHint")}</small>
        </label>
        <label className="cy-model-field">
          <span>{t("settingsPage.modelSettings.userWait")}</span>
          <InputNumber min={1} value={runtime.userChoiceTimeoutSec} onChange={(value) => setRuntime((current) => ({ ...current, userChoiceTimeoutSec: value }))} addonAfter={t("settingsPage.modelSettings.seconds")} />
          <small>{t("settingsPage.modelSettings.userWaitHint")}</small>
        </label>
        <label className="cy-model-field">
          <span>{t("settingsPage.modelSettings.parallel")}</span>
          <SettingsInput className="cy-model-runtime__parallel" type="number" min={1} max={8} step={1} value={runtime.maxParallelToolCalls ?? ""} aria-label={t("settingsPage.modelSettings.parallel")} onChange={(event) => setRuntime((current) => ({ ...current, maxParallelToolCalls: event.target.value === "" ? null : Number(event.target.value) }))} />
          <small>{t("settingsPage.modelSettings.parallelHint")}</small>
        </label>
        <label className="cy-model-field">
          <span>{t("settingsPage.modelSettings.testTimeout")}</span>
          <InputNumber min={1} step={1000} value={runtime.testTimeout} onChange={(value) => setRuntime((current) => ({ ...current, testTimeout: value }))} addonAfter="ms" />
          <small>{t("settingsPage.modelSettings.testTimeoutHint")}</small>
        </label>
      </div>
      <div className="cy-model-runtime__actions">
        <Button type="primary" loading={saving} onClick={() => void saveRuntime()} icon={<Save size={15} />}>{t("settingsPage.modelSettings.saveRuntime")}</Button>
      </div>
    </div>
  );

  if (loading) return <div className="cy-settings-loading"><Spin /></div>;

  return (
    <div className="cy-model-settings">
      <header className="cy-model-header">
        <div>
          <h1>{t("settingsPage.modelSettings.title")}</h1>
          <p className="cy-settings-intro">{t("settingsPage.modelSettings.description")}</p>
        </div>
        <Button icon={<Plus size={16} />} onClick={() => startNewDraft()}>{t("settingsPage.modelSettings.addProfile")}</Button>
      </header>

      <section className="cy-model-layout" aria-label={t("settingsPage.modelSettings.title")}>
        <aside className="cy-model-list">
          <div className="cy-model-list__heading">
            <strong>{t("settingsPage.modelSettings.profiles")}</strong>
            <span>{profiles.length}</span>
          </div>
          <div className="cy-model-list__items">
            {profiles.map((item) => (
              <Card
                as="button"
                className={`cy-model-profile ${activeId === item.id ? "is-active" : ""}`}
                key={item.id}
                type="button"
                aria-current={activeId === item.id ? "true" : undefined}
                onClick={() => { setActiveId(item.id); applyProfile(item); }}
              >
                <span className="cy-model-profile__icon">{providerIcon(item.provider, 22)}</span>
                <span className="cy-model-profile__copy">
                  <strong>{item.displayName || item.model || findPreset(item.provider).shortName}</strong>
                  <small>{findPreset(item.provider).shortName} · {item.model}</small>
                </span>
                {item.id === defaultProfileId && <Tag className="cy-model-default-tag">{t("settingsPage.modelSettings.default")}</Tag>}
              </Card>
            ))}
            {profiles.length === 0 && <Empty className="cy-model-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("settingsPage.modelSettings.noProfiles")} />}
            <Card as="button" className={`cy-model-profile cy-model-profile--draft ${!activeId ? "is-active" : ""}`} type="button" onClick={() => startNewDraft()}>
              <span className="cy-model-profile__icon"><Plus size={18} /></span>
              <span className="cy-model-profile__copy"><strong>{t("settingsPage.modelSettings.newProfile")}</strong><small>{t("settingsPage.modelSettings.newProfileHint")}</small></span>
            </Card>
          </div>
          <p className="cy-model-list__footnote">{t("settingsPage.modelSettings.localStorageNote")}</p>
        </aside>

        <main className="cy-model-editor">
          <div className="cy-model-editor__heading">
            <div className="cy-model-editor__title-icon">{providerIcon(provider, 26)}</div>
            <div className="cy-model-editor__title-copy">
              <h2>{activeId ? (displayName || preset.shortName) : t("settingsPage.modelSettings.newProfile")}</h2>
              <p>{t("settingsPage.modelSettings.editorDescription")}</p>
            </div>
            {activeId === defaultProfileId ? <Tag className="cy-model-default-tag">{t("settingsPage.modelSettings.default")}</Tag> : activeId ? <Button type="text" onClick={() => void setAsDefault()}>{t("settingsPage.modelSettings.setDefault")}</Button> : null}
          </div>

          <Card className="cy-model-card">
            <div className="cy-model-card__section">
              <div className="cy-model-section-heading"><h3><Cpu size={17} />{t("settingsPage.modelSettings.providerSection")}</h3><p>{t("settingsPage.modelSettings.providerDescription")}</p></div>
              <div className="cy-model-fields cy-model-fields--two">
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.provider")}</span>
                  <Select options={providerOptions} value={customMode ? MODEL_PRESETS.find((item) => item.shortName === "自定义")?.providerName : provider} onChange={changeProvider} optionLabelProp="label" />
                </label>
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.profileName")}</span>
                  <SettingsInput value={displayName} onChange={(event) => setDisplayName(event.target.value)} maxLength={80} />
                </label>
              </div>
              {customMode && <div className="cy-model-custom-mode">
                <span>{t("settingsPage.modelSettings.customEndpointType")}</span>
                <Radio.Group value={customMode} onChange={(event) => changeCustomMode(event.target.value)} optionType="button" buttonStyle="solid">
                  <Radio.Button value="cloud">{t("settingsPage.modelSettings.customCloud")}</Radio.Button>
                  <Radio.Button value="local">{t("settingsPage.modelSettings.customLocal")}</Radio.Button>
                </Radio.Group>
              </div>}
              {preset.websiteUrl && !customMode && <a className="cy-model-provider-link" href={preset.websiteUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} />{t("settingsPage.modelSettings.providerWebsite", { provider: preset.shortName })}</a>}
            </div>

            <div className="cy-model-card__section">
              <div className="cy-model-section-heading"><h3><Wrench size={17} />{t("settingsPage.modelSettings.connectionSection")}</h3><p>{t("settingsPage.modelSettings.connectionDescription")}</p></div>
              <div className="cy-model-fields">
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.apiKey")}</span>
                  <SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={customMode === "local" ? t("settingsPage.modelSettings.apiKeyOptional") : "sk-…"} autoComplete="new-password" />
                  {customMode === "local" && <small>{t("settingsPage.modelSettings.localApiKeyHint")}</small>}
                </label>
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.baseUrl")}</span>
                  <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={customMode === "local" ? "http://127.0.0.1:11434/v1" : "https://api.example.com/v1"} addonAfter={<Button type="text" size="small" aria-label={t("settingsPage.modelSettings.resetBaseUrl")} title={t("settingsPage.modelSettings.resetBaseUrl")} onClick={() => setBaseUrl(transportUrl(preset, transport))}><RefreshCw size={13} /></Button>} />
                  {endpointPreview && <small className="cy-model-endpoint-preview">{t("settingsPage.modelSettings.endpointPreview")}: <code>{endpointPreview}</code></small>}
                </label>
                <div className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.transport")}</span>
                  <Radio.Group value={transport} onChange={(event) => changeTransport(event.target.value)} optionType="button" buttonStyle="solid" className="cy-model-transport">
                    <Radio.Button value="openai"><span className="cy-model-transport-option"><OpenAI size={16} aria-hidden="true" /><code>{t("settingsPage.modelSettings.transportOpenAI")}</code></span></Radio.Button>
                    <Radio.Button value="anthropic"><span className="cy-model-transport-option"><Anthropic size={16} aria-hidden="true" /><code>{t("settingsPage.modelSettings.transportAnthropic")}</code></span></Radio.Button>
                    <Radio.Button value="responses"><span className="cy-model-transport-option"><OpenAI size={16} aria-hidden="true" /><code>responses</code></span></Radio.Button>
                  </Radio.Group>
                </div>
                <div className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.modelList")}</span>
                  <div className="cy-model-list-editor">
                    <Radio.Group
                      className="cy-model-list-options"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      aria-label={t("settingsPage.modelSettings.modelList")}
                    >
                      {models.map((item) => (
                        <div className={`cy-model-list-item${item === model ? " is-selected" : ""}`} key={item}>
                          <Radio
                            className="cy-model-list-item__radio"
                            value={item}
                            aria-label={t("settingsPage.modelSettings.modelListDefaultAria", { model: item })}
                          >
                            <code>{item}</code>
                          </Radio>
                          {item === model && <Tag className="cy-model-default-tag">{t("settingsPage.modelSettings.default")}</Tag>}
                          {modelOptions[item]?.multimodal && (
                            <span className="cy-model-list-item__image is-enabled" title={t("settingsPage.modelSettings.multimodal")} aria-label={t("settingsPage.modelSettings.multimodal")}>
                              <ImageIcon size={14} />
                            </span>
                          )}
                          <span className="cy-model-list-item__context-value">{formatContextWindow(parseContextWindow(modelOptions[item]?.contextWindowTokens ?? "") ?? 256000)}</span>
                          <Button
                            type="text"
                            size="small"
                            className="cy-model-list-item__edit"
                            aria-label={t("settingsPage.modelSettings.modelListEditAria", { model: item })}
                            title={t("settingsPage.modelSettings.modelListEditAria", { model: item })}
                            onClick={() => openEditModelOptionModal(item)}
                          >
                            <Pencil size={14} />
                          </Button>
                          <Button
                            type="text"
                            size="small"
                            className="cy-model-list-item__remove"
                            disabled={models.length <= 1}
                            aria-label={t("settingsPage.modelSettings.modelListRemoveAria", { model: item })}
                            title={t("settingsPage.modelSettings.modelListRemoveAria", { model: item })}
                            onClick={() => removeModel(item)}
                          >
                            <X size={14} />
                          </Button>
                        </div>
                      ))}
                    </Radio.Group>
                    <div className="cy-model-list-add">
                      <AutoComplete
                        className="cy-model-list-autocomplete"
                        classNames={{ popup: { root: "cy-model-list-dropdown" } }}
                        options={preset.mainModels.map((value) => ({ value }))}
                        value={newModel}
                        onChange={setNewModel}
                        onSelect={(value) => setNewModel(value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            const value = newModel.trim();
                            const hasSuggestion = preset.mainModels.some((item) => item.toLowerCase().includes(value.toLowerCase()));
                            if (hasSuggestion) return;
                            event.preventDefault();
                            openModelOptionModal(value);
                          }
                        }}
                        placeholder={t("settingsPage.modelSettings.modelListAddPlaceholder")}
                        aria-label={t("settingsPage.modelSettings.modelListAdd")}
                      />
                      <Button type="text" size="small" onClick={() => openModelOptionModal()} aria-label={t("settingsPage.modelSettings.modelListAdd")} title={t("settingsPage.modelSettings.modelListAdd")}>
                        <Plus size={14} />
                      </Button>
                    </div>
                  </div>
                  <small>{t("settingsPage.modelSettings.modelListHint")}</small>
                </div>
              </div>
            </div>

            <div className="cy-model-card__section">
              <div className="cy-model-section-heading"><h3><Eye size={17} />{t("settingsPage.modelSettings.visionSection")}</h3><p>{t("settingsPage.modelSettings.visionDescription")}</p></div>
              <div className="cy-model-fields cy-model-fields--two">
                <label className="cy-model-field"><span>{t("settingsPage.modelSettings.baseUrl")}</span><SettingsInput value={vision.baseUrl} onChange={(event) => setVision((current) => ({ ...current, baseUrl: event.target.value }))} placeholder="https://api.openai.com/v1" /></label>
                <label className="cy-model-field"><span>{t("settingsPage.modelSettings.apiKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={vision.apiKey} onChange={(event) => setVision((current) => ({ ...current, apiKey: event.target.value }))} autoComplete="new-password" /></label>
                <label className="cy-model-field"><span>{t("settingsPage.modelSettings.visionModel")}</span><SettingsInput value={vision.model} onChange={(event) => setVision((current) => ({ ...current, model: event.target.value }))} placeholder="gpt-4o / qwen-vl-max" /></label>
                <div className="cy-model-field cy-model-vision-action"><span>{t("settingsPage.modelSettings.visionTestLabel")}</span><Button loading={testingVision} onClick={() => void testVision()} icon={<Eye size={15} />}>{t("settingsPage.modelSettings.testVision")}</Button>{visionStatus && <small>{visionStatus}</small>}</div>
              </div>
              <Collapse className="cy-model-advanced" items={[{
                key: "advanced",
                label: <span className="cy-model-advanced__label"><ChevronDown size={15} />{t("settingsPage.modelSettings.advancedOptions")}</span>,
                children: <div className="cy-model-advanced__controls">
                  <div className="cy-model-switch-row"><div><strong>{t("settingsPage.modelSettings.disableMaxToken")}</strong><small>{t("settingsPage.modelSettings.disableMaxTokenDescription")}</small></div><SettingsSwitch ariaLabel={t("settingsPage.modelSettings.disableMaxToken")} checked={disableMaxToken} onChange={setDisableMaxToken} disabled={!customMode} /></div>
                  <div className="cy-model-field"><span>{t("settingsPage.modelSettings.thinkingOverride")}</span><Radio.Group value={thinkingOverride} onChange={(event) => setThinkingOverride(event.target.value)} optionType="button" buttonStyle="solid" disabled={!customMode}>
                    <Radio.Button value={0}>{t("settingsPage.modelSettings.thinkingAuto")}</Radio.Button><Radio.Button value={1}>{t("settingsPage.modelSettings.thinkingOn")}</Radio.Button><Radio.Button value={-1}>{t("settingsPage.modelSettings.thinkingOff")}</Radio.Button>
                  </Radio.Group><small>{t("settingsPage.modelSettings.customOnly")}</small></div>
                </div>,
              }]} />
            </div>
          </Card>

          {status && <Alert className="cy-model-status" type={status.kind === "info" ? "info" : status.kind} showIcon message={status.text} />}
          <div className="cy-model-editor__actions">
            {activeId && <Button danger loading={deleting} icon={<Trash2 size={15} />} onClick={() => void deleteProfile()}>{t("settingsPage.modelSettings.deleteProfile")}</Button>}
            <Button loading={testing} icon={<Sparkles size={15} />} onClick={() => void testConnection()}>{t("settingsPage.modelSettings.testConnection")}</Button>
            <Button type="primary" loading={saving} icon={<Save size={15} />} onClick={() => void saveProfile()}>{t("settingsPage.modelSettings.saveProfile")}</Button>
          </div>
        </main>
      </section>

      <Modal
        rootClassName="cy-settings-theme-modal"
        title={t(editingModelId ? "settingsPage.modelSettings.modelOptionEditTitle" : "settingsPage.modelSettings.modelOptionTitle")}
        open={modelOptionModalOpen}
        onCancel={() => { setModelOptionModalOpen(false); setEditingModelId(undefined); }}
        onOk={saveModelOption}
        okText={t(editingModelId ? "settingsPage.modelSettings.modelOptionSave" : "settingsPage.modelSettings.modelListAdd")}
        cancelText={t("common.cancel")}
        destroyOnHidden
        width={640}
        styles={{ body: { maxHeight: "75vh", overflowY: "auto" } }}
      >
        <div className="cy-model-option-form">
          {modelOptionError && <Alert type="error" showIcon message={modelOptionError} />}
          <label className="cy-model-field">
            <span>{t("settingsPage.modelSettings.model")}</span>
            <Input
              autoFocus
              value={modelOptionModelId}
              disabled={Boolean(editingModelId)}
              onChange={(event) => { setModelOptionModelId(event.target.value); setModelOptionError(""); }}
              placeholder={t("settingsPage.modelSettings.modelPlaceholder")}
            />
          </label>
          <div className="cy-model-option-form__switch">
            <div><strong>{t("settingsPage.modelSettings.multimodal")}</strong><small>{t("settingsPage.modelSettings.multimodalDescription")}</small></div>
            <SettingsSwitch ariaLabel={t("settingsPage.modelSettings.multimodal")} checked={modelOptionMultimodal} onChange={setModelOptionMultimodal} />
          </div>
          <label className="cy-model-field">
            <span>{t("settingsPage.modelSettings.contextWindow")}</span>
            <Input
              value={modelOptionContextWindow}
              onChange={(event) => { setModelOptionContextWindow(event.target.value); setModelOptionError(""); }}
              type="number"
              min={4096}
              step={1}
              status={modelOptionContextWindow && parseContextWindow(modelOptionContextWindow) === undefined ? "error" : undefined}
              placeholder="256000"
            />
            <small>{t("settingsPage.modelSettings.contextWindowHint")}</small>
          </label>
          <Collapse items={[{
            key: "reasoning",
            label: t("settingsPage.modelSettings.manualReasoningTitle"),
            children: <div className="cy-model-option-form">
              <div className="cy-model-option-form__switch">
                <div><strong>{t("settingsPage.modelSettings.manualReasoningEnable")}</strong><small>{t("settingsPage.modelSettings.manualReasoningHint")}</small></div>
                <SettingsSwitch ariaLabel={t("settingsPage.modelSettings.manualReasoningEnable")} checked={manualEnabled} onChange={setManualEnabled} />
              </div>
              {manualEnabled && <>
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.manualStyle")}</span>
                  <Select aria-label={t("settingsPage.modelSettings.manualStyle")} value={manualStyle} onChange={(value: ManualReasoningStyle) => { setManualStyle(value); setManualPreviewLevel(value === "qwen-enable-thinking" ? "on" : manualDefaultEffort); setManualPreview(undefined); }} options={[
                    { value: "openai-effort", label: t("settingsPage.modelSettings.manualStyleOpenAI") },
                    { value: "thinking-type", label: t("settingsPage.modelSettings.manualStyleThinking") },
                    { value: "anthropic-adaptive", label: t("settingsPage.modelSettings.manualStyleAnthropic") },
                    { value: "qwen-enable-thinking", label: t("settingsPage.modelSettings.manualStyleQwen") },
                    { value: "custom", label: t("settingsPage.modelSettings.manualStyleCustom") },
                  ]} />
                </label>
                {manualStyle !== "qwen-enable-thinking" && <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.manualLevels")}</span>
                  <Select mode="multiple" aria-label={t("settingsPage.modelSettings.manualLevels")} value={manualEfforts} onChange={(levels: ReasoningEffort[]) => { setManualEfforts(levels); if (!levels.includes(manualDefaultEffort)) setManualDefaultEffort(levels[0] ?? "medium"); setManualPreviewLevel(levels[0] ?? "on"); }} options={MANUAL_EFFORTS.map((level) => ({ value: level, label: level }))} />
                </label>}
                {manualStyle !== "qwen-enable-thinking" && manualEfforts.length > 0 && <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.manualDefault")}</span>
                  <Select aria-label={t("settingsPage.modelSettings.manualDefault")} value={manualEfforts.includes(manualDefaultEffort) ? manualDefaultEffort : manualEfforts[0]} onChange={(level: ReasoningEffort) => setManualDefaultEffort(level)} options={manualEfforts.map((level) => ({ value: level, label: level }))} />
                </label>}
                <div className="cy-model-option-form__switch">
                  <strong>{t("settingsPage.modelSettings.manualOff")}</strong>
                  <SettingsSwitch ariaLabel={t("settingsPage.modelSettings.manualOff")} checked={manualSupportsDisable} onChange={(enabled) => { setManualSupportsDisable(enabled); if (!enabled && manualPreviewLevel === "off") setManualPreviewLevel(manualStyle === "qwen-enable-thinking" || manualEfforts.length === 0 ? "on" : manualEfforts[0]); }} />
                </div>
                {manualStyle === "custom" && [...(manualEfforts.length ? manualEfforts : ["on"]), ...(manualSupportsDisable ? ["off"] : [])].map((level) => <label className="cy-model-field" key={level}>
                  <span>{t("settingsPage.modelSettings.manualBody", { level })}</span>
                  <Input.TextArea aria-label={t("settingsPage.modelSettings.manualBody", { level })} rows={3} value={manualBodies[level] ?? "{}"} onChange={(event) => setManualBodies((current) => ({ ...current, [level]: event.target.value }))} spellCheck={false} />
                </label>)}
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.manualPreviewLevel")}</span>
                  <Select aria-label={t("settingsPage.modelSettings.manualPreviewLevel")} value={manualPreviewLevel} onChange={setManualPreviewLevel} options={[
                    ...(manualStyle === "qwen-enable-thinking" || manualEfforts.length === 0 ? [{ value: "on", label: "on" }] : manualEfforts.map((level) => ({ value: level, label: level }))),
                    ...(manualSupportsDisable ? [{ value: "off", label: "off" }] : []),
                  ]} />
                </label>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button onClick={() => void previewManualRequest()}>{t("settingsPage.modelSettings.manualPreviewButton")}</Button>
                  <Button loading={manualChecking} onClick={() => void previewManualRequest(true)}>{t("settingsPage.modelSettings.manualCheckButton")}</Button>
                </div>
                {manualPreview && <pre style={{ maxHeight: 220, overflow: "auto", padding: 12, border: "1px solid var(--rb-border-color, #d9d9d9)", borderRadius: 8, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{manualPreview}</pre>}
                {manualCheckResult && <small role="status">{manualCheckResult}</small>}
              </>}
            </div>,
          }]} />
        </div>
      </Modal>

      <section className="cy-model-runtime-section">
        <Collapse items={[{
          key: "runtime",
          label: <span className="cy-model-runtime-title"><Wrench size={17} /><span><strong>{t("settingsPage.modelSettings.runtimeTitle")}</strong><small>{t("settingsPage.modelSettings.runtimeDescription")}</small></span></span>,
          children: runtimePanel,
        }]} />
      </section>
    </div>
  );
}
