// Channels 面板业务逻辑：渠道状态 / 配置加载 / 飞书&微信交互 / 消息日志
// 从 settings.ts 抽离。依赖 channels DOM 引用（./dom）、channelsState（./state）、
// general/dom 的 proactiveDeliverySelect + shared 的 normalize/isProactiveDeliveryTargetSelectable。

import { channelsState } from "./state";
import {
  channelsWechatEnabledEl, channelsFeishuEnabledEl, channelsQqEnabledEl,
  channelsRateUserEl, channelsRateChannelEl,
  channelsTtsEl, channelsStickerEl, channelsMirrorEl,
  channelsToolSandboxOffEl, channelsToolSandboxAllEl,
  channelsFeishuAppIdEl, channelsFeishuAppSecretEl, channelsFeishuAppSecretRevealBtn,
  channelsFeishuSaveBtn, channelsFeishuFeedbackEl,
  channelsWechatStatusEl, channelsFeishuStatusEl, channelsQqStatusEl,
  channelsWechatLoginBtn, channelsWechatRestartBtn, channelsWechatFeedbackEl,
  channelsLogListEl, channelsLogRefreshBtn, channelsLogClearBtn,
  channelsQqListenModeEl, channelsQqCustomHostEl, channelsQqPortEl, channelsQqUrlEl, channelsQqUrlCopyBtn,
  channelsQqTokenEl, channelsQqTokenGenerateBtn, channelsQqTokenCopyBtn, channelsQqPrivateAllowlistEl,
  channelsQqGroupAllowlistEl, channelsQqSaveBtn, channelsQqTestBtn, channelsQqFeedbackEl,
  channelsQqBotEnabledEl, channelsQqBotStatusEl, channelsQqBotAppIdEl, channelsQqBotAppSecretEl,
  channelsQqBotAllowAnyPrivateEl, channelsQqBotUserAllowlistEl, channelsQqBotGroupAllowlistEl,
  channelsQqBotSaveBtn, channelsQqBotTestBtn, channelsQqBotFeedbackEl,
  channelsContextSourceEl, channelsContextTargetEl, channelsContextBindBtn,
  channelsContextBindingsListEl, channelsContextFeedbackEl,
} from "./dom";
import { proactiveDeliverySelect } from "../general/dom";
import { normalizeProactiveDeliveryTarget } from "../../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../../shared/proactive-delivery";
import type { QqListenAuthRequirement } from "../../../shared/qq-listen";
import { showConfirm } from "../shared/modal";

// 通用：根据渠道状态更新"主动投递目标"选项的可选择性
// （从 settings.ts 移过来；settings.ts 反向 import 此函数以保持其他面板调用不变）
export function renderProactiveDeliveryAvailability(statuses: Record<string, { phase?: string }>): void {
  proactiveDeliverySelect.querySelectorAll<HTMLButtonElement>(".option-block").forEach((button) => {
    const target = normalizeProactiveDeliveryTarget(button.dataset.value);
    const status = target === "local" ? undefined : statuses[target];
    button.disabled = !isProactiveDeliveryTargetSelectable(target, status);
  });
}

function renderChannelStatus(el: HTMLElement | null, phase: string, message?: string): void {
  if (!el) return;
  const dot = el.querySelector(".channels-status__dot");
  const text = el.querySelector(".channels-status__text");
  if (dot) {
    dot.className = "channels-status__dot";
    if (phase === "running") dot.classList.add("channels-status__dot--running");
    else if (phase === "starting") dot.classList.add("channels-status__dot--starting");
    else if (phase === "error") dot.classList.add("channels-status__dot--error");
    else if (phase === "config_missing") dot.classList.add("channels-status__dot--config_missing");
    else dot.classList.add("channels-status__dot--offline");
  }
  if (text) text.textContent = message ?? (phase === "running" ? "运行中" : phase === "starting" ? "启动中" : phase === "config_missing" ? "配置缺失" : phase === "error" ? "错误" : "未启用");
}

function setFeishuFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!channelsFeishuFeedbackEl) return;
  channelsFeishuFeedbackEl.textContent = msg;
  channelsFeishuFeedbackEl.className = "channels-feedback";
  if (kind === "ok") channelsFeishuFeedbackEl.classList.add("channels-feedback--ok");
  else if (kind === "err") channelsFeishuFeedbackEl.classList.add("channels-feedback--err");
  else channelsFeishuFeedbackEl.classList.add("channels-feedback--info");
}

