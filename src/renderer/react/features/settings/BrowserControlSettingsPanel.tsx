import { useEffect, useRef, useState } from "react";
import { Alert, Button, Popconfirm } from "antd";
import { Cookie, Globe, Smartphone } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Card } from "../../components/ui/Card";
import { SettingsSegmented } from "../../components/ui/SettingsControls";
import {
  DEFAULT_BROWSER_VIEWPORT_MODE,
  normalizeBrowserViewportMode,
  type BrowserViewportMode,
} from "../../../../shared/browser-viewport";
import "./BrowserControlSettingsPanel.css";

export function BrowserControlSettingsPanel() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"cleared" | "failed" | "">("");
  const [viewportMode, setViewportMode] = useState<BrowserViewportMode>(DEFAULT_BROWSER_VIEWPORT_MODE);
  const [viewportModeFailed, setViewportModeFailed] = useState(false);
  // 读到已保存的模式之前禁用切换：否则较晚返回的读取会把用户刚切换并保存的值在界面上覆盖回去；
  // 读取失败时也保持禁用并提示重试，不把未确认的默认值当成已保存的设置显示
  const [viewportModeStatus, setViewportModeStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [viewportModeAttempt, setViewportModeAttempt] = useState(0);
  // 保存进行中禁用切换；失败时只回滚到最后一次确认保存（或读到）的值，而不是某次未落盘的中间值
  const [viewportModeSaving, setViewportModeSaving] = useState(false);
  const confirmedViewportMode = useRef<BrowserViewportMode>(DEFAULT_BROWSER_VIEWPORT_MODE);

  useEffect(() => {
    let disposed = false;
    const api = window.settings;
    if (!api) {
      setViewportModeStatus("failed");
      return;
    }
    setViewportModeStatus("loading");
    void api.getGeneral().then((config) => {
      if (disposed) return;
      const saved = normalizeBrowserViewportMode((config as { browserViewportMode?: unknown } | null)?.browserViewportMode);
      confirmedViewportMode.current = saved;
      setViewportMode(saved);
      setViewportModeStatus("ready");
    }).catch(() => {
      if (!disposed) setViewportModeStatus("failed");
    });
    return () => { disposed = true; };
  }, [viewportModeAttempt]);

  /** 切换即保存；保存失败时回滚，避免界面与实际生效的模式不一致。 */
  async function changeViewportMode(next: BrowserViewportMode) {
    if (viewportModeSaving || next === viewportMode) return;
    setViewportMode(next);
    setViewportModeFailed(false);
    setViewportModeSaving(true);
    try {
      if (!window.settings) throw new Error("Settings API unavailable");
      await window.settings.saveGeneral({ browserViewportMode: next });
      confirmedViewportMode.current = next;
    } catch {
      setViewportMode(confirmedViewportMode.current);
      setViewportModeFailed(true);
    } finally {
      setViewportModeSaving(false);
    }
  }

  async function clearCookies() {
    if (!window.browserPanel || busy) return;
    setBusy(true);
    setStatus("");
    try {
      const result = await window.browserPanel.clearCookies();
      setStatus(result.ok ? "cleared" : "failed");
    } catch {
      setStatus("failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cy-browser-control-page">
      <h1>{t("settingsPage.browserControl.title")}</h1>
      <p className="cy-settings-intro">{t("settingsPage.browserControl.description")}</p>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading">
          <h2 data-settings-search-id="settingsPage.browserControl.sectionTitle"><Globe size={18} />{t("settingsPage.browserControl.sectionTitle")}</h2>
          <p>{t("settingsPage.browserControl.sectionDescription")}</p>
        </div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong data-settings-search-id="settingsPage.browserControl.viewportMode"><Smartphone size={16} />{t("settingsPage.browserControl.viewportMode")}</strong>
              <span>{t(viewportMode === "auto" ? "settingsPage.browserControl.viewportModeAutoDescription" : "settingsPage.browserControl.viewportModeCustomDescription")}</span>
            </div>
            <SettingsSegmented
              value={viewportMode}
              disabled={viewportModeStatus !== "ready" || viewportModeSaving}
              onChange={(next) => void changeViewportMode(normalizeBrowserViewportMode(next))}
              options={[
                { label: t("settingsPage.browserControl.viewportModeAuto"), value: "auto" },
                { label: t("settingsPage.browserControl.viewportModeCustom"), value: "custom" },
              ]}
            />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy">
              <strong data-settings-search-id="settingsPage.browserControl.clearCookies"><Cookie size={16} />{t("settingsPage.browserControl.clearCookies")}</strong>
              <span>{t("settingsPage.browserControl.clearCookiesDescription")}</span>
            </div>
            <Popconfirm
              title={t("settingsPage.browserControl.confirmTitle")}
              description={t("settingsPage.browserControl.confirmDescription")}
              okText={t("settingsPage.browserControl.clearCookies")}
              cancelText={t("common.cancel")}
              onConfirm={() => void clearCookies()}
            >
              <Button danger loading={busy} disabled={!window.browserPanel}>
                {t("settingsPage.browserControl.clearCookies")}
              </Button>
            </Popconfirm>
          </div>
        </Card>
        {viewportModeStatus === "failed" && (
          <Alert
            className="cy-browser-control-page__status"
            type="error"
            showIcon
            message={t("settingsPage.loadFailed")}
            action={window.settings ? <Button size="small" onClick={() => setViewportModeAttempt((attempt) => attempt + 1)}>{t("settingsPage.browserControl.retry")}</Button> : undefined}
          />
        )}
        {viewportModeFailed && <Alert className="cy-browser-control-page__status" type="error" showIcon message={t("settingsPage.saveFailed")} />}
        {status === "cleared" && <Alert className="cy-browser-control-page__status" type="success" showIcon message={t("settingsPage.browserControl.cookiesCleared")} />}
        {status === "failed" && <Alert className="cy-browser-control-page__status" type="error" showIcon message={t("settingsPage.browserControl.clearCookiesFailed")} />}
      </section>
    </div>
  );
}
