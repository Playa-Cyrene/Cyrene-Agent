import { gmail, type gmail_v1 } from "@googleapis/gmail";
import nodemailer from "nodemailer";
import type { GmailErrorCode } from "../../shared/gmail-types";
import { GmailAuthService } from "./gmail-auth-service";
import { htmlToPlainText, markdownToEmailHtml } from "./gmail-html";
import {
  collectAttachmentRefs,
  gmailDraftSummary,
  MAX_GMAIL_ATTACHMENT_BYTES,
  toGmailMessage,
  toGmailSummary,
  type GmailAttachmentRef,
  type GmailDraft,
  type GmailDraftInput,
  type GmailDraftSummary,
  type GmailLabel,
  type GmailMessage,
  type GmailMessageAction,
  type GmailSearchPage,
  type GmailSendResult,
  type GmailThread,
} from "./gmail-message";

const USER_ID = "me";
const MAX_QUERY_LENGTH = 2048;
const MAX_MESSAGE_LENGTH = 200_000;
const MAX_ATTACHMENT_COUNT = 10;
const MAX_THREAD_MESSAGES = 20;
const MAX_THREAD_MESSAGE_BODY_BYTES = 256 * 1024;

interface ResolvedGmailAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
}

export type GmailAttachmentResolver = (reference: GmailAttachmentRef) => Promise<ResolvedGmailAttachment>;

export interface GmailServiceOptions {
  resolveAttachment?: GmailAttachmentResolver;
}

type GmailApi = gmail_v1.Gmail;

export class GmailServiceError extends Error {
  constructor(readonly code: GmailErrorCode, message = messageForCode(code)) {
    super(message);
    this.name = "GmailServiceError";
  }
}

function messageForCode(code: GmailErrorCode): string {
  switch (code) {
    case "not_configured": return "Gmail 尚未配置 OAuth 客户端。";
    case "safe_storage_unavailable": return "系统安全存储不可用，无法安全保存 Gmail 凭据。";
    case "not_connected": return "请先连接 Gmail 账号。";
    case "reauthorization_required": return "Gmail 授权已失效，请重新连接。";
    case "message_not_found": return "找不到这封邮件。";
    case "draft_not_found": return "找不到这封草稿，可能已被删除或发送。";
    case "rate_limited": return "Gmail 请求过于频繁，请稍后再试。";
    case "network_error": return "无法连接 Gmail，请检查网络后重试。";
    case "invalid_request": return "Gmail 拒绝了这项操作，请检查邮件内容或参数。";
    case "authorization_cancelled": return "Gmail 授权已取消。";
    case "authorization_failed": return "Gmail 授权失败。";
    case "authorization_timeout": return "Gmail 授权超时，请重试。";
    case "insufficient_scope": return "Gmail 授权范围不足，请重新连接。";
    default: return "Gmail 操作失败，请重试。";
  }
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = error as { status?: unknown; code?: unknown; response?: { status?: unknown } };
  const status = Number(value.response?.status ?? value.status);
  return Number.isFinite(status) ? status : undefined;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const value = error as { code?: unknown; message?: unknown };
  if (typeof value.code === "string") return value.code;
  return typeof value.message === "string" ? value.message : "";
}

function mapGmailError(error: unknown, notFoundCode: "message_not_found" | "draft_not_found" = "message_not_found"): GmailServiceError {
  if (error instanceof GmailServiceError) return error;
  const code = errorCode(error);
  if (code === "GMAIL_NOT_CONFIGURED") return new GmailServiceError("not_configured");
  if (code === "GMAIL_SAFE_STORAGE_UNAVAILABLE") return new GmailServiceError("safe_storage_unavailable");
  if (code === "GMAIL_NOT_CONNECTED") return new GmailServiceError("not_connected");
  if (code === "GMAIL_REAUTH_REQUIRED") return new GmailServiceError("reauthorization_required");
  const status = errorStatus(error);
  if (status === 404) return new GmailServiceError(notFoundCode);
  if (status === 401) return new GmailServiceError("reauthorization_required");
  if (status === 429 || (status === 403 && /rate.?limit|quota/i.test(code))) return new GmailServiceError("rate_limited");
  if (status === 400 || status === 403) return new GmailServiceError("invalid_request");
  if (status === undefined || /ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(code)) return new GmailServiceError("network_error");
  return new GmailServiceError("unknown");
}

