import { useEffect, useState } from "react";
import { Alert, Button, Spin } from "antd";
import { Mail } from "lucide-react";
import type { GmailAccountStatus, GmailClientConfigStatus } from "../../../../shared/gmail-types";
import { Card } from "../../components/ui/Card";
import { SettingsInput, SettingsPasswordInput, SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";

type SmtpSettings = {
  emailEnabled: boolean;
  emailSmtpHost: string;
  emailSmtpPort: number;
  emailSmtpSecure: boolean;
  emailSmtpUser: string;
  emailSmtpPass: string;
  emailFromName: string;
};

const defaults: SmtpSettings = {
  emailEnabled: false, emailSmtpHost: "", emailSmtpPort: 465,
  emailSmtpSecure: true, emailSmtpUser: "", emailSmtpPass: "", emailFromName: "",
};

const defaultGmailClientConfig: GmailClientConfigStatus = {
  clientId: "",
  clientSecretConfigured: false,
  secureStorageAvailable: false,
};

function readSmtp(value: unknown): SmtpSettings {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    emailEnabled: input.emailEnabled === true,
    emailSmtpHost: typeof input.emailSmtpHost === "string" ? input.emailSmtpHost : "",
    emailSmtpPort: typeof input.emailSmtpPort === "number" ? input.emailSmtpPort : 465,
    emailSmtpSecure: input.emailSmtpSecure !== false,
    emailSmtpUser: typeof input.emailSmtpUser === "string" ? input.emailSmtpUser : "",
    emailSmtpPass: typeof input.emailSmtpPass === "string" ? input.emailSmtpPass : "",
    emailFromName: typeof input.emailFromName === "string" ? input.emailFromName : "",
  };
}

