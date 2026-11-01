import { useEffect, useRef, useState } from "react";
import { Alert, Button, Spin } from "antd";
import { FolderOpen, Info, Monitor, Settings2 } from "lucide-react";
import packageJson from "../../../../../package.json";
import { SettingsSegmented, SettingsSwitch } from "../../components/ui/SettingsControls";
import { setUiLocale, useTranslation } from "../../i18n";
import { normalizeUiLanguage, type UiLanguage } from "../../../../shared/ui-language";
import { Card } from "../../components/ui/Card";
import { useAppUpdate } from "../../hooks/useAppUpdate";
import { resolveAppUpdateView, resolveVersionTitleKey, WEBSITE_URL } from "./app-update-view";

interface GeneralValues {
  rememberWindowState: boolean;
  toastSoundEnabled: boolean;
  launchAtLogin: boolean;
  disableGpuElectron: boolean;
  language: UiLanguage;
}

const defaults: GeneralValues = {
  rememberWindowState: true,
  toastSoundEnabled: true,
  launchAtLogin: false,
  disableGpuElectron: false,
  language: "zh-CN",
};

function readGeneral(value: unknown): GeneralValues {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    rememberWindowState: typeof input.rememberWindowState === "boolean" ? input.rememberWindowState : defaults.rememberWindowState,
    toastSoundEnabled: typeof input.toastSoundEnabled === "boolean" ? input.toastSoundEnabled : defaults.toastSoundEnabled,
    launchAtLogin: typeof input.launchAtLogin === "boolean" ? input.launchAtLogin : defaults.launchAtLogin,
    disableGpuElectron: typeof input.disableGpuElectron === "boolean" ? input.disableGpuElectron : defaults.disableGpuElectron,
    language: normalizeUiLanguage(input.language),
  };
}

