import { useEffect, useRef, useState } from "react";
import { Alert, Input, InputNumber, Select, Slider, Spin, Switch } from "antd";
import { AudioLines, Headphones, Mic2 } from "lucide-react";
import { siAlibabacloud } from "simple-icons";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { useTranslation } from "../../i18n";

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
      setValues(readAsrValues(config));
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
      if (value !== undefined) void window.tts?.saveSettings({ [key]: value });
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

  return <>
    <h1>{t("settingsPage.asr.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.asr.description")}</p>
    {error && <Alert className="cy-settings-alert" type="error" showIcon title={error} closable onClose={() => setError("")} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><AudioLines size={18} />{t("settingsPage.asr.engineTitle")}</h2><p>{t("settingsPage.asr.engineDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.engineLabel")}</strong><span>{t("settingsPage.asr.engineHint")}</span></div>
            <Select className="cy-asr-select" classNames={{ popup: { root: "cy-asr-select-popup" } }} value={values.asrEngine} options={[
              { value: "off", label: t("settingsPage.asr.engineOff") },
              { value: "aliyun", label: t("settingsPage.asr.engineAliyun") },
              { value: "mossland", label: t("settingsPage.asr.engineMossland") },
              { value: "local", label: t("settingsPage.asr.engineLocal") },
            ]} onChange={(value: AsrEngine) => update("asrEngine", value)} />
          </div>
        </div>
      </section>

      {values.asrEngine === "aliyun" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><BrandIcon icon={siAlibabacloud} size={18} label="Alibaba Cloud" />{t("settingsPage.asr.aliyunTitle")}</h2><p>{t("settingsPage.asr.aliyunHint")}</p></div>
        <div className="cy-settings-card cy-asr-fields">
          <label><span>{t("settingsPage.asr.appKey")}</span><Input value={values.asrAliyunAppKey} onChange={(event) => update("asrAliyunAppKey", event.target.value)} onBlur={() => flushSecret("asrAliyunAppKey")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.accessKeyId")}</span><Input value={values.asrAliyunAccessKeyId} onChange={(event) => update("asrAliyunAccessKeyId", event.target.value)} onBlur={() => flushSecret("asrAliyunAccessKeyId")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.accessKeySecret")}</span><Input.Password value={values.asrAliyunAccessKeySecret} onChange={(event) => update("asrAliyunAccessKeySecret", event.target.value)} onBlur={() => flushSecret("asrAliyunAccessKeySecret")} autoComplete="off" /></label>
          <label><span>{t("settingsPage.asr.language")}</span><Select classNames={{ popup: { root: "cy-asr-select-popup" } }} value={values.asrLanguage} options={[{ value: "zh", label: t("settingsPage.asr.chinese") }, { value: "en", label: t("settingsPage.asr.english") }]} onChange={(value: AsrLanguage) => update("asrLanguage", value)} /></label>
        </div>
      </section>}

      {values.asrEngine === "mossland" && <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Mic2 size={18} />{t("settingsPage.asr.mosslandTitle")}</h2><p>{t("settingsPage.asr.mosslandHint")}</p></div>
        <div className="cy-settings-card cy-asr-fields"><label><span>{t("settingsPage.asr.mosslandKey")}</span><Input.Password value={values.ttsMosslandKey} onChange={(event) => update("ttsMosslandKey", event.target.value)} onBlur={() => flushSecret("ttsMosslandKey")} autoComplete="off" /></label></div>
      </section>}

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Headphones size={18} />{t("settingsPage.asr.callTitle")}</h2><p>{t("settingsPage.asr.callDescription")}</p></div>
        <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.vadSilence")}</strong><span>{t("settingsPage.asr.vadSilenceHint")}</span></div><div className="cy-asr-number-control"><InputNumber className="cy-asr-number" min={300} max={10000} step={100} value={values.asrVadSilenceMs} onChange={(value) => update("asrVadSilenceMs", value ?? 1000)} /><span>ms</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.vadThreshold")}</strong><span>{t("settingsPage.asr.vadThresholdHint")}</span></div><div className="cy-settings-row__control cy-settings-slider"><Slider min={0.001} max={0.5} step={0.001} value={values.asrVadThreshold} onChange={(value) => update("asrVadThreshold", Number(value))} /><span>{values.asrVadThreshold.toFixed(3)}</span></div></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.asr.showTranscript")}</strong><span>{t("settingsPage.asr.showTranscriptHint")}</span></div><Switch checked={values.asrShowTranscript} onChange={(value) => update("asrShowTranscript", value)} /></div>
        </div>
      </section>
    </>}
  </>;
}
