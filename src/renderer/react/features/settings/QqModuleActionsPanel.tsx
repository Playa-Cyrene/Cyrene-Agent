import { useEffect, useRef, useState } from "react";
import { Alert, Button, Input, Space } from "antd";
import type { QqModuleActionCommand, QqModuleActionResult } from "../../../../shared/qq-module-actions";
import { useTranslation } from "../../i18n";
type Preview = Extract<QqModuleActionResult, { preview: unknown }>;
export function QqModuleActionsPanel({ action, onBusy, onReady }: {
  action: (command: QqModuleActionCommand) => Promise<QqModuleActionResult>;
  onBusy: (busy: boolean) => void; onReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation(); const key = "settingsPage.channels.qqModule.actions";
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [result, setResult] = useState(""), [account, setAccount] = useState("");
  const [mode, setMode] = useState("ready");
  const [preview, setPreview] = useState<Preview>();
  const alive = useRef(false), pending = useRef<Preview | undefined>(undefined), locked = useRef(false), generation = useRef(0);
  const cancelQuietly = (p?: Preview) => { if (p) void action({ action: "cancel", operationId: p.preview.operationId }).catch(() => {}); };
  useEffect(() => {
    alive.current = true; const gen = ++generation.current;
    setReady(false); onReady(false);
    void action({ action: "status" }).then(r => {
      if (!alive.current || gen !== generation.current) return;
      const available = r.ok && ["ready", "committed", "recovery-required", "disabled"].includes(r.state);
      setReady(available); onReady(available);
      if (available && r.ok) { setMode(r.state); if (r.state !== "ready") setResult(r.state); return; }
      if (!(r.ok === false && r.error === "unconfigured")) setResult("failed");
    }, () => { if (alive.current && gen === generation.current) setResult("failed"); });
    return () => { alive.current = false; generation.current++; cancelQuietly(pending.current); pending.current = undefined; onBusy(false); onReady(false); };
  }, [action]);
  const run = async (command: QqModuleActionCommand) => {
    if (locked.current || !ready) return;
    locked.current = true; setBusy(true); onBusy(true); setResult(""); const gen = generation.current;
    // A confirm consumes consent; closing elsewhere must not pretend to cancel it.
    if (command.action.startsWith("confirm-") || command.action === "cancel") { pending.current = undefined; setPreview(undefined); }
    try {
      const r = await action(command);
      if (!alive.current || gen !== generation.current) { if (r.ok && "preview" in r) cancelQuietly(r); return; }
      if (!r.ok) { setResult(r.error === "recovery-required" ? "recovery-required" : "failed"); setReady(false); return; }
      if ("preview" in r) {
        if (!r.preview.operationId || !/^pkg-[a-f0-9]{64}$/.test(r.preview.packageId)
          || (r.state !== "preview-install" && !/^\d+$/.test(r.preview.accountId ?? ""))
          || (r.state === "preview-reconfigure" && (typeof r.preview.desiredEnabled !== "boolean" || !Array.isArray(r.preview.changes)
            || !r.preview.changes.every(change => ["allowlist", "enabled", "account", "credential", "listen", "configuration"].includes(change))))) { setResult("failed"); return; }
        pending.current = r; setPreview(r); setAccount("");
      } else {
        setResult(r.state);
        if (["committed", "recovery-required", "disabled"].includes(r.state)) { setMode(r.state); onReady(true); }
        if (r.state === "rolled-back") { setReady(false); onReady(true); }
      }
    } catch { if (alive.current && gen === generation.current) setResult("failed"); }
    finally { locked.current = false; if (alive.current && gen === generation.current) { setBusy(false); onBusy(false); } }
  };
  if (!ready && !result) return null;
  const confirm = () => {
    if (!preview) return;
    const operationId = preview.preview.operationId;
    if (preview.state === "preview-install") void run({ action: "confirm-install", operationId, userConfirmed: true });
    else void run({ action: preview.state === "preview-migration" ? "confirm-migration" : preview.state === "preview-recovery" ? "confirm-recovery" : preview.state === "preview-reconfigure" ? "confirm-reconfigure" : "confirm-setup", operationId, accountId: account, userConfirmed: true });
  };
  return <div aria-label={t(`${key}.title`)}>
    <p>{t(`${key}.separation`)}</p>
    {result && <Alert role="status" type={result === "committed" || result === "installed" ? "success" : "warning"} title={t(`${key}.${["installed", "committed", "cancelled", "rolled-back", "recovery-required", "disabled"].includes(result) ? result : "failed"}`)} />}
    {preview ? <>
      <p>{t(`${key}.${preview.state}`)} {preview.preview.version ?? ""}</p>
      {preview.state === "preview-reconfigure" && <><p>{t(`${key}.${preview.preview.desiredEnabled ? "willEnable" : "willDisable"}`)}</p><ul>{preview.preview.changes?.map(change => <li key={change}>{t(`${key}.change-${change}`)}</li>)}</ul></>}
      {preview.preview.accountId && <><p>{t(`${key}.accountConfirm`)} {preview.preview.accountId}</p><Input aria-label={t(`${key}.accountConfirm`)} value={account} disabled={busy} onChange={e => setAccount(e.target.value)} /></>}
      <Space><Button disabled={busy || (preview.state !== "preview-install" && account !== preview.preview.accountId)} onClick={confirm}>{t(`${key}.confirm`)}</Button>
      <Button disabled={busy} onClick={() => void run({ action: "cancel", operationId: preview.preview.operationId })}>{t(`${key}.cancel`)}</Button></Space>
    </> : ready && <Space orientation="vertical">
      {mode === "recovery-required" && <Button disabled={busy} onClick={() => void run({ action: "preview-recovery" })}>{t(`${key}.recover`)}</Button>}
      {["committed", "disabled", "recovery-required"].includes(mode) && <Button disabled={busy} onClick={() => void run({ action: "preview-reconfigure" })}>{t(`${key}.reconfigure`)}</Button>}
      {mode === "ready" && <>
      <Button disabled={busy} onClick={() => void run({ action: "preview-install" })}>{t(`${key}.install`)}</Button>
      <Button disabled={busy} onClick={() => void run({ action: "preview-migration" })}>{t(`${key}.migrate`)}</Button>
      <Input aria-label={t(`${key}.account`)} placeholder={t(`${key}.account`)} value={account} disabled={busy} onChange={e => setAccount(e.target.value)} />
      <Button disabled={busy || !/^\d+$/.test(account)} onClick={() => void run({ action: "preview-setup", accountId: account })}>{t(`${key}.setup`)}</Button>
      </>}
    </Space>}
  </div>;
}
