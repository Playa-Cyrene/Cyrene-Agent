// Channels 面板业务逻辑：渠道状态 / 配置加载 / 飞书&微信交互 / 消息日志
// 从 settings.ts 抽离。依赖 channels DOM 引用（./dom）、channelsState（./state）、
// general/dom 的 proactiveDeliverySelect + shared 的 normalize/isProactiveDeliveryTargetSelectable。

import { channelsState } from "./state";
import {
  channelsWechatEnabledEl, channelsFeishuEnabledEl, channelsDiscordEnabledEl,
  channelsRateUserEl, channelsRateChannelEl,
  channelsTtsEl, channelsStickerEl, channelsMirrorEl,
  channelsToolSandboxOffEl, channelsToolSandboxAllEl,
  channelsFeishuAppIdEl, channelsFeishuAppSecretEl, channelsFeishuAppSecretRevealBtn,
  channelsFeishuSaveBtn, channelsFeishuFeedbackEl,
  channelsDiscordTokenEl, channelsDiscordTokenRevealBtn, channelsDiscordSaveBtn, channelsDiscordFeedbackEl,
  channelsDiscordBoundEl,
  channelsDiscordFallbackModelEl, channelsDiscordFallbackUsersEl,
  channelsWechatStatusEl, channelsFeishuStatusEl, channelsDiscordStatusEl,
  channelsWechatLoginBtn, channelsWechatRestartBtn, channelsWechatFeedbackEl,
  channelsLogListEl, channelsLogRefreshBtn, channelsLogClearBtn,
} from "./dom";
import { proactiveDeliverySelect } from "../general/dom";
import { normalizeProactiveDeliveryTarget } from "../../../shared/preferences";
import { isProactiveDeliveryTargetSelectable } from "../../../shared/proactive-delivery";

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

function renderDiscordBoundChannel(cfg: {
  enabled: boolean;
  boundChannelId?: string;
  boundChannelName?: string;
}): void {
  if (!channelsDiscordBoundEl) return;
  if (!cfg.enabled) {
    channelsDiscordBoundEl.textContent = "";
    return;
  }
  if (cfg.boundChannelId) {
    channelsDiscordBoundEl.textContent = `已綁定對話頻道：#${cfg.boundChannelName ?? cfg.boundChannelId}`;
  } else {
    channelsDiscordBoundEl.textContent = "尚未綁定對話頻道：連上後在頻道輸入 /startagent（回覆「啟動成功」即完成），之後在該頻道 @我 我就能回覆。";
  }
}

