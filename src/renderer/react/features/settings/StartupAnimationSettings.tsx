import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import type { StartupAnimationSettings as AnimationSettings } from "../../../../shared/startup-animation";
import { SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";

export function StartupAnimationSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AnimationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(false);
  const locked = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const api = window.settings?.startupAnimation;
    if (!api) setError(t("settingsPage.loadFailed"));
    else void api.get().then((value) => { if (mounted.current) setSettings(value); })
      .catch(() => { if (mounted.current) setError(t("settingsPage.loadFailed")); });
    return () => { mounted.current = false; };
  }, [t]);

  async function change(action: "toggle" | "import" | "reset", enabled?: boolean) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const api = window.settings?.startupAnimation;
      if (!api) throw new Error(t("settingsPage.loadFailed"));
      const value = action === "toggle" ? await api.setEnabled(Boolean(enabled))
        : action === "import" ? await api.importVideo() : await api.resetVideo();
      if (mounted.current && value) {
        setSettings(value);
        setNotice(t("settingsPage.general.animationApplied"));
      }
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t("settingsPage.saveFailed"));
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return <>
    <div className="cy-settings-row">
      <div className="cy-settings-row__copy"><strong>{t("settingsPage.general.startupAnimation")}</strong><span>{t("settingsPage.general.startupAnimationDescription")}</span></div>
      <SettingsSwitch ariaLabel={t("settingsPage.general.startupAnimation")} checked={settings?.enabled ?? true} disabled={!settings || busy} loading={busy} onChange={(enabled) => void change("toggle", enabled)} />
    </div>
    <div className="cy-settings-row">
      <div className="cy-settings-row__copy">
        <strong>{t("settingsPage.general.animationVideo")}</strong>
        <span>{settings?.videoName || t("settingsPage.general.animationDefault")}</span>
        <span>{t("settingsPage.general.animationVideoDescription")}</span>
        {notice && <span className="cy-settings-general__notice" role="status" aria-live="polite">{notice}</span>}
        {error && <Alert type="error" showIcon message={error} />}
      </div>
      <div className="cy-settings-row__control cy-settings-button-group">
        <Button disabled={!settings || busy} onClick={() => void change("import")}>{t("settingsPage.general.animationImport")}</Button>
        <Button disabled={!settings || busy || !settings.videoFile} onClick={() => void change("reset")}>{t("settingsPage.general.animationReset")}</Button>
      </div>
    </div>
  </>;
}
