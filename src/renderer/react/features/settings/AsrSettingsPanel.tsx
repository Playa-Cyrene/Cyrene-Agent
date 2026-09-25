import { useEffect, useRef, useState } from "react";
import { AlertCircle, AudioLines, Headphones, LoaderCircle, Mic2, X } from "lucide-react";
import { siAlibabacloud } from "simple-icons";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { SettingsInput, SettingsPasswordInput, SettingsSelect, SettingsSlider, SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";
import { Card } from "../../components/ui/Card";

type AsrEngine = "off" | "aliyun" | "mossland" | "local";
type AsrLanguage = "zh" | "en";
type SecretField = "asrAliyunAppKey" | "asrAliyunAccessKeyId" | "asrAliyunAccessKeySecret" | "ttsMosslandKey";
type AsrValues = {
  asrEngine: AsrEngine;
  asrAliyunAppKey: string;
  asrAliyunAccessKeyId: string;
  asrAliyunAccessKeySecret: string;
  ttsMosslandKey: string;
  asrLanguage: AsrLanguage;
  asrVadSilenceMs: number;
  asrVadThreshold: number;
  asrShowTranscript: boolean;
};

const defaults: AsrValues = {
  asrEngine: "off",
  asrAliyunAppKey: "",
  asrAliyunAccessKeyId: "",
  asrAliyunAccessKeySecret: "",
  ttsMosslandKey: "",
  asrLanguage: "zh",
  asrVadSilenceMs: 1000,
  asrVadThreshold: 0.01,
  asrShowTranscript: false,
};

function readAsrValues(config: Record<string, unknown>): AsrValues {
  return {
    asrEngine: config.asrEngine === "aliyun" || config.asrEngine === "mossland" || config.asrEngine === "local" ? config.asrEngine : "off",
    asrAliyunAppKey: typeof config.asrAliyunAppKey === "string" ? config.asrAliyunAppKey : "",
    asrAliyunAccessKeyId: typeof config.asrAliyunAccessKeyId === "string" ? config.asrAliyunAccessKeyId : "",
    asrAliyunAccessKeySecret: typeof config.asrAliyunAccessKeySecret === "string" ? config.asrAliyunAccessKeySecret : "",
    ttsMosslandKey: typeof config.ttsMosslandKey === "string" ? config.ttsMosslandKey : "",
    asrLanguage: config.asrLanguage === "en" ? "en" : "zh",
    asrVadSilenceMs: typeof config.asrVadSilenceMs === "number" ? config.asrVadSilenceMs : 1000,
    asrVadThreshold: typeof config.asrVadThreshold === "number" ? config.asrVadThreshold : 0.01,
    asrShowTranscript: config.asrShowTranscript === true,
  };
}

export function AsrSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState<AsrValues>(defaults);
  const [silenceDraft, setSilenceDraft] = useState(String(defaults.asrVadSilenceMs));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const secretTimers = useRef<Partial<Record<SecretField, ReturnType<typeof setTimeout>>>>({});
  const pendingSecrets = useRef<Partial<Record<SecretField, string>>>({});

  useEffect(() => {
    let active = true;
    if (!window.tts) {
      setError(t("settingsPage.asr.unavailable"));
      setLoading(false);
      return;
    }
    void window.tts.loadSettings().then((config) => {
      if (!active) return;
      const nextValues = readAsrValues(config);
      setValues(nextValues);
      setSilenceDraft(String(nextValues.asrVadSilenceMs));
      setLoading(false);
    }).catch(() => {
      if (!active) return;
      setError(t("settingsPage.asr.loadFailed"));
      setLoading(false);
    });
    return () => { active = false; };
  }, [t]);

  useEffect(() => () => {
    for (const key of Object.keys(secretTimers.current) as SecretField[]) {
      clearTimeout(secretTimers.current[key]);
      const value = pendingSecrets.current[key];
      if (value !== undefined) void window.tts?.saveSettings({ [key]: value }).catch(() => {
        console.warn("[asr] pending setting could not be saved");
      });
    }
  }, []);

  async function persist<K extends keyof AsrValues>(key: K, value: AsrValues[K]) {
    try {
      if (!window.tts) throw new Error("Voice settings API unavailable");
      await window.tts.saveSettings({ [key]: value });
      setError("");
    } catch {
      setError(t("settingsPage.asr.saveFailed"));
    }
  }

  function scheduleSecret(key: SecretField, value: string) {
    clearTimeout(secretTimers.current[key]);
    pendingSecrets.current[key] = value.trim();
    secretTimers.current[key] = setTimeout(() => {
      delete secretTimers.current[key];
      delete pendingSecrets.current[key];
      void persist(key, value.trim());
    }, 800);
  }

  function flushSecret(key: SecretField) {
    const value = pendingSecrets.current[key];
    if (value === undefined) return;
    clearTimeout(secretTimers.current[key]);
    delete secretTimers.current[key];
    delete pendingSecrets.current[key];
    void persist(key, value);
  }

  function update<K extends keyof AsrValues>(key: K, value: AsrValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    if (key === "asrAliyunAppKey" || key === "asrAliyunAccessKeyId" || key === "asrAliyunAccessKeySecret" || key === "ttsMosslandKey") {
      scheduleSecret(key, String(value));
    } else {
      void persist(key, value);
    }
  }

  return <div className="cy-asr-page">
    <h1>{t("settingsPage.asr.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.asr.description")}</p>
    {error && <div className="cy-asr-error" role="alert"><AlertCircle size={16} aria-hidden="true" /><span>{error}</span><button type="button" aria-label={t("settingsPage.asr.dismissError")} onClick={() => setError("")}><X size={15} aria-hidden="true" /></button></div>}
    {loading ? <div className="cy-asr-loading" role="status" aria-label={t("settingsPage.asr.loading")}><LoaderCircle size={18} aria-hidden="true" /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><AudioLines size={18} />{t("settingsPage.asr.engineTitle")}</h2><p>{t("settingsPage.asr.engineDescription")}</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.engineLabel")}</strong><span>{t("settingsPage.asr.engineHint")}</span></div>
            <div className="cy-asr-select"><SettingsSelect ariaLabel={t("settingsPage.asr.engineLabel")} value={values.asrEngine} options={[
              { value: "off", label: t("settingsPage.asr.engineOff") },
              { value: "aliyun", label: t("settingsPage.asr.engineAliyun") },
              { value: "mossland", label: t("settingsPage.asr.engineMossland") },
              { value: "local", label: t("settingsPage.asr.engineLocal") },
            ]} onChange={(value) => update("asrEngine", value)} /></div>
          </div>
        </Card>
      </section>

      {values.asrEngine === "aliyun" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><BrandIcon icon={siAlibabacloud} size={18} label="Alibaba Cloud" />{t("settingsPage.asr.aliyunTitle")}</h2><p>{t("settingsPage.asr.aliyunHint")}</p></div>
        <Card className="cy-asr-fields">
          <label><span>{t("settingsPage.asr.appKey")}</span><SettingsInput value={values.asrAliyunAppKey} onChange={(event) => update("asrAliyunAppKey", event.target.value)} onBlur={() => flushSecret("asrAliyunAppKey")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.accessKeyId")}</span><SettingsInput value={values.asrAliyunAccessKeyId} onChange={(event) => update("asrAliyunAccessKeyId", event.target.value)} onBlur={() => flushSecret("asrAliyunAccessKeyId")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.accessKeySecret")}</span><SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={values.asrAliyunAccessKeySecret} onChange={(event) => update("asrAliyunAccessKeySecret", event.target.value)} onBlur={() => flushSecret("asrAliyunAccessKeySecret")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.language")}</span><SettingsSelect ariaLabel={t("settingsPage.asr.language")} value={values.asrLanguage} options={[{ value: "zh", label: t("settingsPage.asr.chinese") }, { value: "en", label: t("settingsPage.asr.english") }]} onChange={(value) => update("asrLanguage", value)} /></label>
        </Card>
      </section>}

      {values.asrEngine === "mossland" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Mic2 size={18} />{t("settingsPage.asr.mosslandTitle")}</h2><p>{t("settingsPage.asr.mosslandHint")}</p></div>
        <Card className="cy-asr-fields"><label><span>{t("settingsPage.asr.mosslandKey")}</span><SettingsPasswordInput showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={values.ttsMosslandKey} onChange={(event) => update("ttsMosslandKey", event.target.value)} onBlur={() => flushSecret("ttsMosslandKey")} autoComplete="off" /></label></Card>
      </section>}

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Headphones size={18} />{t("settingsPage.asr.callTitle")}</h2><p>{t("settingsPage.asr.callDescription")}</p></div>
        <Card>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.vadSilence")}</strong><span>{t("settingsPage.asr.vadSilenceHint")}</span></div><div className="cy-asr-number-control"><SettingsInput className="cy-asr-number-input" type="number" min={300} max={10000} step={100} value={silenceDraft} aria-label={t("settingsPage.asr.vadSilence")} onChange={(event) => { const raw = event.target.value; const parsed = Number(raw); setSilenceDraft(raw); if (raw !== "" && Number.isFinite(parsed) && parsed >= 300 && parsed <= 10000 && parsed !== values.asrVadSilenceMs) update("asrVadSilenceMs", parsed); }} onBlur={() => { const parsed = Number(silenceDraft); const normalized = Math.min(10000, Math.max(300, Number.isFinite(parsed) && parsed > 0 ? parsed : 1000)); setSilenceDraft(String(normalized)); if (normalized !== values.asrVadSilenceMs) update("asrVadSilenceMs", normalized); }} /><span>ms</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.vadThreshold")}</strong><span>{t("settingsPage.asr.vadThresholdHint")}</span></div><div className="cy-settings-row__control cy-settings-slider"><SettingsSlider min={0.001} max={0.5} step={0.001} value={values.asrVadThreshold} ariaLabel={t("settingsPage.asr.vadThreshold")} onChange={(value) => update("asrVadThreshold", value)} /><span>{values.asrVadThreshold.toFixed(3)}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.showTranscript")}</strong><span>{t("settingsPage.asr.showTranscriptHint")}</span></div><SettingsSwitch checked={values.asrShowTranscript} ariaLabel={t("settingsPage.asr.showTranscript")} onChange={(value) => update("asrShowTranscript", value)} /></div>
        </Card>
      </section>
    </>}
  </div>;
}
