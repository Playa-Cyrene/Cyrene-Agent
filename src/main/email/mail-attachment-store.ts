import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MailAttachmentRef } from "../../shared/mail-draft-card";

const MAX_BYTES = 25 * 1024 * 1024;
const MIME_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".zip": "application/zip", ".json": "application/json",
};

/** User-selected file paths stay in memory; only opaque ids and metadata cross IPC or enter chat history. */
export class MailAttachmentStore {
  private readonly paths = new Map<string, string>();

  async issue(paths: string[]): Promise<MailAttachmentRef[]> {
    const refs: MailAttachmentRef[] = [];
    for (const selectedPath of paths.slice(0, 10)) {
      const realPath = await fs.realpath(selectedPath);
      const stat = await fs.stat(realPath);
      if (!stat.isFile()) continue;
      if (stat.size > MAX_BYTES) throw new Error("MAIL_ATTACHMENT_TOO_LARGE");
      const name = path.basename(realPath).replace(/[\\/\r\n\0]/g, "_").slice(0, 255);
      if (!name) continue;
      const id = `local:${randomUUID()}`;
      this.paths.set(id, realPath);
      refs.push({ id, name, mimeType: MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? "application/octet-stream", size: stat.size });
    }
    return refs;
  }

  async resolve(reference: MailAttachmentRef): Promise<{ filename: string; contentType: string; content: Buffer }> {
    const path = this.paths.get(reference.id);
    if (!path) throw new Error("MAIL_ATTACHMENT_EXPIRED");
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("MAIL_ATTACHMENT_INVALID");
    const content = await fs.readFile(path);
    if (content.byteLength !== stat.size || content.byteLength > MAX_BYTES) throw new Error("MAIL_ATTACHMENT_CHANGED");
    return { filename: reference.name, contentType: reference.mimeType, content };
  }

  clear(): void { this.paths.clear(); }
}
