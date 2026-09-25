import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Button, Input, Modal, Spin, Tag } from "antd";
import { Activity, ChevronDown, Link2, MessageSquareText, MessagesSquare, Smartphone, Trash2 } from "lucide-react";
import { Lark } from "@lobehub/ui/icons";
import { siQq, siWechat } from "simple-icons";
import type { SettingsApi } from "../../../settings/shared/types";
import { BrandIcon } from "../../components/ui/BrandIcon";
import { SettingsInput, SettingsPasswordInput, SettingsSelect, SettingsSwitch } from "../../components/ui/SettingsControls";
import { useTranslation } from "../../i18n";
import "./ChannelsSettingsPanel.css";
import { Card } from "../../components/ui/Card";

type ChannelId = "wechat" | "feishu" | "qq" | "qqbot";
type ChannelConfig = Record<string, unknown>;
type ChannelValues = Record<ChannelId, ChannelConfig> & Record<string, unknown>;
type ChannelStatus = { phase?: string; message?: string; detail?: Record<string, unknown> };
type ChannelStatuses = Partial<Record<ChannelId, ChannelStatus>>;
type LogEntry = { at: string; dir: "incoming" | "outgoing"; channel: string; senderId: string; senderName?: string; chatId: string; text: string; hasAttachments?: boolean };
type ContextSnapshot = Awaited<ReturnType<SettingsApi["channelsContextBindingsGet"]>>;

const defaultValues: ChannelValues = {
  wechat: { enabled: false }, feishu: { enabled: false },
  qq: { enabled: false, listenMode: "auto", port: 6200, allowedPrivateUserIds: [], allowedGroupIds: [] },
  qqbot: { enabled: false, allowAnyPrivate: false, allowedUserOpenids: [], allowedGroupOpenids: [] },
  rateLimitPerUser: 10, rateLimitPerChannel: 100, ttsEnabled: true,
  stickerEnabled: true, mirrorToDesktop: true, toolSandbox: "all",
};

const channelIds: ChannelId[] = ["wechat", "feishu", "qq", "qqbot"];

function ChannelProviderIcon({ id, label }: { id: ChannelId; label: string }) {
  const brand = id === "wechat" ? siWechat : id === "qq" || id === "qqbot" ? siQq : null;
  return <span className="cy-channels-provider__icon">
    {brand ? <BrandIcon icon={brand} size={21} label={label} /> : id === "feishu" ? <Lark.Color size={21} aria-label={label} role="img" /> : <span role="img" aria-label={label}><MessagesSquare size={21} aria-hidden="true" /></span>}
  </span>;
}

function channelName(t: (key: string, options?: Record<string, unknown>) => string, channel: string): string {
  const keys: Record<string, string> = { wechat: "wechat", feishu: "feishu", qq: "qq", qqbot: "qqbot" };
  return t(`settingsPage.channels.channel.${keys[channel] ?? "other"}`);
}

function readConfig(value: unknown): ChannelValues {
  if (!value || typeof value !== "object") return defaultValues;
  const source = value as Record<string, unknown>;
  const feishu = source.feishu && typeof source.feishu === "object" ? source.feishu as ChannelConfig : {};
  const safeFeishu: ChannelConfig = { ...defaultValues.feishu, ...feishu, hasAppSecret: Boolean(feishu.appSecret || feishu.hasAppSecret) };
  delete safeFeishu.appSecret;
  return { ...defaultValues, ...source,
    wechat: { ...defaultValues.wechat, ...(source.wechat as object ?? {}) },
    feishu: safeFeishu,
    qq: { ...defaultValues.qq, ...(source.qq as object ?? {}) },
    qqbot: { ...defaultValues.qqbot, ...(source.qqbot as object ?? {}) },
  };
}

function stringValue(config: ChannelConfig, key: string): string {
  const value = config[key];
  return typeof value === "string" ? value : "";
}

function listValue(config: ChannelConfig, key: string): string {
  const value = config[key];
  return Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "";
}

function splitList(value: string, openid = false): string[] {
  const pattern = openid ? /^[A-Za-z0-9_-]{8,64}$/u : /^\d+$/u;
  return Array.from(new Set(value.split(/[\s,，]+/u).map((item) => item.trim()).filter((item) => pattern.test(item))));
}

