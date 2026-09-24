import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Collapse,
  Empty,
  Input,
  InputNumber,
  Radio,
  Select,
  Spin,
  Tag,
} from "antd";
import {
  Anthropic,
  DeepSeek,
  Doubao,
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
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import type { ApiTransport } from "../../../../shared/api-endpoint";
import { resolveApiEndpoint } from "../../../../shared/api-endpoint";
import type { ReasoningPreference } from "../../../../shared/reasoning";
import type { TimeoutSettings } from "../../../../shared/timeout-types";
import { DEFAULT_TIMEOUT_SETTINGS } from "../../../../shared/timeout-types";
import { CUSTOM_ENDPOINT_PROVIDERS, getCustomEndpointMode, type CustomEndpointMode } from "../../../settings/custom-endpoint-state";
import { MODEL_PRESETS } from "../../../settings/api/presets";
import type { ModelPreset } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";
import { SettingsInput, SettingsPasswordInput, SettingsSwitch } from "../../components/ui/SettingsControls";

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
                  : providerKey.includes("mimo") || providerKey.includes("小米") ? "mimo" : "";
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

export function ModelSettingsPanel() {
  const { t } = useTranslation();
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState<string>();
  const [activeId, setActiveId] = useState<string>();
  const [provider, setProvider] = useState(MODEL_PRESETS[0].providerName);
  const [displayName, setDisplayName] = useState(MODEL_PRESETS[0].shortName);
  const [baseUrl, setBaseUrl] = useState(MODEL_PRESETS[0].baseUrl);
  const [model, setModel] = useState(MODEL_PRESETS[0].mainModels[0] ?? "");
  const [apiKey, setApiKey] = useState("");
  const [transport, setTransport] = useState<ApiTransport>(MODEL_PRESETS[0].transport);
  const [contextWindow, setContextWindow] = useState<number | null>(256000);
  const [multimodal, setMultimodal] = useState(true);
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
    setModel(profile.model ?? "");
    setApiKey(profile.apiKey === LOCAL_ENDPOINT_AUTH_FALLBACK ? "" : profile.apiKey ?? "");
    setTransport(nextTransport);
    setContextWindow(profile.contextWindowTokens ?? 256000);
    setMultimodal(profile.multimodal ?? true);
    setReasoning(profile.reasoning);
    setStatus(undefined);
  }

  function startNewDraft(nextProvider = MODEL_PRESETS[0].providerName) {
    const nextPreset = findPreset(nextProvider);
    setActiveId(undefined);
    setProvider(nextProvider);
    setDisplayName(nextPreset.shortName);
    setBaseUrl(nextPreset.baseUrl);
    setModel(nextPreset.mainModels[0] ?? "");
    setApiKey("");
    setTransport(nextPreset.transport);
    setContextWindow(256000);
    setMultimodal(true);
    setReasoning(undefined);
    setStatus(undefined);
  }

  function changeProvider(nextProvider: string) {
    const nextPreset = findPreset(nextProvider);
    const nextMode = getCustomEndpointMode(nextProvider);
    setProvider(nextProvider);
    setDisplayName(nextPreset.shortName);
    setBaseUrl(nextPreset.baseUrl);
    setModel(nextPreset.mainModels[0] ?? "");
    setApiKey("");
    setTransport(nextPreset.transport);
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

  function currentApiKey() {
    return customMode === "local" && !apiKey.trim() ? LOCAL_ENDPOINT_AUTH_FALLBACK : apiKey.trim();
  }

  function validateProfile(): string | null {
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
        apiKey: currentApiKey(),
        explicitTransport: transport,
        reasoning,
        contextWindowTokens: Math.max(4096, Number(contextWindow) || 256000),
        multimodal,
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
              <button
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
              </button>
            ))}
            {profiles.length === 0 && <Empty className="cy-model-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("settingsPage.modelSettings.noProfiles")} />}
            <button className={`cy-model-profile cy-model-profile--draft ${!activeId ? "is-active" : ""}`} type="button" onClick={() => startNewDraft()}>
              <span className="cy-model-profile__icon"><Plus size={18} /></span>
              <span className="cy-model-profile__copy"><strong>{t("settingsPage.modelSettings.newProfile")}</strong><small>{t("settingsPage.modelSettings.newProfileHint")}</small></span>
            </button>
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

          <div className="cy-settings-card cy-model-card">
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
                    <Radio.Button value="openai">{t("settingsPage.modelSettings.transportOpenAI")}</Radio.Button>
                    <Radio.Button value="anthropic">{t("settingsPage.modelSettings.transportAnthropic")}</Radio.Button>
                    <Radio.Button value="responses">Responses</Radio.Button>
                  </Radio.Group>
                </div>
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.model")}</span>
                  <SettingsInput value={model} onChange={(event) => setModel(event.target.value)} placeholder={preset.mainModels[0] ?? t("settingsPage.modelSettings.modelPlaceholder")} list="cy-model-suggestions" />
                  <datalist id="cy-model-suggestions">{preset.mainModels.map((item) => <option key={item} value={item} />)}</datalist>
                </label>
                <label className="cy-model-field">
                  <span>{t("settingsPage.modelSettings.contextWindow")}</span>
                  <InputNumber min={4096} step={4096} value={contextWindow} onChange={setContextWindow} addonAfter="Tokens" />
                </label>
                <div className="cy-model-switch-row">
                  <div><strong>{t("settingsPage.modelSettings.multimodal")}</strong><small>{t("settingsPage.modelSettings.multimodalDescription")}</small></div>
                  <SettingsSwitch ariaLabel={t("settingsPage.modelSettings.multimodal")} checked={multimodal} onChange={setMultimodal} />
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
          </div>

          {status && <Alert className="cy-model-status" type={status.kind === "info" ? "info" : status.kind} showIcon message={status.text} />}
          <div className="cy-model-editor__actions">
            {activeId && <Button danger loading={deleting} icon={<Trash2 size={15} />} onClick={() => void deleteProfile()}>{t("settingsPage.modelSettings.deleteProfile")}</Button>}
            <Button loading={testing} icon={<Sparkles size={15} />} onClick={() => void testConnection()}>{t("settingsPage.modelSettings.testConnection")}</Button>
            <Button type="primary" loading={saving} icon={<Save size={15} />} onClick={() => void saveProfile()}>{t("settingsPage.modelSettings.saveProfile")}</Button>
          </div>
        </main>
      </section>

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