export function GeneralSettingsPanel() {
  const { t } = useTranslation();
  const [values, setValues] = useState(defaults);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  // 最近一次「打开数据目录」失败时显示的提示；之后打开成功时只清除它，不覆盖其他状态
  const dataDirErrorRef = useRef("");
  const [dataDir, setDataDir] = useState("");
  const updateState = useAppUpdate();
  const updateView = resolveAppUpdateView(updateState);
  // 版本称号（如 1.3.0 的"正式版"）随版本走，普通版本查不到就不显示
  const versionTitleKey = resolveVersionTitleKey(packageJson.version);

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

  // 数据目录只读展示；取不到时整行隐藏，不影响其余设置
  useEffect(() => {
    let disposed = false;
    void window.settings?.getDataDir?.().then((dir) => {
      if (!disposed && typeof dir === "string") setDataDir(dir);
    }).catch(() => {});
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
        language: values.language,
      });
      setStatus(t("settingsPage.saved"));
    } catch {
      setStatus(t("settingsPage.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  /** 打开数据目录：系统无法打开时在状态栏提示，避免按钮静默无效 */
  async function openDataDir() {
    const showError = (error: string) => {
      const message = t("settingsPage.general.openDataDirFailed", { error });
      dataDirErrorRef.current = message;
      setStatus(message);
    };
    try {
      const result = await window.settings?.openDataDir?.();
      if (result && !result.ok) {
        showError(result.error ?? "");
        return;
      }
      // 失败后重试成功：清掉仍在显示的旧失败提示，避免目录已打开却继续报错
      const stale = dataDirErrorRef.current;
      dataDirErrorRef.current = "";
      if (stale) setStatus((current) => (current === stale ? "" : current));
    } catch {
      showError("");
    }
  }

  /** 更新按钮：下载/安装按当前动作执行，检查与重试都从头查一遍 */
  function triggerUpdateAction() {
    const api = window.appUpdate;
    if (!api) return;
    if (updateView.action === "download") void api.download();
    else if (updateView.action === "install") void api.install();
    else if (updateView.action !== null) void api.check();
  }

  /** 切换界面语言：先即时生效再落盘，落盘失败时回滚，避免界面与配置不一致。 */
  async function changeLanguage(next: UiLanguage) {
    const previous = values.language;
    if (next === previous) return;
    setValues((current) => ({ ...current, language: next }));
    setUiLocale(next);
    setStatus(t("settingsPage.preferences.saving"));
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({ language: next });
      setStatus(t("settingsPage.applied"));
    } catch {
      setValues((current) => ({ ...current, language: previous }));
      setUiLocale(previous);
      setStatus(t("settingsPage.saveFailed"));
    }
  }

  return (
    <>
      <h1>{t("settingsPage.general.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.general.description")}</p>
      {loadError && <Alert className="cy-settings-alert" type="error" showIcon message={t("settingsPage.loadFailed")} />}
      {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
        <section className="cy-settings-section">
          <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.general.windows"><Settings2 size={18} />{t("settingsPage.general.windows")}</h2><p>{t("settingsPage.general.windowsDescription")}</p></div>
          <Card>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.rememberWindowState">{t("settingsPage.general.rememberWindowState")}</strong><span>{t("settingsPage.general.rememberWindowStateDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.general.rememberWindowState")} checked={values.rememberWindowState} onChange={(checked) => void saveImmediate("rememberWindowState", checked)} /></div>
          </Card>
        </section>

        <section className="cy-settings-section">
          <div className="cy-settings-section__heading"><h2 data-settings-search-id="settingsPage.general.system"><Monitor size={18} />{t("settingsPage.general.system")}</h2><p>{t("settingsPage.general.systemDescription")}</p></div>
          <Card>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.toastSound">{t("settingsPage.general.toastSound")}</strong><span>{t("settingsPage.general.toastSoundDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.general.toastSound")} checked={values.toastSoundEnabled} onChange={(checked) => { setValues((current) => ({ ...current, toastSoundEnabled: checked })); setStatus(t("settingsPage.preferences.unsaved")); }} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.launchAtLogin">{t("settingsPage.general.launchAtLogin")}</strong><span>{t("settingsPage.general.launchAtLoginDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.general.launchAtLogin")} checked={values.launchAtLogin} onChange={(checked) => { setValues((current) => ({ ...current, launchAtLogin: checked })); setStatus(t("settingsPage.preferences.unsaved")); }} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.language">{t("settingsPage.general.language")}</strong><span>{t("settingsPage.general.languageDescription")}</span></div><SettingsSegmented value={values.language} onChange={(next) => void changeLanguage(next as UiLanguage)} options={[{ label: t("settingsPage.general.chinese"), value: "zh-CN" }, { label: "English", value: "en" }, { label: t("settingsPage.general.japanese"), value: "ja-JP" }, { label: t("settingsPage.general.korean"), value: "ko", disabled: true }]} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.disableGpu">{t("settingsPage.general.disableGpu")}</strong><span>{t("settingsPage.general.disableGpuDescription")}</span><span className="cy-settings-general__notice">{t("settingsPage.general.restartNotice")}</span></div><div className="cy-settings-row__control cy-settings-button-group"><SettingsSwitch ariaLabel={t("settingsPage.general.disableGpu")} checked={values.disableGpuElectron} onChange={(checked) => void saveImmediate("disableGpuElectron", checked)} /><Button onClick={() => window.settings?.openChromeGpu()}>{t("settingsPage.general.gpuInternals")}</Button></div></div>
          </Card>
        </section>

        <section className="cy-settings-section">
          <Card>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong data-settings-search-id="settingsPage.general.about"><Info size={16} /> {t("settingsPage.general.about")}</strong><span>{t("settingsPage.general.aboutDescription")} · v{packageJson.version}{versionTitleKey && ` · ${t(versionTitleKey)}`} · <a className="cy-settings-about__link" href={WEBSITE_URL} onClick={(event) => { event.preventDefault(); void window.system?.openExternal(WEBSITE_URL); }}>{t("ui.website.menuEntry")}</a></span></div></div>
            {dataDir && (
              <div className="cy-settings-row">
                <div className="cy-settings-row__copy">
                  <strong data-settings-search-id="settingsPage.general.dataDir">{t("settingsPage.general.dataDir")}</strong>
                  <span>{t("settingsPage.general.dataDirDescription")}</span>
                  <span className="cy-settings-general__path" data-testid="settings-data-dir">{dataDir}</span>
                </div>
                <div className="cy-settings-row__control">
                  <Button icon={<FolderOpen size={14} />} onClick={() => void openDataDir()}>{t("settingsPage.general.openDataDir")}</Button>
                </div>
              </div>
            )}
            <div className="cy-settings-row">
              <div className="cy-settings-row__copy">
                <strong data-settings-search-id="settingsPage.general.softwareUpdate">{t("settingsPage.general.softwareUpdate")}</strong>
                <span>{t(updateView.label.key, updateView.label.params)}</span>
                {updateState.releaseNotes && <span className="cy-settings-general__notice">{updateState.releaseNotes}</span>}
              </div>
              <div className="cy-settings-row__control">
                {updateView.busy && <Spin size="small" />}
                {updateView.action && (
                  <Button
                    type={updateView.action === "install" ? "primary" : "default"}
                    onClick={triggerUpdateAction}
                  >
                    {t(updateView.actionLabel ?? "")}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        </section>

        <div className="cy-settings-preferences-actions">
          <div className="cy-settings-status" role="status" aria-live="polite">{status || t("settingsPage.preferences.unsaved")}</div>
          <Button type="primary" loading={saving} onClick={() => void saveGeneral()}>{t("settingsPage.general.save")}</Button>
        </div>
      </>}
    </>
  );
}
