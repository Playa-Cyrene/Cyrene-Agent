import { useEffect, useState } from "react";
import { Alert, Button, Input, InputNumber, Modal, Radio, Slider, Spin, Switch } from "antd";
import { BookOpen, Heart, Images } from "lucide-react";
import type { SettingsApi } from "../../../settings/shared/types";
import { useTranslation } from "../../i18n";

type RuntimeSync = "off" | "local" | "llm";
type StickerSize = "small" | "standard" | "large";
type Values = { runtimeSync: RuntimeSync; stickerEnabled: boolean; stickerSize: StickerSize; stickerSimilarityThreshold: number; embeddingDimensions?: number };
type Notice = { type: "success" | "error" | "info"; text: string };
type ExtendedSettingsApi = SettingsApi & { getRerankerStatus?: () => Promise<{ light: boolean; standard: boolean }> };

const defaults: Values = { runtimeSync: "off", stickerEnabled: true, stickerSize: "standard", stickerSimilarityThreshold: 0.55 };

function settingsApi(): ExtendedSettingsApi | undefined {
  return window.settings as unknown as ExtendedSettingsApi | undefined;
}

function readValues(config: Partial<Values>): Values {
  return {
    runtimeSync: config.runtimeSync === "local" || config.runtimeSync === "llm" ? config.runtimeSync : "off",
    stickerEnabled: config.stickerEnabled !== false,
    stickerSize: config.stickerSize === "small" || config.stickerSize === "large" ? config.stickerSize : "standard",
    stickerSimilarityThreshold: typeof config.stickerSimilarityThreshold === "number" ? config.stickerSimilarityThreshold : 0.55,
    embeddingDimensions: typeof config.embeddingDimensions === "number" ? config.embeddingDimensions : undefined,
  };
}

