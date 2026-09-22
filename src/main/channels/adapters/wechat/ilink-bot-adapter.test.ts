import { describe, expect, it, vi } from "vitest";
import { ILinkBotAdapter } from "./ilink-bot-adapter";
import type { OutgoingMessage } from "../../types";

vi.mock("electron", () => ({
  app: {
    getPath: () => "C:/tmp/cyrene-test-user-data",
  },
}));

function message(parts: OutgoingMessage["parts"]): OutgoingMessage {
  return {
    channel: "wechat",
    targetId: "wx-user-1",
    parts,
  };
}

describe("ILinkBotAdapter.send", () => {
  it("sends text replies through the protocol client with the cached context token", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).client = { sendText };
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([{ kind: "text", text: "你好" }]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "你好", "ctx-1");
  });

  it("sends multiple text parts as separate messages", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).client = { sendText };
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "text", text: "第一句。" },
      { kind: "text", text: "第二句？" },
      { kind: "text", text: "\n第三句！" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenNthCalledWith(1, "wx-user-1", "第一句。", "ctx-1");
    expect(sendText).toHaveBeenNthCalledWith(2, "wx-user-1", "第二句？", "ctx-1");
    expect(sendText).toHaveBeenNthCalledWith(3, "wx-user-1", "第三句！", "ctx-1");
  });

  it("uploads image and sticker parts as image items in one sendmessage payload", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const uploadMedia = vi.fn(async (_client, _userId, filePath: string) => ({
      encrypt_query_param: `encrypted:${filePath}`,
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendText, sendMessage };
    (adapter as any).uploadMedia = uploadMedia;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "text", text: "看图" },
      { kind: "image", filePath: "C:/tmp/pic.png", caption: "图片" },
      { kind: "sticker", stickerId: "happy", imagePath: "C:/tmp/sticker.png" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "看图", "ctx-1");
    expect(uploadMedia).toHaveBeenCalledTimes(2);
    expect(uploadMedia).toHaveBeenNthCalledWith(1, expect.anything(), "wx-user-1", "C:/tmp/pic.png", 1);
    expect(uploadMedia).toHaveBeenNthCalledWith(2, expect.anything(), "wx-user-1", "C:/tmp/sticker.png", 1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, "wx-user-1", [
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/pic.png",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "wx-user-1", [
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/sticker.png",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
  });

  it("uploads file and video parts as file and video items", async () => {
    const adapter = new ILinkBotAdapter();
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const uploadMedia = vi.fn(async (_client, _userId, filePath: string) => ({
      encrypt_query_param: `encrypted:${filePath}`,
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendMessage };
    (adapter as any).uploadMedia = uploadMedia;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "file", filePath: "C:/tmp/report.pdf", name: "report.pdf", mime: "application/pdf" },
      { kind: "video", filePath: "C:/tmp/demo.mp4", name: "demo.mp4", mime: "video/mp4" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(uploadMedia).toHaveBeenNthCalledWith(1, expect.anything(), "wx-user-1", "C:/tmp/report.pdf", 3);
    expect(uploadMedia).toHaveBeenNthCalledWith(2, expect.anything(), "wx-user-1", "C:/tmp/demo.mp4", 2);
    expect(sendMessage).toHaveBeenNthCalledWith(1, "wx-user-1", [
      {
        type: 4,
        file_item: {
          file_name: "report.pdf",
          media: {
            encrypt_query_param: "encrypted:C:/tmp/report.pdf",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
    expect(sendMessage).toHaveBeenNthCalledWith(2, "wx-user-1", [
      {
        type: 5,
        video_item: {
          media: {
            encrypt_query_param: "encrypted:C:/tmp/demo.mp4",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
        },
      },
    ], "ctx-1");
  });

  it("encodes and uploads audio parts as voice items", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendMessage = vi.fn(async () => ({ ok: true }));
    const encodeVoice = vi.fn(async () => ({
      data: Buffer.from("silk-data"),
      durationMs: 1200,
      sampleRate: 24000,
      encodeType: 6,
    }));
    const uploadMediaData = vi.fn(async (_client, _userId, data: Buffer) => ({
      encrypt_query_param: `encrypted:${data.toString("utf8")}`,
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendText, sendMessage };
    (adapter as any).encodeVoice = encodeVoice;
    (adapter as any).uploadMediaData = uploadMediaData;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "text", text: "语音来了" },
      { kind: "audio", filePath: "package.json", mime: "audio/wav" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "语音来了", "ctx-1");
    expect(encodeVoice).toHaveBeenCalledWith(expect.any(Buffer), { format: "wav" });
    expect(uploadMediaData).toHaveBeenCalledWith(expect.anything(), "wx-user-1", Buffer.from("silk-data"), 4);
    expect(sendMessage).toHaveBeenCalledWith("wx-user-1", [
      {
        type: 3,
        voice_item: {
          media: {
            encrypt_query_param: "encrypted:silk-data",
            aes_key: "encoded-key",
            encrypt_type: 1,
          },
          encode_type: 6,
          sample_rate: 24000,
          playtime: 1200,
        },
      },
    ], "ctx-1");
  });

  it("keeps the text reply successful when optional audio sending is rejected", async () => {
    const adapter = new ILinkBotAdapter();
    const sendText = vi.fn(async () => ({ ok: true }));
    const sendMessage = vi.fn(async () => ({ ok: false, error: "ret=-2" }));
    const encodeVoice = vi.fn(async () => ({
      data: Buffer.from("silk-data"),
      durationMs: 1200,
      sampleRate: 24000,
      encodeType: 6,
    }));
    const uploadMediaData = vi.fn(async () => ({
      encrypt_query_param: "encrypted:silk-data",
      aes_key: "encoded-key",
      encrypt_type: 1,
    }));
    (adapter as any).client = { sendText, sendMessage };
    (adapter as any).encodeVoice = encodeVoice;
    (adapter as any).uploadMediaData = uploadMediaData;
    (adapter as any).replyContextByTarget.set("wx-user-1", "ctx-1");

    const result = await adapter.send(message([
      { kind: "text", text: "先把文字发出去" },
      { kind: "audio", filePath: "package.json", mime: "audio/wav" },
    ]));

    expect(result).toEqual({ ok: true });
    expect(sendText).toHaveBeenCalledWith("wx-user-1", "先把文字发出去", "ctx-1");
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe("ILinkBotAdapter inbound media", () => {
  it("downloads supported image media into incoming attachments", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText: vi.fn() };
    (adapter as any).downloadMedia = vi.fn(async () => ({
      filePath: "C:/tmp/cyrene-test-user-data/channels/cache/wechat-msg-1-image.png",
      mime: "image/png",
    }));

    await (adapter as any).dispatchInbound({
      msgId: "msg-1",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "看看这个",
      items: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
          },
        },
      ],
      contextToken: "ctx-1",
      raw: {},
    });

    expect((adapter as any).downloadMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image" }),
      "msg-1",
    );
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "wechat",
      senderId: "wx-user-1",
      // 平台消息 ID 必须透传：重投同一条消息得到相同 turn ID，不会重复执行
      messageId: "msg-1",
      text: "看看这个",
      attachments: [
        {
          kind: "image",
          filePath: "C:/tmp/cyrene-test-user-data/channels/cache/wechat-msg-1-image.png",
          mime: "image/png",
          caption: "微信图片",
        },
      ],
    }));
  });

  it("does not dispatch to the agent when supported media download fails", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).downloadMedia = vi.fn(async () => {
      throw new Error("download failed");
    });

    await (adapter as any).dispatchInbound({
      msgId: "msg-2",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "看看这个",
      items: [
        {
          type: 2,
          image_item: {
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
          },
        },
      ],
      contextToken: "ctx-1",
      raw: {},
    });

    expect(sendText).toHaveBeenCalledWith(
      "wx-user-1",
      expect.stringContaining("微信附件下载失败"),
      "ctx-1",
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("saves a pending unsupported file when the user replies with save intent within five minutes", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).saveInboundMedia = vi.fn(async () => "C:/Users/testuser/Desktop/Cyrene 收件箱/archive.zip");

    await (adapter as any).dispatchInbound({
      msgId: "msg-file-1",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "",
      items: [
        {
          type: 4,
          file_item: {
            file_name: "archive.zip",
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
          },
        },
      ],
      contextToken: "ctx-file",
      raw: {},
    });
    await (adapter as any).dispatchInbound({
      msgId: "msg-text-1",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "保存到桌面",
      items: [{ type: 1, text_item: { text: "保存到桌面" } }],
      contextToken: "ctx-text",
      raw: {},
    });

    expect((adapter as any).saveInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", fileName: "archive.zip" }),
      "msg-file-1",
    );
    expect(sendText).toHaveBeenLastCalledWith(
      "wx-user-1",
      "收好啦，伙伴。人家已经帮你放到桌面的“Cyrene 收件箱”里了：C:/Users/testuser/Desktop/Cyrene 收件箱/archive.zip",
      "ctx-text",
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("saves an unsupported file when it arrives after a save intent", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).saveInboundMedia = vi.fn(async () => "C:/Users/testuser/Desktop/Cyrene 收件箱/movie.mp4");

    await (adapter as any).dispatchInbound({
      msgId: "msg-text-2",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "帮我代收一下",
      items: [{ type: 1, text_item: { text: "帮我代收一下" } }],
      contextToken: "ctx-text",
      raw: {},
    });
    await (adapter as any).dispatchInbound({
      msgId: "msg-video-1",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "",
      items: [
        {
          type: 5,
          video_item: {
            file_name: "movie.mp4",
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
          },
        },
      ],
      contextToken: "ctx-video",
      raw: {},
    });

    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "wx-user-1",
      "好呀，伙伴，尽管把文件发过来吧。我会帮你放到桌面的“Cyrene 收件箱”里哦~~",
      "ctx-text",
    );
    expect((adapter as any).saveInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", fileName: "movie.mp4" }),
      "msg-video-1",
    );
    expect(sendText).toHaveBeenLastCalledWith(
      "wx-user-1",
      "收好啦，伙伴。人家已经帮你放到桌面的“Cyrene 收件箱”里了：C:/Users/testuser/Desktop/Cyrene 收件箱/movie.mp4",
      "ctx-video",
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("saves an analyzable file instead of dispatching it when a save intent is already pending", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).saveInboundMedia = vi.fn(async () => "C:/Users/testuser/Desktop/Cyrene 收件箱/report.pdf");
    (adapter as any).downloadMedia = vi.fn();

    await (adapter as any).dispatchInbound({
      msgId: "msg-text-3",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "保存到桌面",
      items: [{ type: 1, text_item: { text: "保存到桌面" } }],
      contextToken: "ctx-text",
      raw: {},
    });
    await (adapter as any).dispatchInbound({
      msgId: "msg-file-2",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "",
      items: [
        {
          type: 4,
          file_item: {
            file_name: "report.pdf",
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
          },
        },
      ],
      contextToken: "ctx-file",
      raw: {},
    });

    expect((adapter as any).saveInboundMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", fileName: "report.pdf" }),
      "msg-file-2",
    );
    expect((adapter as any).downloadMedia).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("transcribes inbound voice and dispatches the transcript when ASR is configured", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).isAsrConfigured = () => true;
    (adapter as any).transcribeVoice = vi.fn(async () => "你在忙什么呀");

    await (adapter as any).dispatchInbound({
      msgId: "msg-voice-1",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "",
      items: [
        {
          type: 3,
          voice_item: {
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
            sample_rate: 16000,
          },
        },
      ],
      contextToken: "ctx-voice",
      raw: {},
    });

    expect((adapter as any).transcribeVoice).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "voice", fileName: "微信语音" }),
      "msg-voice-1",
    );
    expect(sendText).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: "wechat",
      senderId: "wx-user-1",
      text: "你在忙什么呀",
      attachments: undefined,
    }));
  });

  it("does not dispatch inbound voice when ASR transcription fails", async () => {
    const adapter = new ILinkBotAdapter();
    const onMessage = vi.fn(async () => null);
    const sendText = vi.fn(async () => ({ ok: true }));
    (adapter as any).onMessage = onMessage;
    (adapter as any).client = { sendText };
    (adapter as any).isAsrConfigured = () => true;
    (adapter as any).transcribeVoice = vi.fn(async () => {
      throw new Error("ASR timeout");
    });

    await (adapter as any).dispatchInbound({
      msgId: "msg-voice-2",
      fromUserId: "wx-user-1",
      toUserId: "bot-1",
      msgType: 1,
      content: "",
      items: [
        {
          type: 3,
          voice_item: {
            media: {
              encrypt_query_param: "download-param",
              aes_key: "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
              encrypt_type: 1,
            },
            sample_rate: 16000,
          },
        },
      ],
      contextToken: "ctx-voice",
      raw: {},
    });

    expect(sendText).toHaveBeenCalledWith(
      "wx-user-1",
      "伙伴，这条语音人家暂时没听清楚：ASR timeout。可以换成文字再发我一次哦~~",
      "ctx-voice",
    );
    expect(onMessage).not.toHaveBeenCalled();
  });
});
