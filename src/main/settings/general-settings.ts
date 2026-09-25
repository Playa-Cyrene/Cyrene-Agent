import type { UiTheme } from "../../shared/ui-theme";
import type { UiFont } from "../../shared/ui-font";
import type { UiIcon } from "../../shared/ui-icon";
import type { MessageTypography } from "../../shared/message-typography";
import type {
  DefaultChatMode,
  MobileMessageSegmentationMode,
  ProactiveChatMode,
  ProactiveDeliveryTarget,
  SegmentedOutputMode,
} from "../../shared/preferences";
import type { CustomStyleConfig, StyleId } from "../../shared/style-sampling";
import type { ToolModeOverrides } from "../orchestrator/tools/registry/tool-registry";
import type { SkillModeOverrides } from "../skills/types";
import type { LspServerOverride } from "../lsp/types";

/**
 * 通用设置（GeneralSettings）：与模型配置无关的 UI、TTS、工具开关、快捷键等。
 * 统一保存到 general-settings.json。
 */
export interface GeneralSettings {
  /** 功能插件开关表：pluginId -> enabled */
  plugins: Record<string, boolean>;
  /** Harness 同时执行已明确安全工具的上限；1 表示完全串行。 */
  maxParallelToolCalls: number;
  citaEnabled: boolean;
  citaSemanticEngine: "remote";
  /** Chat 模式的轻量社交上下文；默认关闭，开启后每轮最多多一次异步抽取调用。 */
  chatSocialContextEnabled: boolean;
  /** 朋友圈功能总开关：关闭后 UI 隐藏、Chat 上下文不注入、昔涟不反应不发帖。 */
  momentsEnabled: boolean;
  /** Chat 模式注入近期朋友圈动态背景；默认开启（只读本地数据，无额外 LLM 调用）。 */
  chatMomentsContextEnabled: boolean;
  /** 昔涟主动发帖；默认关闭（审慎，与 proactiveChatMode 默认 off 一致）。 */
  cyreneMomentsPostingEnabled: boolean;
  /** 昔涟对朋友圈动态的点赞/评论反应；默认开启（Feed 内被动行为，不打扰）。 */
  cyreneMomentsReactionsEnabled: boolean;
  /** 角色对朋友圈动态的点赞/评论/互聊；默认开启（有独立日调用上限兜底成本）。 */
  momentsCharacterReactionsEnabled: boolean;
  /** 朋友圈热闹程度：控制每条动态的抽签人数分布与角色日调用上限。
   *  quiet=现状（冷场常见），natural=冷场减半，lively=上限 5 人冷场罕见。 */
  momentsLiveliness: "quiet" | "natural" | "lively";
  petAlwaysOnTop: boolean;
  /** 记住设置与音乐窗口的位置和大小。 */
  rememberWindowState: boolean;
  petVisible: boolean;
  /** 桌宠缩放因子：1.0=默认，0.5~2.0，窗口与模型同步等比缩放。 */
  petZoom: number;
  /** 桌宠窗口 X 坐标，未保存时为 undefined */
  petWindowX?: number;
  /** 桌宠窗口 Y 坐标，未保存时为 undefined */
  petWindowY?: number;
  disableGpuElectron?: boolean;
  /** 提醒中心音效总开关：关闭后所有 toast 静音，弹窗行为不受影响。 */
  toastSoundEnabled: boolean;
  launchAtLogin: boolean;
  /** 界面语言：目前支持中文与英文，其余语言待翻译补齐后开放。 */
  language: "zh-CN" | "en";
  uiTheme: UiTheme;
  windowCornerRadius: number;
  /** @deprecated 旧版透明窗口开关，仅保留用于配置兼容。 */
  uiThemeRadius: boolean;
  uiFont: UiFont;
  uiIcon: UiIcon;
  /** 昔涟回复正文的排版（字号/行距/字距/字重），只作用于 AI 回复气泡。 */
  messageTypography: MessageTypography;
  /** 聊天窗口打开时默认选中的模式。 */
  defaultChatMode: DefaultChatMode;
  /** 聊天窗口当前风格，启动时恢复；本轮请求仍以 renderer 显式 styleId 为准。 */
  currentStyleId: StyleId;
  /** 全局自定义风格采样配置。 */
  customStyle: CustomStyleConfig;
  /** 聊天气泡分段输出偏好。 */
  segmentedOutputMode: SegmentedOutputMode;
  /** 手机渠道文本消息分段发送偏好。 */
  mobileMessageSegmentation: MobileMessageSegmentationMode;
  /** 主动聊天功能开关占位；当前不接实际逻辑。 */
  proactiveChatMode: ProactiveChatMode;
  /** 主动消息最终投递到本地、微信或飞书。 */
  proactiveDeliveryTarget: ProactiveDeliveryTarget;
  // TTS 配置
  ttsEngine: "off" | "minimax" | "gptsovits" | "custom-cloud" | "mimo" | "mossland";
  ttsAutoRead: boolean;
  ttsSpeed: number;
  ttsVolume: number;
  /** 自动语音早播的文本切分是否开启：关闭时不再流式切分，收完整条回复再整段朗读。 */
  ttsEarlyReadSplitEnabled: boolean;
  /** 自动语音早播的文本切分方式：sentence=一句一切（默认，现状）；paragraph=一段一切（仅空行段落切分）。 */
  ttsEarlyReadSplitMode: "sentence" | "paragraph";
  // MiniMax
  ttsMinimaxKey: string;
  ttsMinimaxVoiceId: string;
  /** MiniMax 合成模型：speech-2.8-hd(高保真¥3.5/万字符) | speech-2.8-turbo(极速¥2.0/万字符) */
  ttsMinimaxModel: "speech-2.8-hd" | "speech-2.8-turbo";
  /** MiniMax 流式播放（边合成边播，首字延迟低）；false=完整合成收完再播 */
  ttsStreaming: boolean;
  /** MiniMax 语音增强：自动插入 (laughs)、(breath) 等语气词标签 */
  ttsMinimaxVocalEnhance: boolean;
  // GPT-SoVITS（本地）
  ttsGptsovitsBaseUrl: string;
  ttsGptsovitsRefAudioPath: string;
  ttsGptsovitsPromptText: string;
  ttsGptsovitsFormat: "wav" | "mp3";
  /** GPT-SoVITS 单次合成超时（毫秒）。本地推理长文本可能较慢，默认 3 分钟。 */
  ttsGptsovitsTimeoutMs: number;
  // 自定义云端 TTS
  ttsCustomCloudEndpointUrl: string;
  ttsCustomCloudApiKey: string;
  ttsCustomCloudVoiceId: string;
  ttsCustomCloudFormat: "wav" | "mp3";
  ttsCustomCloudTimeoutMs: number;
  // 小米 MiMo TTS
  ttsMimoKey: string;
  ttsMimoVoiceAudioPath: string;
  ttsMimoStylePrompt: string;
  // Mossland TTS
  ttsMosslandKey: string;
  ttsMosslandVoiceId: string;
  ttsMosslandModel: string;
  ttsMosslandTestText: string;
  ttsMosslandFormat: "mp3" | "wav";
  /** 天气源：open-meteo(免配置默认) | amap(高德,需填key) */
  weatherSource: "open-meteo" | "amap";
  /** 天气插件是否启用（开关） */
  weatherEnabled: boolean;
  /** 高德天气 key（https://lbs.amap.com 注册 Web服务 key） */
  amapKey: string;
  /** 🚗出行工具是否启用 */
  travelEnabled: boolean;
  /** 🖥️ 浏览器自动化（Playwright MCP）是否启用。默认 false，需用户手动开启。 */
  playwrightMcpEnabled: boolean;
  /** 📁 文件系统 MCP（官方 server-filesystem，允许目录为下载文件夹）是否启用。默认 false。 */
  filesystemMcpEnabled: boolean;
  // 联网搜索：选哪个搜索源 + 对应 key
  searchEngine: "off" | "bocha" | "tavily" | "minimax" | "anySearch";
  searchBochaKey: string;
  searchTavilyKey: string;
  searchMinimaxKey: string;
  searchAnySearchKey: string;
  /** ✉️邮件发送插件是否启用 */
  emailEnabled: boolean;
  /** SMTP 主机，如 smtp.qq.com */
  emailSmtpHost: string;
  /** SMTP 端口，如 465（SSL）/ 587（STARTTLS） */
  emailSmtpPort: number;
  /** 使用 SSL/TLS（465 通常 true，587 通常 false；用户可覆盖） */
  emailSmtpSecure: boolean;
  /** 发件邮箱地址 */
  emailSmtpUser: string;
  /** SMTP 授权码（非邮箱登录密码） */
  emailSmtpPass: string;
  /** 发件人显示名（可选） */
  emailFromName: string;
  /** 🎧ASR 服务商：off(关闭) | aliyun(阿里云) | mossland(MOSI) | local(本地,占位) */
  asrEngine: "off" | "aliyun" | "mossland" | "local";
  /** 阿里云智能语音交互 AppKey */
  asrAliyunAppKey: string;
  /** 阿里云 RAM AccessKey ID */
  asrAliyunAccessKeyId: string;
  /** 阿里云 RAM AccessKey Secret */
  asrAliyunAccessKeySecret: string;
  /** ASR 识别语言：zh(中文) | en(英文) | auto(自动) */
  asrLanguage: "zh" | "en" | "auto";
  /** VAD 静默检测阈值（毫秒），500~2000，默认 1000 */
  asrVadSilenceMs: number;
  /** VAD 音量阈值（0~1），默认 0.01。环境吵或麦克风音量低时可调 */
  asrVadThreshold: number;
  /** 通话中显示文字转写 */
  asrShowTranscript: boolean;
  /** 截图全局热键（Electron Accelerator 格式，如 "Alt+Shift+S"） */
  screenshotHotkey: string;
  /** 工具-模式覆盖层：用户自定义每个工具在 learn/code/work 模式下的可见性。
   *  key = toolId，value = { mode: enabled }。覆盖优先于工具声明的 modes 字段。
   *  空对象 = 全部按默认（modes 字段或全可见），由设置面板 UI 写入。 */
  toolModeOverrides: ToolModeOverrides;
  /** Chat 模式工具增强总开关：false=纯聊天（现状零影响）；true=勾选的工具
   *  经 toolModeOverrides.chat 放行，chat 会话走 CyreneHarness native function calling。 */
  chatToolsEnabled: boolean;
  /** Skill-模式覆盖层：用户自定义每个 skill 在 work/code/learn 模式下的可见性。
   *  key = skillId，value = { mode: enabled }。覆盖优先于 skill 声明的 modes 字段。
   *  空对象 = 全部按默认（modes 字段或全可见），由设置面板 UI 写入。 */
  skillModeOverrides: SkillModeOverrides;
  /** Code 模式使用的用户自管语言服务命令覆盖。 */
  lspServerOverrides: LspServerOverride[];
  /** 最近绑定的项目文件夹（绝对路径），按最近使用时间倒序，最多保留 10 个。 */
  recentProjects: string[];
  /** 用户明确接受的免责声明版本；空字符串表示尚未接受当前条款。 */
  disclaimerAcceptedVersion?: string;
}
