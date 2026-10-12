import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import type { StartupAnimationSettings as AnimationSettings, StartupAnimationMode } from "../../../../shared/startup-animation";
import { SettingsSegmented } from "../../components/ui/SettingsControls";
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

  async function change(action: "mode" | "import" | "reset", mode?: StartupAnimationMode) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      const api = window.settings?.startupAnimation;
      if (!api) throw new Error(t("settingsPage.loadFailed"));
      const value = action === "mode" ? await api.setMode(mode!)
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
      <SettingsSegmented<StartupAnimationMode> aria-label={t("settingsPage.general.startupAnimation")} value={settings?.mode ?? "startup"} disabled={!settings || busy} onChange={(mode) => void change("mode", mode)} options={[
        { label: t("settingsPage.general.animationOff"), value: "off" },
        { label: t("settingsPage.general.animationStartup"), value: "startup" },
        { label: t("settingsPage.general.animationExceptTray"), value: "except-tray" },
        { label: t("settingsPage.general.animationAlways"), value: "always" },
      ]} />
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