export function ChannelsSettingsPanel() {
  const { t } = useTranslation();
  const api = window.settings as unknown as SettingsApi | undefined;
  const [values, setValues] = useState<ChannelValues>(defaultValues);
  const [statuses, setStatuses] = useState<ChannelStatuses>({});
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [context, setContext] = useState<ContextSnapshot>({ externalChats: [], bindings: [], conversations: [] });
  const [sourceSession, setSourceSession] = useState("");
  const [targetConversation, setTargetConversation] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [feedback, setFeedback] = useState("");
  const [dialog, setDialog] = useState<ChannelId | null>(null);
  const [logsExpanded, setLogsExpanded] = useState(false);
  const [qrCode, setQrCode] = useState("");
  const [secretDrafts, setSecretDrafts] = useState({ feishu: "", qq: "", qqbot: "" });
  const [qqToken, setQqToken] = useState("");
  const debounce = useRef<number | undefined>(undefined);
  const pendingGlobalPatch = useRef<Record<string, unknown>>({});

  const channelRows = useMemo(() => channelIds.map((id) => ({ id, status: statuses[id] })), [statuses]);

  const refreshLogs = useCallback(async () => {
    if (!api) return;
    try { setLogs(await api.channelsLogGet(100) as LogEntry[]); }
    catch { setFeedback(t("settingsPage.channels.loadFailed")); }
  }, [api, t]);

  const refreshContext = useCallback(async () => {
    if (!api) return;
    try { setContext(await api.channelsContextBindingsGet()); }
    catch { setFeedback(t("settingsPage.channels.loadFailed")); }
  }, [api, t]);

  const refreshStatus = useCallback(async () => {
    if (!api) return;
    try { setStatuses(await api.channelsGetStatus() as ChannelStatuses); }
    catch { /* status is secondary; connection forms remain usable */ }
  }, [api]);

  useEffect(() => {
    let active = true;
    if (!api) { setLoading(false); setFeedback(t("settingsPage.channels.unavailable")); return; }
    void Promise.all([api.channelsGetConfig(), api.channelsGetStatus(), api.channelsLogGet(100), api.channelsContextBindingsGet()])
      .then(([config, status, entries, bindings]) => {
        if (!active) return;
        setValues(readConfig(config)); setStatuses(status as ChannelStatuses);
        setLogs(entries as LogEntry[]); setContext(bindings); setLoading(false);
      })
      .catch(() => { if (active) { setFeedback(t("settingsPage.channels.loadFailed")); setLoading(false); } });
    const offStatus = api.onChannelsStatusChanged((next) => setStatuses(next as ChannelStatuses));
    const offQr = api.onChannelsWechatQrcode((dataUrl) => setQrCode(dataUrl));
    const offLogin = api.onChannelsWechatLoginDone((result) => {
      setFeedback(result.ok ? t("settingsPage.channels.wechat.loginSuccess") : result.error ?? t("settingsPage.channels.wechat.loginFailed"));
      if (result.ok) { setQrCode(""); void refreshStatus(); }
    });
    return () => { active = false; if (typeof offStatus === "function") offStatus(); if (typeof offQr === "function") offQr(); if (typeof offLogin === "function") offLogin(); };
  }, [api, refreshStatus, t]);

  useEffect(() => () => {
    if (debounce.current !== undefined) window.clearTimeout(debounce.current);
    if (api && Object.keys(pendingGlobalPatch.current).length) void api.channelsSaveConfig(pendingGlobalPatch.current).catch(() => {});
  }, [api]);

  const updateGlobal = useCallback((key: string, value: unknown) => {
    setValues((current) => ({ ...current, [key]: value }));
    if (!api) return;
    pendingGlobalPatch.current = { ...pendingGlobalPatch.current, [key]: value };
    if (debounce.current !== undefined) window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(() => {
      const patch = pendingGlobalPatch.current;
      pendingGlobalPatch.current = {};
      void api.channelsSaveConfig(patch).then(() => setFeedback(t("settingsPage.channels.saved"))).catch(() => setFeedback(t("settingsPage.saveFailed")));
    }, 250);
  }, [api, t]);

  const updateChannel = (id: ChannelId, key: string, value: unknown) => {
    setValues((current) => ({ ...current, [id]: { ...current[id], [key]: value } }));
  };

  const saveChannel = async (id: ChannelId, patch: ChannelConfig, restart = false) => {
    if (!api) return false;
    setBusy(id); setFeedback("");
    try {
      await api.channelsSaveConfig({ [id]: patch });
      if (restart) await api.channelsRestart();
      setValues((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
      setFeedback(t("settingsPage.channels.saved"));
      await refreshStatus();
      return true;
    } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.saveFailed")); return false; }
    finally { setBusy(""); }
  };

  const bindContext = async () => {
    if (!api || !sourceSession || !targetConversation) { setFeedback(t("settingsPage.channels.selectBoth")); return; }
    setBusy("binding");
    try {
      const result = await api.channelsContextBind({ sessionId: sourceSession, conversationId: targetConversation });
      if (!result.ok) throw new Error(result.error ?? t("settingsPage.channels.bindFailed"));
      setFeedback(t("settingsPage.channels.bound")); await refreshContext();
    } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.bindFailed")); }
    finally { setBusy(""); }
  };

  const unbindContext = async (sessionId: string) => {
    if (!api) return;
    setBusy(`unbind:${sessionId}`);
    try {
      const result = await api.channelsContextUnbind(sessionId);
      if (!result.ok) throw new Error(result.error ?? t("settingsPage.channels.unbindFailed"));
      setFeedback(t("settingsPage.channels.unbound")); await refreshContext();
    } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.unbindFailed")); }
    finally { setBusy(""); }
  };

  const clearLogs = () => Modal.confirm({
    title: t("settingsPage.channels.clearTitle"), content: t("settingsPage.channels.clearConfirm"),
    okText: t("settingsPage.channels.clear"), okButtonProps: { danger: true }, cancelText: t("settingsPage.channels.cancel"),
    onOk: async () => { if (!api) return; await api.channelsLogClear(); await refreshLogs(); },
  });

  const changeChannelSwitch = (id: ChannelId, checked: boolean) => {
    const patch = { enabled: checked };
    updateChannel(id, "enabled", checked);
    void saveChannel(id, patch);
  };

  const statusLabel = (status?: ChannelStatus) => status?.message || (status?.phase === "running" ? t("settingsPage.channels.running") : status?.phase === "starting" ? t("settingsPage.channels.starting") : status?.phase === "error" ? t("settingsPage.channels.error") : status?.phase === "config_missing" ? t("settingsPage.channels.configMissing") : t("settingsPage.channels.offline"));

  const renderChannelDialog = (id: ChannelId) => {
    const config = values[id];
    const enabled = Boolean(config.enabled);
    const title = channelName(t, id);
    return <Modal key={id} className="cy-settings-theme-modal cy-channels-dialog" open={dialog === id} title={title} onCancel={() => { setDialog(null); setQrCode(""); setFeedback(""); }} footer={null} destroyOnHidden>
      <div className="cy-channels-dialog__body">
        <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.enableChannel")}</strong><span>{statusLabel(statuses[id])}</span></div><SettingsSwitch ariaLabel={t("settingsPage.channels.enableChannel")} checked={enabled} onChange={(checked) => changeChannelSwitch(id, checked)} /></div>
        {id === "wechat" && <>
          <p className="cy-channels-hint">{t("settingsPage.channels.wechat.description")}</p>
          {qrCode && <div className="cy-channels-qr"><img src={qrCode} alt={t("settingsPage.channels.wechat.qrAlt")} /><Button onClick={() => setQrCode("")}>{t("settingsPage.channels.cancel")}</Button></div>}
          <div className="cy-channels-actions"><Button loading={busy === "wechat-login"} onClick={async () => { if (!api) return; setBusy("wechat-login"); setFeedback(t("settingsPage.channels.wechat.waitingQr")); try { const result = await api.channelsWechatLoginStart(); if (!result.ok) setFeedback(result.error ?? t("settingsPage.channels.wechat.loginFailed")); } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.wechat.loginFailed")); } finally { setBusy(""); } }}>{t("settingsPage.channels.wechat.login")}</Button><Button onClick={async () => { setBusy("wechat"); try { await api?.channelsRestart(); setFeedback(t("settingsPage.channels.wechat.restarted")); await refreshStatus(); } catch { setFeedback(t("settingsPage.channels.saveFailed")); } finally { setBusy(""); } }}>{t("settingsPage.channels.wechat.restart")}</Button></div>
        </>}
        {id === "feishu" && <>
          <p className="cy-channels-hint">{t("settingsPage.channels.feishu.description")}</p>
          <label className="cy-channels-field"><span>App ID</span><SettingsInput value={stringValue(config, "appId")} onChange={(event) => updateChannel(id, "appId", event.target.value)} /></label>
          <label className="cy-channels-field"><span>App Secret</span><SettingsPasswordInput value={secretDrafts.feishu} placeholder={config.hasAppSecret ? t("settingsPage.channels.secretSaved") : t("settingsPage.channels.secretPlaceholder")} autoComplete="new-password" showLabel={t("settingsPage.channels.showSecret")} hideLabel={t("settingsPage.channels.hideSecret")} onChange={(event) => setSecretDrafts((current) => ({ ...current, feishu: event.target.value }))} /></label>
          <div className="cy-channels-actions"><Button type="primary" loading={busy === "feishu"} onClick={() => { const patch = { enabled: Boolean(config.enabled), appId: stringValue(config, "appId").trim(), ...(secretDrafts.feishu ? { appSecret: secretDrafts.feishu } : {}) }; void saveChannel(id, patch, true).then((saved) => { if (saved) setSecretDrafts((current) => ({ ...current, feishu: "" })); }); }}>{t("settingsPage.channels.saveAndConnect")}</Button></div>
        </>}
        {id === "qq" && <>
          <p className="cy-channels-hint">{t("settingsPage.channels.qq.description")}</p>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.listenMode")}</span><SettingsSelect ariaLabel={t("settingsPage.channels.qq.listenMode")} value={String(config.listenMode ?? "auto")} onChange={(value) => updateChannel(id, "listenMode", value)} options={[{ value: "auto", label: t("settingsPage.channels.qq.auto") }, { value: "wsl", label: "WSL" }, { value: "loopback", label: "127.0.0.1" }, { value: "custom", label: t("settingsPage.channels.qq.custom") }]} /></label>
          {config.listenMode === "custom" && <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.customHost")}</span><SettingsInput value={stringValue(config, "customHost")} onChange={(event) => updateChannel(id, "customHost", event.target.value)} /></label>}
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.port")}</span><SettingsInput type="number" min={1} max={65535} value={String(config.port ?? 6200)} onChange={(event) => updateChannel(id, "port", Number(event.target.value))} /></label>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.accessToken")}</span><div className="cy-channels-token"><SettingsPasswordInput value={qqToken} placeholder={config.hasAccessToken ? t("settingsPage.channels.secretSaved") : t("settingsPage.channels.qq.tokenHint")} autoComplete="new-password" showLabel={t("settingsPage.channels.showSecret")} hideLabel={t("settingsPage.channels.hideSecret")} onChange={(event) => setQqToken(event.target.value)} /><Button onClick={() => setQqToken(Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""))}>{t("settingsPage.channels.qq.generate")}</Button><Button disabled={!qqToken} onClick={() => { void navigator.clipboard?.writeText(qqToken).then(() => setFeedback(t("settingsPage.channels.qq.tokenCopied"))); }}>{t("settingsPage.channels.copy")}</Button></div></label>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.privateAllowlist")}</span><Input.TextArea rows={2} value={listValue(config, "allowedPrivateUserIds")} onChange={(event) => updateChannel(id, "allowedPrivateUserIds", event.target.value)} /></label>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qq.groupAllowlist")}</span><Input.TextArea rows={2} value={listValue(config, "allowedGroupIds")} onChange={(event) => updateChannel(id, "allowedGroupIds", event.target.value)} /></label>
          <div className="cy-channels-actions"><Button loading={busy === "qq-test"} onClick={async () => { if (!api) return; setBusy("qq-test"); try { const result = await api.channelsQqTestConnection(); setFeedback(result.ok ? t("settingsPage.channels.testOk") : result.error ?? t("settingsPage.channels.testFailed")); } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.testFailed")); } finally { setBusy(""); } }}>{t("settingsPage.channels.testConnection")}</Button><Button type="primary" loading={busy === "qq"} onClick={async () => { if (!api) return; const listenMode = String(config.listenMode ?? "auto"); const customHost = stringValue(config, "customHost"); try { const requirement = await api.channelsQqResolveAuthRequirement({ listenMode, customHost }); if (!requirement.ok) { setFeedback(requirement.error ?? t("settingsPage.channels.qq.invalidHost")); return; } if (requirement.requiresAccessToken && !qqToken && !config.hasAccessToken) { const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, "0")).join(""); setQqToken(generated); setFeedback(t("settingsPage.channels.qq.copyTokenFirst", { host: requirement.resolvedHost })); return; } const patch = { enabled: Boolean(config.enabled), listenMode, customHost: customHost.trim() || undefined, port: Number(config.port) || 6200, allowedPrivateUserIds: typeof config.allowedPrivateUserIds === "string" ? splitList(config.allowedPrivateUserIds) : config.allowedPrivateUserIds, allowedGroupIds: typeof config.allowedGroupIds === "string" ? splitList(config.allowedGroupIds) : config.allowedGroupIds, ...(qqToken ? { accessToken: qqToken } : {}) }; const saved = await saveChannel(id, patch, true); if (saved) setQqToken(""); } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.saveFailed")); } }}>{t("settingsPage.channels.saveAndStart")}</Button></div>
        </>}
        {id === "qqbot" && <>
          <p className="cy-channels-hint">{t("settingsPage.channels.qqbot.description")}</p>
          <label className="cy-channels-field"><span>AppID</span><SettingsInput value={stringValue(config, "appId")} onChange={(event) => updateChannel(id, "appId", event.target.value)} /></label>
          <label className="cy-channels-field"><span>AppSecret</span><SettingsPasswordInput value={secretDrafts.qqbot} placeholder={config.hasAppSecret ? t("settingsPage.channels.secretSaved") : t("settingsPage.channels.secretPlaceholder")} autoComplete="new-password" showLabel={t("settingsPage.channels.showSecret")} hideLabel={t("settingsPage.channels.hideSecret")} onChange={(event) => setSecretDrafts((current) => ({ ...current, qqbot: event.target.value }))} /></label>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.qqbot.allowAnyPrivate")}</strong><span>{t("settingsPage.channels.qqbot.allowAnyHint")}</span></div><SettingsSwitch ariaLabel={t("settingsPage.channels.qqbot.allowAnyPrivate")} checked={Boolean(config.allowAnyPrivate)} onChange={(checked) => updateChannel(id, "allowAnyPrivate", checked)} /></div>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qqbot.userAllowlist")}</span><Input.TextArea rows={2} value={listValue(config, "allowedUserOpenids")} onChange={(event) => updateChannel(id, "allowedUserOpenids", event.target.value)} /></label>
          <label className="cy-channels-field"><span>{t("settingsPage.channels.qqbot.groupAllowlist")}</span><Input.TextArea rows={2} value={listValue(config, "allowedGroupOpenids")} onChange={(event) => updateChannel(id, "allowedGroupOpenids", event.target.value)} /></label>
          <div className="cy-channels-actions"><Button loading={busy === "qqbot-test"} onClick={async () => { if (!api) return; setBusy("qqbot-test"); try { const result = await api.channelsQqBotTestConnection(); setFeedback(result.ok ? t("settingsPage.channels.testOk") : result.error ?? t("settingsPage.channels.testFailed")); } catch (error) { setFeedback(error instanceof Error ? error.message : t("settingsPage.channels.testFailed")); } finally { setBusy(""); } }}>{t("settingsPage.channels.testConnection")}</Button><Button type="primary" loading={busy === "qqbot"} onClick={() => { const appId = stringValue(config, "appId").trim(); if (!appId) { setFeedback(t("settingsPage.channels.qqbot.missingAppId")); return; } const patch = { enabled: Boolean(config.enabled), appId, allowAnyPrivate: Boolean(config.allowAnyPrivate), allowedUserOpenids: typeof config.allowedUserOpenids === "string" ? splitList(config.allowedUserOpenids, true) : config.allowedUserOpenids, allowedGroupOpenids: typeof config.allowedGroupOpenids === "string" ? splitList(config.allowedGroupOpenids, true) : config.allowedGroupOpenids, ...(secretDrafts.qqbot ? { appSecret: secretDrafts.qqbot } : {}) }; void saveChannel(id, patch, true).then((saved) => { if (saved) setSecretDrafts((current) => ({ ...current, qqbot: "" })); }); }}>{t("settingsPage.channels.saveAndConnect")}</Button></div>
        </>}
        {feedback && <Alert className="cy-channels-feedback" type={/失败|错误|无法|请先/.test(feedback) ? "error" : "info"} showIcon message={feedback} />}
      </div>
    </Modal>;
  };

  return <>
    <h1>{t("settingsPage.channels.title")}</h1>
    <p className="cy-settings-intro">{t("settingsPage.channels.description")}</p>
    {feedback && !dialog && <Alert className="cy-settings-alert" type="info" showIcon message={feedback} />}
    {loading ? <div className="cy-settings-loading"><Spin /></div> : <>
      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Link2 size={18} />{t("settingsPage.channels.contextTitle")}</h2><p>{t("settingsPage.channels.contextDescription")}</p></div>
        <Card className="cy-channels-context">
          <div className="cy-channels-context__form">
            <label><span>{t("settingsPage.channels.externalChat")}</span><SettingsSelect ariaLabel={t("settingsPage.channels.externalChat")} placeholder={t("settingsPage.channels.noRecentChats")} value={sourceSession} disabled={!context.externalChats.length} onChange={setSourceSession} options={context.externalChats.length ? context.externalChats.map((chat) => ({ value: chat.sessionId, label: `${channelName(t, chat.channel)} · ${chat.chatType === "group" ? t("settingsPage.channels.groupChat") : t("settingsPage.channels.privateChat")} · ${chat.senderName || chat.chatId}` })) : [{ value: "__no_external_chats__", label: t("settingsPage.channels.noRecentChats"), disabled: true }]} /> </label>
            <label><span>{t("settingsPage.channels.desktopConversation")}</span><SettingsSelect ariaLabel={t("settingsPage.channels.desktopConversation")} placeholder={t("settingsPage.channels.noConversations")} value={targetConversation} disabled={!context.conversations.length} onChange={setTargetConversation} options={context.conversations.length ? context.conversations.map((item) => ({ value: item.id, label: `${item.title || t("settingsPage.channels.untitledConversation")} · ${item.mode}` })) : [{ value: "__no_conversations__", label: t("settingsPage.channels.noConversations"), disabled: true }]} /></label>
            <Button type="primary" loading={busy === "binding"} disabled={!context.externalChats.length || !context.conversations.length} onClick={() => void bindContext()}>{t("settingsPage.channels.bind")}</Button>
          </div>
          <div className="cy-channels-bindings">{context.bindings.length === 0 ? <span className="cy-channels-empty">{t("settingsPage.channels.noBindings")}</span> : context.bindings.map((binding) => {
            const chat = context.externalChats.find((item) => item.sessionId === binding.sessionId);
            const conversation = context.conversations.find((item) => item.id === binding.conversationId);
            return <div className="cy-channels-binding" key={binding.sessionId}><span>{channelName(t, chat?.channel ?? "")} · {chat?.senderName || chat?.chatId || binding.sessionId} → {conversation?.title || binding.conversationId}</span><Button type="text" size="small" loading={busy === `unbind:${binding.sessionId}`} icon={<Trash2 size={14} />} aria-label={t("settingsPage.channels.unbind")} onClick={() => void unbindContext(binding.sessionId)} /></div>;
          })}</div>
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Smartphone size={18} />{t("settingsPage.channels.providersTitle")}</h2><p>{t("settingsPage.channels.providersDescription")}</p></div>
        <div className="cy-channels-grid">{channelRows.map(({ id, status }) => <button key={id} type="button" className="cy-channels-provider" onClick={() => { setDialog(id); setFeedback(""); }}>
          <ChannelProviderIcon id={id} label={channelName(t, id)} />
          <span className="cy-channels-provider__copy"><strong>{channelName(t, id)}</strong><small>{t("settingsPage.channels.openSettings")}</small></span>
          <Tag className={`cy-channels-status cy-channels-status--${status?.phase === "running" ? "running" : status?.phase === "error" ? "error" : "offline"}`}>{statusLabel(status)}</Tag>
        </button>)}</div>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading"><h2><Activity size={18} />{t("settingsPage.channels.globalTitle")}</h2><p>{t("settingsPage.channels.globalDescription")}</p></div>
        <Card>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.rateUser")}</strong><span>{t("settingsPage.channels.rateUserHint")}</span></div><SettingsInput className="cy-channels-number" type="number" min={1} max={1000} value={String(values.rateLimitPerUser ?? 10)} onChange={(event) => updateGlobal("rateLimitPerUser", Number(event.target.value))} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.rateChannel")}</strong><span>{t("settingsPage.channels.rateChannelHint")}</span></div><SettingsInput className="cy-channels-number" type="number" min={1} max={10000} value={String(values.rateLimitPerChannel ?? 100)} onChange={(event) => updateGlobal("rateLimitPerChannel", Number(event.target.value))} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.sendTts")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.channels.sendTts")} checked={Boolean(values.ttsEnabled)} onChange={(checked) => updateGlobal("ttsEnabled", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.sendSticker")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.channels.sendSticker")} checked={Boolean(values.stickerEnabled)} onChange={(checked) => updateGlobal("stickerEnabled", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.mirrorDesktop")}</strong></div><SettingsSwitch ariaLabel={t("settingsPage.channels.mirrorDesktop")} checked={Boolean(values.mirrorToDesktop)} onChange={(checked) => updateGlobal("mirrorToDesktop", checked)} /></div>
          <div className="cy-settings-row"><div className="cy-settings-row__copy"><strong>{t("settingsPage.channels.toolPermission")}</strong><span>{t("settingsPage.channels.toolPermissionHint")}</span></div><div className="cy-settings-row__control cy-channels-global-select"><SettingsSelect ariaLabel={t("settingsPage.channels.toolPermission")} value={String(values.toolSandbox ?? "all")} onChange={(value) => updateGlobal("toolSandbox", value)} options={[{ value: "off", label: t("settingsPage.channels.toolsOff") }, { value: "all", label: t("settingsPage.channels.toolsAll") }]} /></div></div>
        </Card>
      </section>

      <section className="cy-settings-section">
        <div className="cy-settings-section__heading cy-channels-logs-heading"><div><h2><MessageSquareText size={18} />{t("settingsPage.channels.logsTitle")}</h2><p>{t("settingsPage.channels.logsDescription")}</p></div><Button type="text" aria-expanded={logsExpanded} aria-controls="cy-channels-logs-panel" onClick={() => setLogsExpanded((expanded) => !expanded)}>{logsExpanded ? t("settingsPage.channels.collapse") : t("settingsPage.channels.expand")}<ChevronDown className={logsExpanded ? "is-expanded" : ""} size={16} aria-hidden="true" /></Button></div>
        {logsExpanded && <Card className="cy-channels-logs-card" id="cy-channels-logs-panel">
          <div className="cy-channels-logs__toolbar"><span>{t("settingsPage.channels.logsCount", { count: logs.length })}</span><div><Button size="small" onClick={() => void refreshLogs()}>{t("settingsPage.channels.refresh")}</Button><Button size="small" danger onClick={clearLogs}>{t("settingsPage.channels.clear")}</Button></div></div>
          <div className="cy-channels-logs" role="list">{logs.length === 0 ? <div className="cy-channels-empty">{t("settingsPage.channels.noMessages")}</div> : logs.map((entry, index) => <article className={`cy-channels-log cy-channels-log--${entry.dir}`} role="listitem" key={`${entry.at}-${entry.channel}-${entry.chatId}-${index}`}>
            <div className="cy-channels-log__meta"><Tag className="cy-channels-log__channel">{channelName(t, entry.channel)}</Tag><span>{entry.dir === "incoming" ? t("settingsPage.channels.received") : t("settingsPage.channels.replied")}</span><span>{entry.senderName || entry.senderId}</span><time>{new Date(entry.at).toLocaleTimeString()}</time></div>
            <div className="cy-channels-log__text">{entry.text.length > 280 ? `${entry.text.slice(0, 280)}…` : entry.text}{entry.hasAttachments && <small>{t("settingsPage.channels.hasAttachment")}</small>}</div>
          </article>)}</div>
        </Card>}
      </section>
    </>}
    {channelRows.map(({ id }) => renderChannelDialog(id))}
  </>;
}
