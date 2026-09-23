import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Spin } from "antd";
import { siNeteasecloudmusic } from "simple-icons";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { useTranslation } from "../../i18n";
import { deriveNeteaseViewState, type MusicStatusSnapshot } from "../../../../shared/music-view-state";
import type { MusicIpcResult } from "../../../settings/music/types";

interface MusicSettingsApi {
  getOpenapiConfig: () => Promise<MusicIpcResult<{ appId: string; privateKey: string } | null>>;
  saveOpenapiConfig: (config: { appId: string; privateKey: string }) => Promise<MusicIpcResult<{ backend: string }>>;
  getStatus: () => Promise<MusicIpcResult<MusicStatusSnapshot>>;
  beginLogin: () => Promise<MusicIpcResult<{ qrContent?: string; pollIntervalMs?: number }>>;
  cancelLogin: () => Promise<MusicIpcResult<unknown>>;
  logout: () => Promise<MusicIpcResult<unknown>>;
  openPlayer: () => Promise<unknown>;
  onStateChanged?: (callback: (status: MusicStatusSnapshot) => void) => (() => void) | void;
}

function musicApi(): MusicSettingsApi | undefined {
  return (window as Window & { music?: MusicSettingsApi }).music;
}

type BusyAction = "" | "save" | "login" | "cancel" | "logout" | "player";

