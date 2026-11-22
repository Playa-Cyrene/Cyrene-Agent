import { useEffect, useRef, useState } from "react";
import { Alert, Button, Checkbox, Input, Space, Spin } from "antd";
import type { QqModuleActionCommand, QqModuleActionResult, QqModuleConfigurationView } from "../../../../shared/qq-module-actions";
import { useTranslation } from "../../i18n";
import { createQqModuleInitialReader, runQqModuleAction } from "./qq-module-initial-read";

export function QqModuleConfigurationEditor({ action, onBusy, onClose, onSaved }: {
  action: (command: QqModuleActionCommand) => Promise<QqModuleActionResult>;
  onBusy(busy: boolean): void; onClose(): void; onSaved(): void;
}) {
  const [readInitial] = useState(createQqModuleInitialReader);
  const { t } = useTranslation(); const key = "settingsPage.channels.qqModule.configuration";
  const [view, setView] = useState<QqModuleConfigurationView>();
  const [account, setAccount] = useState(""), [host, setHost] = useState(""), [port, setPort] = useState("");
  const [privateIds, setPrivateIds] = useState(""), [groupIds, setGroupIds] = useState("");
  const [mention, setMention] = useState(true), [enabled, setEnabled] = useState(false), [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(""), [stale, setStale] = useState(false);
  const alive = useRef(false), sequence = useRef(0), locked = useRef(false);
  const populate = (next: QqModuleConfigurationView) => {
    setView(next); setAccount(next.config?.expectedSelfId ?? next.credentialAccountId ?? "");
    setHost(next.config?.listen.host ?? ""); setPort(next.config ? String(next.config.listen.port) : "");
    setPrivateIds(next.config?.allowedPrivateUserIds.join(", ") ?? ""); setGroupIds(next.config?.allowedGroupIds.join(", ") ?? "");
    setMention(next.config?.groupRequireMention ?? true); setEnabled(next.enabled); setStale(false);
  };
  const request = async (command: QqModuleActionCommand | "initialize") => {
    if (locked.current) return;
    locked.current = true; setBusy(true); onBusy(true); setMessage(""); const current = ++sequence.current;
    try {
      const result = await (command === "initialize" ? readInitial(action, "read-configuration") : runQqModuleAction(action, command));
      if (!alive.current || sequence.current !== current) return;
      if (!result.ok || !(result.state === "configuration" || result.state === "configuration-saved")) {
        setMessage(!result.ok && result.error === "stale" ? "stale" : "failed"); setStale(true); return;
      }
      populate(result.configuration);
      if (result.state === "configuration-saved") { setMessage("saved"); onSaved(); }
    } catch { if (alive.current && current === sequence.current) { setMessage("failed"); setStale(true); } }
    finally { if (alive.current && current === sequence.current) { locked.current = false; setBusy(false); onBusy(false); } }
  };
  useEffect(() => {
    alive.current = true; locked.current = false; setView(undefined); setStale(false);
    void request("initialize");
    return () => { alive.current = false; sequence.current++; onBusy(false); };
  }, [action]);
  const ids = (raw: string) => raw.split(/[\s,，]+/).filter(Boolean);
  // Only non-secret fields are editable. Host repeats the authoritative validation.
  const loopback = host === "::1" || /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host) && host.split(".").every(part => Number(part) <= 255);
  const valid = !!view && /^\d{1,128}$/.test(account) && loopback && /^\d+$/.test(port) && Number(port) >= 1 && Number(port) <= 65535
    && [...ids(privateIds), ...ids(groupIds)].every(value => /^\d{1,128}$/.test(value))
    && (!enabled || view.credentialAccountId === account);
  const save = () => { if (!valid || !view || busy || stale) return; void request({ action: "propose-configuration", expectedRevision: view.proposalRevision,
    config: { configRevision: (view.config?.configRevision ?? 0) + 1, expectedSelfId: account,
      listen: { host, port: Number(port) }, allowedPrivateUserIds: [...new Set(ids(privateIds))], allowedGroupIds: [...new Set(ids(groupIds))], groupRequireMention: mention }, enabled }); };
  return <section aria-label={t(`${key}.title`)}>
    <p>{t(`${key}.notice`)}</p>
    {message && <Alert role="status" type={message === "saved" ? "success" : "warning"} title={t(`${key}.${message}`)} />}
    {busy && <Spin />}
    {view && <Space orientation="vertical">
      {!view.credentialAccountId && <Alert type="warning" title={t(`${key}.credentialMissing`)} />}
      {enabled && view.credentialAccountId && view.credentialAccountId !== account && <Alert type="warning" title={t(`${key}.credentialMismatch`)} />}
      <Input aria-label={t(`${key}.account`)} placeholder={t(`${key}.account`)} value={account} disabled={busy} onChange={e => setAccount(e.target.value)} />
      <Input aria-label={t(`${key}.host`)} placeholder={t(`${key}.host`)} value={host} disabled={busy} onChange={e => setHost(e.target.value)} />
      <Input aria-label={t(`${key}.port`)} placeholder={t(`${key}.port`)} value={port} disabled={busy} onChange={e => setPort(e.target.value)} />
      <Input.TextArea aria-label={t(`${key}.privateIds`)} placeholder={t(`${key}.privateIds`)} value={privateIds} disabled={busy} onChange={e => setPrivateIds(e.target.value)} />
      <Input.TextArea aria-label={t(`${key}.groupIds`)} placeholder={t(`${key}.groupIds`)} value={groupIds} disabled={busy} onChange={e => setGroupIds(e.target.value)} />
      <Checkbox checked={mention} disabled={busy} onChange={e => setMention(e.target.checked)}>{t(`${key}.mention`)}</Checkbox>
      <Checkbox checked={enabled} disabled={busy} onChange={e => setEnabled(e.target.checked)}>{t(`${key}.enabled`)}</Checkbox>
      <Button disabled={!valid || busy || stale} onClick={save}>{t(`${key}.save`)}</Button>
    </Space>}
    <Space><Button disabled={busy} onClick={() => void request({ action: "read-configuration" })}>{t(`${key}.reload`)}</Button>
      <Button disabled={busy} onClick={onClose}>{t(`${key}.back`)}</Button></Space>
  </section>;
}
