import { createDecipheriv } from "node:crypto";
import type { CDNMedia } from "./ilink-protocol-client";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface DownloadOptions {
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export function decodeWechatAesKey(value: string): Buffer {
  const raw = value.trim();
  if (/^[0-9a-fA-F]{32}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  const decoded = Buffer.from(raw, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  const decodedText = decoded.toString("utf8");
  if (/^[0-9a-fA-F]{32}$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error("unsupported WeChat AES key format");
}

export function decryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(data), decipher.final()]);
}

export async function downloadWechatMedia(
  media: CDNMedia,
  options: DownloadOptions = {},
): Promise<Buffer> {
  const encryptQueryParam = media.encrypt_query_param?.trim();
  if (!encryptQueryParam) throw new Error("missing WeChat encrypted query param");
  const key = decodeWechatAesKey(media.aes_key);
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
  options.signal?.throwIfAborted();
  const response = await fetchImpl(url, ...(options.signal ? [{ signal: options.signal }] : []));
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(`CDN download failed: HTTP ${response.status} ${message.slice(0, 120)}`.trim());
  }
  const encrypted = Buffer.from(await response.arrayBuffer());
  options.signal?.throwIfAborted();
  return media.encrypt_type === 0 ? encrypted : decryptAesEcb(encrypted, key);
}