export function MusicSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [appId, setAppId] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [status, setStatus] = useState<MusicStatusSnapshot | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<BusyAction>("");
  const [feedback, setFeedback] = useState<{ type: "success" | "error" | "info"; text: string } | null>(null);
  const pollTimer = useRef<number | null>(null);
  const pollBusy = useRef(false);
  const active = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollTimer.current !== null) window.clearInterval(pollTimer.current);
    pollTimer.current = null;
  }, []);

  const refreshStatus = useCallback(async (): Promise<MusicStatusSnapshot | null> => {
    const api = musicApi();
    if (!api || pollBusy.current) return null;
    pollBusy.current = true;
    try {
      const result = await api.getStatus();
      if (!active.current) return null;
      if (!result.ok) throw new Error(result.errorCode);
      setStatus(result.data);
      if (result.data.account === "signed_in") {
        setQrDataUrl("");
        stopPolling();
      } else if (["expired", "failed", "cancelled"].includes(result.data.flow)) {
        setQrDataUrl("");
        stopPolling();
      }
      return result.data;
    } catch {
      if (active.current) setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.statusFailed") });
      return null;
    } finally {
      pollBusy.current = false;
    }
  }, [stopPolling, t]);

  const startPolling = useCallback((intervalMs?: number) => {
    stopPolling();
    pollTimer.current = window.setInterval(() => void refreshStatus(), Math.max(1000, intervalMs ?? 2000));
  }, [refreshStatus, stopPolling]);

  useEffect(() => {
    if (!open) return;
    active.current = true;
    setLoading(true);
    setFeedback(null);
    setQrDataUrl("");
    setPrivateKey("");
    const api = musicApi();
    if (!api) {
      setLoading(false);
      setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.unavailable") });
      return () => { active.current = false; };
    }
    void Promise.allSettled([api.getOpenapiConfig(), api.getStatus()]).then(([configResult, statusResult]) => {
      if (!active.current) return;
      if (configResult.status === "fulfilled" && configResult.value.ok) {
        setAppId(configResult.value.data?.appId ?? "");
      } else {
        setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.loadFailed") });
      }
      if (statusResult.status === "fulfilled" && statusResult.value.ok) {
        setStatus(statusResult.value.data);
        if (["creating_qr", "waiting_scan", "waiting_confirm"].includes(statusResult.value.data.flow)) {
          startPolling();
        }
      } else {
        setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.statusFailed") });
      }
      setLoading(false);
    });
    const unsubscribe = api.onStateChanged?.((snapshot) => {
      if (!active.current) return;
      setStatus(snapshot);
      if (snapshot.account === "signed_in" || ["expired", "failed", "cancelled"].includes(snapshot.flow)) {
        setQrDataUrl("");
        stopPolling();
      }
    });
    return () => {
      active.current = false;
      stopPolling();
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [open, startPolling, stopPolling, t]);

  async function saveConfig() {
    const api = musicApi();
    if (!api) return;
    if (!appId.trim() || !privateKey.trim()) {
      setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.credentialsRequired") });
      return;
    }
    setBusy("save");
    try {
      const result = await api.saveOpenapiConfig({ appId: appId.trim(), privateKey: privateKey.trim() });
      if (!result.ok) throw new Error(result.errorCode);
      setPrivateKey("");
      setFeedback({ type: "success", text: t("settingsPage.tools.neteaseModal.saved") });
      await refreshStatus();
    } catch {
      setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.saveFailed") });
    } finally {
      setBusy("");
    }
  }

  async function beginLogin() {
    const api = musicApi();
    if (!api) return;
    setBusy("login");
    setFeedback({ type: "info", text: t("settingsPage.tools.neteaseModal.creatingQr") });
    try {
      const result = await api.beginLogin();
      if (!result.ok) throw new Error(result.errorCode);
      if (result.data.qrContent) {
        const qrModule = await import("qrcode");
        const toDataURL = qrModule.toDataURL ?? qrModule.default?.toDataURL;
        if (!toDataURL) throw new Error("QR renderer unavailable");
        const image = await toDataURL(result.data.qrContent, { width: 220, margin: 1 });
        if (active.current) setQrDataUrl(image);
      }
      if (active.current) {
        setFeedback({ type: "info", text: t("settingsPage.tools.neteaseModal.waitingScan") });
        const snapshot = await refreshStatus();
        if (!snapshot || (["creating_qr", "waiting_scan", "waiting_confirm"].includes(snapshot.flow) && snapshot.account !== "signed_in")) {
          startPolling(result.data.pollIntervalMs);
        }
      }
    } catch {
      if (active.current) setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.loginFailed") });
    } finally {
      setBusy("");
    }
  }

  async function endLogin(mode: "cancel" | "logout") {
    const api = musicApi();
    if (!api) return;
    setBusy(mode);
    stopPolling();
    try {
      const result = mode === "cancel" ? await api.cancelLogin() : await api.logout();
      if (!result.ok) throw new Error(result.errorCode);
      setQrDataUrl("");
      setFeedback({ type: "success", text: t(mode === "cancel" ? "settingsPage.tools.neteaseModal.cancelled" : "settingsPage.tools.neteaseModal.disconnected") });
      await refreshStatus();
    } catch {
      setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.actionFailed") });
    } finally {
      setBusy("");
    }
  }

  async function openPlayer() {
    const api = musicApi();
    if (!api) return;
    setBusy("player");
    try {
      await api.openPlayer();
      setFeedback({ type: "success", text: t("settingsPage.tools.neteaseModal.playerOpened") });
    } catch {
      setFeedback({ type: "error", text: t("settingsPage.tools.neteaseModal.playerFailed") });
    } finally {
      setBusy("");
    }
  }

  const view = status ? deriveNeteaseViewState(status) : "backend_starting";
  const connected = view === "connected" || view === "connected_without_client";
  const loggingIn = view === "creating_qr" || view === "waiting_scan" || view === "waiting_confirm";
  const stateLabel = t(`settingsPage.tools.neteaseModal.state.${view}`);

  return <Modal
    open={open}
    onCancel={() => { setPrivateKey(""); onClose(); }}
    footer={null}
    width={560}
    destroyOnHidden
    rootClassName="cy-settings-music-modal"
    title={<span className="cy-settings-music-modal__title"><BrandIcon icon={siNeteasecloudmusic} size={22} label={t("settingsPage.tools.netease")} />{t("settingsPage.tools.netease")}</span>}
  >
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <div className="cy-settings-music-modal__body">
      <p className="cy-settings-music-modal__intro">{t("settingsPage.tools.neteaseModal.description")}</p>
      {feedback && <Alert showIcon type={feedback.type} message={feedback.text} />}
      <section className="cy-settings-music-modal__section">
        <h3>{t("settingsPage.tools.neteaseModal.openapiTitle")}</h3>
        <p>{t("settingsPage.tools.neteaseModal.openapiHint")}</p>
        <label htmlFor="cy-music-app-id">{t("settingsPage.tools.neteaseModal.appId")}</label>
        <Input id="cy-music-app-id" value={appId} onChange={(event) => setAppId(event.target.value)} autoComplete="off" />
        <label htmlFor="cy-music-private-key">{t("settingsPage.tools.neteaseModal.privateKey")}</label>
        <Input.TextArea id="cy-music-private-key" value={privateKey} onChange={(event) => setPrivateKey(event.target.value)} rows={3} autoComplete="off" spellCheck={false} />
        <span className="cy-settings-music-modal__hint">{t("settingsPage.tools.neteaseModal.privateKeyHint")}</span>
        <div className="cy-settings-music-modal__actions"><Button type="primary" loading={busy === "save"} disabled={Boolean(busy) && busy !== "save"} onClick={() => void saveConfig()}>{t("settingsPage.tools.neteaseModal.save")}</Button></div>
      </section>
      <section className="cy-settings-music-modal__section">
        <h3>{t("settingsPage.tools.neteaseModal.connectionTitle")}</h3>
        <div className="cy-settings-music-modal__connection"><span className={`cy-settings-music-modal__dot ${connected ? "is-connected" : ""}`} /><span>{stateLabel}</span>
          {connected ? <Button loading={busy === "logout"} disabled={Boolean(busy) && busy !== "logout"} onClick={() => void endLogin("logout")}>{t("settingsPage.tools.neteaseModal.disconnect")}</Button>
            : loggingIn ? <span className="cy-settings-music-modal__connection-actions">{!qrDataUrl && <Button loading={busy === "login"} disabled={Boolean(busy) && busy !== "login"} onClick={() => void beginLogin()}>{t("settingsPage.tools.neteaseModal.showQr")}</Button>}<Button loading={busy === "cancel"} disabled={Boolean(busy) && busy !== "cancel"} onClick={() => void endLogin("cancel")}>{t("settingsPage.tools.neteaseModal.cancelLogin")}</Button></span>
              : <Button loading={busy === "login"} disabled={Boolean(busy) && busy !== "login"} onClick={() => void beginLogin()}>{t("settingsPage.tools.neteaseModal.connect")}</Button>}</div>
        {qrDataUrl && <div className="cy-settings-music-modal__qr"><img src={qrDataUrl} alt={t("settingsPage.tools.neteaseModal.qrAlt")} /><span>{t("settingsPage.tools.neteaseModal.qrHint")}</span></div>}
      </section>
      <section className="cy-settings-music-modal__section cy-settings-music-modal__player"><div><h3>{t("settingsPage.tools.neteaseModal.playerTitle")}</h3><p>{t("settingsPage.tools.neteaseModal.playerHint")}</p></div><Button loading={busy === "player"} disabled={Boolean(busy) && busy !== "player"} onClick={() => void openPlayer()}>{t("settingsPage.tools.openPlayer")}</Button></section>
    </div>}
  </Modal>;
}