// 这里**故意不保留**「回环判断 / 是否需要 Access Token」的本地副本。
//
// 该判定的输入是网络接口列表，只有主进程看得到 —— auto 模式在存在 WSL 虚拟网卡时会
// 解析为非回环地址。任何本地副本都会与主进程漂移，症状是设置页不提示、用户直接被硬拒。
// 渲染端统一通过 window.settings.channelsQqResolveAuthRequirement() 索取权威判定。

function setQqFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!channelsQqFeedbackEl) return;
  channelsQqFeedbackEl.textContent = msg;
  channelsQqFeedbackEl.className = "channels-feedback";
  channelsQqFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function parseIdList(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,，]+/u).map((item) => item.trim()).filter((item) => /^\d+$/u.test(item))));
}

async function copyInputValue(input: HTMLInputElement | null, label: string): Promise<void> {
  const value = input?.value ?? "";
  if (!value) throw new Error(`${label}为空`);
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  input!.select();
  if (!document.execCommand("copy")) throw new Error(`无法复制${label}`);
}

function renderQqDetail(status?: { detail?: Record<string, unknown> }): void {
  const url = status?.detail?.listenUrl;
  if (channelsQqUrlEl) channelsQqUrlEl.value = typeof url === "string" ? url : "";
}

function setQqBotFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!channelsQqBotFeedbackEl) return;
  channelsQqBotFeedbackEl.textContent = msg;
  channelsQqBotFeedbackEl.className = "channels-feedback";
  channelsQqBotFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

/** openid 白名单解析：大小写十六进制/字母数字串（与主进程 normalizeOpenids 对齐） */
function parseOpenidList(value: string): string[] {
  return Array.from(new Set(value.split(/[\s,，]+/u).map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]{8,64}$/u.test(item))));
}

/** 展示最近被拒的 openid，方便用户复制进白名单（openid 无法提前得知） */
function renderQqBotDetail(status?: { detail?: Record<string, unknown> }): void {
  const rejected = status?.detail?.lastRejectedOpenid;
  if (typeof rejected === "string" && rejected) {
    setQqBotFeedback("info", `最近一条被白名单拒绝的消息来自 openid：${rejected}（复制到上方白名单可放行）`);
  }
}

export interface LogEntry {
  at: string;
  dir: "incoming" | "outgoing";
  channel: string;
  senderId: string;
  senderName?: string;
  chatId: string;
  text: string;
  hasAttachments?: boolean;
}

export function renderChannelsLog(entries: LogEntry[]): void {
  if (!channelsLogListEl) return;
  if (entries.length === 0) {
    channelsLogListEl.innerHTML = '<p class="empty-hint">暂无消息。</p>';
    return;
  }
  const html = entries
    .map((e) => {
      const t = new Date(e.at);
      const hh = String(t.getHours()).padStart(2, "0");
      const mm = String(t.getMinutes()).padStart(2, "0");
      const ss = String(t.getSeconds()).padStart(2, "0");
      const dir = e.dir === "incoming" ? "← 收到" : "→ 回复";
      const who = e.senderName ? `${e.senderName} (${e.senderId})` : e.senderId;
      const safe = (s: string) =>
        s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      const text = e.text.length > 280 ? safe(e.text.slice(0, 280)) + "…" : safe(e.text);
      return `<div class="channels-log__entry channels-log__entry--${e.dir}">
        <div class="channels-log__meta">${hh}:${mm}:${ss} · ${dir} · ${safe(e.channel)} · ${safe(who)}</div>
        <div class="channels-log__text">${text}</div>
      </div>`;
    })
    .join("");
  channelsLogListEl.innerHTML = html;
}

export async function refreshChannelsLog(): Promise<void> {
  try {
    const entries = (await window.settings.channelsLogGet(100)) as LogEntry[];
    renderChannelsLog(entries);
  } catch (err) {
    console.warn("[Channels] refreshChannelsLog 失败:", err);
  }
}

type ContextBindingSnapshot = Awaited<ReturnType<NonNullable<Window["settings"]>["channelsContextBindingsGet"]>>;

function setContextFeedback(kind: "info" | "ok" | "err", message: string): void {
  if (!channelsContextFeedbackEl) return;
  channelsContextFeedbackEl.textContent = message;
  channelsContextFeedbackEl.className = "channels-feedback";
  channelsContextFeedbackEl.classList.add(kind === "ok" ? "channels-feedback--ok" : kind === "err" ? "channels-feedback--err" : "channels-feedback--info");
}