function setFeishuFeedback(kind: "info" | "ok" | "err", msg: string): void {
  if (!channelsFeishuFeedbackEl) return;
  channelsFeishuFeedbackEl.textContent = msg;
  channelsFeishuFeedbackEl.className = "channels-feedback";
  if (kind === "ok") channelsFeishuFeedbackEl.classList.add("channels-feedback--ok");
  else if (kind === "err") channelsFeishuFeedbackEl.classList.add("channels-feedback--err");
  else channelsFeishuFeedbackEl.classList.add("channels-feedback--info");
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

export async function loadChannelsPanel(): Promise<void> {
  if (channelsState.initialized) return;
  channelsState.initialized = true;
  try {
    const cfg = await window.settings.channelsGetConfig();
    if (channelsWechatEnabledEl) channelsWechatEnabledEl.checked = !!cfg.wechat.enabled;
    if (channelsFeishuEnabledEl) channelsFeishuEnabledEl.checked = !!cfg.feishu.enabled;
    if (channelsDiscordEnabledEl) channelsDiscordEnabledEl.checked = !!cfg.discord.enabled;
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

    // Discord 字段填充（token 加密存盘，UI 不回填明文）
    if (channelsDiscordTokenEl) {
      channelsDiscordTokenEl.value = "";
      channelsDiscordTokenEl.placeholder = cfg.discord.token
        ? "已保存（输入新值会覆盖）"
        : "点击保存配置时保存";
    }
    renderDiscordBoundChannel(cfg.discord);
    if (channelsDiscordFallbackUsersEl) {
      channelsDiscordFallbackUsersEl.value = cfg.discord.fallbackUserIds?.join(", ") ?? "";
    }
    if (channelsDiscordFallbackModelEl && window.settings.listModelProfiles) {
      const select = channelsDiscordFallbackModelEl;
      try {
        const { profiles, defaultModelProfileId } = await window.settings.listModelProfiles();
        for (const profile of profiles) {
          if (profile.id === defaultModelProfileId) continue;
          select.add(new Option(profile.displayName || `${profile.provider} / ${profile.model}`, profile.id));
        }
        select.value = cfg.discord.fallbackModelProfileId ?? "";
        if (select.selectedIndex < 0) select.selectedIndex = 0;
        select.disabled = false;
      } catch (err) {
        console.warn("[Channels] 无法读取备用模型列表:", err);
      }
    }

    // 拉一次渠道状态
    const status = (await window.settings.channelsGetStatus()) as Record<string, { phase: string; message?: string }>;
    renderProactiveDeliveryAvailability(status);
    renderChannelStatus(channelsWechatStatusEl, status.wechat?.phase ?? "offline", status.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, status.feishu?.phase ?? "offline", status.feishu?.message);
    renderChannelStatus(channelsDiscordStatusEl, status.discord?.phase ?? "offline", status.discord?.message);
    // Phase 3.4：拉一次消息日志
    void refreshChannelsLog();
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
        discord: { enabled: channelsDiscordEnabledEl?.checked ?? false },
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
    channelsDiscordEnabledEl,
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

  // 监听安装进度（Phase 1+ 才会收到）
  window.settings.onChannelsInstallProgress((progress) => {
    const target = progress.channel === "wechat" ? channelsWechatStatusEl : progress.channel === "feishu" ? channelsFeishuStatusEl : progress.channel === "discord" ? channelsDiscordStatusEl : null;
    if (target) renderChannelStatus(target, "starting", `${progress.phase} ${progress.pct}%`);
  });
  window.settings.onChannelsStatusChanged((status) => {
    const s = status as Record<string, { phase: string; message?: string }>;
    renderProactiveDeliveryAvailability(s);
    renderChannelStatus(channelsWechatStatusEl, s.wechat?.phase ?? "offline", s.wechat?.message);
    renderChannelStatus(channelsFeishuStatusEl, s.feishu?.phase ?? "offline", s.feishu?.message);
    renderChannelStatus(channelsDiscordStatusEl, s.discord?.phase ?? "offline", s.discord?.message);
  });

  // ===== 飞书交互（Phase 2 长连接版） =====

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

  // ===== Discord 交互（discord.js Gateway 长连接） =====

  // 显示/隐藏 Bot Token
  channelsDiscordTokenRevealBtn?.addEventListener("click", () => {
    if (!channelsDiscordTokenEl) return;
    channelsDiscordTokenEl.type =
      channelsDiscordTokenEl.type === "password" ? "text" : "password";
  });

  function setDiscordFeedback(kind: "info" | "ok" | "err", msg: string): void {
    if (!channelsDiscordFeedbackEl) return;
    channelsDiscordFeedbackEl.textContent = msg;
    channelsDiscordFeedbackEl.className = "channels-feedback";
    if (kind === "ok") channelsDiscordFeedbackEl.classList.add("channels-feedback--ok");
    else if (kind === "err") channelsDiscordFeedbackEl.classList.add("channels-feedback--err");
    else channelsDiscordFeedbackEl.classList.add("channels-feedback--info");
  }

  // 保存配置（token 用 safeStorage 加密后落盘 + 触发 adapter 重建）
  channelsDiscordSaveBtn?.addEventListener("click", async () => {
    const fallbackUserIds = channelsDiscordFallbackUsersEl?.value.split(/[\s,，]+/).filter(Boolean) ?? [];
    if (fallbackUserIds.length > 100 || fallbackUserIds.some((id) => !/^\d{17,20}$/.test(id))) {
      setDiscordFeedback("err", "请输入有效的 Discord 用户 ID，最多 100 个。");
      return;
    }
    setDiscordFeedback("info", "保存并连接中...");
    const patch: Record<string, unknown> = {
      discord: {
        enabled: channelsDiscordEnabledEl?.checked ?? false,
        ...(channelsDiscordFallbackModelEl && !channelsDiscordFallbackModelEl.disabled
          ? { fallbackModelProfileId: channelsDiscordFallbackModelEl.value }
          : {}),
        ...(channelsDiscordFallbackUsersEl ? { fallbackUserIds } : {}),
      },
    };
    // 仅在用户输入了新值时才覆盖 token（避免误清空）
    if (channelsDiscordTokenEl?.value) {
      (patch.discord as Record<string, unknown>).token = channelsDiscordTokenEl.value;
    }
    try {
      await window.settings.channelsSaveConfig(patch);
      // 保存后立即触发 Discord adapter 重建 + 重新连接 Gateway
      await window.settings.channelsRestart();
      setDiscordFeedback("ok", "已保存，Discord 连接中…");
      // 清空输入框（已落盘），并把 placeholder 切到"已保存"
      if (channelsDiscordTokenEl) {
        channelsDiscordTokenEl.value = "";
        channelsDiscordTokenEl.placeholder = "已保存（输入新值会覆盖）";
      }
      // 重新读取配置以更新綁定頻道顯示
      const fresh = await window.settings.channelsGetConfig();
      renderDiscordBoundChannel(fresh.discord);
    } catch (err) {
      setDiscordFeedback("err", err instanceof Error ? err.message : String(err));
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

  // ===== Phase 3.4：消息日志事件绑定 =====
  channelsLogRefreshBtn?.addEventListener("click", () => void refreshChannelsLog());
  channelsLogClearBtn?.addEventListener("click", async () => {
    if (!confirm("确认清空所有 bot 消息日志？")) return;
    await window.settings.channelsLogClear();
    await refreshChannelsLog();
  });
}