export function CyreneSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState<Values>(defaults);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [embeddingInstalled, setEmbeddingInstalled] = useState<boolean | null>(null);
  const [rerankerInstalled, setRerankerInstalled] = useState<boolean | null>(null);
  const [rerankerMode, setRerankerMode] = useState(() => localStorage.getItem("cyrene.reranker.mode") === "none" ? "none" : "standard");
  const [addOpen, setAddOpen] = useState(false);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");
  const [pickedPath, setPickedPath] = useState("");
  const [stickerId, setStickerId] = useState("");
  const [stickerDescription, setStickerDescription] = useState("");
  const [stickerPhrases, setStickerPhrases] = useState("");

  useEffect(() => {
    let active = true;
    const api = settingsApi();
    if (!api) { setNotice({ type: "error", text: t("settingsPage.cyrene.unavailable") }); setLoading(false); return; }
    void api.getConfig().then((config) => { if (active) { setValues(readValues(config)); setLoading(false); } }).catch(() => { if (active) { setNotice({ type: "error", text: t("settingsPage.cyrene.loadFailed") }); setLoading(false); } });
    void api.getRerankerStatus?.().then((status) => { if (active) setRerankerInstalled(status.standard); }).catch(() => {});
    const modelConfig = (window as Window & { modelConfig?: { getModelInstallStatus?: () => Promise<{ embedding?: { bgem3?: boolean } }> } }).modelConfig;
    void modelConfig?.getModelInstallStatus?.().then((status) => { if (active) setEmbeddingInstalled(Boolean(status.embedding?.bgem3)); }).catch(() => {});
    return () => { active = false; };
  }, [t]);

  function update<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((current) => ({ ...current, [key]: value }));
    setNotice(null);
    if (key === "runtimeSync") settingsApi()?.previewRuntimeSync(value as RuntimeSync);
  }

  async function save() {
    const api = settingsApi();
    if (!api) return;
    setSaving(true);
    try {
      await api.saveConfig({ ...values, embeddingDimensions: values.embeddingDimensions && values.embeddingDimensions > 0 ? Math.min(65536, Math.round(values.embeddingDimensions)) : undefined });
      setNotice({ type: "success", text: t("settingsPage.cyrene.saved") });
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.saveFailed") }); }
    finally { setSaving(false); }
  }

  async function openStickerManager() {
    try {
      const result = await settingsApi()?.openStickerManager();
      if (!result?.ok) throw new Error(result?.error);
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.managerFailed") }); }
  }

  async function pickStickerFile() {
    try {
      const path = await settingsApi()?.stickerPickFile?.();
      if (!path) return;
      setPickedPath(path);
      if (!stickerId) setStickerId((path.split(/[\\/]/).pop() ?? "").replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, ""));
    } catch { setAddError(t("settingsPage.cyrene.pickFailed")); }
  }

  async function addSticker() {
    const api = settingsApi();
    const id = stickerId.trim();
    const description = stickerDescription.trim();
    const phrases = stickerPhrases.split("\n").map((part) => part.trim()).filter(Boolean);
    if (!pickedPath || !/^[a-zA-Z0-9_-]+$/.test(id) || !description || !phrases.length) {
      setAddError(t("settingsPage.cyrene.stickerInvalid"));
      return;
    }
    if (!api?.stickerAdd) return;
    setAddError("");
    setAddBusy(true);
    try {
      const result = await api.stickerAdd({ sourcePath: pickedPath, id, description, phrases });
      if (result && typeof result === "object" && "ok" in result && result.ok === false) throw new Error("Sticker add failed");
      setAddOpen(false);
      setPickedPath(""); setStickerId(""); setStickerDescription(""); setStickerPhrases("");
      setNotice({ type: "success", text: t("settingsPage.cyrene.stickerAdded") });
    } catch { setAddError(t("settingsPage.cyrene.stickerAddFailed")); }
    finally { setAddBusy(false); }
  }

  function openStickerDialog() {
    setPickedPath("");
    setStickerId("");
    setStickerDescription("");
    setStickerPhrases("");
    setAddError("");
    setAddOpen(true);
  }

  async function selectReranker(mode: "standard" | "none") {
    const api = settingsApi();
    if (!api?.rerankerSetMode) return;
    try {
      const okay = await api.rerankerSetMode(mode);
      if (!okay) throw new Error("Reranker switch failed");
      localStorage.setItem("cyrene.reranker.mode", mode);
      setRerankerMode(mode);
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.rerankerFailed") }); }
  }

  async function selectEmbedding() {
    const api = settingsApi();
    if (!api?.embeddingSetModel) return;
    try {
      const result = await api.embeddingSetModel("bgem3");
      if (!result.ok) throw new Error(result.error);
      localStorage.setItem("cyrene.rag.model", "bgem3");
      setNotice({ type: "success", text: t("settingsPage.cyrene.embeddingSelected") });
    } catch { setNotice({ type: "error", text: t("settingsPage.cyrene.embeddingFailed") }); }
  }

  return <>
    <h1>{t("settingsPage.cyrene.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.cyrene.description")}</p>
    {notice && <Alert className="cy-settings-alert" showIcon type={notice.type} title={notice.text} closable onClose={() => setNotice(null)} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><Heart size={18} />{t("settingsPage.cyrene.runtimeTitle")}</h2><p>{t("settingsPage.cyrene.runtimeDescription")}</p></div>
        <div className="cy-settings-card"><div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.runtimeMode")}</strong><span>{t("settingsPage.cyrene.runtimeHint")}</span></div><Radio.Group value={values.runtimeSync} optionType="button" buttonStyle="solid" onChange={(event) => update("runtimeSync", event.target.value as RuntimeSync)}><Radio.Button value="off">{t("settingsPage.cyrene.off")}</Radio.Button><Radio.Button value="local">{t("settingsPage.cyrene.local")}</Radio.Button><Radio.Button value="llm">{t("settingsPage.cyrene.llm")}</Radio.Button></Radio.Group></div>{values.runtimeSync === "llm" && <div className="cy-settings-row cy-cyrene-note">{t("settingsPage.cyrene.llmCost")}</div>}</div>
      </section>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><Images size={18} />{t("settingsPage.cyrene.stickerTitle")}</h2><p>{t("settingsPage.cyrene.stickerDescription")}</p></div>
        <div className="cy-settings-card"><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.stickerEnabled")}</strong><span>{t("settingsPage.cyrene.stickerEnabledHint")}</span></div><Switch checked={values.stickerEnabled} onChange={(checked) => update("stickerEnabled", checked)} /></div>
          <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.stickerSize")}</strong></div><Radio.Group value={values.stickerSize} optionType="button" buttonStyle="solid" onChange={(event) => update("stickerSize", event.target.value as StickerSize)}><Radio.Button value="small">{t("settingsPage.cyrene.small")}</Radio.Button><Radio.Button value="standard">{t("settingsPage.cyrene.standard")}</Radio.Button><Radio.Button value="large">{t("settingsPage.cyrene.large")}</Radio.Button></Radio.Group></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.threshold")}</strong><span>{t("settingsPage.cyrene.thresholdHint")}</span></div><div className="cy-settings-row__control cy-settings-slider"><Slider min={0.3} max={0.9} step={0.05} value={values.stickerSimilarityThreshold} onChange={(value) => update("stickerSimilarityThreshold", Number(value))} /><span>{values.stickerSimilarityThreshold.toFixed(2)}</span></div></div>
          <div className="cy-settings-row cy-cyrene-actions"><Button onClick={() => void openStickerManager()}>{t("settingsPage.cyrene.manageStickers")}</Button><Button onClick={openStickerDialog}>{t("settingsPage.cyrene.addSticker")}</Button></div>
        </div>
      </section>
      <section className="cy-settings-section"><div className="cy-settings-section__heading"><h2><BookOpen size={18} />{t("settingsPage.cyrene.retrievalTitle")}</h2><p>{t("settingsPage.cyrene.retrievalDescription")}</p></div>
        <div className="cy-settings-card"><div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingModel")}</strong><span>{t("settingsPage.cyrene.embeddingHint")}</span></div><Button className="cy-cyrene-model-choice" onClick={() => void selectEmbedding()}>BGE-M3 · {embeddingInstalled === null ? t("settingsPage.cyrene.unknown") : embeddingInstalled ? t("settingsPage.cyrene.installed") : t("settingsPage.cyrene.notInstalled")}</Button></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.embeddingDimensions")}</strong><span>{t("settingsPage.cyrene.embeddingDimensionsHint")}</span></div><InputNumber min={1} max={65536} value={values.embeddingDimensions} placeholder={t("settingsPage.cyrene.autoDetect")} onChange={(value) => update("embeddingDimensions", value ?? undefined)} /></div>
          <div className="cy-settings-row cy-cyrene-radio-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.cyrene.reranker")}</strong><span>{rerankerInstalled === null ? t("settingsPage.cyrene.unknown") : rerankerInstalled ? t("settingsPage.cyrene.installed") : t("settingsPage.cyrene.notInstalled")}</span></div><Radio.Group value={rerankerMode} optionType="button" buttonStyle="solid" onChange={(event) => void selectReranker(event.target.value as "standard" | "none")}><Radio.Button value="standard">bge-reranker-base</Radio.Button><Radio.Button value="none">{t("settingsPage.cyrene.off")}</Radio.Button></Radio.Group></div>
        </div>
      </section>
      <div className="cy-settings-form-footer"><Button type="primary" loading={saving} onClick={() => void save()}>{t("settingsPage.cyrene.save")}</Button></div>
    </>}
    <Modal className="cy-settings-theme-modal" open={addOpen} title={t("settingsPage.cyrene.addSticker")} okText={t("settingsPage.cyrene.add")} cancelText={t("settingsPage.cyrene.cancel")} okButtonProps={{ loading: addBusy }} onOk={() => void addSticker()} onCancel={() => setAddOpen(false)} destroyOnHidden><div className="cy-cyrene-sticker-form">{addError && <Alert type="error" showIcon title={addError} />}<label><span>{t("settingsPage.cyrene.stickerFile")}</span><div className="cy-cyrene-sticker-file"><Button onClick={() => void pickStickerFile()}>{t("settingsPage.cyrene.chooseFile")}</Button><span>{pickedPath.split(/[\\/]/).pop() || t("settingsPage.cyrene.noFile")}</span></div></label><label><span>{t("settingsPage.cyrene.stickerId")}</span><Input value={stickerId} onChange={(event) => setStickerId(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerDescriptionField")}</span><Input value={stickerDescription} onChange={(event) => setStickerDescription(event.target.value)} /></label><label><span>{t("settingsPage.cyrene.stickerPhrases")}</span><Input.TextArea rows={3} value={stickerPhrases} onChange={(event) => setStickerPhrases(event.target.value)} /></label></div></Modal>
  </>;
}
