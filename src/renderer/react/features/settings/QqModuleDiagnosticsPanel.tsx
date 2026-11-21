import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import type { QqModuleActionCommand, QqModuleActionResult } from "../../../../shared/qq-module-actions";
import { validateQqLifecycleDiagnostics, type QqLifecycleDiagnostics } from "../../../../shared/qq-module-diagnostics";
import { useTranslation } from "../../i18n";
/** Read-only, explicit request. Never presents a clear-lock or reset action. */
export function QqModuleDiagnosticsPanel({ action, disabled, onBusy }: { onBusy?: (busy: boolean) => void; action: (command: QqModuleActionCommand) => Promise<QqModuleActionResult>; disabled: boolean }) {
  const { t } = useTranslation(), key = "settingsPage.channels.qqModule.diagnostics";
  const [report, setReport] = useState<QqLifecycleDiagnostics>(), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
  const generation = useRef(0), locked = useRef(false);
  useEffect(() => { generation.current++; locked.current = false; setBusy(false); setReport(undefined); setFailed(false); return () => { generation.current++; if (locked.current) { locked.current = false; onBusy?.(false); } }; }, [action]);
  const read = async () => {
    if (disabled || locked.current) return;
    locked.current = true; setBusy(true); onBusy?.(true); setFailed(false); setReport(undefined); const gen = generation.current;
    try {
      const result = await action({ action: "read-diagnostics" });
      if (gen !== generation.current) return;
      if (result.ok && result.state === "diagnostics" && validateQqLifecycleDiagnostics(result.diagnostics)) setReport(result.diagnostics);
      else setFailed(true);
    } catch { if (gen === generation.current) setFailed(true); }
    finally { if (gen === generation.current) { locked.current = false; setBusy(false); onBusy?.(false); } }
  };
  return <section aria-label={t(`${key}.title`)}>
    <Button disabled={disabled || busy} onClick={() => void read()}>{t(`${key}.read`)}</Button>
    {failed && <Alert role="status" type="warning" title={t(`${key}.failed`)} />}
    {report && <><Alert role="status" type="info" title={t(`${key}.notice`)} />
      <ul>{Object.entries(report.stores).map(([name, value]) => <li key={name}>{t(`${key}.store-${name}`)}: {t(`${key}.status-${value.status}`)}</li>)}</ul>
      <p>{t(`${key}.manual`)}</p></>}
  </section>;
}