export function EmailSettingsPanel() {
  const { t } = useTranslation();
  const [smtp, setSmtp] = useState(defaults);
  const [gmail, setGmail] = useState<GmailAccountStatus>({ state: "disconnected" });
  const [gmailClientConfig, setGmailClientConfig] = useState(defaultGmailClientConfig);
  const [gmailClientId, setGmailClientId] = useState("");
  const [gmailClientSecret, setGmailClientSecret] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [authFlowId, setAuthFlowId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");

  useEffect(() => {
    let disposed = false;
    void Promise.all([window.settings?.getGeneral(), window.gmail?.getStatus(), window.gmail?.getClientConfig()])
      .then(([general, connection, clientConfig]) => {
        if (disposed) return;
        setSmtp(readSmtp(general));
        if (connection) setGmail(connection);
        if (clientConfig) {
          setGmailClientConfig(clientConfig);
          setGmailClientId(clientConfig.clientId);
        }
        setLoading(false);
      })
      .catch(() => { if (!disposed) { setError(t("settingsPage.emailSettings.loadFailed")); setLoading(false); } });
    return () => { disposed = true; };
  }, [t]);

  async function refreshGmail() {
    if (!window.gmail) throw new Error("Gmail API unavailable");
    const next = await window.gmail.getStatus();
    setGmail(next);
    return next;
  }

  async function runGmailAuthorization() {
    if (!window.gmail) throw new Error("Gmail API unavailable");
    setStatus(t("settingsPage.emailSettings.authorizing"));
    const { flowId } = await window.gmail.beginAuthorization();
    setAuthFlowId(flowId);
    const result = await window.gmail.waitForAuthorization(flowId);
    setGmail(result);
    setStatus(result.state === "connected" ? t("settingsPage.emailSettings.connected") : t("settingsPage.emailSettings.notConnected"));
    setAuthFlowId(null);
    return result;
  }

  async function saveAndConnectGmail() {
    if (!window.gmail || busy) return;
    setBusy(true); setError(""); setStatus("");
    let credentialsSaved = false;
    try {
      const saved = await window.gmail.saveClientConfig(gmailClientId, gmailClientSecret);
      credentialsSaved = true;
      setGmailClientConfig(saved);
      setGmailClientId(saved.clientId);
      setGmailClientSecret("");
      const connection = await window.gmail.getStatus();
      setGmail(connection);
      if (connection.state !== "connected") await runGmailAuthorization();
      else setStatus(t("settingsPage.emailSettings.connected"));
    } catch {
      setAuthFlowId(null);
      setError(t(credentialsSaved ? "settingsPage.emailSettings.connectFailed" : "settingsPage.emailSettings.configSaveFailed"));
      await refreshGmail().catch(() => undefined);
    } finally { setBusy(false); }
  }

  async function cancelGmailAuthorization() {
    if (!window.gmail || !authFlowId) return;
    try { setGmail(await window.gmail.cancelAuthorization(authFlowId)); }
    catch { setError(t("settingsPage.emailSettings.connectFailed")); }
    finally { setAuthFlowId(null); setBusy(false); }
  }

  async function disconnectGmail() {
    if (!window.gmail || busy) return;
    setBusy(true); setError("");
    try { setGmail(await window.gmail.disconnect()); setStatus(t("settingsPage.emailSettings.disconnected")); }
    catch { setError(t("settingsPage.emailSettings.disconnectFailed")); }
    finally { setBusy(false); }
  }

  async function saveSmtp(patch: Partial<SmtpSettings>) {
    if (!window.settings || busy) return;
    setBusy(true); setError("");
    try {
      await window.settings.saveGeneral(patch);
      setSmtp((current) => ({ ...current, ...patch }));
      setStatus(t("settingsPage.saved"));
    } catch { setError(t("settingsPage.saveFailed")); }
    finally { setBusy(false); }
  }

  const connectionText = gmail.state === "connected"
    ? gmail.emailAddress
      ? t("settingsPage.emailSettings.connectedAs", { address: gmail.emailAddress })
      : t("settingsPage.emailSettings.connected")
    : t(`settingsPage.emailSettings.state.${gmail.state}`);

  return <>
    <h1>{t("settingsPage.emailSettings.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.emailSettings.description")}</p>
    {error && <Alert className="cy-settings-alert" type="error" showIcon message={error} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Mail size={18} />{t("settingsPage.emailSettings.gmailTitle")}</h2><p>{t("settingsPage.emailSettings.gmailDescription")}</p></div>
        <Card>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{connectionText}</strong><span>{t("settingsPage.emailSettings.privacy")}</span></div>
            <div className="cy-settings-row__control cy-settings-button-group">
              {authFlowId
                ? <Button disabled={!authFlowId} onClick={() => void cancelGmailAuthorization()}>{t("settingsPage.emailSettings.cancelAuthorization")}</Button>
                : gmail.state === "connected"
                ? <Button danger disabled={busy} onClick={() => void disconnectGmail()}>{t("settingsPage.emailSettings.disconnect")}</Button>
                : null}
            </div>
          </div>
          {!gmailClientConfig.secureStorageAvailable && <Alert type="warning" showIcon message={t("settingsPage.emailSettings.secureStorageUnavailable")} />}
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.emailSettings.clientId")}</strong></div>
            <SettingsInput className="cy-settings-tools__select" autoComplete="off" value={gmailClientId} disabled={busy} placeholder={t("settingsPage.emailSettings.clientIdPlaceholder")} onChange={(event) => setGmailClientId(event.target.value)} />
          </div>
          <div className="cy-settings-row">
            <div className="cy-settings-row__copy"><strong>{t("settingsPage.emailSettings.clientSecret")}</strong><span>{gmailClientConfig.clientSecretConfigured ? t("settingsPage.emailSettings.clientSecretSaved") : t("settingsPage.emailSettings.clientSecretHelp")}</span></div>
            <SettingsPasswordInput className="cy-settings-tools__select" autoComplete="new-password" value={gmailClientSecret} disabled={busy} placeholder={gmailClientConfig.clientSecretConfigured ? t("settingsPage.emailSettings.clientSecretSavedPlaceholder") : t("settingsPage.emailSettings.clientSecretPlaceholder")} showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} onChange={(event) => setGmailClientSecret(event.target.value)} />
          </div>
          <div className="cy-settings-row cy-settings-tools__actions">
            <Button type="primary" disabled={busy || !gmailClientConfig.secureStorageAvailable || !gmailClientId.trim()} loading={busy} onClick={() => void saveAndConnectGmail()}>{gmail.state === "reauthorization_required" ? t("settingsPage.emailSettings.saveAndReconnect") : t("settingsPage.emailSettings.saveAndConnect")}</Button>
          </div>
        </Card>
      </section>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2>{t("settingsPage.emailSettings.smtpTitle")}</h2><p>{t("settingsPage.emailSettings.smtpDescription")}</p></div>
        <Card>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.emailEnabled")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.tools.emailEnabled")} checked={smtp.emailEnabled} disabled={busy} onChange={(checked) => void saveSmtp({ emailEnabled: checked })} /></div>
          {smtp.emailEnabled && <>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.emailSettings.smtpIdentity")}</strong><span>{smtp.emailSmtpUser || t("mailDraft.senderUnavailable")}</span></div></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpHost")}</strong></div><SettingsInput className="cy-settings-tools__select" value={smtp.emailSmtpHost} onChange={(event) => setSmtp((value) => ({ ...value, emailSmtpHost: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpPort")}</strong></div><SettingsInput className="cy-settings-tools__select" type="number" min={1} max={65535} value={smtp.emailSmtpPort} onChange={(event) => setSmtp((value) => ({ ...value, emailSmtpPort: event.target.value === "" ? 465 : Number(event.target.value) }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpSecure")}</strong><span>{t("settingsPage.tools.smtpSecureDescription")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.tools.smtpSecure")} checked={smtp.emailSmtpSecure} disabled={busy} onChange={(checked) => setSmtp((value) => ({ ...value, emailSmtpSecure: checked }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpUser")}</strong></div><SettingsInput className="cy-settings-tools__select" value={smtp.emailSmtpUser} onChange={(event) => setSmtp((value) => ({ ...value, emailSmtpUser: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.smtpPass")}</strong></div><SettingsPasswordInput className="cy-settings-tools__select" showLabel={t("settingsPage.asr.showSecret")} hideLabel={t("settingsPage.asr.hideSecret")} value={smtp.emailSmtpPass} onChange={(event) => setSmtp((value) => ({ ...value, emailSmtpPass: event.target.value }))} /></div>
            <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.tools.fromName")}</strong></div><SettingsInput className="cy-settings-tools__select" value={smtp.emailFromName} onChange={(event) => setSmtp((value) => ({ ...value, emailFromName: event.target.value }))} /></div>
            <div className="cy-settings-row cy-settings-tools__actions"><Button type="primary" disabled={busy} onClick={() => void saveSmtp({ emailSmtpHost: smtp.emailSmtpHost, emailSmtpPort: smtp.emailSmtpPort, emailSmtpSecure: smtp.emailSmtpSecure, emailSmtpUser: smtp.emailSmtpUser, emailSmtpPass: smtp.emailSmtpPass, emailFromName: smtp.emailFromName })}>{t("settingsPage.tools.saveEmail")}</Button></div>
          </>}
        </Card>
      </section>
      <div className="cy-settings-status" role="status" aria-live="polite">{status}</div>
    </>}
  </>;
}
