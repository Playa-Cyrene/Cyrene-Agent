// 飞书 FeishuAdapter —— implements ChannelAdapter。
//
// 接入方式：**长连接 WebSocket**（飞书官方 SDK 内置支持）。
// 比 HTTP webhook 简单几个数量级：
//   - 不需要公网 HTTPS URL（飞书 SDK 主动连出）
//   - 不需要 Verification Token / Encrypt Key（WS 自动鉴权）
//   - 不需要内网穿透
//   - 重连 / 心跳 / ack SDK 全自动处理
//
// 数据流：
//   飞书服务器 ←WSS→ @larksuiteoapi/node-sdk WSClient
//       ↓ onMessage (normalized LarkChannel event)
//       ↓ LarkChannel.on('message')
//   FeishuAdapter.handleLarkMessage → adapter.onMessage (dispatcher)
//       ↓ CyreneAgent runs
//   LarkChannel.send(chatId, { text }) → 飞书服务器
//
// 图片/文件/音频消息：通过 SDK 的 messageResource.get 下载到 userData/channels/cache/
// 转化为本地 filePath 写入 IncomingMessage.attachments，buildAgentRunOptions 会注入 prompt。
//
// 注意：本 adapter 只在用户启用飞书时才创建 LarkChannel 实例。
// 切换 enabled/config 后调 rebuild() 重启。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  createLarkChannel,
  Domain,
  LoggerLevel,
  type LarkChannel,
  type NormalizedMessage,
  type SendInput,
  type EventName,
} from "@larksuiteoapi/node-sdk";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings } from "../../settings-store";
import { getAudioDurationMs } from "./audio-duration";
import { logger, LogTag } from "../../../logger";

export { transcodeAudioFileToFeishuOpus } from "./audio-transcode";

const LOG = "[FeishuAdapter]";

/** 飞书 capability 声明。SDK 已经把消息/图片/音频/视频/卡片/sticker 都内置支持 */
const FEISHU_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: true,
  maxTextLength: 4000,
};

/** 飞书资源类型 → 我们的附件类型 + 扩展名 */
function resourceKindToExt(ktype: string): { ext: string; mime: string } {
  switch (ktype) {
    case "image": return { ext: ".png", mime: "image/png" };
    case "audio": return { ext: ".mp3", mime: "audio/mpeg" };
    case "video": return { ext: ".mp4", mime: "video/mp4" };
    case "file":  return { ext: ".bin", mime: "application/octet-stream" };
    case "sticker": return { ext: ".png", mime: "image/png" };
    default: return { ext: ".bin", mime: "application/octet-stream" };
  }
}

