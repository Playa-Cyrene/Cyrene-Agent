// Discord 頻道 ↔ 桌面端聊天對話 的橋接。
//
// 每則頻道訊息在進入時選定 Chat 或 Work，回覆沿用同一個桌面對話。
import { randomUUID } from "crypto";
import * as chatsStore from "../../../chats/chats-store";
import { broadcastChatsChanged } from "../../../chats/chats-ipc";
import { loadChannelsSettings, saveChannelsSettings } from "../../settings-store";
import type { ChatMessage, ChatSessionPurpose } from "../../../../shared/chat-types";
import { getConfiguredDiscordMode, type DiscordMode } from "./access";

/** 依 purpose 回傳對應的對話標題（首次建立用）。 */
function titleForPurpose(purpose: ChatSessionPurpose): string {
  return purpose === "discord-work" ? "Discord 對話 (Work)" : "Discord 對話 (Chat)";
}

/** /startagent 成功後，由 bootstrap 注入「開啟桌面端聊天窗並切到指定 session」的回調。 */
let openSessionHandler: ((sessionId: string) => void) | null = null;

export function setDiscordSessionOpenHandler(fn: ((sessionId: string) => void) | null): void {
  openSessionHandler = fn;
}

/** 取得（或建立）目前 mode 對應的 Discord 對話（work/chat 各自獨立）。 */
function getCurrentDiscordSession(mode: DiscordMode): { id: string } | null {
  try {
    chatsStore.initialize();
    const purpose = mode === "work" ? "discord-work" : "discord-chat";
    const session = chatsStore.getOrCreateSessionByPurpose(purpose, { title: titleForPurpose(purpose) }, mode);
    return session ? { id: session.id } : null;
  } catch (err) {
    console.warn("[DiscordSession] 建立 Discord 對話失敗:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** 把目前 mode 的桌面對話 session id 記到 Discord 設定（workSessionId/chatSessionId），純供對應定位。 */
export function recordCurrentDiscordSessionId(): void {
  try {
    const mode = currentDiscordMode();
    const info = getCurrentDiscordSession(mode);
    if (!info) return;
    const cfg = loadChannelsSettings().discord;
    const patch: { workSessionId?: string; chatSessionId?: string } =
      mode === "work"
        ? { workSessionId: info.id }
        : { chatSessionId: info.id };
    saveChannelsSettings({ discord: { ...cfg, ...patch } });
  } catch (err) {
    console.warn("[DiscordSession] 記錄 session id 失敗:", err instanceof Error ? err.message : err);
  }
}

/** 目前 mode 的對話 purpose（work/chat 判斷，供 /status）。 */
export function currentDiscordMode(): DiscordMode {
  return getConfiguredDiscordMode(loadChannelsSettings());
}

/** 建立/確保目前 mode 對話存在，並要求開啟桌面端聊天窗。返回 sessionId。 */
export function ensureDiscordSessionAndOpen(): string | null {
  const info = getCurrentDiscordSession(currentDiscordMode());
  if (info) {
    try {
      broadcastChatsChanged();
      openSessionHandler?.(info.id);
    } catch (err) {
      console.warn("[DiscordSession] 開啟桌面端聊天窗失敗:", err instanceof Error ? err.message : err);
    }
  }
  return info?.id ?? null;
}

/** 把「給 agent 處理的那則用戶訊息」寫進目前 mode 的 Discord 對話。 */
export function appendDiscordUserMessage(text: string, mode: DiscordMode, at = Date.now()): void {
  const info = getCurrentDiscordSession(mode);
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "user", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 用戶訊息失敗:", err instanceof Error ? err.message : err);
  }
}

/** 把「Bot 對該頻道訊息的回覆」寫進目前 mode 的 Discord 對話。 */
export function appendDiscordReply(text: string, mode: DiscordMode, at = Date.now()): void {
  const info = getCurrentDiscordSession(mode);
  if (!info || !text.trim()) return;
  const msg: ChatMessage = { id: randomUUID(), role: "model", content: text.trim(), at };
  try {
    chatsStore.appendMessage(info.id, msg);
    broadcastChatsChanged();
  } catch (err) {
    console.warn("[DiscordSession] 寫入 Discord 回覆失敗:", err instanceof Error ? err.message : err);
  }
}

/** 取得目前 mode 的 Discord 對話綁定之工作目錄（「指定資料夾」）。未綁定回 null。 */
export function getDiscordSessionWorkspace(mode: DiscordMode): { workspaceRoot: string; displayName?: string } | null {
  try {
    const info = getCurrentDiscordSession(mode);
    if (!info) return null;
    const session = chatsStore.getSession(info.id);
    if (!session?.workspaceBinding?.workspaceRoot) return null;
    return {
      workspaceRoot: session.workspaceBinding.workspaceRoot,
      displayName: session.workspaceBinding.displayName,
    };
  } catch {
    return null;
  }
}

let lastDiscordErrorAt: Date | undefined;

export function recordDiscordError(): void {
  lastDiscordErrorAt = new Date();
}

export function getLastDiscordErrorAt(): Date | undefined {
  return lastDiscordErrorAt;
}
