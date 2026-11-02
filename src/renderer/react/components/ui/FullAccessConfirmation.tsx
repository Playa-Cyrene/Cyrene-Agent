import { useEffect, useRef, useState } from "react";
import { Alert, Button, Modal } from "antd";
import { ShieldAlert } from "lucide-react";
import { useTranslation } from "../../i18n";
import { DisclaimerSettingsPanel } from "../../features/settings/DisclaimerSettingsPanel";

interface Props {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<boolean>;
}

/** 每次重新打开都创建新的确认会话，不能沿用上次倒计时或未提交的授权。 */
export function FullAccessConfirmation(props: Props) {
  return props.open ? <ConfirmationSession {...props} /> : null;
}

function ConfirmationSession({ onCancel, onConfirm }: Props) {
  const { t } = useTranslation();
  const [seconds, setSeconds] = useState(5);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [termsOpen, setTermsOpen] = useState(false);
  const pending = useRef(false);
  const cancelled = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (seconds <= 0) return;
    const timer = window.setTimeout(() => setSeconds(value => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [seconds]);

  const cancel = () => {
    // 已提交的 IPC 不能撤销，保存期间禁止伪装成“取消了授权”。
    if (!pending.current) {
      cancelled.current = true;
      onCancel();
    }
  };
  async function confirmFullAccess() {
    if (seconds > 0 || pending.current || cancelled.current || termsOpen) return;
    pending.current = true;
    setSaving(true);
    setFailed(false);
    try {
      const ok = await onConfirm();
      if (!mounted.current) return;
      if (ok) onCancel();
      else setFailed(true);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  return <>
    <Modal title={<><ShieldAlert size={18} /> {t("settingsPage.tools.fullAccessTitle")}</>}
      open onCancel={cancel} onOk={() => void confirmFullAccess()} closable={!saving} keyboard={!saving && !termsOpen}
      maskClosable={!saving && !termsOpen} confirmLoading={saving} cancelButtonProps={{ disabled: saving, autoFocus: true }}
      okButtonProps={{ disabled: seconds > 0 || saving, danger: true }}
      okText={seconds > 0 ? t("settingsPage.tools.fullAccessWait", { count: seconds }) : t("settingsPage.tools.fullAccessConfirm")}
      cancelText={t("settingsPage.tools.fullAccessCancel")} destroyOnHidden>
      <p>{t("settingsPage.tools.fullAccessWarning")}</p>
      <p>{t("settingsPage.tools.fullAccessPrecaution")}</p>
      <Button type="link" disabled={saving} onClick={() => setTermsOpen(true)}>{t("settingsPage.tools.fullAccessTerms")}</Button>
      {failed && <Alert role="alert" type="error" showIcon message={t("settingsPage.saveFailed")} />}
    </Modal>
    <Modal open={termsOpen} title={t("settingsPage.disclaimer.heading")} onCancel={() => setTermsOpen(false)}
      footer={null} width={800} destroyOnHidden>
      <div style={{ maxHeight: "65vh", overflowY: "auto" }}><DisclaimerSettingsPanel /></div>
    </Modal>
  </>;
}
