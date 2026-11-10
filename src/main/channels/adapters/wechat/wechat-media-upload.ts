import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import type { CDNMedia, GetUploadUrlRequest, GetUploadUrlResponse } from "./ilink-protocol-client";
import { MediaType } from "./ilink-protocol-client";

const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

interface UploadClient {
  getUploadUrl(req: GetUploadUrlRequest): Promise<GetUploadUrlResponse>;
}

interface UploadOptions {
  signal?: AbortSignal;
  aesKey?: Buffer;
  fileKey?: string;
  fetchImpl?: FetchLike;
}

export { MediaType };

export function encryptAesEcb(data: Buffer, key: Buffer): Buffer {
  if (key.length !== 16) throw new Error(`AES key must be 16 bytes, got ${key.length}`);
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function encodeAesKeyHex(key: Buffer): string {
  return key.toString("hex");
}

function encodeAesKeyBase64(key: Buffer): string {
  return Buffer.from(key.toString("hex"), "utf8").toString("base64");
}

export async function uploadWechatMedia(
  client: UploadClient,
  userId: string,
  data: Buffer,
  mediaType: MediaType,
  options: UploadOptions = {},
): Promise<CDNMedia> {
  options.signal?.throwIfAborted();
  const aesKey = options.aesKey ?? randomBytes(16);
  const filekey = options.fileKey ?? randomBytes(16).toString("hex");
  const ciphertext = encryptAesEcb(data, aesKey);
  const uploadParams = await client.getUploadUrl({
    filekey,
    media_type: mediaType,
    to_user_id: userId,
    rawsize: data.length,
    rawfilemd5: createHash("md5").update(data).digest("hex"),
    filesize: ciphertext.length,
    no_need_thumb: true,
    aeskey: encodeAesKeyHex(aesKey),
  });

  const uploadFullUrl = uploadParams.upload_full_url?.trim();
  options.signal?.throwIfAborted();
  if (!uploadFullUrl && !uploadParams.upload_param) {
    throw new Error("getuploadurl returned no upload URL");
  }
  const uploadUrl = uploadFullUrl
    || `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParams.upload_param)}&filekey=${encodeURIComponent(filekey)}`;

  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(uploadUrl, {
    signal: options.signal,
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });
  if (!response.ok) {
    const errMsg = response.headers.get("x-error-message") ?? `HTTP ${response.status}`;
    throw new Error(`CDN upload failed: ${errMsg}`);
  }
  const encryptQueryParam = response.headers.get("x-encrypted-param");
  if (!encryptQueryParam) {
    throw new Error("CDN upload response missing x-encrypted-param header");
  }

  return {
    encrypt_query_param: encryptQueryParam,
    aes_key: encodeAesKeyBase64(aesKey),
    encrypt_type: 1,
  };
}

export async function uploadWechatMediaFile(
  client: UploadClient,
  userId: string,
  filePath: string,
  mediaType: MediaType,
  options: UploadOptions = {},
): Promise<CDNMedia> {
  options.signal?.throwIfAborted();
  const data = await fs.readFile(filePath, { signal: options.signal });
  return uploadWechatMedia(client, userId, data, mediaType, options);
}
