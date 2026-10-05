import addressparser from "nodemailer/lib/addressparser";
import type { gmail_v1 } from "@googleapis/gmail";
import { htmlToPlainText, sanitizeEmailHtml } from "./gmail-html";

export const MAX_GMAIL_BODY_BYTES = 1024 * 1024;
export const MAX_GMAIL_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export interface GmailAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export interface GmailMessageSummary {
  id: string;
  threadId: string;
  from: string[];
  to: string[];
  subject: string;
  date: string;
  snippet: string;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  attachmentCount: number;
}

export interface GmailMessage extends GmailMessageSummary {
  cc: string[];
  bcc: string[];
  textBody: string;
  htmlBody: string;
  bodyTruncated: boolean;
  attachments: GmailAttachmentRef[];
}

export interface GmailThread {
  id: string;
  messages: GmailMessage[];
}

export interface GmailSearchPage {
  messages: GmailMessageSummary[];
  nextPageToken?: string;
  resultSizeEstimate: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: "system" | "user";
  messagesTotal?: number;
  messagesUnread?: number;
}

export interface GmailDraftSummary {
  id: string;
  messageId: string;
  threadId: string;
  to: string[];
  subject: string;
  snippet: string;
  date: string;
}

export interface GmailDraft {
  id: string;
  message: GmailMessage;
}

export interface GmailDraftInput {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyMarkdown: string;
  attachmentRefs?: GmailAttachmentRef[];
}

export type GmailMessageAction = "mark_read" | "mark_unread" | "star" | "unstar" | "archive" | "trash" | "restore";

export interface GmailSendResult {
  messageId: string;
  threadId: string;
}

export interface DecodedGmailPartBody {
  textBody: string;
  htmlBody: string;
  bodyTruncated: boolean;
  attachments: GmailAttachmentRef[];
}

function decodeHeaderValue(value: string): string {
  return value.replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (encoded, charset: string, encoding: string, data: string) => {
    try {
      let bytes: Buffer;
      if (encoding.toLowerCase() === "b") {
        bytes = Buffer.from(data, "base64");
      } else {
        const output: number[] = [];
        const normalized = data.replace(/_/g, " ");
        for (let index = 0; index < normalized.length; index += 1) {
          if (normalized[index] === "=" && /^[\da-f]{2}$/i.test(normalized.slice(index + 1, index + 3))) {
            output.push(Number.parseInt(normalized.slice(index + 1, index + 3), 16));
            index += 2;
          } else {
            output.push(normalized.charCodeAt(index));
          }
        }
        bytes = Buffer.from(output);
      }
      return new TextDecoder(charset, { fatal: false }).decode(bytes);
    } catch {
      return encoded;
    }
  }).replace(/\?=\s+=\?/g, "");
}

function decodeBase64Url(data: string | null | undefined, maxBytes: number): { bytes: Buffer; truncated: boolean } {
  if (!data) return { bytes: Buffer.alloc(0), truncated: false };
  const bytes = Buffer.from(data, "base64url");
  const truncated = bytes.byteLength > maxBytes;
  return {
    bytes: truncated ? bytes.subarray(0, maxBytes) : bytes,
    truncated,
  };
}

function getHeader(payload: gmail_v1.Schema$MessagePart | undefined, name: string): string {
  const value = payload?.headers?.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value;
  return value ? decodeHeaderValue(value) : "";
}

function parseAddresses(value: string): string[] {
  if (!value) return [];
  try {
    return addressparser(value, { flatten: true })
      .map(({ address }) => address.trim())
      .filter((address) => address.length > 0 && address.length <= 320);
  } catch {
    return [];
  }
}

function parseDate(message: gmail_v1.Schema$Message, payload: gmail_v1.Schema$MessagePart | undefined): string {
  const internalDate = Number(message.internalDate);
  if (Number.isFinite(internalDate) && internalDate > 0 && internalDate <= 8_640_000_000_000_000) {
    return new Date(internalDate).toISOString();
  }
  return getHeader(payload, "Date").slice(0, 128);
}

function charsetForPart(part: gmail_v1.Schema$MessagePart): string {
  const contentType = part.headers?.find((header) => header.name?.toLowerCase() === "content-type")?.value ?? "";
  const charset = contentType.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
  return charset && /^[\w.-]{1,40}$/.test(charset) ? charset : "utf-8";
}

