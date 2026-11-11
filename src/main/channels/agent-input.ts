import path from "node:path";
import type { AguiRunInput } from "../agui-bridge";
import type { IncomingMessage } from "./types";

type AttachmentInputs = Pick<AguiRunInput, "attachments" | "imageAttachments">;

export interface ChannelAttachmentInputOptions {
  imageMode?: "direct" | "caption";
  captionImage?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
}

export async function buildChannelAttachmentInputs(
  msg: IncomingMessage,
  options: ChannelAttachmentInputOptions = {},
): Promise<AttachmentInputs> {
  const attachments: NonNullable<AguiRunInput["attachments"]> = [];
  const imageAttachments: NonNullable<AguiRunInput["imageAttachments"]> = [];
  const imageMode = options.imageMode ?? "direct";

  for (const item of msg.attachments ?? []) {
    msg.signal?.throwIfAborted();
    if (!item.filePath) continue;
    const name = item.caption || path.basename(item.filePath);
    if (item.kind === "image") {
      if (imageMode === "direct") {
        imageAttachments.push({ name, filePath: item.filePath, mime: item.mime });
      } else {
        const result = options.captionImage
          ? await options.captionImage(item.filePath)
          : { ok: false, error: "未配置视觉模型，无法分析图片" };
        const text = result.ok && result.caption
          ? result.caption
          : `图片分析失败：${result.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`;
        attachments.push({
          name,
          text: `【图片视觉信息】\n用户通过${channelName(msg.channel)}发送了图片：${name}\n${text}`,
        });
      }
    } else if (item.kind === "file" || item.kind === "audio" || item.kind === "video") {
      const label = item.kind === "audio" ? "语音" : item.kind === "video" ? "视频" : "文件";
      attachments.push({
        name,
        text: `用户通过${channelName(msg.channel)}发送了${label}：${item.filePath}`,
      });
    }
  }

  return {
    attachments: attachments.length > 0 ? attachments : undefined,
    imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
  };
}

function channelName(channel: IncomingMessage["channel"]): string {
  switch (channel) {
    case "wechat": return "微信";
    case "feishu": return "飞书";
    case "qq": return "QQ";
    case "qqbot": return "QQ 机器人";
    default: return channel;
  }
}
