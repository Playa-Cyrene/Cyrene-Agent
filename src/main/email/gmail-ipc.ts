import { dialog } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { GmailAccountStatus } from "../../shared/gmail-types";
import { normalizeMailDraftCardData, type MailAttachmentRef, type MailDraftCardData } from "../../shared/mail-draft-card";
import type { IpcScope } from "../application/ipc-scope";
import { GmailAuthService } from "./gmail-auth-service";
import { GmailService } from "./gmail-service";
import { MailAttachmentStore } from "./mail-attachment-store";
import { getSmtpSenderIdentity, sendSmtpMail } from "../orchestrator/tools/email-tools";

function draftInput(card: MailDraftCardData) {
  return {
    to: card.to, cc: card.cc, bcc: card.bcc, subject: card.subject,
    bodyMarkdown: card.bodyMarkdown, attachmentRefs: card.attachments,
  };
}

function draftCard(card: MailDraftCardData, draft: Awaited<ReturnType<GmailService["updateDraft"]>>, from: string): MailDraftCardData {
  return {
    ...card,
    gmailDraftId: draft.id,
    from,
    to: draft.message.to,
    cc: draft.message.cc,
    bcc: draft.message.bcc,
    subject: draft.message.subject,
    bodyMarkdown: card.bodyMarkdown,
    attachments: draft.message.attachments,
    status: "draft",
  };
}

function validFlowId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{24,100}$/.test(value);
}

async function status(auth: GmailAuthService, service: GmailService): Promise<GmailAccountStatus> {
  const state = await auth.getStatus();
  if (state !== "connected") return { state };
  try {
    const profile = await service.getProfile();
    return { state, emailAddress: profile.emailAddress };
  } catch {
    // A temporary profile lookup failure must not discard a valid local OAuth state.
    return { state };
  }
}

