import { useState } from "react";
import { Alert, Button, Popconfirm } from "antd";
import { Cookie, Globe } from "lucide-react";
import { useTranslation } from "../../i18n";
import { Card } from "../../components/ui/Card";
import "./BrowserControlSettingsPanel.css";

export function BrowserControlSettingsPanel() {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<"cleared" | "failed" | "">("");

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
          <h2><Globe size={18} />{t("settingsPage.browserControl.sectionTitle")}</h2>
          <p>{t("settingsPage.browserControl.sectionDescription")}</p>
        </div>
        <Card>
          <div className="cy-settings-row" data-settings-search-key="settingsPage.browserControl.clearCookies">
            <div className="cy-settings-row__copy">
              <strong><Cookie size={16} />{t("settingsPage.browserControl.clearCookies")}</strong>
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
        {status === "cleared" && <Alert className="cy-browser-control-page__status" type="success" showIcon message={t("settingsPage.browserControl.cookiesCleared")} />}
        {status === "failed" && <Alert className="cy-browser-control-page__status" type="error" showIcon message={t("settingsPage.browserControl.clearCookiesFailed")} />}
      </section>
    </div>
  );
}