/** 把飞书资源下载到本地缓存目录。返回本地文件路径或 null（失败时）。 */
async function downloadLarkResource(
  channel: LarkChannel,
  messageId: string,
  fileKey: string,
  kind: string,
): Promise<string | null> {
  const cacheDir = path.join(app.getPath("userData"), "channels", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });
  // 命名: feishu-<messageId>-<fileKey 末 8 位>.<ext>
  const { ext } = resourceKindToExt(kind);
  const shortKey = fileKey.slice(-8);
  const localPath = path.join(cacheDir, `feishu-${messageId}-${shortKey}${ext}`);
  if (fs.existsSync(localPath)) return localPath; // 已下载过
  try {
    // 绕过 LarkChannel.downloadResource() 这个 wrapper 的 bug —— 它对 image 调的是
    // /open-apis/im/v1/image/{image_key}（只能下机器人自己上传的图），而我们要的是
    // /open-apis/im/v1/messages/{message_id}/resources/{file_key}（用户发的图）。
    // 直接用 channel.rawClient 调正确的 API。
    const typeParam = (kind === "file" || kind === "audio" || kind === "video") ? "file" : "image";
    const res = await channel.rawClient.im.v1.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: typeParam },
    });
    // SDK 返回带 writeFile / getReadableStream / headers；用 writeFile 直接落盘
    if (res && typeof res.writeFile === "function") {
      await res.writeFile(localPath);
    } else {
      // 兜底：手动从 readable stream 读
      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () => resolve());
        stream.on("error", (e: Error) => reject(e));
      });
      fs.writeFileSync(localPath, Buffer.concat(chunks));
    }
    const stat = fs.statSync(localPath);
    console.log(LOG, `已下载飞书资源 → ${localPath} (${stat.size} bytes, kind=${kind})`);
    return localPath;
  } catch (err) {
    console.warn(LOG, `下载飞书资源失败: messageId=${messageId} fileKey=${fileKey} err=`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把飞书 NormalizedMessage → 我们的 IncomingMessage（异步，会下载附件） */
async function normalizeLarkMessage(
  channel: LarkChannel,
  msg: NormalizedMessage,
): Promise<IncomingMessage> {
  // msg.content 是 JSON 字符串，msg.rawContentType 是消息类型（"text" / "image" / "post" / ...）
  let text = "";
  const rawType = msg.rawContentType ?? "text";
  const attachments: IncomingMessage["attachments"] = [];

  if (rawType === "text") {
    try {
      const c = JSON.parse(msg.content) as { text?: string };
      text = c.text ?? msg.content;
    } catch {
      text = msg.content;
    }
  } else if (rawType === "image" || rawType === "file" || rawType === "audio" || rawType === "video" || rawType === "sticker") {
    // 下载所有 resources 到本地，给 LLM 一个明确的本地路径
    for (const r of msg.resources ?? []) {
      const localPath = await downloadLarkResource(channel, msg.messageId, r.fileKey, r.type);
      if (localPath) {
        const { mime } = resourceKindToExt(r.type);
        attachments.push({
          kind: r.type === "sticker" ? "image" : (r.type as "image" | "file" | "audio" | "video"),
          filePath: localPath,
          mime,
          caption: r.fileName,
        });
        if (!text) text = `[${rawType}]`;
        // 把"附件路径"嵌进 text，让 LLM 一眼看到
        text = (text ? text + "\n" : "") + `[附件: ${localPath}]`;
      }
    }
    if (attachments.length === 0) text = `[${rawType}]`;
  } else {
    // post / interactive / shareChat 等未知类型
    text = `[${rawType}]`;
  }

  return {
    channel: "feishu",
    senderId: msg.senderId ?? "",
    senderName: msg.senderName,
    chatId: msg.chatId,
    threadId: msg.threadId,
    // 透传平台消息 ID：附件正文含换行，若走时间+正文回退生成 turn ID 会被拒绝写入 journal
    messageId: msg.messageId,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
    at: new Date(msg.createTime ?? Date.now()),
    _raw: msg,
  };
}

/** 把我们 OutgoingMessage.parts 翻译成飞书 SendInput。飞书 send() 一次只发一个 payload，
 *  所以多 parts 时循环调用 send。 */
async function sendLark(channel: LarkChannel, targetId: string, part: OutgoingPart): Promise<{ messageId: string } | null> {
  let result: { messageId: string } | null = null;
  switch (part.kind) {
    case "text": {
      result = (await channel.send(targetId, { text: part.text } as SendInput)) ?? null;
      break;
    }
    case "image": {
      if (part.filePath) {
        // 飞书 image: { image: { source: path/Buffer } }
        result = (await channel.send(targetId, {
          image: { source: part.filePath },
        } as SendInput)) ?? null;
      } else if (part.url) {
        throw new Error("image URL 需要先下载到本地 filePath");
      } else {
        throw new Error("image part needs filePath or url");
      }
      break;
    }
    case "audio": {
      // 飞书 SDK 会从 Opus 自动解析时长；兼容旧的非 Opus 音频时仍显式估算 duration。
      if (part.mime === "audio/ogg" || path.extname(part.filePath).toLowerCase() === ".opus") {
        result = (await channel.send(targetId, {
          audio: { source: part.filePath },
        } as SendInput)) ?? null;
        break;
      }
      const duration = await getAudioDurationMs(part.filePath);
      console.log("[Feishu audio] send file:", part.filePath, "duration:", duration, "mime:", part.mime);
      if (!duration) {
        throw new Error(`无法解析音频时长: ${part.filePath}`);
      }
      result = (await channel.send(targetId, {
        audio: {
          source: part.filePath,
          duration,
        },
      } as SendInput)) ?? null;
      break;
    }
    case "card": {
      result = (await channel.send(targetId, {
        card: {
          schema: "2.0",
          header: { title: { tag: "plain_text", content: part.title }, template: "blue" },
          elements: [
            { tag: "div", text: { tag: "lark_md", content: part.markdown ?? "" } },
            ...(part.fields && part.fields.length > 0
              ? [
                  {
                    tag: "div",
                    fields: part.fields.map((f) => ({
                      is_short: true,
                      text: { tag: "lark_md", content: `**${f.key}**\n${f.value}` },
                    })),
                  },
                ]
              : []),
          ],
        },
      } as unknown as SendInput)) ?? null;
      break;
    }
    case "sticker": {
      result = (await channel.send(targetId, {
        image: { source: part.imagePath },
      } as SendInput)) ?? null;
      break;
    }
  }
  return result;
}

export class FeishuAdapter implements ChannelAdapter {
  readonly id = "feishu" as const;
  readonly displayName = "飞书";
  readonly capability = FEISHU_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private channel: LarkChannel | null = null;
  private status: ChannelStatus = { enabled: false, phase: "config_missing" };
  /** connect() 失败后的定时重建句柄；连接成功、停用或手动 rebuild 时清除 */
  private connectRetryTimer: NodeJS.Timeout | null = null;

  constructor() {
    // start() 时再初始化
  }

  /** 重建 LarkChannel 实例（用户在 UI 里改了 AppID/Secret 后调） */
  private async rebuildChannel(): Promise<LarkChannel | null> {
    const settings = loadChannelsSettings().feishu;
    if (!settings.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未启用" };
      return null;
    }
    if (!settings.appId || !settings.appSecret) {
      this.status = {
        enabled: true,
        phase: "config_missing",
        message: "App ID / App Secret 缺失",
      };
      return null;
    }

    const ch = createLarkChannel({
      appId: settings.appId,
      appSecret: settings.appSecret,
      domain: Domain.Feishu,
      loggerLevel: LoggerLevel.warn,
      transport: "websocket",
      // 禁止启用 SDK 的 handshakeTimeoutMs 看门狗：其超时回调先 removeAllListeners()
      // 再 terminate()，ws 库对"连接建立中"的 socket 会异步 emit('error')，
      // 此刻监听器已清空，错误直接炸成主进程 Uncaught Exception。
      // 首连失败的恢复由 start() 之后的定时重建兜底。
    });

    // 绑定入站消息
    ch.on("message" as EventName, async (msg: NormalizedMessage) => {
      // 私聊 only（方案决策）
      if (msg.chatType !== "p2p") {
        console.log(LOG, `忽略 ${msg.chatType} 消息 (私聊优先)`);
        return;
      }
      try {
        const inMsg = await normalizeLarkMessage(ch, msg);
        if (this.onMessage) {
          await this.onMessage(inMsg);
        }
      } catch (err) {
        console.error(LOG, "处理入站消息失败:", err);
      }
    });

    // 错误/重连事件
    ch.on("error" as EventName, (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "channel error:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    });
    ch.on("reconnecting" as EventName, () => {
      console.log(LOG, "reconnecting…");
      this.status = { enabled: true, phase: "starting", message: "重新连接中" };
    });
    ch.on("reconnected" as EventName, () => {
      console.log(LOG, "reconnected");
      this.status = { enabled: true, phase: "running", message: "已连接" };
    });

    this.channel = ch;
    return ch;
  }

  async start(): Promise<void> {
    const ch = await this.rebuildChannel();
    if (!ch) return;

    try {
      await ch.connect();
      this.status = { enabled: true, phase: "running", message: "长连接已建立" };
      logger.info(LogTag.Feishu, "WS long connection ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "connect() failed:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
      this.scheduleConnectRetry();
    }
  }

  /** 首连失败后定时重建整个 channel。SDK 内部的自动重连只覆盖"连上后断开"，
   *  首连挂死（握手无响应）只能靠新建连接恢复；固定 30 秒重试直到成功或停用。 */
  private scheduleConnectRetry(): void {
    if (this.connectRetryTimer) return;
    console.warn(LOG, "30 秒后自动重建连接");
    this.connectRetryTimer = setTimeout(() => {
      this.connectRetryTimer = null;
      // 到点时用户可能已停用飞书，停用状态下不再重建
      if (!loadChannelsSettings().feishu.enabled) return;
      void this.rebuild();
    }, 30_000);
  }

  private clearConnectRetryTimer(): void {
    if (this.connectRetryTimer) {
      clearTimeout(this.connectRetryTimer);
      this.connectRetryTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.clearConnectRetryTimer();
    if (this.channel) {
      try {
        await this.channel.disconnect();
      } catch (err) {
        console.warn(LOG, "disconnect 失败:", err);
      }
      this.channel = null;
    }
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().feishu;
    if (!settings.enabled) {
      return { enabled: false, phase: "offline", message: "未启用" };
    }
    if (!settings.appId || !settings.appSecret) {
      return { enabled: true, phase: "config_missing", message: "App ID/Secret 缺失" };
    }
    return this.status;
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.channel) {
      console.warn(LOG, "send 失败: 长连接未建立");
      return { ok: false, error: "飞书长连接未建立" };
    }
    if (!msg.parts || msg.parts.length === 0) {
      return { ok: false, error: "没有可发送的内容" };
    }
    console.log(LOG, `send: targetId=${msg.targetId} parts=${msg.parts.length}`);
    let lastErr: string | undefined;
    let anyOk = false;
    for (const part of msg.parts) {
      try {
        const r = await sendLark(this.channel, msg.targetId, part);
        console.log(LOG, `send ok: messageId=${r?.messageId ?? "?"}`);
        anyOk = true;
      } catch (err) {
        lastErr = err instanceof Error ? err.message : String(err);
        console.error(LOG, `send part failed: targetId=${msg.targetId} part=${part.kind} err=`, lastErr, err);
      }
    }
    if (!anyOk) return { ok: false, error: lastErr ?? "send failed" };
    return { ok: true };
  }

  /** 给外部：触发重建（用户改 AppID/Secret 后调用） */
  public async rebuild(): Promise<void> {
    this.clearConnectRetryTimer();
    if (this.channel) {
      try {
        await this.channel.disconnect();
      } catch {
        /* ignore */
      }
      this.channel = null;
    }
    await this.start();
  }
}