export function registerGmailIpc(input: {
  ipc: IpcScope;
  auth: GmailAuthService;
  service: GmailService;
  attachmentStore: MailAttachmentStore;
}): void {
  const { ipc, auth, service, attachmentStore } = input;
  ipc.handle(IPC.GMAIL_GET_STATUS, () => status(auth, service));
  ipc.handle(IPC.GMAIL_BEGIN_AUTHORIZATION, () => auth.startAuthorization());
  ipc.handle(IPC.GMAIL_WAIT_AUTHORIZATION, async (_event, flowId: unknown) => {
    if (!validFlowId(flowId)) return { state: "disconnected" } satisfies GmailAccountStatus;
    await auth.waitForAuthorization(flowId);
    return status(auth, service);
  });
  ipc.handle(IPC.GMAIL_CANCEL_AUTHORIZATION, async (_event, flowId: unknown) => {
    if (validFlowId(flowId)) await auth.cancelAuthorization(flowId);
    return status(auth, service);
  });
  ipc.handle(IPC.GMAIL_DISCONNECT, async () => {
    await auth.disconnect();
    return { state: "disconnected" } satisfies GmailAccountStatus;
  });
  ipc.handle(IPC.GMAIL_PICK_ATTACHMENTS, async () => {
    const result = await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"] });
    if (result.canceled) return { ok: false, attachments: [] as MailAttachmentRef[] };
    try { return { ok: true, attachments: await attachmentStore.issue(result.filePaths) }; }
    catch { return { ok: false, attachments: [] as MailAttachmentRef[] }; }
  });
  ipc.handle(IPC.MAIL_DRAFT_UPDATE, async (_event, value: unknown) => {
    const card = normalizeMailDraftCardData(value);
    const isReconnectCheck = card?.provider === "gmail" && card.status === "reconnect_required";
    if (!card || (card.status !== "draft" && !isReconnectCheck)) return { ok: false, error: "邮件草稿数据无效或当前状态不可编辑。" };
    const draftCardInput = isReconnectCheck ? { ...card, status: "draft" as const } : card;
    if (card.provider === "smtp") {
      const updated = normalizeMailDraftCardData({ ...card, from: getSmtpSenderIdentity() ?? "" });
      return updated ? { ok: true, card: updated } : { ok: false, error: "SMTP 发件身份不可用。" };
    }
    try {
      const draft = await service.updateDraft(draftCardInput.gmailDraftId!, draftInput(draftCardInput));
      const profile = await service.getProfile();
      return { ok: true, card: draftCard(draftCardInput, draft, profile.emailAddress) };
    } catch {
      return { ok: false, error: "无法保存 Gmail 草稿，请检查连接和草稿状态。" };
    }
  });
  ipc.handle(IPC.MAIL_DRAFT_DELETE, async (_event, value: unknown) => {
    const card = normalizeMailDraftCardData(value);
    if (!card || card.status !== "draft") return { ok: false, error: "邮件草稿数据无效或当前状态不可删除。" };
    if (card.provider === "gmail") {
      try { await service.deleteDraft(card.gmailDraftId!); }
      catch { return { ok: false, error: "无法删除 Gmail 草稿，请检查连接或草稿状态。" }; }
    }
    return { ok: true, status: "deleted" as const };
  });
  ipc.handle(IPC.MAIL_DRAFT_SEND, async (_event, value: unknown) => {
    const card = normalizeMailDraftCardData(value);
    if (!card || card.status !== "draft" || card.to.length === 0 || !card.subject.trim() || !card.bodyMarkdown.trim()) {
      return { ok: false, status: "draft" as const, error: "请填写收件人、主题和正文。" };
    }
    if (card.provider === "smtp") {
      const currentSender = getSmtpSenderIdentity() ?? "";
      if (currentSender.trim().toLowerCase() !== card.from.trim().toLowerCase()) {
        const updatedCard = normalizeMailDraftCardData({ ...card, from: currentSender });
        return {
          ok: false,
          status: "draft" as const,
          ...(updatedCard ? { card: updatedCard } : {}),
          error: "SMTP 发件账号已变化。请核对更新后的发件身份，再点击发送。",
        };
      }
      try {
        const attachments: Array<{ filename: string; contentType: string; content: Buffer }> = [];
        let attachmentBytes = 0;
        for (const attachment of card.attachments) {
          const resolved = await attachmentStore.resolve(attachment);
          attachmentBytes += resolved.content.byteLength;
          if (attachmentBytes > 25 * 1024 * 1024) return { ok: false, status: "draft" as const, error: "附件总大小不能超过 25 MB。" };
          attachments.push({ filename: resolved.filename, contentType: resolved.contentType, content: resolved.content });
        }
        const result = await sendSmtpMail({ to: card.to, cc: card.cc, bcc: card.bcc, subject: card.subject, body: card.bodyMarkdown, bodyIsMarkdown: true, attachments });
        return result.status === "sent"
          ? { ok: true, status: "sent" as const }
          : { ok: false, status: result.status === "unknown" ? "unknown" as const : "draft" as const, error: result.status === "unknown" ? "SMTP 发送结果未知，请先查看已发送邮件。" : "SMTP 未启用或配置不完整。" };
      } catch {
        return { ok: false, status: "draft" as const, error: "附件已失效，请重新选择文件。" };
      }
    }
    let updated: Awaited<ReturnType<GmailService["updateDraft"]>>;
    try {
      updated = await service.updateDraft(card.gmailDraftId!, draftInput(card));
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (["not_connected", "reauthorization_required"].includes(code)) return { ok: false, status: "reconnect_required" as const, error: "Gmail 授权失效，请重新连接。" };
      return { ok: false, status: "draft" as const, error: "Gmail 草稿尚未发送，保存失败后可以重试。" };
    }
    try {
      await service.sendDraft(updated.id);
      return { ok: true, status: "sent" as const };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code) : "";
      if (["not_connected", "reauthorization_required"].includes(code)) return { ok: false, status: "reconnect_required" as const, error: "Gmail 授权失效，请重新连接。" };
      if (["network_error", "unknown"].includes(code)) return { ok: false, status: "unknown" as const, error: "Gmail 发送结果未知。先查看已发送邮件，不要立即重发。" };
      return { ok: false, status: "draft" as const, error: "Gmail 草稿未发送，请检查连接或邮件内容。" };
    }
  });
}
