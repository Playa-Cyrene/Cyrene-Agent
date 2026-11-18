// Channels 面板 DOM 引用
// 从 settings.ts 抽离。ESM 静态导入保证查询在 settings.ts 顶层代码之前执行。

export const channelsWechatEnabledEl = document.getElementById("channels-wechat-enabled") as HTMLInputElement | null;
export const channelsFeishuEnabledEl = document.getElementById("channels-feishu-enabled") as HTMLInputElement | null;
export const channelsDiscordEnabledEl = document.getElementById("channels-discord-enabled") as HTMLInputElement | null;
export const channelsWechatStatusEl = document.getElementById("channels-wechat-status");
export const channelsFeishuStatusEl = document.getElementById("channels-feishu-status");
export const channelsDiscordStatusEl = document.getElementById("channels-discord-status");
export const channelsRateUserEl = document.getElementById("channels-rate-user") as HTMLInputElement | null;
export const channelsRateChannelEl = document.getElementById("channels-rate-channel") as HTMLInputElement | null;
export const channelsTtsEl = document.getElementById("channels-tts-enabled") as HTMLInputElement | null;
export const channelsStickerEl = document.getElementById("channels-sticker-enabled") as HTMLInputElement | null;
export const channelsMirrorEl = document.getElementById("channels-mirror-desktop") as HTMLInputElement | null;
export const channelsToolSandboxOffEl = document.getElementById("channels-tool-sandbox-off") as HTMLInputElement | null;
export const channelsToolSandboxAllEl = document.getElementById("channels-tool-sandbox-all") as HTMLInputElement | null;
export const channelsFeishuAppIdEl = document.getElementById("channels-feishu-app-id") as HTMLInputElement | null;
export const channelsFeishuAppSecretEl = document.getElementById("channels-feishu-app-secret") as HTMLInputElement | null;
export const channelsFeishuAppSecretRevealBtn = document.getElementById("channels-feishu-app-secret-reveal");
export const channelsFeishuSaveBtn = document.getElementById("channels-feishu-save");
export const channelsDiscordTokenEl = document.getElementById("channels-discord-token") as HTMLInputElement | null;
export const channelsDiscordTokenRevealBtn = document.getElementById("channels-discord-token-reveal");
export const channelsDiscordSaveBtn = document.getElementById("channels-discord-save");
export const channelsDiscordBoundEl = document.getElementById("channels-discord-bound");
export const channelsDiscordFallbackModelEl = document.querySelector<HTMLSelectElement>("#channels-discord-fallback-model");
export const channelsDiscordFallbackUsersEl = document.querySelector<HTMLInputElement>("#channels-discord-fallback-users");
export const channelsWechatLoginBtn = document.getElementById("channels-wechat-login");
export const channelsWechatRestartBtn = document.getElementById("channels-wechat-restart");
export const channelsWechatFeedbackEl = document.getElementById("channels-wechat-feedback");
export const channelsFeishuFeedbackEl = document.getElementById("channels-feishu-feedback");
export const channelsDiscordFeedbackEl = document.getElementById("channels-discord-feedback");
export const channelsLogListEl = document.getElementById("channels-log-list");
export const channelsLogRefreshBtn = document.getElementById("channels-log-refresh");
export const channelsLogClearBtn = document.getElementById("channels-log-clear");
