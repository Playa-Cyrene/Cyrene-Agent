import { describe, expect, it, vi } from "vitest";
import { uploadWechatMedia, MediaType } from "./wechat-media-upload";

describe("uploadWechatMedia", () => {
  it("获取上传地址期间撤销后，不发送媒体内容到 CDN", async () => {
    const activity = new AbortController();
    const fetchImpl = vi.fn();
    const client = { getUploadUrl: async () => {
      activity.abort(new Error("channel_stopped"));
      return { upload_full_url: "https://cdn.example/synthetic", upload_param: "synthetic" };
    } };
    await expect(uploadWechatMedia(client, "peer", Buffer.from("synthetic"), MediaType.IMAGE, { signal: activity.signal, fetchImpl }))
      .rejects.toThrow("channel_stopped");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("encrypts media, uses upload_full_url, and returns CDN media fields", async () => {
    const getUploadUrl = vi.fn(async () => ({
      upload_param: "fallback-param",
      upload_full_url: "https://cdn.example/upload/full",
    }));
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: {
        get: (name: string) => name.toLowerCase() === "x-encrypted-param" ? "encrypted-param" : null,
      },
    } as Response));

    const result = await uploadWechatMedia(
      { getUploadUrl },
      "wx-user-1",
      Buffer.from("hello"),
      MediaType.IMAGE,
      {
        aesKey: Buffer.from("00112233445566778899aabbccddeeff", "hex"),
        fileKey: "file-key-1",
        fetchImpl,
      },
    );

    expect(getUploadUrl).toHaveBeenCalledWith({
      filekey: "file-key-1",
      media_type: MediaType.IMAGE,
      to_user_id: "wx-user-1",
      rawsize: 5,
      rawfilemd5: "5d41402abc4b2a76b9719d911017c592",
      filesize: 16,
      no_need_thumb: true,
      aeskey: "00112233445566778899aabbccddeeff",
    });
    expect(fetchImpl).toHaveBeenCalledWith("https://cdn.example/upload/full", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
    }));
    expect(result).toEqual({
      encrypt_query_param: "encrypted-param",
      aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
      encrypt_type: 1,
    });
  });
});
