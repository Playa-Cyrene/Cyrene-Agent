import { useEffect, useState } from "react";
import { Alert, Button, Input } from "antd";
import { AudioLines, Cloud, FileAudio, Headphones, Laptop, ListMusic, Mic2, Volume2, WandSparkles } from "lucide-react";
import { siMinimax, siXiaomi } from "simple-icons";
import { createUniqueMiniMaxVoiceId, validateMiniMaxVoiceId } from "../../../../shared/minimax-voice";
import { DEFAULT_MOSSLAND_TTS_MODEL, type MosslandSyncFormat } from "../../../../shared/tts-types";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { SettingsInput, SettingsPasswordInput, SettingsSelect, SettingsSegmented, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";
import "./TtsSettingsPanel.css";

type TtsEngine = "off" | "minimax" | "mimo" | "mossland" | "gptsovits" | "custom-cloud";
type Provider = Exclude<TtsEngine, "off">;
type SplitMode = "sentence" | "paragraph";
type TtsValues = {
  ttsEngine: TtsEngine;
  ttsAutoRead: boolean;
  ttsEarlyReadSplitEnabled: boolean;
  ttsEarlyReadSplitMode: SplitMode;
  ttsSpeed: number;
  ttsVolume: number;
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  ttsMinimaxModel: string;
  ttsStreaming: boolean;
  ttsMinimaxVocalEnhance: boolean;
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  ttsGptsovitsTimeoutMs: number;
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  ttsMosslandKey: string;
  ttsMosslandVoiceId: string;
  ttsMosslandModel: string;
  ttsMosslandTestText: string;
  ttsMosslandFormat: MosslandSyncFormat;
};

type TtsApi = {
  loadSettings: () => Promise<Record<string, unknown>>;
  saveSettings: (patch: Record<string, unknown>) => Promise<unknown>;
  pickAudio: () => Promise<string | null>;
  pickAudioFile: () => Promise<string | null>;
  synthesize: (payload: { apiKey: string; voiceId: string; text: string; model?: string; vocalEnhance?: { enabled: boolean } }) => Promise<string>;
  synthesizeGptsovits: (payload: { baseUrl: string; refAudioPath: string; promptText: string; text: string; format?: "wav" | "mp3" }) => Promise<{ base64: string; format: "wav" | "mp3" }>;
  synthesizeCustomCloud: (payload: { endpointUrl: string; apiKey?: string; voiceId?: string; text: string; speed?: number; volume?: number; format?: "wav" | "mp3"; timeoutMs?: number }) => Promise<{ base64: string; format: "wav" | "mp3" }>;
  synthesizeMimo: (payload: { apiKey: string; voiceAudioPath?: string; text: string; stylePrompt?: string }) => Promise<{ base64: string; format: "wav" }>;
  synthesizeMossland: (payload: { apiKey: string; voiceId: string; text: string; model?: string; format?: MosslandSyncFormat }) => Promise<{ base64: string; format: MosslandSyncFormat }>;
  upload: (apiKey: string, filePath: string, purpose: "voice_clone" | "prompt_audio") => Promise<{ file_id: string }>;
  clone: (payload: { apiKey: string; fileId: string; voiceId: string; promptAudioId?: string; promptText?: string; text: string }) => Promise<{ voiceId: string; audioDemo?: string }>;
  cloneMossland: (payload: { apiKey: string; filePath: string; name?: string; description?: string }) => Promise<{ voiceId: string; name?: string; createdAt?: number }>;
  listMosslandVoices: (payload: { apiKey: string; limit?: number }) => Promise<{ voices: Array<{ id: string; name: string; createdAt: number }>; hasMore: boolean }>;
};

const defaults: TtsValues = {
  ttsEngine: "off",
  ttsAutoRead: false,
  ttsEarlyReadSplitEnabled: true,
  ttsEarlyReadSplitMode: "sentence",
  ttsSpeed: 1,
  ttsVolume: 1,
  ttsMinimaxKey: "",
  ttsMinimaxVoiceId: "",
  ttsMinimaxModel: "speech-2.8-turbo",
  ttsStreaming: true,
  ttsMinimaxVocalEnhance: true,
  ttsGptsovitsBaseUrl: "http://localhost:9880",
  ttsGptsovitsRefAudioPath: "",
  ttsGptsovitsPromptText: "",
  ttsGptsovitsFormat: "wav",
  ttsGptsovitsTimeoutMs: 180000,
  ttsCustomCloudEndpointUrl: "",
  ttsCustomCloudApiKey: "",
  ttsCustomCloudVoiceId: "",
  ttsCustomCloudFormat: "mp3",
  ttsCustomCloudTimeoutMs: 30000,
  ttsMimoKey: "",
  ttsMimoVoiceAudioPath: "",
  ttsMimoStylePrompt: "温柔、自然、略带亲近感，像在轻声陪用户聊天。",
  ttsMosslandKey: "",
  ttsMosslandVoiceId: "",
  ttsMosslandModel: DEFAULT_MOSSLAND_TTS_MODEL,
  ttsMosslandTestText: "你好，我是昔涟，很高兴见到你。",
  ttsMosslandFormat: "mp3",
};

const providerFields: Record<Provider, Array<keyof TtsValues>> = {
  minimax: ["ttsMinimaxKey", "ttsMinimaxVoiceId"],
  gptsovits: ["ttsGptsovitsBaseUrl", "ttsGptsovitsRefAudioPath", "ttsGptsovitsPromptText", "ttsGptsovitsTimeoutMs"],
  "custom-cloud": ["ttsCustomCloudEndpointUrl", "ttsCustomCloudApiKey", "ttsCustomCloudVoiceId", "ttsCustomCloudTimeoutMs"],
  mimo: ["ttsMimoKey", "ttsMimoVoiceAudioPath", "ttsMimoStylePrompt"],
  mossland: ["ttsMosslandKey", "ttsMosslandVoiceId", "ttsMosslandModel", "ttsMosslandTestText", "ttsMosslandFormat"],
};

const testText = "你好，我是昔涟，很高兴见到你。";
const providerDocs = {
  minimax: "https://platform.minimax.cn/docs/api-reference/voice-cloning-uploadcloneaudio",
  minimaxErrors: "https://platform.minimax.cn/docs/api-reference/errorcode",
  mimo: "https://mimo.mi.com/docs/zh-CN/quick-start/usage-guide/audio/speech-synthesis-v2.5",
  mimoErrors: "https://mimo.mi.com/docs/zh-CN/api/guidance/error-codes",
  mossland: "https://platform.mosi.cn/docs/reference/voices-create",
  mosslandErrors: "https://platform.mosi.cn/docs/errors-and-limits/error-codes",
} as const;

function ttsApi(): TtsApi | undefined {
  return (window as Window & { tts?: TtsApi }).tts;
}

function readValues(raw: Record<string, unknown>): TtsValues {
  return {
    ...defaults,
    ...Object.fromEntries(Object.keys(defaults).map((key) => [key, raw[key] ?? defaults[key as keyof TtsValues]])),
    ttsEngine: ["minimax", "mimo", "mossland", "gptsovits", "custom-cloud"].includes(String(raw.ttsEngine)) ? raw.ttsEngine as TtsEngine : "off",
    ttsAutoRead: raw.ttsAutoRead === true,
    ttsEarlyReadSplitEnabled: raw.ttsEarlyReadSplitEnabled !== false,
    ttsEarlyReadSplitMode: raw.ttsEarlyReadSplitMode === "paragraph" ? "paragraph" : "sentence",
    ttsSpeed: typeof raw.ttsSpeed === "number" ? raw.ttsSpeed : defaults.ttsSpeed,
    ttsVolume: typeof raw.ttsVolume === "number" ? raw.ttsVolume : defaults.ttsVolume,
    ttsStreaming: raw.ttsStreaming !== false,
    ttsMinimaxVocalEnhance: raw.ttsMinimaxVocalEnhance !== false,
    ttsMinimaxModel: raw.ttsMinimaxModel === "speech-2.8-hd" ? "speech-2.8-hd" : "speech-2.8-turbo",
    ttsGptsovitsFormat: raw.ttsGptsovitsFormat === "mp3" ? "mp3" : "wav",
    ttsGptsovitsTimeoutMs: typeof raw.ttsGptsovitsTimeoutMs === "number" ? raw.ttsGptsovitsTimeoutMs : defaults.ttsGptsovitsTimeoutMs,
    ttsCustomCloudFormat: raw.ttsCustomCloudFormat === "wav" ? "wav" : "mp3",
    ttsCustomCloudTimeoutMs: typeof raw.ttsCustomCloudTimeoutMs === "number" ? raw.ttsCustomCloudTimeoutMs : defaults.ttsCustomCloudTimeoutMs,
    ttsMosslandModel: typeof raw.ttsMosslandModel === "string" && raw.ttsMosslandModel && raw.ttsMosslandModel !== "moss-tts" ? raw.ttsMosslandModel : DEFAULT_MOSSLAND_TTS_MODEL,
    ttsMosslandFormat: raw.ttsMosslandFormat === "wav" ? "wav" : "mp3",
  } as TtsValues;
}

function playAudio(base64: string, format: "wav" | "mp3" = "mp3") {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: format === "wav" ? "audio/wav" : "audio/mp3" }));
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  void audio.play().catch(() => URL.revokeObjectURL(url));
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function TtsSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState<TtsValues>(defaults);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [dirty, setDirty] = useState<Record<Provider, boolean>>({ minimax: false, gptsovits: false, "custom-cloud": false, mimo: false, mossland: false });
  const [saveStatus, setSaveStatus] = useState<Partial<Record<Provider, string>>>({});
  const [busy, setBusy] = useState("");
  const [cloneState, setCloneState] = useState({ file: "", promptFile: "", promptText: "", text: testText, voiceId: createUniqueMiniMaxVoiceId(), status: "" });
  const [mossClone, setMossClone] = useState({ file: "", name: "", description: "", status: "" });
  const [mossVoices, setMossVoices] = useState<Array<{ id: string; name: string; createdAt: number }>>([]);
  const [mossListStatus, setMossListStatus] = useState("");

  useEffect(() => {
    let active = true;
    const api = ttsApi();
    if (!api) {
      setError(t("settingsPage.tts.unavailable"));
      setLoading(false);
      return () => { active = false; };
    }
    void api.loadSettings().then((config) => {
      if (!active) return;
      setValues(readValues(config));
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(t("settingsPage.tts.loadFailed"));
      setLoading(false);
    });
    return () => { active = false; };
  }, [t]);

  async function persist(patch: Partial<TtsValues>) {
    const api = ttsApi();
    if (!api) {
      setError(t("settingsPage.tts.unavailable"));
      return false;
    }
    try {
      await api.saveSettings(patch as Record<string, unknown>);
      setError("");
      return true;
    } catch {
      setError(t("settingsPage.tts.saveFailed"));
      return false;
    }
  }

  async function openProviderLink(url: string) {
    try {
      const result = await window.system?.openExternal(url);
      if (!result?.ok) setError(result?.error || t("settingsPage.tts.externalOpenFailed"));
    } catch (cause) {
      setError(errorText(cause));
    }
  }

  function updateImmediate<K extends keyof TtsValues>(key: K, value: TtsValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    void persist({ [key]: value } as Partial<TtsValues>);
  }

  function updateProvider<K extends keyof TtsValues>(provider: Provider, key: K, value: TtsValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setDirty((current) => ({ ...current, [provider]: true }));
    setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.unsaved") }));
  }

  async function saveProvider(provider: Provider) {
    const patch: Record<string, unknown> = {};
    for (const key of providerFields[provider]) patch[key] = values[key];
    if (provider === "gptsovits") {
      const timeout = Number(patch.ttsGptsovitsTimeoutMs);
      patch.ttsGptsovitsTimeoutMs = Math.min(3600000, Math.max(10000, Number.isFinite(timeout) ? timeout : 180000));
    }
    if (provider === "custom-cloud") {
      const timeout = Number(patch.ttsCustomCloudTimeoutMs);
      patch.ttsCustomCloudTimeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 30000;
    }
    setBusy(`save-${provider}`);
    setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.saving") }));
    const saved = await persist(patch as Partial<TtsValues>);
    if (saved) {
      setDirty((current) => ({ ...current, [provider]: false }));
      setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.saved") }));
    } else {
      setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.saveFailed") }));
    }
    setBusy("");
  }

  async function pickAudio(provider: Provider, key: "ttsGptsovitsRefAudioPath" | "ttsMimoVoiceAudioPath", cloneTarget?: "minimax" | "mossland") {
    const api = ttsApi();
    if (!api) return;
    try {
      const filePath = cloneTarget === "mossland" ? await api.pickAudioFile() : await api.pickAudio();
      if (!filePath) return;
      if (cloneTarget === "minimax") setCloneState((current) => ({ ...current, file: filePath }));
      else if (cloneTarget === "mossland") setMossClone((current) => ({ ...current, file: filePath }));
      else {
        setValues((current) => ({ ...current, [key]: filePath }));
        void persist({ [key]: filePath } as Partial<TtsValues>);
      }
    } catch (cause) {
      setError(errorText(cause));
    }
    void provider;
  }

  async function testEngine(provider: Provider) {
    const api = ttsApi();
    if (!api) return;
    const value = values;
    try {
      setBusy(`test-${provider}`);
      setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.synthesizing") }));
      if (provider === "minimax") {
        if (!value.ttsMinimaxKey.trim() || !value.ttsMinimaxVoiceId.trim()) throw new Error(t("settingsPage.tts.missingMiniMax"));
        const base64 = await api.synthesize({ apiKey: value.ttsMinimaxKey.trim(), voiceId: value.ttsMinimaxVoiceId.trim(), text: testText, model: value.ttsMinimaxModel, vocalEnhance: { enabled: value.ttsMinimaxVocalEnhance } });
        playAudio(base64);
      } else if (provider === "gptsovits") {
        if (!value.ttsGptsovitsBaseUrl.trim() || !value.ttsGptsovitsRefAudioPath.trim() || !value.ttsGptsovitsPromptText.trim()) throw new Error(t("settingsPage.tts.missingGpt"));
        const result = await api.synthesizeGptsovits({ baseUrl: value.ttsGptsovitsBaseUrl.trim(), refAudioPath: value.ttsGptsovitsRefAudioPath.trim(), promptText: value.ttsGptsovitsPromptText.trim(), text: testText, format: value.ttsGptsovitsFormat });
        playAudio(result.base64, result.format);
      } else if (provider === "custom-cloud") {
        if (!value.ttsCustomCloudEndpointUrl.trim()) throw new Error(t("settingsPage.tts.missingEndpoint"));
        const result = await api.synthesizeCustomCloud({ endpointUrl: value.ttsCustomCloudEndpointUrl.trim(), apiKey: value.ttsCustomCloudApiKey.trim(), voiceId: value.ttsCustomCloudVoiceId.trim(), text: testText, speed: value.ttsSpeed, volume: value.ttsVolume, format: value.ttsCustomCloudFormat, timeoutMs: value.ttsCustomCloudTimeoutMs });
        playAudio(result.base64, result.format);
      } else if (provider === "mimo") {
        if (!value.ttsMimoKey.trim() || !value.ttsMimoVoiceAudioPath.trim()) throw new Error(t("settingsPage.tts.missingMimo"));
        const result = await api.synthesizeMimo({ apiKey: value.ttsMimoKey.trim(), voiceAudioPath: value.ttsMimoVoiceAudioPath.trim(), text: testText, stylePrompt: value.ttsMimoStylePrompt.trim() });
        playAudio(result.base64, result.format);
      } else {
        if (!value.ttsMosslandKey.trim() || !value.ttsMosslandVoiceId.trim() || !value.ttsMosslandTestText.trim()) throw new Error(t("settingsPage.tts.missingMossland"));
        const result = await api.synthesizeMossland({ apiKey: value.ttsMosslandKey.trim(), voiceId: value.ttsMosslandVoiceId.trim(), text: value.ttsMosslandTestText.trim(), model: value.ttsMosslandModel, format: value.ttsMosslandFormat });
        playAudio(result.base64, result.format);
      }
      setSaveStatus((current) => ({ ...current, [provider]: t("settingsPage.tts.testDone") }));
    } catch (cause) {
      setSaveStatus((current) => ({ ...current, [provider]: errorText(cause) }));
    } finally {
      setBusy("");
    }
  }

  async function startMiniMaxClone() {
    const api = ttsApi();
    if (!api) return;
    const apiKey = values.ttsMinimaxKey.trim();
    const voiceId = cloneState.voiceId.trim();
    if (!apiKey || !cloneState.file || !cloneState.text.trim() || !voiceId) {
      setCloneState((current) => ({ ...current, status: t("settingsPage.tts.cloneRequired") }));
      return;
    }
    const validation = validateMiniMaxVoiceId(voiceId);
    if (validation) {
      setCloneState((current) => ({ ...current, status: validation }));
      return;
    }
    try {
      setBusy("clone-minimax");
      setCloneState((current) => ({ ...current, status: t("settingsPage.tts.uploadingVoice") }));
      const voiceFile = await api.upload(apiKey, cloneState.file, "voice_clone");
      let promptAudioId: string | undefined;
      if (cloneState.promptFile) {
        setCloneState((current) => ({ ...current, status: t("settingsPage.tts.uploadingPrompt") }));
        promptAudioId = (await api.upload(apiKey, cloneState.promptFile, "prompt_audio")).file_id;
      }
      setCloneState((current) => ({ ...current, status: t("settingsPage.tts.cloning") }));
      const result = await api.clone({ apiKey, fileId: voiceFile.file_id, voiceId, promptAudioId, promptText: cloneState.promptText.trim() || undefined, text: cloneState.text.trim() });
      setValues((current) => ({ ...current, ttsMinimaxVoiceId: result.voiceId }));
      await persist({ ttsMinimaxVoiceId: result.voiceId });
      setCloneState((current) => ({ ...current, voiceId: createUniqueMiniMaxVoiceId(), status: t("settingsPage.tts.cloneDone", { voiceId: result.voiceId }) }));
      if (result.audioDemo) {
        const response = await fetch(result.audioDemo);
        const bytes = new Uint8Array(await response.arrayBuffer());
        playAudio(btoa(String.fromCharCode(...bytes)));
      }
    } catch (cause) {
      setCloneState((current) => ({ ...current, status: errorText(cause), voiceId: createUniqueMiniMaxVoiceId() }));
    } finally {
      setBusy("");
    }
  }

  async function startMosslandClone() {
    const api = ttsApi();
    if (!api) return;
    if (!values.ttsMosslandKey.trim() || !mossClone.file) {
      setMossClone((current) => ({ ...current, status: t("settingsPage.tts.mosslandCloneRequired") }));
      return;
    }
    try {
      setBusy("clone-mossland");
      setMossClone((current) => ({ ...current, status: t("settingsPage.tts.uploadingVoice") }));
      const result = await api.cloneMossland({ apiKey: values.ttsMosslandKey.trim(), filePath: mossClone.file, name: mossClone.name.trim() || undefined, description: mossClone.description.trim() || undefined });
      setValues((current) => ({ ...current, ttsMosslandVoiceId: result.voiceId }));
      await persist({ ttsMosslandVoiceId: result.voiceId });
      setDirty((current) => ({ ...current, mossland: true }));
      setMossClone((current) => ({ ...current, status: t("settingsPage.tts.cloneDone", { voiceId: result.voiceId }) }));
    } catch (cause) {
      setMossClone((current) => ({ ...current, status: errorText(cause) }));
    } finally {
      setBusy("");
    }
  }

  async function loadMosslandVoices() {
    const api = ttsApi();
    if (!api) return;
    if (!values.ttsMosslandKey.trim()) {
      setMossListStatus(t("settingsPage.tts.mosslandKeyRequired"));
      return;
    }
    try {
      setBusy("list-mossland");
      setMossListStatus(t("settingsPage.tts.loadingVoices"));
      const result = await api.listMosslandVoices({ apiKey: values.ttsMosslandKey.trim(), limit: 150 });
      setMossVoices(result.voices);
      setMossListStatus(result.voices.length ? t("settingsPage.tts.voicesLoaded", { count: result.voices.length }) : t("settingsPage.tts.noVoices"));
    } catch (cause) {
      setMossListStatus(errorText(cause));
    } finally {
      setBusy("");
    }
  }

  function saveButton(provider: Provider) {
    return <div className="cy-tts-actions"><span role="status">{saveStatus[provider] ?? ""}</span><Button type="primary" disabled={!dirty[provider]} loading={busy === `save-${provider}`} onClick={() => void saveProvider(provider)}>{t("settingsPage.tts.saveConfig")}</Button></div>;
  }

  function testButton(provider: Provider) {
    return <Button loading={busy === `test-${provider}`} icon={<Volume2 size={15} />} onClick={() => void testEngine(provider)}>{busy === `test-${provider}` ? t("settingsPage.tts.synthesizing") : t("settingsPage.tts.testPronunciation")}</Button>;
  }

  const { TextArea } = Input;

  return <div className="cy-tts-page">
    <h1>{t("settingsPage.tts.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.tts.description")}</p>
    {error && <Alert className="cy-settings-alert" type="error" showIcon message={error} closable onClose={() => setError("")} />}
    {loading ? <div className="cy-asr-loading" role="status" aria-label={t("settingsPage.tts.loading")}><AudioLines size={18} aria-hidden="true" /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Volume2 size={18} />{t("settingsPage.tts.playbackTitle")}</h2><p>{t("settingsPage.tts.playbackDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tts.autoReadTitle")}</strong><span>{t("settingsPage.tts.autoReadDescription")}</span></div><SettingsSwitch checked={values.ttsAutoRead} ariaLabel={t("settingsPage.tts.autoReadTitle")} onChange={(checked) => updateImmediate("ttsAutoRead", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tts.splitEnabledTitle")}</strong><span>{t("settingsPage.tts.splitEnabledDescription")}</span></div><SettingsSwitch checked={values.ttsEarlyReadSplitEnabled} ariaLabel={t("settingsPage.tts.splitEnabledTitle")} onChange={(checked) => updateImmediate("ttsEarlyReadSplitEnabled", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tts.splitModeTitle")}</strong><span>{t("settingsPage.tts.splitModeDescription")}</span></div><SettingsSegmented disabled={!values.ttsEarlyReadSplitEnabled} value={values.ttsEarlyReadSplitMode} options={[{ label: t("settingsPage.tts.splitModeSentence"), value: "sentence" }, { label: t("settingsPage.tts.splitModeParagraph"), value: "paragraph" }]} onChange={(value) => updateImmediate("ttsEarlyReadSplitMode", value as SplitMode)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tts.speedTitle")}</strong><span>{t("settingsPage.tts.speedDescription")}</span></div><div className="cy-settings-row__control cy-settings-slider"><SettingsSlider min={0.5} max={2} step={0.1} value={values.ttsSpeed} ariaLabel={t("settingsPage.tts.speedTitle")} onChange={(value) => setValues((current) => ({ ...current, ttsSpeed: value }))} onChangeComplete={(value) => void persist({ ttsSpeed: value })} /><span>{values.ttsSpeed.toFixed(1)}x</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tts.volumeTitle")}</strong><span>{t("settingsPage.tts.volumeDescription")}</span></div><div className="cy-settings-row__control cy-settings-slider"><SettingsSlider min={0} max={1} step={0.1} value={values.ttsVolume} ariaLabel={t("settingsPage.tts.volumeTitle")} onChange={(value) => setValues((current) => ({ ...current, ttsVolume: value }))} onChangeComplete={(value) => void persist({ ttsVolume: value })} /><span>{Math.round(values.ttsVolume * 100)}%</span></div></div>
        </div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Headphones size={18} />{t("settingsPage.tts.engineTitle")}</h2><p>{t("settingsPage.tts.engineDescription")}</p></div>
        <div className="cy-tts-engine-grid" role="group" aria-label={t("settingsPage.tts.engineTitle")}>
          {([
            { value: "off", label: t("settingsPage.tts.engineOff"), icon: <Volume2 size={19} /> },
            { value: "minimax", label: t("settingsPage.tts.engineMiniMax"), icon: <BrandIcon icon={siMinimax} size={20} label="MiniMax" /> },
            { value: "mimo", label: t("settingsPage.tts.engineMimo"), icon: <BrandIcon icon={siXiaomi} size={20} label="Xiaomi" /> },
            { value: "mossland", label: t("settingsPage.tts.engineMossland"), icon: <Cloud size={19} /> },
            { value: "gptsovits", label: t("settingsPage.tts.engineGptSovits"), icon: <Laptop size={19} /> },
            { value: "custom-cloud", label: t("settingsPage.tts.engineCustomCloud"), icon: <AudioLines size={19} /> },
          ] as const).map((engine) => <button key={engine.value} type="button" aria-pressed={values.ttsEngine === engine.value} className={`cy-tts-engine ${values.ttsEngine === engine.value ? "is-active" : ""}`} onClick={() => updateImmediate("ttsEngine", engine.value)}>
            <span className="cy-tts-engine__icon">{engine.icon}</span><span>{engine.label}</span>
            {engine.value !== "off" && <small>{engine.value === "gptsovits" ? t("settingsPage.tts.tagLocal") : engine.value === "custom-cloud" ? t("settingsPage.tts.tagInterface") : t("settingsPage.tts.tagCloud")}</small>}
          </button>)}
        </div>
      </section>

      {values.ttsEngine === "minimax" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><BrandIcon icon={siMinimax} size={18} label="MiniMax" />{t("settingsPage.tts.minimaxConfig")}</h2><p>{t("settingsPage.tts.minimaxHint")}</p></div>
        <div className="cy-settings-card cy-tts-fields">
          <label><span>{t("settingsPage.tts.apiKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.tts.showSecret")} hideLabel={t("settingsPage.tts.hideSecret")} value={values.ttsMinimaxKey} onChange={(event) => updateProvider("minimax", "ttsMinimaxKey", event.target.value)} autoComplete="off" /></label>
          <label><span>{t("settingsPage.tts.voiceId")}</span><SettingsInput value={values.ttsMinimaxVoiceId} onChange={(event) => updateProvider("minimax", "ttsMinimaxVoiceId", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.model")}</span><SettingsSelect ariaLabel={t("settingsPage.tts.model")} value={values.ttsMinimaxModel} options={[{ value: "speech-2.8-turbo", label: t("settingsPage.tts.modelTurbo") }, { value: "speech-2.8-hd", label: t("settingsPage.tts.modelHd") }]} onChange={(value) => updateImmediate("ttsMinimaxModel", value)} /></label>
          <div className="cy-tts-field-switch"><div><strong>{t("settingsPage.tts.streamingTitle")}</strong><span>{t("settingsPage.tts.streamingDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tts.streamingTitle")} checked={values.ttsStreaming} onChange={(checked) => updateImmediate("ttsStreaming", checked)} /></div>
          <div className="cy-tts-field-switch"><div><strong>{t("settingsPage.tts.vocalEnhanceTitle")}</strong><span>{t("settingsPage.tts.vocalEnhanceDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tts.vocalEnhanceTitle")} checked={values.ttsMinimaxVocalEnhance} onChange={(checked) => updateImmediate("ttsMinimaxVocalEnhance", checked)} /></div>
          <div className="cy-tts-form-actions">{saveButton("minimax")}{testButton("minimax")}</div>
        </div>
        <div className="cy-settings-card cy-tts-subcard">
          <div className="cy-settings-section__heading"><h3><WandSparkles size={17} />{t("settingsPage.tts.cloneTitle")}</h3><p>{t("settingsPage.tts.cloneHint")}</p><div className="cy-tts-doc-links"><Button type="link" onClick={() => void openProviderLink(providerDocs.minimax)}>{t("settingsPage.tts.providerDocs")}</Button><Button type="link" onClick={() => void openProviderLink(providerDocs.minimaxErrors)}>{t("settingsPage.tts.errorCodes")}</Button></div></div>
          <Alert type="warning" showIcon message={t("settingsPage.tts.cloneWarning")} />
          <div className="cy-tts-fields"><label><span>{t("settingsPage.tts.cloneFile")}</span><div className="cy-tts-file-control"><SettingsInput readOnly value={cloneState.file} placeholder={t("settingsPage.tts.noFile")} /><Button icon={<FileAudio size={15} />} onClick={() => void pickAudio("minimax", "ttsGptsovitsRefAudioPath", "minimax")}>{t("settingsPage.tts.chooseFile")}</Button></div></label>
            <label><span>{t("settingsPage.tts.clonePromptFile")}</span><div className="cy-tts-file-control"><SettingsInput readOnly value={cloneState.promptFile} placeholder={t("settingsPage.tts.optional")} /><Button onClick={async () => { const file = await ttsApi()?.pickAudio(); if (file) setCloneState((current) => ({ ...current, promptFile: file })); }}>{t("settingsPage.tts.chooseFile")}</Button></div></label>
            <label><span>{t("settingsPage.tts.clonePromptText")}</span><TextArea rows={2} value={cloneState.promptText} onChange={(event) => setCloneState((current) => ({ ...current, promptText: event.target.value }))} /></label>
            <label><span>{t("settingsPage.tts.cloneText")}</span><TextArea rows={2} value={cloneState.text} onChange={(event) => setCloneState((current) => ({ ...current, text: event.target.value }))} /></label>
            <label><span>{t("settingsPage.tts.cloneVoiceId")}</span><SettingsInput value={cloneState.voiceId} onChange={(event) => setCloneState((current) => ({ ...current, voiceId: event.target.value }))} /></label>
            <div className="cy-tts-form-actions"><span role="status">{cloneState.status}</span><Button type="primary" loading={busy === "clone-minimax"} onClick={() => void startMiniMaxClone()}>{t("settingsPage.tts.cloneStart")}</Button></div>
          </div>
        </div>
      </section>}

      {values.ttsEngine === "gptsovits" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Laptop size={18} />{t("settingsPage.tts.gptConfig")}</h2><p>{t("settingsPage.tts.gptHint")}</p></div>
        <div className="cy-settings-card cy-tts-fields">
          <label><span>{t("settingsPage.tts.gptUrl")}</span><SettingsInput value={values.ttsGptsovitsBaseUrl} onChange={(event) => updateProvider("gptsovits", "ttsGptsovitsBaseUrl", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.gptReferenceAudio")}</span><div className="cy-tts-file-control"><SettingsInput readOnly value={values.ttsGptsovitsRefAudioPath} placeholder={t("settingsPage.tts.noFile")} /><Button icon={<FileAudio size={15} />} onClick={() => void pickAudio("gptsovits", "ttsGptsovitsRefAudioPath")}>{t("settingsPage.tts.chooseFile")}</Button></div></label>
          <label><span>{t("settingsPage.tts.gptPromptText")}</span><TextArea rows={2} value={values.ttsGptsovitsPromptText} onChange={(event) => updateProvider("gptsovits", "ttsGptsovitsPromptText", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.format")}</span><SettingsSelect ariaLabel={t("settingsPage.tts.format")} value={values.ttsGptsovitsFormat} options={[{ value: "wav", label: t("settingsPage.tts.wavRecommended") }, { value: "mp3", label: "mp3" }]} onChange={(value) => updateImmediate("ttsGptsovitsFormat", value)} /></label>
          <label><span>{t("settingsPage.tts.timeoutMs")}</span><SettingsInput type="number" min={10000} max={3600000} value={values.ttsGptsovitsTimeoutMs} onChange={(event) => updateProvider("gptsovits", "ttsGptsovitsTimeoutMs", Number(event.target.value))} /></label>
          <div className="cy-tts-form-actions">{saveButton("gptsovits")}{testButton("gptsovits")}</div>
        </div>
      </section>}

      {values.ttsEngine === "custom-cloud" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Cloud size={18} />{t("settingsPage.tts.customCloudConfig")}</h2><p>{t("settingsPage.tts.customCloudHint")}</p></div>
        <div className="cy-settings-card cy-tts-fields">
          <label><span>{t("settingsPage.tts.endpointUrl")}</span><SettingsInput value={values.ttsCustomCloudEndpointUrl} onChange={(event) => updateProvider("custom-cloud", "ttsCustomCloudEndpointUrl", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.apiKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.tts.showSecret")} hideLabel={t("settingsPage.tts.hideSecret")} value={values.ttsCustomCloudApiKey} onChange={(event) => updateProvider("custom-cloud", "ttsCustomCloudApiKey", event.target.value)} autoComplete="off" /></label>
          <label><span>{t("settingsPage.tts.voiceIdOptional")}</span><SettingsInput value={values.ttsCustomCloudVoiceId} onChange={(event) => updateProvider("custom-cloud", "ttsCustomCloudVoiceId", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.format")}</span><SettingsSelect ariaLabel={t("settingsPage.tts.format")} value={values.ttsCustomCloudFormat} options={[{ value: "mp3", label: "mp3" }, { value: "wav", label: "wav" }]} onChange={(value) => updateImmediate("ttsCustomCloudFormat", value)} /></label>
          <label><span>{t("settingsPage.tts.timeoutMs")}</span><SettingsInput type="number" min={1} value={values.ttsCustomCloudTimeoutMs} onChange={(event) => updateProvider("custom-cloud", "ttsCustomCloudTimeoutMs", Number(event.target.value))} /></label>
          <div className="cy-tts-form-actions">{saveButton("custom-cloud")}{testButton("custom-cloud")}</div>
        </div>
      </section>}

      {values.ttsEngine === "mimo" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><BrandIcon icon={siXiaomi} size={18} label="Xiaomi" />{t("settingsPage.tts.mimoConfig")}</h2><p>{t("settingsPage.tts.mimoHint")}</p><div className="cy-tts-doc-links"><Button type="link" onClick={() => void openProviderLink(providerDocs.mimo)}>{t("settingsPage.tts.providerDocs")}</Button><Button type="link" onClick={() => void openProviderLink(providerDocs.mimoErrors)}>{t("settingsPage.tts.errorCodes")}</Button></div></div>
        <div className="cy-settings-card cy-tts-fields">
          <label><span>{t("settingsPage.tts.apiKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.tts.showSecret")} hideLabel={t("settingsPage.tts.hideSecret")} value={values.ttsMimoKey} onChange={(event) => updateProvider("mimo", "ttsMimoKey", event.target.value)} autoComplete="off" /></label>
          <label><span>{t("settingsPage.tts.mimoReferenceAudio")}</span><div className="cy-tts-file-control"><SettingsInput readOnly value={values.ttsMimoVoiceAudioPath} placeholder={t("settingsPage.tts.noFile")} /><Button icon={<FileAudio size={15} />} onClick={() => void pickAudio("mimo", "ttsMimoVoiceAudioPath")}>{t("settingsPage.tts.chooseFile")}</Button></div></label>
          <label className="cy-tts-field-wide"><span>{t("settingsPage.tts.stylePrompt")}</span><TextArea rows={3} value={values.ttsMimoStylePrompt} onChange={(event) => updateProvider("mimo", "ttsMimoStylePrompt", event.target.value)} /></label>
          <div className="cy-tts-form-actions">{saveButton("mimo")}{testButton("mimo")}</div>
        </div>
      </section>}

      {values.ttsEngine === "mossland" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Mic2 size={18} />{t("settingsPage.tts.mosslandConfig")}</h2><p>{t("settingsPage.tts.mosslandHint")}</p><div className="cy-tts-doc-links"><Button type="link" onClick={() => void openProviderLink(providerDocs.mossland)}>{t("settingsPage.tts.providerDocs")}</Button><Button type="link" onClick={() => void openProviderLink(providerDocs.mosslandErrors)}>{t("settingsPage.tts.errorCodes")}</Button></div></div>
        <div className="cy-settings-card cy-tts-fields">
          <label><span>{t("settingsPage.tts.apiKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.tts.showSecret")} hideLabel={t("settingsPage.tts.hideSecret")} value={values.ttsMosslandKey} onChange={(event) => updateProvider("mossland", "ttsMosslandKey", event.target.value)} autoComplete="off" /></label>
          <label><span>{t("settingsPage.tts.model")}</span><SettingsSelect ariaLabel={t("settingsPage.tts.model")} value={values.ttsMosslandModel} options={[{ value: DEFAULT_MOSSLAND_TTS_MODEL, label: t("settingsPage.tts.mosslandFlash") }, { value: "moss-tts-1.0-pro", label: t("settingsPage.tts.mosslandPro") }, ...(values.ttsMosslandModel !== DEFAULT_MOSSLAND_TTS_MODEL && values.ttsMosslandModel !== "moss-tts-1.0-pro" ? [{ value: values.ttsMosslandModel, label: t("settingsPage.tts.savedModel", { model: values.ttsMosslandModel }) }] : [])]} onChange={(value) => updateProvider("mossland", "ttsMosslandModel", value)} /></label>
          <label><span>{t("settingsPage.tts.voiceId")}</span><SettingsInput value={values.ttsMosslandVoiceId} onChange={(event) => updateProvider("mossland", "ttsMosslandVoiceId", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.testText")}</span><SettingsInput value={values.ttsMosslandTestText} onChange={(event) => updateProvider("mossland", "ttsMosslandTestText", event.target.value)} /></label>
          <label><span>{t("settingsPage.tts.format")}</span><SettingsSelect ariaLabel={t("settingsPage.tts.format")} value={values.ttsMosslandFormat} options={[{ value: "mp3", label: "mp3" }, { value: "wav", label: "wav" }]} onChange={(value) => updateProvider("mossland", "ttsMosslandFormat", value)} /></label>
          <div className="cy-tts-form-actions">{saveButton("mossland")}{testButton("mossland")}</div>
        </div>
        <div className="cy-settings-card cy-tts-subcard">
          <div className="cy-settings-section__heading"><h3><WandSparkles size={17} />{t("settingsPage.tts.mosslandCloneTitle")}</h3><p>{t("settingsPage.tts.mosslandCloneHint")}</p></div>
          <Alert type="info" showIcon message={t("settingsPage.tts.mosslandCloneWarning")} />
          <div className="cy-tts-fields"><label><span>{t("settingsPage.tts.referenceAudio")}</span><div className="cy-tts-file-control"><SettingsInput readOnly value={mossClone.file} placeholder={t("settingsPage.tts.noFile")} /><Button onClick={() => void pickAudio("mossland", "ttsGptsovitsRefAudioPath", "mossland")}>{t("settingsPage.tts.chooseFile")}</Button></div></label>
            <label><span>{t("settingsPage.tts.voiceName")}</span><SettingsInput value={mossClone.name} onChange={(event) => setMossClone((current) => ({ ...current, name: event.target.value }))} /></label>
            <label><span>{t("settingsPage.tts.voiceDescription")}</span><SettingsInput value={mossClone.description} onChange={(event) => setMossClone((current) => ({ ...current, description: event.target.value }))} /></label>
            <div className="cy-tts-form-actions"><span role="status">{mossClone.status}</span><Button type="primary" loading={busy === "clone-mossland"} onClick={() => void startMosslandClone()}>{t("settingsPage.tts.cloneUpload")}</Button></div>
          </div>
        </div>
        <div className="cy-settings-card cy-tts-subcard">
          <div className="cy-settings-section__heading"><h3><ListMusic size={17} />{t("settingsPage.tts.myVoices")}</h3><p>{t("settingsPage.tts.myVoicesHint")}</p></div>
          <div className="cy-tts-form-actions"><span role="status">{mossListStatus}</span><Button loading={busy === "list-mossland"} onClick={() => void loadMosslandVoices()}>{t("settingsPage.tts.loadVoices")}</Button></div>
          {!!mossVoices.length && <ul className="cy-tts-voice-list">{mossVoices.map((voice) => <li key={voice.id}><code>{voice.id}</code><span>{voice.name}</span><Button size="small" onClick={() => updateProvider("mossland", "ttsMosslandVoiceId", voice.id)}>{t("settingsPage.tts.useVoice")}</Button></li>)}</ul>}
        </div>
      </section>}

      <Alert className="cy-tts-hint" type="info" showIcon message={t("settingsPage.tts.engineHint")} />
    </>}
  </div>;
}