function validateId(value: string, field = "id"): string {
  const id = value.trim();
  if (!/^[\w-]{1,256}$/.test(id)) throw new GmailServiceError("invalid_request", `${field} 无效。`);
  return id;
}

function parseLabel(label: gmail_v1.Schema$Label): GmailLabel | null {
  if (!label.id || !label.name) return null;
  return {
    id: label.id,
    name: label.name,
    type: label.type === "system" ? "system" : "user",
    ...(typeof label.messagesTotal === "number" ? { messagesTotal: label.messagesTotal } : {}),
    ...(typeof label.messagesUnread === "number" ? { messagesUnread: label.messagesUnread } : {}),
  };
}

function partsOf(message: gmail_v1.Schema$Message): gmail_v1.Schema$MessagePart[] {
  const result: gmail_v1.Schema$MessagePart[] = [];
  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    result.push(part);
    for (const child of part.parts ?? []) visit(child);
  };
  if (message.payload) visit(message.payload);
  return result;
}

function getHeader(message: gmail_v1.Schema$Message, name: string): string {
  return message.payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function cleanHeader(value: string, maxLength = 998): string {
  return value.replace(/[\r\n\0]/g, " ").trim().slice(0, maxLength);
}

function cleanAddresses(values: string[] | undefined): string[] {
  const addresses = (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0);
  if (addresses.length > 100 || addresses.some((address) => address.length > 320 || /[\r\n\0]/.test(address))) {
    throw new GmailServiceError("invalid_request", "邮件地址无效或数量过多。");
  }
  return addresses;
}

function safeFilename(value: string): string {
  const filename = value.replace(/[\\/\r\n\0]/g, "_").trim().slice(0, 255);
  if (!filename) throw new GmailServiceError("invalid_request", "附件文件名无效。");
  return filename;
}

function toBuffer(base64Url: string | null | undefined): Buffer {
  return Buffer.from(base64Url ?? "", "base64url");
}

export class GmailService {
  constructor(
    private readonly authService: GmailAuthService,
    private readonly options: GmailServiceOptions = {},
  ) {}

  async getProfile(): Promise<{ emailAddress: string }> {
    try {
      const response = await this.call((api) => api.users.getProfile({ userId: USER_ID }));
      if (!response.emailAddress) throw new GmailServiceError("unknown");
      return { emailAddress: response.emailAddress.slice(0, 320) };
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async searchMessages(input: { query: string; pageToken?: string; pageSize?: number }): Promise<GmailSearchPage> {
    const query = input.query.trim();
    if (query.length > MAX_QUERY_LENGTH) throw new GmailServiceError("invalid_request", "Gmail 搜索条件过长。");
    const pageSize = Math.max(1, Math.min(50, Math.floor(input.pageSize ?? 25)));
    const pageToken = input.pageToken?.slice(0, 8192);
    try {
      const api = await this.getApi();
      const response = await api.users.messages.list({
        userId: USER_ID,
        q: query,
        maxResults: pageSize,
        ...(pageToken ? { pageToken } : {}),
      });
      const list = response.data;
      const summaries = await Promise.all((list.messages ?? []).flatMap((message) => {
        if (!message.id) return [];
        return [api.users.messages.get({
          userId: USER_ID,
          id: message.id!,
          format: "metadata",
          metadataHeaders: ["From", "To", "Subject", "Date"],
        }).then((item) => toGmailSummary(item.data))];
      }));
      return {
        messages: summaries,
        ...(list.nextPageToken ? { nextPageToken: list.nextPageToken } : {}),
        resultSizeEstimate: Math.max(0, list.resultSizeEstimate ?? summaries.length),
      };
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async getMessage(messageId: string): Promise<GmailMessage> {
    const id = validateId(messageId, "messageId");
    try {
      const response = await this.call((api) => api.users.messages.get({ userId: USER_ID, id, format: "full" }));
      return toGmailMessage(response);
    } catch (error) {
      throw mapGmailError(error, "message_not_found");
    }
  }

  async getThread(threadId: string): Promise<GmailThread> {
    const id = validateId(threadId, "threadId");
    try {
      const response = await this.call((api) => api.users.threads.get({ userId: USER_ID, id, format: "full" }));
      return {
        id: response.id ?? id,
        messages: (response.messages ?? []).slice(-MAX_THREAD_MESSAGES)
          .map((message) => toGmailMessage(message, MAX_THREAD_MESSAGE_BODY_BYTES)),
      };
    } catch (error) {
      throw mapGmailError(error, "message_not_found");
    }
  }

  async updateMessage(input: { messageId: string; action: GmailMessageAction }): Promise<void> {
    const id = validateId(input.messageId, "messageId");
    try {
      const api = await this.getApi();
      switch (input.action) {
        case "mark_read":
          await api.users.messages.modify({ userId: USER_ID, id, requestBody: { removeLabelIds: ["UNREAD"] } });
          break;
        case "mark_unread":
          await api.users.messages.modify({ userId: USER_ID, id, requestBody: { addLabelIds: ["UNREAD"] } });
          break;
        case "star":
          await api.users.messages.modify({ userId: USER_ID, id, requestBody: { addLabelIds: ["STARRED"] } });
          break;
        case "unstar":
          await api.users.messages.modify({ userId: USER_ID, id, requestBody: { removeLabelIds: ["STARRED"] } });
          break;
        case "archive":
          await api.users.messages.modify({ userId: USER_ID, id, requestBody: { removeLabelIds: ["INBOX"] } });
          break;
        case "trash":
          await api.users.messages.trash({ userId: USER_ID, id });
          break;
        case "restore":
          await api.users.messages.untrash({ userId: USER_ID, id });
          break;
        default:
          throw new GmailServiceError("invalid_request");
      }
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async listLabels(): Promise<GmailLabel[]> {
    try {
      const response = await this.call((api) => api.users.labels.list({ userId: USER_ID }));
      return (response.labels ?? []).map(parseLabel).filter((label): label is GmailLabel => label !== null);
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async createLabel(name: string): Promise<GmailLabel> {
    const safeName = this.validateLabelName(name);
    try {
      const response = await this.call((api) => api.users.labels.create({
        userId: USER_ID,
        requestBody: { name: safeName, labelListVisibility: "labelShow", messageListVisibility: "show" },
      }));
      const label = parseLabel(response);
      if (!label) throw new GmailServiceError("unknown");
      return label;
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async updateLabel(id: string, name: string): Promise<GmailLabel> {
    const labelId = validateId(id, "labelId");
    const safeName = this.validateLabelName(name);
    try {
      const response = await this.call((api) => api.users.labels.patch({
        userId: USER_ID,
        id: labelId,
        requestBody: { name: safeName },
      }));
      const label = parseLabel(response);
      if (!label) throw new GmailServiceError("unknown");
      return label;
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async deleteLabel(id: string): Promise<void> {
    const labelId = validateId(id, "labelId");
    try {
      await this.call((api) => api.users.labels.delete({ userId: USER_ID, id: labelId }));
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async updateMessageLabels(messageId: string, add: string[], remove: string[]): Promise<void> {
    const id = validateId(messageId, "messageId");
    const normalize = (values: string[]) => [...new Set(values.map((value) => validateId(value, "labelId")))].slice(0, 100);
    try {
      await this.call((api) => api.users.messages.modify({
        userId: USER_ID,
        id,
        requestBody: { addLabelIds: normalize(add), removeLabelIds: normalize(remove) },
      }));
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async listDrafts(): Promise<GmailDraftSummary[]> {
    try {
      const api = await this.getApi();
      const response = await api.users.drafts.list({ userId: USER_ID, maxResults: 100 });
      const drafts = await Promise.all((response.data.drafts ?? []).flatMap((draft) => {
        if (!draft.id) return [];
        return [api.users.drafts.get({ userId: USER_ID, id: draft.id!, format: "metadata" })
          .then((item) => gmailDraftSummary(item.data))];
      }));
      return drafts;
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  async getDraft(draftId: string): Promise<GmailDraft> {
    const id = validateId(draftId, "draftId");
    try {
      const draft = await this.getDraftResource(id);
      if (!draft.message) throw new GmailServiceError("draft_not_found");
      return { id: draft.id ?? id, message: toGmailMessage(draft.message) };
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  async createDraft(input: GmailDraftInput): Promise<GmailDraft> {
    return this.createDraftWithThreading(input);
  }

  async updateDraft(draftId: string, input: GmailDraftInput): Promise<GmailDraft> {
    const id = validateId(draftId, "draftId");
    const current = await this.getDraftResource(id);
    if (!current.message) throw new GmailServiceError("draft_not_found");
    let attachmentRefs = input.attachmentRefs;
    if (attachmentRefs === undefined) {
      attachmentRefs = collectAttachmentRefs(current.message.payload, current.message.id ?? "");
    }
    const threading = this.threadingFromDraft(current.message);
    const raw = await this.buildRawMessage({ ...input, attachmentRefs }, threading);
    try {
      const response = await this.call((api) => api.users.drafts.update({
        userId: USER_ID,
        id,
        requestBody: { id, message: { raw, ...(threading?.threadId ? { threadId: threading.threadId } : {}) } },
      }));
      return this.getDraft(response.id ?? id);
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  async deleteDraft(draftId: string): Promise<void> {
    const id = validateId(draftId, "draftId");
    try {
      await this.call((api) => api.users.drafts.delete({ userId: USER_ID, id }));
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  async sendDraft(draftId: string): Promise<GmailSendResult> {
    const id = validateId(draftId, "draftId");
    try {
      const response = await this.call((api) => api.users.drafts.send({ userId: USER_ID, requestBody: { id } }));
      if (!response.id) throw new GmailServiceError("unknown");
      return { messageId: response.id, threadId: response.threadId ?? "" };
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  async sendMessage(input: GmailDraftInput & { sourceMessageId?: string }): Promise<GmailSendResult> {
    const threading = input.sourceMessageId ? await this.threadingFor(input.sourceMessageId) : undefined;
    const raw = await this.buildRawMessage(input, threading);
    try {
      const response = await this.call((api) => api.users.messages.send({
        userId: USER_ID,
        requestBody: { raw, ...(threading?.threadId ? { threadId: threading.threadId } : {}) },
      }));
      if (!response.id) throw new GmailServiceError("unknown");
      return { messageId: response.id, threadId: response.threadId ?? "" };
    } catch (error) {
      throw mapGmailError(error);
    }
  }

  async createReplyDraft(messageId: string, input: GmailDraftInput): Promise<GmailDraft> {
    const source = await this.getMessageResource(messageId);
    const threading = this.threadingFrom(source);
    const sourceMessage = toGmailMessage(source);
    return this.createDraftWithThreading({
      ...input,
      to: input.to.length ? input.to : sourceMessage.from,
      subject: sourceMessage.subject,
    }, threading);
  }

  async createForwardDraft(messageId: string, input: GmailDraftInput): Promise<GmailDraft> {
    const source = await this.getMessageResource(messageId);
    const message = toGmailMessage(source);
    const forwardBlock = [
      "",
      "---------- Forwarded message ----------",
      `From: ${message.from.join(", ")}`,
      `Date: ${message.date}`,
      `Subject: ${message.subject}`,
      `To: ${message.to.join(", ")}`,
      "",
      message.textBody,
    ].filter((line) => line !== undefined).join("\n");
    const subject = /^fwd?:/i.test(input.subject) ? input.subject : `Fwd: ${message.subject}`;
    return this.createDraft({ ...input, subject, bodyMarkdown: `${input.bodyMarkdown}${forwardBlock}` });
  }

  async downloadAttachment(messageId: string, attachmentId: string): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
    const message = await this.getMessageResource(messageId);
    const partId = attachmentId.startsWith("gmail:")
      ? attachmentId.split(":").slice(2).join(":")
      : attachmentId;
    const part = partsOf(message).find((item) => item.partId === partId || item.body?.attachmentId === partId);
    if (!part?.filename || !partId) throw new GmailServiceError("invalid_request", "附件引用不属于这封邮件。");
    let bytes: Buffer;
    if (part.body?.data) {
      bytes = toBuffer(part.body.data);
    } else if (part.body?.attachmentId) {
      const attachment = await this.call((api) => api.users.messages.attachments.get({
        userId: USER_ID,
        messageId: validateId(messageId, "messageId"),
        id: part.body!.attachmentId!,
      }));
      bytes = toBuffer(attachment.data);
    } else {
      bytes = Buffer.alloc(0);
    }
    if (bytes.byteLength > MAX_GMAIL_ATTACHMENT_BYTES) {
      throw new GmailServiceError("invalid_request", "附件超过 25 MB，当前版本无法下载。");
    }
    return {
      filename: safeFilename(part.filename),
      mimeType: (part.mimeType || "application/octet-stream").slice(0, 128),
      bytes,
    };
  }

  private async createDraftWithThreading(input: GmailDraftInput, threading?: ThreadingHeaders): Promise<GmailDraft> {
    const raw = await this.buildRawMessage(input, threading);
    try {
      const response = await this.call((api) => api.users.drafts.create({
        userId: USER_ID,
        requestBody: { message: { raw, ...(threading?.threadId ? { threadId: threading.threadId } : {}) } },
      }));
      if (!response.id) throw new GmailServiceError("unknown");
      return this.getDraft(response.id);
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  private async buildRawMessage(input: GmailDraftInput, threading?: ThreadingHeaders): Promise<string> {
    const to = cleanAddresses(input.to);
    const cc = cleanAddresses(input.cc);
    const bcc = cleanAddresses(input.bcc);
    const subject = cleanHeader(input.subject);
    const bodyMarkdown = input.bodyMarkdown.slice(0, MAX_MESSAGE_LENGTH);
    const html = await markdownToEmailHtml(bodyMarkdown);
    const text = htmlToPlainText(html) || bodyMarkdown;
    const attachments = await this.resolveAttachments(input.attachmentRefs ?? []);
    const transporter = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });
    try {
      const info = await transporter.sendMail({
        to,
        cc,
        bcc,
        subject,
        text,
        html,
        ...(threading?.messageId ? { inReplyTo: threading.messageId } : {}),
        ...(threading?.references.length ? { references: threading.references } : {}),
        ...(attachments.length ? { attachments } : {}),
      });
      if (!Buffer.isBuffer(info.message)) throw new GmailServiceError("unknown");
      // Gmail expects the full RFC 2822 message in base64url form. The thread ID is sent separately.
      return info.message.toString("base64url");
    } finally {
      transporter.close();
    }
  }

  private async resolveAttachments(references: GmailAttachmentRef[]): Promise<ResolvedGmailAttachment[]> {
    if (references.length > MAX_ATTACHMENT_COUNT) throw new GmailServiceError("invalid_request", "一次最多附加 10 个文件。");
    let totalBytes = 0;
    const resolved: ResolvedGmailAttachment[] = [];
    for (const reference of references) {
      let attachment: ResolvedGmailAttachment;
      const remote = reference.id.match(/^gmail:([\w-]{1,256}):([\w.-]{1,256})$/);
      if (remote) {
        const downloaded = await this.downloadAttachment(remote[1], remote[2]);
        attachment = { filename: downloaded.filename, contentType: downloaded.mimeType, content: downloaded.bytes };
      } else {
        if (!this.options.resolveAttachment) throw new GmailServiceError("invalid_request", "附件已失效，请重新选择文件。");
        attachment = await this.options.resolveAttachment(reference);
      }
      if (!Buffer.isBuffer(attachment.content)) throw new GmailServiceError("invalid_request", "附件内容不可用。");
      totalBytes += attachment.content.byteLength;
      if (attachment.content.byteLength > MAX_GMAIL_ATTACHMENT_BYTES || totalBytes > MAX_GMAIL_ATTACHMENT_BYTES) {
        throw new GmailServiceError("invalid_request", "附件总大小不能超过 25 MB。");
      }
      resolved.push({
        filename: safeFilename(attachment.filename),
        contentType: /^[\w.+-]+\/[\w.+-]+$/.test(attachment.contentType) ? attachment.contentType : "application/octet-stream",
        content: attachment.content,
      });
    }
    return resolved;
  }

  private async threadingFor(messageId: string): Promise<ThreadingHeaders> {
    const message = await this.getMessageResource(messageId);
    return this.threadingFrom(message);
  }

  private threadingFrom(message: gmail_v1.Schema$Message): ThreadingHeaders {
    const threadId = validateId(message.threadId ?? "", "threadId");
    const messageId = cleanHeader(getHeader(message, "Message-ID"), 998);
    const oldReferences = cleanHeader(getHeader(message, "References"), 5000).split(/\s+/).filter(Boolean).slice(-50);
    const references = [...new Set([...oldReferences, ...(messageId ? [messageId] : [])])];
    return { threadId, ...(messageId ? { messageId } : {}), references };
  }

  private threadingFromDraft(message: gmail_v1.Schema$Message): ThreadingHeaders | undefined {
    if (!message.threadId) return undefined;
    const replyTo = cleanHeader(getHeader(message, "In-Reply-To"), 998);
    const references = cleanHeader(getHeader(message, "References"), 5000).split(/\s+/).filter(Boolean).slice(-50);
    return {
      threadId: validateId(message.threadId, "threadId"),
      ...(replyTo ? { messageId: replyTo } : {}),
      references,
    };
  }

  private async getDraftResource(draftId: string): Promise<gmail_v1.Schema$Draft> {
    const id = validateId(draftId, "draftId");
    try {
      return await this.call((api) => api.users.drafts.get({ userId: USER_ID, id, format: "full" }));
    } catch (error) {
      throw mapGmailError(error, "draft_not_found");
    }
  }

  private async getMessageResource(messageId: string): Promise<gmail_v1.Schema$Message> {
    const id = validateId(messageId, "messageId");
    try {
      return await this.call((api) => api.users.messages.get({ userId: USER_ID, id, format: "full" }));
    } catch (error) {
      throw mapGmailError(error, "message_not_found");
    }
  }

  private validateLabelName(name: string): string {
    const value = name.replace(/[\r\n\0]/g, " ").trim();
    if (!value || value.length > 225) throw new GmailServiceError("invalid_request", "标签名称不能为空，且最多 225 个字符。");
    return value;
  }

  private async getApi(): Promise<GmailApi> {
    const auth = await this.authService.getAuthorizedClient();
    return gmail({ version: "v1", auth });
  }

  private async call<T>(fn: (api: GmailApi) => Promise<{ data: T }>): Promise<T> {
    const api = await this.getApi();
    const response = await fn(api);
    return response.data;
  }
}

interface ThreadingHeaders {
  threadId: string;
  messageId?: string;
  references: string[];
}
