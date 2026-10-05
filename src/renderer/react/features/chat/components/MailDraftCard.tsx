import { useEffect, useState } from "react";
import { Alert, Button, Input, Modal, Space } from "antd";
import { ChevronDown, ChevronUp, Clipboard, Paperclip, Send, Trash2, X } from "lucide-react";
import type { MailDraftCardData, MailDraftStatus } from "../../../../../shared/mail-draft-card";
import { useTranslation } from "../../../i18n";
import "./MailDraftCard.css";

const { TextArea } = Input;

export function MailDraftCard(props: {
  card: MailDraftCardData;
  conversationId?: string;
  messageId: string;
  onChange?: (messageId: string, card: MailDraftCardData) => void;
}) {
  const { t } = useTranslation();
  const [card, setCard] = useState(props.card);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setCard(props.card), [props.card]);

  function publish(next: MailDraftCardData) {
    setCard(next);
    props.onChange?.(props.messageId, next);
  }

  function update<K extends keyof MailDraftCardData>(key: K, value: MailDraftCardData[K]) {
    setCard((current) => ({ ...current, [key]: value }));
  }

  function splitAddresses(value: string): string[] {
    return value.split(/[,;\n]/).map((part) => part.trim()).filter(Boolean);
  }

  async function save() {
    if (!window.mailDrafts || busy) return;
    setBusy(true); setError("");
    try {
      const result = await window.mailDrafts.update(card);
      if (!result.ok || !result.card) throw new Error(result.error ?? "MAIL_DRAFT_SAVE_FAILED");
      publish(result.card);
    } catch { setError(t("mailDraft.saveFailed")); }
    finally { setBusy(false); }
  }

  async function addAttachments() {
    if (!window.mailDrafts || busy) return;
    setBusy(true); setError("");
    try {
      const result = await window.mailDrafts.pickAttachments();
      if (!result.ok) return;
      update("attachments", [...card.attachments, ...result.attachments].slice(0, 10));
    } catch { setError(t("mailDraft.attachmentFailed")); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!window.mailDrafts || busy || card.status !== "draft") return;
    setBusy(true); setError("");
    const sending = { ...card, status: "sending" as const };
    publish(sending);
    try {
      const result = await window.mailDrafts.send(card);
      const status: MailDraftStatus = result.status ?? (result.ok ? "sent" : "unknown");
      publish({ ...sending, status });
      if (!result.ok) setError(result.error ?? t("mailDraft.sendFailed"));
    } catch {
      publish({ ...sending, status: "unknown" });
      setError(t("mailDraft.sendUnknown"));
    } finally { setBusy(false); }
  }

  function confirmDelete() {
    Modal.confirm({
      title: t(card.provider === "gmail" ? "mailDraft.deleteGmailTitle" : "mailDraft.deleteTitle"),
      content: t(card.provider === "gmail" ? "mailDraft.deleteGmailWarning" : "mailDraft.deleteWarning"),
      okText: t("mailDraft.delete"), cancelText: t("mailDraft.cancel"), okButtonProps: { danger: true },
      onOk: async () => {
        if (!window.mailDrafts) return;
        setBusy(true); setError("");
        try {
          const result = await window.mailDrafts.delete(card);
          if (!result.ok) throw new Error(result.error);
          publish({ ...card, status: "deleted" });
        } catch { setError(t("mailDraft.deleteFailed")); }
        finally { setBusy(false); }
      },
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText([
        `To: ${card.to.join(", ")}`,
        card.cc.length ? `Cc: ${card.cc.join(", ")}` : "",
        `Subject: ${card.subject}`,
        "",
        card.bodyMarkdown,
      ].filter(Boolean).join("\n"));
    } catch { setError(t("mailDraft.copyFailed")); }
  }

  const locked = busy || card.status !== "draft";
  return <section className="cy-mail-draft" aria-label={t("mailDraft.title")}>
    <header className="cy-mail-draft__header">
      <strong>{t("mailDraft.title")}</strong>
      <span className={`cy-mail-draft__status is-${card.status}`}>{t(`mailDraft.status.${card.status}`)}</span>
      <Space size={4}>
        <Button type="text" size="small" icon={<Clipboard size={15} />} aria-label={t("mailDraft.copy")} onClick={() => void copy()} />
        <Button type="text" size="small" icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />} aria-label={t(expanded ? "mailDraft.collapse" : "mailDraft.expand")} onClick={() => setExpanded((value) => !value)} />
        {card.status === "draft" && <Button type="text" danger size="small" icon={<Trash2 size={15} />} aria-label={t("mailDraft.delete")} onClick={confirmDelete} />}
      </Space>
    </header>
    <div className="cy-mail-draft__identity"><span>{t("mailDraft.from")}</span><span>{card.from || t("mailDraft.senderUnavailable")}</span></div>
    <label className="cy-mail-draft__field"><span>{t("mailDraft.to")}</span><Input disabled={locked} value={card.to.join(", ")} onChange={(event) => update("to", splitAddresses(event.target.value))} /></label>
    {expanded && <>
      <label className="cy-mail-draft__field"><span>{t("mailDraft.cc")}</span><Input disabled={locked} value={card.cc.join(", ")} onChange={(event) => update("cc", splitAddresses(event.target.value))} /></label>
      <label className="cy-mail-draft__field"><span>{t("mailDraft.bcc")}</span><Input disabled={locked} value={card.bcc.join(", ")} onChange={(event) => update("bcc", splitAddresses(event.target.value))} /></label>
    </>}
    <label className="cy-mail-draft__field"><span>{t("mailDraft.subject")}</span><Input disabled={locked} value={card.subject} onChange={(event) => update("subject", event.target.value)} /></label>
    <TextArea className="cy-mail-draft__body" disabled={locked} autoSize={{ minRows: expanded ? 8 : 4, maxRows: 24 }} value={card.bodyMarkdown} onChange={(event) => update("bodyMarkdown", event.target.value)} />
    {card.attachments.length > 0 && <ul className="cy-mail-draft__attachments">{card.attachments.map((attachment) => <li key={attachment.id}><span>{attachment.name}</span><span>{Math.max(1, Math.round(attachment.size / 1024))} KB</span>{card.status === "draft" && <Button type="text" danger size="small" icon={<X size={14} />} aria-label={t("mailDraft.removeAttachment")} disabled={busy} onClick={() => update("attachments", card.attachments.filter((item) => item.id !== attachment.id))} />}</li>)}</ul>}
    {error && <Alert type="error" showIcon message={error} />}
    <footer className="cy-mail-draft__actions">
      {card.status === "draft" && <>
        <Button size="small" icon={<Paperclip size={14} />} disabled={busy || card.attachments.length >= 10} onClick={() => void addAttachments()}>{t("mailDraft.attach")}</Button>
        <Button size="small" disabled={busy} onClick={() => void save()}>{t("mailDraft.save")}</Button>
        <Button type="primary" size="small" icon={<Send size={14} />} loading={busy} onClick={() => void send()}>{t("mailDraft.send")}</Button>
      </>}
      {card.status === "unknown" && <span className="cy-mail-draft__hint">
        {t(card.provider === "gmail" ? "mailDraft.checkSent" : "mailDraft.checkSmtpSent")}
        {card.provider === "gmail" && <Button type="link" size="small" onClick={() => void window.system?.openExternal("https://mail.google.com/mail/u/0/#sent")}>{t("mailDraft.openSent")}</Button>}
      </span>}
      {card.status === "reconnect_required" && <Button type="link" size="small" onClick={() => void window.settings?.openSection?.("email")}>{t("mailDraft.reconnect")}</Button>}
    </footer>
  </section>;
}