function appendOption(select: HTMLSelectElement, value: string, label: string): void {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

function renderContextBindingOptions(snapshot: ContextBindingSnapshot): void {
  if (channelsContextSourceEl) {
    channelsContextSourceEl.replaceChildren();
    if (snapshot.externalChats.length === 0) {
      appendOption(channelsContextSourceEl, "", "暂无最近聊天");
    } else {
      for (const chat of snapshot.externalChats) {
        const kind = chat.chatType === "group" ? "群聊" : "私聊";
        const name = chat.senderName || chat.chatId;
        appendOption(channelsContextSourceEl, chat.sessionId, `${chat.channel} · ${kind} · ${name} (${chat.chatId})`);
      }
    }
  }
  if (channelsContextTargetEl) {
    channelsContextTargetEl.replaceChildren();
    if (snapshot.conversations.length === 0) {
      appendOption(channelsContextTargetEl, "", "暂无可用对话");
    } else {
      for (const conversation of snapshot.conversations) {
        appendOption(channelsContextTargetEl, conversation.id, `${conversation.title || "新对话"} · ${conversation.mode}`);
      }
    }
  }
}

function renderContextBindings(snapshot: ContextBindingSnapshot): void {
  if (!channelsContextBindingsListEl) return;
  channelsContextBindingsListEl.replaceChildren();
  if (snapshot.bindings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-hint";
    empty.textContent = "暂无绑定。";
    channelsContextBindingsListEl.append(empty);
    return;
  }
  const chats = new Map(snapshot.externalChats.map((chat) => [chat.sessionId, chat]));
  const conversations = new Map(snapshot.conversations.map((conversation) => [conversation.id, conversation]));
  for (const binding of snapshot.bindings) {
    const chat = chats.get(binding.sessionId);
    const conversation = conversations.get(binding.conversationId);
    const row = document.createElement("div");
    row.className = "channels-context-binding";
    const text = document.createElement("span");
    text.textContent = `${chat?.channel ?? "外部聊天"} · ${chat?.senderName || chat?.chatId || binding.sessionId} → ${conversation?.title || binding.conversationId}`;
    row.append(text);
    const unbind = document.createElement("button");
    unbind.type = "button";
    unbind.className = "btn-secondary";
    unbind.textContent = "解除";
    unbind.addEventListener("click", async () => {
      setContextFeedback("info", "解除中...");
      try {
        const result = await window.settings!.channelsContextUnbind(binding.sessionId);
        if (!result.ok) throw new Error(result.error ?? "解除失败");
        setContextFeedback("ok", "已解除上下文绑定");
        await refreshContextBindings();
      } catch (err) {
        setContextFeedback("err", err instanceof Error ? err.message : String(err));
      }
    });
    row.append(unbind);
    channelsContextBindingsListEl.append(row);
  }
}

export async function refreshContextBindings(): Promise<void> {
  try {
    const snapshot = await window.settings!.channelsContextBindingsGet();
    renderContextBindingOptions(snapshot);
    renderContextBindings(snapshot);
  } catch (err) {
    setContextFeedback("err", err instanceof Error ? err.message : String(err));
  }
}

export async function loadChannelsPanel(): Promise<void> {
  if (channelsState.initialized) {
    await refreshContextBindings();
    return;
  }
  channelsState.initialized = true;
  // 必须在 try 之外声明：同函数内的保存处理器位于 try 之外，却要读它。
  // 原先是 try 块内的 let，导致「需要补 token」这条路径抛 ReferenceError
  // （该路径此前没有任何测试覆盖，所以一直没暴露）。
  let hadQqToken = false;
  try {
    const cfg = await window.settings.channelsGetConfig();
    if (channelsWechatEnabledEl) channelsWechatEnabledEl.checked = !!cfg.wechat.enabled;
    if (channelsFeishuEnabledEl) channelsFeishuEnabledEl.checked = !!cfg.feishu.enabled;
    if (channelsQqEnabledEl) channelsQqEnabledEl.checked = !!cfg.qq?.enabled;
    if (channelsRateUserEl) channelsRateUserEl.value = String(cfg.rateLimitPerUser ?? 10);
    if (channelsRateChannelEl) channelsRateChannelEl.value = String(cfg.rateLimitPerChannel ?? 100);
    if (channelsTtsEl) channelsTtsEl.checked = cfg.ttsEnabled !== false;
    if (channelsStickerEl) channelsStickerEl.checked = cfg.stickerEnabled !== false;
    if (channelsMirrorEl) channelsMirrorEl.checked = cfg.mirrorToDesktop !== false;
    if (channelsToolSandboxOffEl) channelsToolSandboxOffEl.checked = cfg.toolSandbox === "off";
    if (channelsToolSandboxAllEl) channelsToolSandboxAllEl.checked = cfg.toolSandbox === "all";

    // 飞书字段填充（长连接模式只需要 App ID；secret 加密存盘，UI 不回填明文）
    if (channelsFeishuAppIdEl) channelsFeishuAppIdEl.value = cfg.feishu.appId ?? "";
    if (channelsFeishuAppSecretEl) {
      channelsFeishuAppSecretEl.value = "";
      channelsFeishuAppSecretEl.placeholder = cfg.feishu.appSecret
        ? "已保存（输入新值会覆盖）"
        : "点击保存配置时加密保存";
    }
    if (channelsQqListenModeEl) channelsQqListenModeEl.value = cfg.qq?.listenMode ?? "auto";
    if (channelsQqCustomHostEl) channelsQqCustomHostEl.value = cfg.qq?.customHost ?? "";
    if (channelsQqPortEl) channelsQqPortEl.value = String(cfg.qq?.port ?? 6200);
    if (channelsQqPrivateAllowlistEl) channelsQqPrivateAllowlistEl.value = (cfg.qq?.allowedPrivateUserIds ?? []).join("\n");
    if (channelsQqGroupAllowlistEl) channelsQqGroupAllowlistEl.value = (cfg.qq?.allowedGroupIds ?? []).join("\n");
    if (channelsQqTokenEl) channelsQqTokenEl.placeholder = cfg.qq?.hasAccessToken
      ? "已保存（输入新值会覆盖）"
      : "留空仅允许本机 127.0.0.1 监听；WSL/跨网卡请先生成";
    // 已保存的 token 不回显；保存时若输入为空且没有已存值，非回环监听需要先补生成
    hadQqToken = !!cfg.qq?.hasAccessToken;

    // QQ 官方机器人字段填充（secret 加密存盘，UI 不回填明文）
    if (channelsQqBotEnabledEl) channelsQqBotEnabledEl.checked = !!cfg.qqbot?.enabled;
    if (channelsQqBotAppIdEl) channelsQqBotAppIdEl.value = cfg.qqbot?.appId ?? "";
    if (channelsQqBotAppSecretEl) {
      channelsQqBotAppSecretEl.value = "";
      channelsQqBotAppSecretEl.placeholder = cfg.qqbot?.hasAppSecret
        ? "已保存（输入新值会覆盖）"
        : "点击保存配置时加密保存";
    }
    if (channelsQqBotAllowAnyPrivateEl) channelsQqBotAllowAnyPrivateEl.checked = !!cfg.qqbot?.allowAnyPrivate;
    if (channelsQqBotUserAllowlistEl) channelsQqBotUserAllowlistEl.value = (cfg.qqbot?.allowedUserOpenids ?? []).join("\n");
    if (channelsQqBotGroupAllowlistEl) channelsQqBotGroupAllowlistEl.value = (cfg.qqbot?.allowedGroupOpenids ?? []).join("\n");

    // 拉一次渠道状态
    const status = (await window.settings.channelsGetStatus()) as Record<string, { phase: string; message?: string; detail?: Record<string, unknown> }>;
    renderProactiveDeliveryAvailability(status);
    renderChannelStatus(channelsWechatStatusEl, status.wechat?.phase ?? "offline", status.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, status.feishu?.phase ?? "offline", status.feishu?.message);
    renderChannelStatus(channelsQqStatusEl, status.qq?.phase ?? "offline", status.qq?.message);
    renderQqDetail(status.qq);
    renderChannelStatus(channelsQqBotStatusEl, status.qqbot?.phase ?? "offline", status.qqbot?.message);
    renderQqBotDetail(status.qqbot);
    // 拉一次消息日志
    void refreshChannelsLog();
    void refreshContextBindings();
  } catch (err) {
    console.warn("[Channels] loadChannelsPanel 失败:", err);
  }

  // 自动保存（debounce 200ms）
  const scheduleSave = () => {
    if (channelsState.saveTimer != null) window.clearTimeout(channelsState.saveTimer);
    channelsState.saveTimer = window.setTimeout(() => {
      void window.settings.channelsSaveConfig({
        wechat: { enabled: channelsWechatEnabledEl?.checked ?? false },
        feishu: { enabled: channelsFeishuEnabledEl?.checked ?? false },
        qq: { enabled: channelsQqEnabledEl?.checked ?? false },
        qqbot: { enabled: channelsQqBotEnabledEl?.checked ?? false },
        rateLimitPerUser: Number(channelsRateUserEl?.value) || 10,
        rateLimitPerChannel: Number(channelsRateChannelEl?.value) || 100,
        ttsEnabled: channelsTtsEl?.checked ?? true,
        stickerEnabled: channelsStickerEl?.checked ?? true,
        mirrorToDesktop: channelsMirrorEl?.checked ?? true,
        toolSandbox: channelsToolSandboxOffEl?.checked
          ? "off"
          : "all",
      });
    }, 200);
  };
  for (const el of [
    channelsWechatEnabledEl,
    channelsFeishuEnabledEl,
    channelsQqEnabledEl,
    channelsQqBotEnabledEl,
    channelsRateUserEl,
    channelsRateChannelEl,
    channelsTtsEl,
    channelsStickerEl,
    channelsMirrorEl,
    channelsToolSandboxOffEl,
    channelsToolSandboxAllEl,
  ]) {
    el?.addEventListener("change", scheduleSave);
  }

  channelsContextBindBtn?.addEventListener("click", async () => {
    const sessionId = channelsContextSourceEl?.value ?? "";
    const conversationId = channelsContextTargetEl?.value ?? "";
    if (!sessionId || !conversationId) {
      setContextFeedback("err", "请先选择外部聊天和桌面对话");
      return;
    }
    setContextFeedback("info", "绑定中...");
    try {
      const result = await window.settings!.channelsContextBind({ sessionId, conversationId });
      if (!result.ok) throw new Error(result.error ?? "绑定失败");
      setContextFeedback("ok", "上下文绑定已保存");
      await refreshContextBindings();
    } catch (err) {
      setContextFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // 监听安装进度（渠道运行时安装进行时才会收到）
  window.settings.onChannelsInstallProgress((progress) => {
    const target = progress.channel === "wechat" ? channelsWechatStatusEl : progress.channel === "feishu" ? channelsFeishuStatusEl : progress.channel === "qq" ? channelsQqStatusEl : null;
    if (target) renderChannelStatus(target, "starting", `${progress.phase} ${progress.pct}%`);
  });
  window.settings.onChannelsStatusChanged((status) => {
    const s = status as Record<string, { phase: string; message?: string; detail?: Record<string, unknown> }>;
    renderProactiveDeliveryAvailability(s);
    renderChannelStatus(channelsWechatStatusEl, s.wechat?.phase ?? "offline", s.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, s.feishu?.phase ?? "offline", s.feishu?.message);
    renderChannelStatus(channelsQqStatusEl, s.qq?.phase ?? "offline", s.qq?.message);
    renderQqDetail(s.qq);
    renderChannelStatus(channelsQqBotStatusEl, s.qqbot?.phase ?? "offline", s.qqbot?.message);
    renderQqBotDetail(s.qqbot);
  });

  // ===== 飞书交互（长连接版） =====

  // 显示/隐藏 App Secret
  channelsFeishuAppSecretRevealBtn?.addEventListener("click", () => {
    if (!channelsFeishuAppSecretEl) return;
    channelsFeishuAppSecretEl.type =
      channelsFeishuAppSecretEl.type === "password" ? "text" : "password";
  });

  // 保存配置（secret 用 safeStorage 加密后落盘 + 触发长连接重连）
  channelsFeishuSaveBtn?.addEventListener("click", async () => {
    setFeishuFeedback("info", "保存并连接中...");
    const patch: Record<string, unknown> = {
      feishu: {
        enabled: channelsFeishuEnabledEl?.checked ?? false,
        appId: channelsFeishuAppIdEl?.value.trim() || undefined,
      },
    };
    // 仅在用户输入了新值时才覆盖 secret（避免误清空）
    if (channelsFeishuAppSecretEl?.value) {
      (patch.feishu as Record<string, unknown>).appSecret = channelsFeishuAppSecretEl.value;
    }
    try {
      await window.settings.channelsSaveConfig(patch);
      // 保存后立即触发飞书 adapter 重建 + 重连长连接
      await window.settings.channelsRestart();
      setFeishuFeedback("ok", "已保存，飞书长连接正在建立…");
      // 清空输入框（已落盘），并把 placeholder 切到"已保存"
      if (channelsFeishuAppSecretEl) {
        channelsFeishuAppSecretEl.value = "";
        channelsFeishuAppSecretEl.placeholder = "已保存（输入新值会覆盖）";
      }
    } catch (err) {
      setFeishuFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // ===== 微信交互（扫码登录走 iLink HTTP API，详见 src/main/channels/adapters/wechat/） =====

  function setWechatFeedback(kind: "info" | "ok" | "err", msg: string): void {
    if (!channelsWechatFeedbackEl) return;
    channelsWechatFeedbackEl.textContent = msg;
    channelsWechatFeedbackEl.className = "channels-feedback";
    if (kind === "ok") channelsWechatFeedbackEl.classList.add("channels-feedback--ok");
    else if (kind === "err") channelsWechatFeedbackEl.classList.add("channels-feedback--err");
    else channelsWechatFeedbackEl.classList.add("channels-feedback--info");
  }

  // 扫码登录：Main Process 生成 PNG → 推到 Renderer → modal 弹窗
  const channelsWechatQrEl = document.getElementById("channels-wechat-qr");
  const channelsWechatQrImgEl = document.getElementById("channels-wechat-qr-img") as HTMLImageElement | null;
  const channelsWechatQrCloseBtn = document.getElementById("channels-wechat-qr-close");
  const channelsWechatQrBackdrop = document.getElementById("channels-wechat-qr-backdrop");

  function showWechatQr(dataUrl: string): void {
    if (channelsWechatQrImgEl) {
      channelsWechatQrImgEl.src = dataUrl;
      channelsWechatQrImgEl.classList.remove("is-empty");
    }
    channelsWechatQrEl?.removeAttribute("hidden");
  }
  function hideWechatQr(): void {
    channelsWechatQrEl?.setAttribute("hidden", "");
    if (channelsWechatQrImgEl) {
      channelsWechatQrImgEl.src = "";
      channelsWechatQrImgEl.classList.add("is-empty");
    }
  }

  // 关闭交互：点按钮 / 点背景 / 按 ESC
  channelsWechatQrCloseBtn?.addEventListener("click", hideWechatQr);
  channelsWechatQrBackdrop?.addEventListener("click", hideWechatQr);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && channelsWechatQrEl && !channelsWechatQrEl.hasAttribute("hidden")) {
      hideWechatQr();
    }
  });

  // 订阅 Main 推送的二维码（每次登录会推一次）
  window.settings.onChannelsWechatQrcode((dataUrl) => {
    console.log("[WechatSettings] QR event received, dataUrl prefix:", dataUrl?.slice(0, 40), "len:", dataUrl?.length);
    showWechatQr(dataUrl);
    setWechatFeedback("info", "请用微信扫描二维码");
  });
  // 订阅 Main 推送的登录结果（成功 / 失败 / 二维码过期）
  window.settings.onChannelsWechatLoginDone((payload) => {
    hideWechatQr();
    if (payload.ok) {
      setWechatFeedback("ok", `已登录（botId=${payload.botId ?? "?"}）`);
    } else {
      setWechatFeedback("err", `登录失败：${payload.error ?? "未知错误"}`);
    }
  });

  channelsWechatLoginBtn?.addEventListener("click", async () => {
    hideWechatQr();
    setWechatFeedback("info", "正在启动扫码…");
    try {
      const result = await window.settings.channelsWechatLoginStart();
      if (result.ok) {
        // 二维码由 onChannelsWechatQrcode 推过来并显示；这里只刷个轻提示
        setWechatFeedback("info", "等待二维码推送…");
      } else {
        setWechatFeedback("err", result.error ?? "启动失败");
      }
    } catch (err) {
      setWechatFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // 重启连接
  channelsWechatRestartBtn?.addEventListener("click", async () => {
    setWechatFeedback("info", "重启连接中…");
    try {
      await window.settings.channelsRestart();
      setWechatFeedback("ok", "已重启");
    } catch (err) {
      setWechatFeedback("err", err instanceof Error ? err.message : String(err));
    }
  });

  // ===== QQ / NapCat OneBot 11 反向 WebSocket =====
  channelsQqListenModeEl?.addEventListener("change", () => {
    if (channelsQqCustomHostEl) channelsQqCustomHostEl.disabled = channelsQqListenModeEl.value !== "custom";
  });
  if (channelsQqCustomHostEl && channelsQqListenModeEl) {
    channelsQqCustomHostEl.disabled = channelsQqListenModeEl.value !== "custom";
  }
  channelsQqTokenGenerateBtn?.addEventListener("click", () => {
    if (!channelsQqTokenEl) return;
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    channelsQqTokenEl.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    channelsQqTokenEl.type = "text";
    channelsQqTokenEl.select();
    setQqFeedback("info", "已生成 Token，请复制到 NapCat WebSocket Client 配置后再保存。");
  });
  channelsQqUrlCopyBtn?.addEventListener("click", () => {
    void copyInputValue(channelsQqUrlEl, "连接 URL")
      .then(() => setQqFeedback("ok", "连接 URL 已复制。"))
      .catch((error) => setQqFeedback("err", error instanceof Error ? error.message : String(error)));
  });
  channelsQqTokenCopyBtn?.addEventListener("click", () => {
    void copyInputValue(channelsQqTokenEl, "Token")
      .then(() => setQqFeedback("ok", "Token 已复制；保存后将无法从设置页读取明文。"))
      .catch((error) => setQqFeedback("err", error instanceof Error ? error.message : String(error)));
  });
  channelsQqSaveBtn?.addEventListener("click", async () => {
    // 非回环监听必须鉴权（主进程会硬校验）：输入为空且无已存 token 时，
    // 先生成并让用户复制到 NapCat，本次不落盘（token 保存后不再回显，用户就拿不到了）
    const listenMode = channelsQqListenModeEl?.value ?? "auto";
    const customHost = channelsQqCustomHostEl?.value ?? "";
    const qqEnabled = channelsQqEnabledEl?.checked ?? false;

    // 是否需要 token 由主进程判定：渲染进程看不到网络接口（auto 在存在 WSL 网卡时会
    // 解析为非回环地址），本地按模式名判断必然漏报。QQ 未启用时不会启动监听，
    // 因此跳过预检 —— 否则想关掉 QQ 的用户会因地址无效而保存不了。
    if (qqEnabled) {
      let requirement: QqListenAuthRequirement;
      try {
        requirement = await window.settings.channelsQqResolveAuthRequirement({ listenMode, customHost });
      } catch (error) {
        setQqFeedback("err", error instanceof Error ? error.message : String(error));
        return;
      }
      if (!requirement.ok) {
        setQqFeedback("err", requirement.error ?? "无法解析监听地址，请检查监听模式与自定义地址。");
        return;
      }
      if (channelsQqTokenEl && requirement.requiresAccessToken && !channelsQqTokenEl.value && !hadQqToken) {
        const bytes = crypto.getRandomValues(new Uint8Array(32));
        channelsQqTokenEl.value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        channelsQqTokenEl.type = "text";
        channelsQqTokenEl.select();
        setQqFeedback(
          "info",
          `监听地址 ${requirement.resolvedHost} 非回环，需要 Access Token：已自动生成，请先复制到 NapCat WebSocket Client 的 Token 字段，再回来点击保存。`,
        );
        return;
      }
    }
    setQqFeedback("info", "正在保存并启动 QQ 监听…");
    const qq: Record<string, unknown> = {
      enabled: channelsQqEnabledEl?.checked ?? false,
      listenMode,
      customHost: channelsQqCustomHostEl?.value.trim() || undefined,
      port: Number(channelsQqPortEl?.value) || 6200,
      allowedPrivateUserIds: parseIdList(channelsQqPrivateAllowlistEl?.value ?? ""),
      allowedGroupIds: parseIdList(channelsQqGroupAllowlistEl?.value ?? ""),
    };
    if (channelsQqTokenEl?.value) qq.accessToken = channelsQqTokenEl.value;
    try {
      await window.settings.channelsSaveConfig({ qq });
      if (qq.accessToken) hadQqToken = true;
      await window.settings.channelsRestart();
      const status = await window.settings.channelsGetStatus() as Record<string, { phase?: string; message?: string; detail?: Record<string, unknown> }>;
      renderQqDetail(status.qq);
      if (channelsQqTokenEl) {
        channelsQqTokenEl.value = "";
        channelsQqTokenEl.type = "password";
        channelsQqTokenEl.placeholder = "已保存（输入新值会覆盖）";
      }
      setQqFeedback("ok", "已启动监听；请在 NapCat 中新增 WebSocket Client，并使用上方 URL。");
    } catch (error) {
      setQqFeedback("err", error instanceof Error ? error.message : String(error));
    }
  });
  channelsQqTestBtn?.addEventListener("click", async () => {
    setQqFeedback("info", "正在检查 NapCat 连接…");
    try {
      const result = await window.settings.channelsQqTestConnection();
      setQqFeedback(result.ok ? "ok" : "err", result.ok
        ? `连接正常：${result.detail?.nickname ? `${String(result.detail.nickname)} (` : "QQ "}${String(result.detail?.selfId ?? "")}${result.detail?.nickname ? ")" : ""}${result.detail?.appVersion ? ` · NapCat ${String(result.detail.appVersion)}` : ""} · Stream ${result.detail?.supportsStream ? "可用" : "不可用"}`
        : result.error ?? "连接失败");
    } catch (error) {
      setQqFeedback("err", error instanceof Error ? error.message : String(error));
    }
  });

  // ===== QQ 官方机器人（QQ 开放平台 API v2） =====

  channelsQqBotSaveBtn?.addEventListener("click", async () => {
    const appId = channelsQqBotAppIdEl?.value.trim() ?? "";
    if (!appId) {
      setQqBotFeedback("err", "请先填写 AppID（q.qq.com → 机器人开发设置里获取）。");
      return;
    }
    setQqBotFeedback("info", "正在保存并连接 QQ 开放平台网关…");
    const qqbot: Record<string, unknown> = {
      enabled: channelsQqBotEnabledEl?.checked ?? false,
      appId,
      allowAnyPrivate: channelsQqBotAllowAnyPrivateEl?.checked ?? false,
      allowedUserOpenids: parseOpenidList(channelsQqBotUserAllowlistEl?.value ?? ""),
      allowedGroupOpenids: parseOpenidList(channelsQqBotGroupAllowlistEl?.value ?? ""),
    };
    // secret 不回显：留空表示沿用已存值
    if (channelsQqBotAppSecretEl?.value) qqbot.appSecret = channelsQqBotAppSecretEl.value;
    try {
      await window.settings.channelsSaveConfig({ qqbot });
      await window.settings.channelsRestart();
      const status = await window.settings.channelsGetStatus() as Record<string, { phase?: string; message?: string }>;
      if (channelsQqBotAppSecretEl) {
        channelsQqBotAppSecretEl.value = "";
        channelsQqBotAppSecretEl.placeholder = "已保存（输入新值会覆盖）";
      }
      setQqBotFeedback(
        status.qqbot?.phase === "running" ? "ok" : "info",
        status.qqbot?.phase === "running"
          ? "网关已连接，机器人已上线。"
          : `已保存（当前状态：${status.qqbot?.message ?? status.qqbot?.phase ?? "未知"}）`,
      );
    } catch (error) {
      setQqBotFeedback("err", error instanceof Error ? error.message : String(error));
    }
  });

  channelsQqBotTestBtn?.addEventListener("click", async () => {
    setQqBotFeedback("info", "正在校验 AppID / AppSecret…");
    try {
      const result = await window.settings.channelsQqBotTestConnection();
      setQqBotFeedback(result.ok ? "ok" : "err", result.ok
        ? "凭证有效，可以正常连接 QQ 开放平台。"
        : result.error ?? "连接失败");
    } catch (error) {
      setQqBotFeedback("err", error instanceof Error ? error.message : String(error));
    }
  });

  // ===== 消息日志事件绑定 =====
  channelsLogRefreshBtn?.addEventListener("click", () => void refreshChannelsLog());
  channelsLogClearBtn?.addEventListener("click", async () => {
    // 清空日志不可撤销：危险确认，默认聚焦取消
    const confirmed = await showConfirm({
      title: "清空消息日志",
      message: "确认清空所有 bot 消息日志？",
      confirmText: "清空",
      dangerous: true,
    });
    if (!confirmed) return;
    await window.settings.channelsLogClear();
    await refreshChannelsLog();
  });
}