export function collectAttachmentRefs(payload: gmail_v1.Schema$MessagePart | undefined, messageId: string): GmailAttachmentRef[] {
  const attachments: GmailAttachmentRef[] = [];
  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    const name = (part.filename ?? "").trim().slice(0, 255);
    const attachmentId = part.body?.attachmentId;
    if (name && (attachmentId || part.body?.data || part.partId)) {
      attachments.push({
        id: `gmail:${messageId}:${attachmentId ?? part.partId ?? ""}`,
        name,
        mimeType: (part.mimeType || "application/octet-stream").slice(0, 128),
        size: Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Number(part.body?.size) || 0)),
      });
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  return attachments.slice(0, 100);
}

export function decodeGmailPayload(
  payload: gmail_v1.Schema$MessagePart | undefined,
  messageId: string,
  maxBodyBytes = MAX_GMAIL_BODY_BYTES,
): DecodedGmailPartBody {
  const textParts: Array<{ text: string; truncated: boolean }> = [];
  const htmlParts: Array<{ text: string; truncated: boolean }> = [];
  let remainingBytes = maxBodyBytes;
  let bodyTruncated = false;
  const visit = (part: gmail_v1.Schema$MessagePart): void => {
    if (part.filename || part.body?.attachmentId) {
      for (const child of part.parts ?? []) visit(child);
      return;
    }
    const mimeType = (part.mimeType ?? "").toLowerCase();
    if (mimeType === "text/plain" || mimeType === "text/html") {
      if (remainingBytes <= 0) {
        bodyTruncated ||= (part.body?.size ?? 0) > 0;
      } else {
        const decoded = decodeBase64Url(part.body?.data, remainingBytes);
        remainingBytes -= decoded.bytes.byteLength;
        bodyTruncated ||= decoded.truncated;
        try {
          const text = new TextDecoder(charsetForPart(part), { fatal: false }).decode(decoded.bytes);
          (mimeType === "text/plain" ? textParts : htmlParts).push({ text, truncated: decoded.truncated });
        } catch {
          const text = new TextDecoder("utf-8", { fatal: false }).decode(decoded.bytes);
          (mimeType === "text/plain" ? textParts : htmlParts).push({ text, truncated: decoded.truncated });
        }
      }
    }
    for (const child of part.parts ?? []) visit(child);
  };
  if (payload) visit(payload);
  const textBody = textParts.map((part) => part.text).join("\n\n").slice(0, maxBodyBytes);
  const rawHtml = htmlParts.map((part) => part.text).join("\n").slice(0, maxBodyBytes);
  const htmlBody = rawHtml ? sanitizeEmailHtml(rawHtml) : "";
  return {
    textBody: (textBody || (htmlBody ? htmlToPlainText(htmlBody) : "")).slice(0, maxBodyBytes),
    htmlBody,
    bodyTruncated: bodyTruncated || [...textParts, ...htmlParts].some((part) => part.truncated),
    attachments: collectAttachmentRefs(payload, messageId),
  };
}

export function toGmailMessage(message: gmail_v1.Schema$Message, maxBodyBytes = MAX_GMAIL_BODY_BYTES): GmailMessage {
  const id = message.id ?? "";
  const payload = message.payload;
  const body = decodeGmailPayload(payload, id, maxBodyBytes);
  const labels = message.labelIds ?? [];
  const attachments = body.attachments;
  return {
    id,
    threadId: message.threadId ?? "",
    from: parseAddresses(getHeader(payload, "From")),
    to: parseAddresses(getHeader(payload, "To")),
    cc: parseAddresses(getHeader(payload, "Cc")),
    bcc: parseAddresses(getHeader(payload, "Bcc")),
    subject: getHeader(payload, "Subject").slice(0, 998),
    date: parseDate(message, payload),
    snippet: (message.snippet ?? "").slice(0, 1000),
    labels,
    isRead: !labels.includes("UNREAD"),
    isStarred: labels.includes("STARRED"),
    attachmentCount: attachments.length,
    attachments,
    textBody: body.textBody,
    htmlBody: body.htmlBody,
    bodyTruncated: body.bodyTruncated,
  };
}

export function toGmailSummary(message: gmail_v1.Schema$Message): GmailMessageSummary {
  const full = toGmailMessage(message);
  const { cc: _cc, bcc: _bcc, textBody: _text, htmlBody: _html, bodyTruncated: _truncated, attachments: _attachments, ...summary } = full;
  return summary;
}

export function gmailDraftSummary(draft: gmail_v1.Schema$Draft): GmailDraftSummary {
  const message = draft.message;
  return {
    id: draft.id ?? "",
    messageId: message?.id ?? "",
    threadId: message?.threadId ?? "",
    to: parseAddresses(getHeader(message?.payload, "To")),
    subject: getHeader(message?.payload, "Subject").slice(0, 998),
    snippet: (message?.snippet ?? "").slice(0, 1000),
    date: parseDate(message ?? {}, message?.payload),
  };
}
