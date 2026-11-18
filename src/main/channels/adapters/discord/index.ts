// DiscordAdapter —— implements ChannelAdapter。
//
// 接入方式：**长连接 WebSocket**（discord.js Gateway）。
// 和飞书一样是完全出站连接：
//   - 不需要公网 HTTPS URL / 内网穿透
//   - 重连 / 心跳 / 鉴权由 discord.js Client 自动处理
//   - 需要提供一个 Discord Bot Token（在 Discord Developer Portal 创建 Bot 后获取）
//
// 數據流：
//   Discord Gateway ←WSS→ discord.js Client
//       ↓ `messageCreate` / `interactionCreate`
//   DiscordAdapter.handleMessage / handleInteraction → adapter.onMessage (dispatcher)
//       ↓ CyreneAgent runs
//   DiscordAdapter.send(...) → 回覆至同一頻道或私訊
//
// 對話模式（在**伺服器頻道**中對話，用正式 slash command）：
//   - 連上時自動在 Bot 已加入的每個伺服器註冊 `/startagent`（guild command，立即生效）。
//   - 使用者在你想要對話的文字頻道輸入 `/startagent` → 該頻道被綁定為唯一「對話頻道」，
//     綁定會透過 settings-store 持久化，重啟後仍保留，同步收到「啟動成功」回覆。
//   - 之後只有**綁定頻道**裡有人 **@ 提到 Bot** 才會觸發對話，回覆在同一個頻道。
//   - 你可以隨時回到該頻道確認完整對話內容（不另建頻道）。
//   - 私訊(DM) 仍然可用：直接私訊 Bot 即可對話。
//
// 設計決策：
//   - 群聊頻道：僅當被 `/startagent` 綁定頻道 + 有人 @Bot 時回應；避免誤觸發 / 刷屏。
//   - 入站圖片/文件會下載到 userData/channels/cache/，以 filePath 寫進
//     IncomingMessage.attachments，buildAgentRunOptions 會把路徑注入 prompt。
//   - 出站 parts 翻譯：text → 純文本；image/file/audio/video → AttachmentBuilder；
//     card → EmbedBuilder；sticker → 當作圖片附件。
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import {
  AttachmentBuilder,
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  type BaseGuildTextChannel,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type { ChannelAdapter } from "../base";
import type {
  ChannelCapability,
  ChannelStatus,
  ChannelAttachment,
  IncomingMessage,
  MessageHandler,
  OutgoingMessage,
  OutgoingPart,
} from "../../types";
import { loadChannelsSettings, saveChannelsSettings } from "../../settings-store";
import {
  ensureDiscordSessionAndOpen,
  appendDiscordUserMessage,
  appendDiscordReply,
  currentDiscordMode,
  getLastDiscordErrorAt,
  getDiscordSessionWorkspace,
  recordCurrentDiscordSessionId,
} from "./discord-session";
import { getDiscordMessageAccess, recordDiscordMessageAccess } from "./access";
import { DiscordSpotifyPlayer, spotifyCommand } from "./spotify-command";
import { getDiscordVoiceReplyText, resolveDiscordMessageContext } from "./message-context";
import { getDefaultModelProfile, loadModelSettings } from "../../../settings/model-settings";
import { getCurrentLevel, ACCESS_LEVEL_LABEL } from "../../../permission";
import { logger, LogTag } from "../../../logger";

const LOG = "[DiscordAdapter]";
const OWNER_LOOKUP_TTL_MS = 60_000;

/** 頻道綁定的正式 slash command 名稱。 */
const SLASH_STARTAGENT = "startagent";
const SLASH_STARTAGENT_DESC = "把本頻道設為 Cyrene 的對話頻道（之後在本頻道 @我 就能對話）";
const SLASH_STATUS = "status";
const SLASH_STATUS_DESC = "顯示目前的執行模式、模型及最近一次失敗時間";
const SLASH_MODE = "mode";
const SLASH_MODE_DESC = "切換執行模式：/mode work = 可呼叫工具，/mode chat = 純聊天";

/** Discord capability 声明。Discord 原生支持文本/富文本(markdown)/embed/附件。 */
const DISCORD_CAPABILITY: ChannelCapability = {
  text: true,
  image: true,
  audio: true,
  file: true,
  video: true,
  markdown: true,
  card: true,
  sticker: false, // Discord 没有我们的"内置表情包"；sticker 会按 cap 降级跳过
  maxTextLength: 2000, // Discord 单条消息上限 2000 字符
};

/** 根据 URL 后缀 / MIME 推断下载后的扩展名。 */
function extFromUrl(url: string, fallback = ".bin"): string {
  try {
    const clean = url.split("?")[0];
    const m = /\.([a-zA-Z0-9]+)$/.exec(clean);
    return m ? `.${m[1].toLowerCase()}` : fallback;
  } catch {
    return fallback;
  }
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".mp3": return "audio/mpeg";
    case ".wav": return "audio/wav";
    case ".ogg":
    case ".oga": return "audio/ogg";
    case ".mp4": return "video/mp4";
    case ".webm": return "video/webm";
    case ".txt":
    case ".md":
    case ".log":
    case ".csv": return "text/plain";
    case ".json": return "application/json";
    case ".pdf": return "application/pdf";
    default: return "application/octet-stream";
  }
}

