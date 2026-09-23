import { useEffect, useState } from "react";
import { Alert, Button, Segmented, Spin, Switch } from "antd";
import { Info, Monitor, Settings2 } from "lucide-react";
import packageJson from "../../../../../package.json";
import { useTranslation } from "../../i18n";

interface GeneralValues {
  sidebarVisible: boolean;
  tasksVisible: boolean;
  rememberWindowState: boolean;
  toastSoundEnabled: boolean;
  launchAtLogin: boolean;
  disableGpuElectron: boolean;
}

const defaults: GeneralValues = {
  sidebarVisible: true,
  tasksVisible: true,
  rememberWindowState: true,
  toastSoundEnabled: true,
  launchAtLogin: false,
  disableGpuElectron: false,
};

function readGeneral(value: unknown): GeneralValues {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    sidebarVisible: typeof input.sidebarVisible === "boolean" ? input.sidebarVisible : defaults.sidebarVisible,
    tasksVisible: typeof input.tasksVisible === "boolean" ? input.tasksVisible : defaults.tasksVisible,
    rememberWindowState: typeof input.rememberWindowState === "boolean" ? input.rememberWindowState : defaults.rememberWindowState,
    toastSoundEnabled: typeof input.toastSoundEnabled === "boolean" ? input.toastSoundEnabled : defaults.toastSoundEnabled,
    launchAtLogin: typeof input.launchAtLogin === "boolean" ? input.launchAtLogin : defaults.launchAtLogin,
    disableGpuElectron: typeof input.disableGpuElectron === "boolean" ? input.disableGpuElectron : defaults.disableGpuElectron,
  };
}

export function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let disposed = false;
    const api = window.settings;
    if (!api) {
      setLoadError(true);
      setLoading(false);
      return;
    }
    void api.getGeneral().then((config) => {
      if (disposed) return;
      setValues(readGeneral(config));
      setLoading(false);
    }).catch(() => {
      if (disposed) return;
      setLoadError(true);
      setLoading(false);
    });
    return () => { disposed = true; };
  }, []);

  async function saveImmediate(key: keyof GeneralValues, checked: boolean) {
    setValues((current) => ({ ...current, [key]: checked }));
    setStatus(t("settingsPage.preferences.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({ [key]: checked });
      setStatus(t("settingsPage.applied"));
    } catch {
      setValues((current) => ({ ...current, [key]: !checked }));
      setStatus(t("settingsPage.saveFailed"));
    }
  }

  async function saveGeneral() {
    setSaving(true);
    setStatus(t("settingsPage.preferences.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({
        toastSoundEnabled: values.toastSoundEnabled,
        launchAtLogin: values.launchAtLogin,
        language: "zh-CN",
      });
      setStatus(t("settingsPage.saved"));
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1>{t("settingsPage.general.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.general.description")}</p>
      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.loadFailed")} />}
      {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
        <section className="cy-settings-section">
          <div className="cy-settings-section__heading"><h2><Settings2 size={18} />{t("settingsPage.general.windows")}</h2><p>{t("settingsPage.general.windowsDescription")}</p></div>
          <div className="cy-settings-card">
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.sidebar")}</strong><span>{t("settingsPage.general.sidebarDescription")}</span></div><Switch checked={values.sidebarVisible} onChange={(checked) => void saveImmediate("sidebarVisible", checked)} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.tasks")}</strong><span>{t("settingsPage.general.tasksDescription")}</span></div><Switch checked={values.tasksVisible} onChange={(checked) => void saveImmediate("tasksVisible", checked)} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.rememberWindowState")}</strong><span>{t("settingsPage.general.rememberWindowStateDescription")}</span></div><Switch checked={values.rememberWindowState} onChange={(checked) => void saveImmediate("rememberWindowState", checked)} /></div>
          </div>
        </section>

        <section className="cy-settings-section">
          <div className="cy-settings-section__heading"><h2><Monitor size={18} />{t("settingsPage.general.system")}</h2><p>{t("settingsPage.general.systemDescription")}</p></div>
          <div className="cy-settings-card">
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.toastSound")}</strong><span>{t("settingsPage.general.toastSoundDescription")}</span></div><Switch checked={values.toastSoundEnabled} onChange={(checked) => { setValues((current) => ({ ...current, toastSoundEnabled: checked })); setStatus(t("settingsPage.preferences.unsaved")); }} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.launchAtLogin")}</strong><span>{t("settingsPage.general.launchAtLoginDescription")}</span></div><Switch checked={values.launchAtLogin} onChange={(checked) => { setValues((current) => ({ ...current, launchAtLogin: checked })); setStatus(t("settingsPage.preferences.unsaved")); }} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.language")}</strong><span>{t("settingsPage.general.languageDescription")}</span></div><Segmented value="zh-CN" options={[{ label: t("settingsPage.general.chinese"), value: "zh-CN" }, { label: "English", value: "en", disabled: true }, { label: t("settingsPage.general.japanese"), value: "ja", disabled: true }, { label: t("settingsPage.general.korean"), value: "ko", disabled: true }]} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.general.disableGpu")}</strong><span>{t("settingsPage.general.disableGpuDescription")}</span><span className="cy-settings-general__notice">{t("settingsPage.general.restartNotice")}</span></div><div className="cy-settings-row__control cy-settings-button-group"><Switch checked={values.disableGpuElectron} onChange={(checked) => void saveImmediate("disableGpuElectron", checked)} /><Button onClick={() => window.settings?.openChromeGpu()}>{t("settingsPage.general.gpuInternals")}</Button></div></div>
          </div>
        </section>

        <section className="cy-settings-section">
          <div className="cy-settings-card">
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong><Info size={16} /> {t("settingsPage.general.about")}</strong><span>{t("settingsPage.general.aboutDescription")} · v{packageJson.version}</span></div></div>
          </div>
        </section>

        <div className="cy-settings-preferences-actions">
          <div className="cy-settings-status" role="status" aria-live="polite">{status || t("settingsPage.preferences.unsaved")}</div>
          <Button type="primary" loading={saving} onClick={() => void saveGeneral()}>{t("settingsPage.general.save")}</Button>
        </div>
      </>}
    </>
  );
}
