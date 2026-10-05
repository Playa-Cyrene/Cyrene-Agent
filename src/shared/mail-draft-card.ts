export interface MailAttachmentRef {
  id: string;
  name: string;
  mimeType: string;
  size: number;
}

export type MailDraftStatus = "draft" | "sending" | "sent" | "cancelled" | "deleted" | "unknown" | "reconnect_required";

export interface MailDraftCardData {
  id: string;
  provider: "gmail" | "smtp";
  gmailDraftId?: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyMarkdown: string;
  attachments: MailAttachmentRef[];
  status: MailDraftStatus;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const STATUSES = new Set<MailDraftStatus>(["draft", "sending", "sent", "cancelled", "deleted", "unknown", "reconnect_required"]);
const CARD_KEYS = new Set(["id", "provider", "gmailDraftId", "from", "to", "cc", "bcc", "subject", "bodyMarkdown", "attachments", "status"]);

function cleanAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim();
  return address.length <= 320 && EMAIL.test(address) && !/[\r\n\0]/.test(address) ? address : null;
}

function addressList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const result = value.map(cleanAddress);
  return result.every((item): item is string => item !== null) ? result : null;
}

function normalizeAttachments(value: unknown): MailAttachmentRef[] | null {
  if (!Array.isArray(value) || value.length > 10) return null;
  const result: MailAttachmentRef[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const source = item as Record<string, unknown>;
    if (Object.keys(source).some((key) => !["id", "name", "mimeType", "size"].includes(key))) return null;
    if (typeof source.id !== "string" || source.id.length < 1 || source.id.length > 512 || /[\r\n\0]/.test(source.id)) return null;
    if (typeof source.name !== "string" || !source.name.trim() || source.name.length > 255 || /[\\/\r\n\0]/.test(source.name)) return null;
    if (typeof source.mimeType !== "string" || source.mimeType.length > 128 || !/^[\w.+-]+\/[\w.+-]+$/.test(source.mimeType)) return null;
    if (typeof source.size !== "number" || !Number.isSafeInteger(source.size) || source.size < 0) return null;
    result.push({ id: source.id, name: source.name.trim(), mimeType: source.mimeType, size: source.size });
  }
  return result;
}

export function normalizeMailDraftCardData(value: unknown): MailDraftCardData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (Object.keys(card).some((key) => !CARD_KEYS.has(key))) return null;
  if (typeof card.id !== "string" || card.id.length < 8 || card.id.length > 128 || /[^\w-]/.test(card.id)) return null;
  if (card.provider !== "gmail" && card.provider !== "smtp") return null;
  if (card.gmailDraftId !== undefined && (typeof card.gmailDraftId !== "string" || !/^[\w-]{1,256}$/.test(card.gmailDraftId))) return null;
  if (card.provider === "gmail" && !card.gmailDraftId) return null;
  const from = card.from === "" && card.provider === "smtp" ? "" : cleanAddress(card.from);
  const to = addressList(card.to);
  const cc = addressList(card.cc);
  const bcc = addressList(card.bcc);
  const attachments = normalizeAttachments(card.attachments);
  if (from === null || !to || !cc || !bcc || !attachments) return null;
  if (typeof card.subject !== "string" || card.subject.length > 998 || /[\r\n\0]/.test(card.subject)) return null;
  if (typeof card.bodyMarkdown !== "string" || card.bodyMarkdown.length > 200_000) return null;
  if (typeof card.status !== "string" || !STATUSES.has(card.status as MailDraftStatus)) return null;
  return {
    id: card.id,
    provider: card.provider,
    ...(typeof card.gmailDraftId === "string" ? { gmailDraftId: card.gmailDraftId } : {}),
    from,
    to,
    cc,
    bcc,
    subject: card.subject,
    bodyMarkdown: card.bodyMarkdown,
    attachments,
    status: card.status as MailDraftStatus,
  };
}