/** 把 Discord 附件下载到本地缓存目录，返回本地路径。失败返回 null。 */
async function downloadDiscordAttachment(
  url: string,
  fileName: string | undefined,
  fallbackKind: ChannelAttachment["kind"],
): Promise<{ filePath: string; mime: string } | null> {
  try {
    const cacheDir = path.join(app.getPath("userData"), "channels", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const ext = fileName ? path.extname(fileName).toLowerCase() || extFromUrl(url) : extFromUrl(url);
    const baseName = fileName
      ? fileName.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80)
      : fallbackKind;
    const localPath = path.join(cacheDir, `discord-${Date.now()}-${baseName}${ext}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(localPath, buf);
    return { filePath: localPath, mime: mimeFromExt(ext) };
  } catch (err) {
    console.warn(LOG, `下载 Discord 附件失败:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把出站 parts 翻译成 Discord 可发送的内容（单条消息可能含多附件/多 embed）。 */
function buildDiscordSendPayload(parts: OutgoingPart[]): {
  text: string;
  attachments: AttachmentBuilder[];
  embeds: EmbedBuilder[];
} {
  const textParts: string[] = [];
  const attachments: AttachmentBuilder[] = [];
  const embeds: EmbedBuilder[] = [];

  for (const part of parts) {
    switch (part.kind) {
      case "text": {
        const t = (part.text ?? "").trim();
        if (t) textParts.push(t);
        break;
      }
      case "card": {
        const embed = new EmbedBuilder().setTitle(part.title);
        if (part.markdown) {
          embed.setDescription(part.markdown.slice(0, 4000));
        }
        if (part.fields && part.fields.length > 0) {
          embed.addFields(
            part.fields.map((f) => ({ name: f.key.slice(0, 256), value: f.value.slice(0, 1024) })),
          );
        }
        embeds.push(embed);
        break;
      }
      case "image": {
        const src = part.filePath ?? part.url;
        if (src) {
          attachments.push(
            new AttachmentBuilder(src, { name: path.basename(src).slice(0, 100) }),
          );
        }
        break;
      }
      case "sticker": {
        if (part.imagePath) {
          attachments.push(
            new AttachmentBuilder(part.imagePath, { name: `${part.stickerId}.png` }),
          );
        }
        break;
      }
      case "audio":
      case "video":
      case "file": {
        if (part.filePath) {
          const name = part.kind === "file"
            ? (part.name ?? path.basename(part.filePath))
            : path.basename(part.filePath);
          attachments.push(
            new AttachmentBuilder(part.filePath, { name: name.slice(0, 100) }),
          );
        }
        break;
      }
    }
  }

  return { text: textParts.join("\n").slice(0, 2000), attachments, embeds };
}

export class DiscordAdapter implements ChannelAdapter {
  readonly id = "discord" as const;
  readonly displayName = "Discord";
  readonly capability = DISCORD_CAPABILITY;
  onMessage: MessageHandler | null = null;

  private client: Client | null = null;
  private status: ChannelStatus = { enabled: false, phase: "config_missing" };
  private started = false;
  private readonly spotify = DiscordSpotifyPlayer.fromEnvironment();
  private ownerLookup?: { client: Client; expiresAt: number; result: Promise<string | null> };
  #seenMessageIds = new Set<string>();

  constructor() {}

  /** 生成一个新的 discord.js Client（token 变化后 rebuild 用）。 */
  private createClient(): Client {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    client.once(Events.ClientReady, (c) => {
      console.log(LOG, `ready: 已登录 ${c.user?.username}`);
      this.status = { enabled: true, phase: "running", message: `已连接（${c.user?.tag ?? c.user?.username}）` };
      void this.registerSlashCommands(c);
      const cfg = loadChannelsSettings().discord;
      if (cfg.boundChannelId) {
        console.log(LOG, `已綁定對話頻道: ${cfg.boundChannelName ?? cfg.boundChannelId}`);
      }
    });

    client.on(Events.Error, (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "client error:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    });

    client.on(Events.MessageCreate, (msg) => {
      void this.handleMessage(msg);
    });

    client.on(Events.InteractionCreate, (interaction) => {
      void this.handleInteraction(interaction);
    });

    return client;
  }

  /** 連上後，在每個已加入的伺服器註冊 /startagent /status /mode（guild command，立即生效；重複註冊用 set 覆蓋）。 */
  private async registerSlashCommands(client: Client): Promise<void> {
    const commandData = [
      { name: SLASH_STARTAGENT, description: SLASH_STARTAGENT_DESC },
      { name: SLASH_STATUS, description: SLASH_STATUS_DESC },
      {
        name: SLASH_MODE,
        description: SLASH_MODE_DESC,
        options: [
          {
            name: "mode",
            description: "work = 可呼叫工具；chat = 純聊天",
            type: 3, // STRING
            required: true,
            choices: [
              { name: "work", value: "work" },
              { name: "chat", value: "chat" },
            ],
          },
        ],
      },
      ...(this.spotify ? [spotifyCommand] : []),
    ];
    try {
      const app = client.application;
      if (!app?.id) {
        console.warn(LOG, "application 資訊尚不可用，跳過註冊指令");
        return;
      }
      for (const guild of client.guilds.cache.values()) {
        try {
          await guild.commands.set(commandData);
          console.log(LOG, `已註冊 /${SLASH_STARTAGENT} /${SLASH_STATUS} /${SLASH_MODE} 到 ${guild.name} (${guild.id})`);
        } catch (err) {
          console.warn(LOG, `註冊指令到 ${guild.id} 失敗:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.warn(LOG, "註冊指令失敗（請在 Bot 的 OAuth2 scope 勾選 applications.commands）:", err instanceof Error ? err.message : err);
    }
  }

  /** 處理 slash command 互動：/startagent → 綁定頻道；/status → 回報模型與錯誤。 */
  private async handleInteraction(interaction: unknown): Promise<void> {
    if (!(interaction as { isChatInputCommand?: () => boolean }).isChatInputCommand?.()) return;
    const cmd = interaction as ChatInputCommandInteraction;
    const command = cmd.commandName;
    if (command !== SLASH_STATUS && command !== SLASH_MODE && command !== SLASH_STARTAGENT
      && !(this.spotify && command === spotifyCommand.name)) return;

    try {
      await cmd.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.warn(LOG, `/${command} deferReply 失敗:`, err instanceof Error ? err.message : err);
      return;
    }
    if (cmd.client !== this.client || !await this.isApplicationOwner(cmd.user.id)) {
      await cmd.editReply("只有 Discord 應用程式擁有者可以使用此指令。").catch(() => {});
      return;
    }
    if (this.spotify && command === spotifyCommand.name) {
      await this.spotify.handleCommand(cmd).catch(() => {});
      return;
    }

    // /status：回報模型/API 設定與最近一次錯誤（可在任意頻道或私訊使用）
    if (command === SLASH_STATUS) {
      await this.handleStatusCommand(cmd);
      return;
    }
    // /mode：切換執行模式（work=可呼叫工具 / chat=純聊天）
    if (command === SLASH_MODE) {
      await this.handleModeCommand(cmd);
      return;
    }
    // 只在伺服器文字頻道中使用
    if (!cmd.inGuild() || !cmd.channelId) {
      await cmd.editReply("請在伺服器的文字頻道中使用 /startagent。").catch(() => {});
      return;
    }

    try {
      // fetch 真實頻道，避免對 partial channel 呼叫 isTextBased() 而 crash
      const fetched = await cmd.channel?.fetch();
      if (cmd.client !== this.client) return;
      if (!fetched || fetched.type !== ChannelType.GuildText) {
        await cmd.editReply("請在一般文字頻道中使用 /startagent。").catch(() => {});
        return;
      }
      const channel = fetched as BaseGuildTextChannel;
      const channelName = channel.name ?? cmd.channelId;
      const cfg = loadChannelsSettings().discord;
      const changed = cfg.boundChannelId !== cmd.channelId;

      saveChannelsSettings({
        discord: {
          ...cfg,
          boundChannelId: cmd.channelId,
          boundChannelName: channelName,
        },
      });

      console.log(LOG, `/${SLASH_STARTAGENT}: 綁定頻道 ${channelName} (${cmd.channelId})`);
      // 建立或取得目前 mode 對應的桌面端 Discord 對話（work/chat），並嘗試開啟聊天窗
      ensureDiscordSessionAndOpen();
      recordCurrentDiscordSessionId();
      await cmd.editReply(
        changed
          ? `✅ 啟動成功！已把本頻道 #${channelName} 設為 Cyrene 的對話頻道。之後在頻道裡 **@我** 就能跟我對話，我也會在這裡回覆。`
          : `✅ 啟動成功！本頻道 (#${channelName}) 已是指定的對話頻道，直接在頻道裡 **@我** 就能開始對話。`,
      ).catch(() => {});
    } catch (err) {
      console.warn(LOG, `/${SLASH_STARTAGENT} 綁定失敗:`, err instanceof Error ? err.message : err);
      await cmd.editReply("❌ 啟動失敗，請確認我有權限在此頻道發言。").catch(() => {});
    }
  }

  private async isApplicationOwner(userId: string): Promise<boolean> {
    const client = this.client;
    const application = client?.application;
    if (!client || !application) return false;
    if (this.ownerLookup?.client !== client || this.ownerLookup.expiresAt <= Date.now()) {
      const result = application.fetch().then(({ owner }) => {
        if (!owner) return null;
        return "ownerId" in owner ? owner.ownerId : owner.id;
      }).catch(() => {
        console.warn(LOG, "無法確認 Discord 應用程式擁有者。");
        return null;
      });
      this.ownerLookup = { client, expiresAt: Date.now() + OWNER_LOOKUP_TTL_MS, result };
    }
    const ownerId = await this.ownerLookup.result;
    return this.client === client && ownerId === userId;
  }

  /** 處理 /status：回報目前模型/API 設定與最近一次錯誤（供除錯，無需綁定頻道）。 */
  private async handleStatusCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    const lines: string[] = [];
    const dsc = loadChannelsSettings().discord;
    const mode = currentDiscordMode();
    lines.push("**📊 Cyrene Agent 狀態**");
    lines.push(`- 綁定頻道：${dsc.boundChannelName ? `#${dsc.boundChannelName}` : "尚未綁定（請用 /startagent）"}`);
    const modeLabel = mode === "work" ? "**Work**（依桌面端權限使用工具）" : "**Chat**（純聊天，不呼叫工具）";
    const modeConv = mode === "work" ? "Discord 對話 (Work)" : "Discord 對話 (Chat)";
    lines.push(`- 執行模式：${modeLabel}`);
    lines.push(`- 對話：${modeConv}`);

    // 工作目錄（與桌面端「指定資料夾」對齊）+ 權限
    lines.push("");
    lines.push("**📁 工作目錄 / 權限**");
    const ws = getDiscordSessionWorkspace(mode);
    if (ws?.workspaceRoot) {
      lines.push("- 已綁定工作目錄");
    } else {
      lines.push("- 工作目錄：未綁定（可在桌面端對話設定「指定資料夾」）");
    }
    const permLevelLabel = getCurrentLevel();
    lines.push(`- 權限檔位：${ACCESS_LEVEL_LABEL[permLevelLabel] ?? permLevelLabel}`);

    // 模型/API 設定
    try {
      const settings = loadModelSettings();
      const ms = getDefaultModelProfile(settings) ?? settings;
      lines.push("");
      lines.push("**🤖 模型 / API**");
      lines.push(`- provider：${ms.provider || "(空)"}`);
      lines.push(`- model：${ms.model || "(空)"}`);
      lines.push(`- API Key：${ms.apiKey ? "已填" : "❌ 未填"}`);
      lines.push(`- transport：${ms.explicitTransport ?? "auto"}`);
    } catch {
      lines.push("", "- 讀取模型設定失敗，請查看桌面端日誌。");
    }

    // 最近一次錯誤
    const last = getLastDiscordErrorAt();
    lines.push("");
    lines.push("**⚠️ 最近一次錯誤**");
    if (!last) {
      lines.push("- 尚無錯誤紀錄。");
    } else {
      lines.push(`- 時間：${last.toLocaleString()}。詳細資訊請查看桌面端日誌。`);
    }

    // 操作提示
    lines.push("");
    lines.push("> 若 API Key 未填或錯誤，請到 Cyrene 設定 → 模型，確認 provider/Key/模型名。");

    const text = lines.join("\n").slice(0, 2000);
    await cmd.editReply({ content: text, allowedMentions: { parse: [] } }).catch(() => {});
  }

  /** 處理 /mode：切換 Discord 執行模式。 */
  private async handleModeCommand(cmd: ChatInputCommandInteraction): Promise<void> {
    const value = cmd.options.getString("mode", true);
    if (value !== "work" && value !== "chat") {
      await cmd.editReply("`/mode` 需要 `work` 或 `chat`。").catch(() => {});
      return;
    }
    try {
      saveChannelsSettings({ discord: { ...loadChannelsSettings().discord, mode: value } });
      // 切換後，目前 mode 對應的工作/聊天對話隨之切換；開啟對應對話視窗並記錄其 session id。
      ensureDiscordSessionAndOpen();
      recordCurrentDiscordSessionId();
      const label = value === "work" ? "**Work**（依桌面端權限使用工具）" : "**Chat**（純聊天，不呼叫工具）";
      console.log(LOG, `/${SLASH_MODE}: 切換至 ${value}`);
      await cmd.editReply(
        `✅ 已切換擁有者的私訊模式為 ${label}。伺服器頻道使用 Chat。`
      ).catch(() => {});
    } catch (err) {
      console.warn(LOG, `/${SLASH_MODE} 切換失敗:`, err instanceof Error ? err.message : err);
      await cmd.editReply("❌ 切換執行模式失敗，請稍後重試。").catch(() => {});
    }
  }

  /** 入口：處理所有普通訊息，決定是否觸發對話。 */
  private async handleMessage(msg: Message): Promise<void> {
    // 忽略自己發的消息與其他 bot
    if (msg.author?.id === this.client?.user?.id) return;
    if (msg.author?.bot) return;
    if (!this.onMessage) {
      console.warn(LOG, "onMessage 未注入，跳過消息");
      return;
    }

    const isGuildChannel = msg.guildId != null;
    const isDM = msg.channel?.type === ChannelType.DM;

    // 1) 伺服器頻道：只有「/startagent 綁定頻道 + @ 提到 Bot」才觸發
    if (isGuildChannel) {
      if (!await this.isBoundChannel(msg.channelId)) {
        return;
      }
      const mentionedBot = Boolean(this.client?.user) && msg.mentions.has(this.client!.user!.id);
      if (!mentionedBot) {
        return; // 沒 @Bot 就不回應，避免刷屏
      }
      const clean = stripBotMention((msg.content ?? "").trim(), this.client!.user!.id);
      await this.dispatchIncoming(msg, clean, true);
      return;
    }

    // 2) 私訊：直接觸發
    if (isDM) {
      await this.dispatchIncoming(msg, (msg.content ?? "").trim(), false);
      return;
    }

    // 其他類型（話題/公告等）忽略
  }

  /** 綁定頻道存在與否（由 /startagent 寫入 settings-store）。 */
  private async isBoundChannel(channelId?: string): Promise<boolean> {
    if (!channelId) return false;
    const cfg = loadChannelsSettings().discord;
    return cfg.boundChannelId === channelId;
  }

  /** 去重、下載附件並轉交 dispatcher。伺服器對話與擁有者的 Work 私訊分開鏡像。 */
  private async dispatchIncoming(msg: Message, text: string, fromGuild: boolean): Promise<void> {
    if (msg.client !== this.client) return;
    // 去重
    if (msg.id && this.#seenMessageIds.has(msg.id)) return;
    if (msg.id) this.#seenMessageIds.add(msg.id);
    if (this.#seenMessageIds.size > 1000) this.#seenMessageIds.clear();

    try {
      const incoming = await this.normalizeDiscordMessage(msg, text);
      if (msg.client !== this.client) return;
      const isOwner = await this.isApplicationOwner(msg.author.id);
      if (msg.client !== this.client) return;
      recordDiscordMessageAccess(incoming, isOwner, currentDiscordMode());
      const { mode } = getDiscordMessageAccess(incoming);
      const mirror = loadChannelsSettings().mirrorToDesktop && (fromGuild || mode === "work");
      if (mirror && text.trim()) appendDiscordUserMessage(text, mode);
      const outgoing = await this.onMessage!(incoming);
      // 鏡像 Bot 回覆到桌面端對應（work/chat）的 Discord 對話
      if (mirror && outgoing?.parts) {
        const replyText = outgoing.parts
          .filter((p) => p.kind === "text")
          .map((p) => (p as { text: string }).text)
          .join("\n")
          .trim();
        if (replyText) appendDiscordReply(replyText, mode);
      }
    } catch (err) {
      console.error(LOG, "處理入站消息失敗:", err instanceof Error ? err.message : err);
      try {
        await this.sendDirectAck(msg);
      } catch { /* ignore */ }
    }
  }

  /** 把 Discord Message 歸一化成 IncomingMessage（含附件下載）。 */
  private async normalizeDiscordMessage(msg: Message, text: string): Promise<IncomingMessage> {
    const attachments: IncomingMessage["attachments"] = [];
    const fromGuild = msg.guildId != null;
    const voiceReplyText = getDiscordVoiceReplyText(text);
    const referencedMessages = voiceReplyText ? undefined : await resolveDiscordMessageContext(msg, text);

    for (const att of msg.attachments.values()) {
      const kind: ChannelAttachment["kind"] = att.contentType?.startsWith("image/")
        ? "image"
        : att.contentType?.startsWith("audio/")
          ? "audio"
          : att.contentType?.startsWith("video/")
            ? "video"
            : "file";
      const downloaded = await downloadDiscordAttachment(att.url, att.name, kind);
      if (downloaded) {
        attachments.push({
          kind,
          filePath: downloaded.filePath,
          mime: downloaded.mime,
          caption: att.name,
        });
      }
    }
    for (const a of attachments) {
      if (a.filePath) text = (text ? text + "\n" : "") + `[附件: ${a.filePath}]`;
    }

    return {
      channel: "discord",
      senderId: msg.author.id,
      senderName: msg.author.username,
      // 頻道模式：chatId = 頻道 id，replies 回到同一頻道；DM：chatId = 使用者 id
      chatId: fromGuild ? msg.channelId : msg.author.id,
      text: (text || "").trim() || "[空消息]",
      voiceReplyText,
      referencedMessages,
      attachments: attachments.length > 0 ? attachments : undefined,
      at: msg.createdAt,
      _raw: { id: msg.id, content: msg.content, channelId: msg.channelId, guildId: msg.guildId },
    };
  }

  /** 觸發訊息處理失敗時的簡短澄清回覆。 */
  private async sendDirectAck(msg: Message): Promise<void> {
    const text = "我處理你的訊息時出了點問題，請稍後重試。";
    const target = msg.guildId ? (msg.channel as BaseGuildTextChannel) : null;
    if (target) {
      await target.send(text);
    } else if (msg.channel && msg.channel.isDMBased()) {
      await msg.author.send(text);
    }
  }

  async start(): Promise<void> {
    if (this.started) return;

    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      this.status = { enabled: false, phase: "offline", message: "未啟用" };
      return;
    }
    const token = (settings.token ?? "").trim();
    if (!token) {
      this.status = { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
      return;
    }

    try {
      this.status = { enabled: true, phase: "starting", message: "連接 Discord Gateway…" };
      this.client = this.createClient();
      this.started = true;
      await this.client.login(token);
      logger.info(LogTag.Channels, `discord adapter started`);
    } catch (err) {
      this.started = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error(LOG, "login() failed:", msg);
      this.status = { enabled: true, phase: "error", message: msg };
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ownerLookup = undefined;
    if (this.client) {
      try {
        this.client.destroy();
      } catch (err) {
        console.warn(LOG, "destroy 失敗:", err);
      }
      this.client = null;
    }
    this.#seenMessageIds.clear();
    this.status = { enabled: false, phase: "offline", message: "已停止" };
  }

  async send(msg: OutgoingMessage): Promise<{ ok: boolean; error?: string }> {
    if (!this.client) {
      console.warn(LOG, "send 失敗: Discord 未連接");
      return { ok: false, error: "Discord 未連接" };
    }
    if (!msg.parts || msg.parts.length === 0) {
      return { ok: false, error: "沒有可發送的內容" };
    }

    const { text, attachments, embeds } = buildDiscordSendPayload(msg.parts);
    if (!text && attachments.length === 0 && embeds.length === 0) {
      return { ok: false, error: "沒有可發送的內容（capability 全部被降級）" };
    }
    const payload = { content: text || undefined, files: attachments, embeds, allowedMentions: { parse: [] } };

    // targetId 可能是頻道 id（頻道模式）或使用者 id（DM）。先嘗試當頻道解析。
    try {
      const channel = await this.tryResolveTextChannel(msg.targetId);
      if (channel) {
        await channel.send(payload);
        console.log(LOG, `send ok: channel=${channel.id} parts=${msg.parts.length}`);
        return { ok: true };
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(LOG, `頻道發送失敗 [${msg.targetId}]，改走 DM:`, reason);
    }

    // 非頻道 → 視為 DM
    try {
      const user = await this.client.users.fetch(msg.targetId);
      await user.send(payload);
      console.log(LOG, `send ok (DM): target=${msg.targetId} parts=${msg.parts.length}`);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(LOG, `send 失敗 [${msg.targetId}]:`, reason);
      return { ok: false, error: reason };
    }
  }

  /** 嘗試把 targetId 當作伺服器文字頻道解析；解析失敗返回 null。 */
  private async tryResolveTextChannel(targetId: string): Promise<BaseGuildTextChannel | null> {
    try {
      const fetched = await this.client!.channels.fetch(targetId);
      // 用 enum 型別判斷（GuildText），避免對 partial channel 呼叫 isTextBased() crash
      if (fetched && fetched.type === ChannelType.GuildText) {
        return fetched as BaseGuildTextChannel;
      }
      return null;
    } catch {
      return null;
    }
  }

  getStatus(): ChannelStatus {
    const settings = loadChannelsSettings().discord;
    if (!settings.enabled) {
      return { enabled: false, phase: "offline", message: "未啟用" };
    }
    if (!settings.token) {
      return { enabled: true, phase: "config_missing", message: "Bot Token 缺失" };
    }
    return this.status;
  }

  /** 給外部：觸發重建（用戶改了 token 後調用）。 */
  public async rebuild(): Promise<void> {
    await this.stop();
    await this.start();
  }
}

/** 從訊息中移除 Discord 的 @ 提及（含群組角色 <@&...>），只保留純文字內容。 */
function stripBotMention(content: string, botId: string): string {
  // 1) 移除特定 Bot 提及：<@123>（一般）或 <@!123>（舊式 / nickname）
  const botMentionRegex = new RegExp(`<@!?${escapeRegex(botId)}>`, "g");
  let cleaned = content.replace(botMentionRegex, " ");
  // 2) 移除其餘 Discord 提及/標記 token：<@&> 群組角色、<@> 使用者、<#> 頻道、
  //    <:emojiname:id> 及 <a:animated...:id> 自訂表情
  cleaned = cleaned.replace(/<@&?\d+>/g, " ");                   // <@...>, <@!...>, <@&...>
  cleaned = cleaned.replace(/<#\d+>/g, " ");                     // channel
  cleaned = cleaned.replace(/<(a?):[A-Za-z0-9_]+:\d+>/g, " ");  // custom emoji
  return cleaned.replace(/\s+/g, " ").trim();
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
