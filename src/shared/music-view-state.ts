// Pure mapping from MusicStatusSnapshot → UI view state.
// Lives in src/shared so it can be unit-tested without pulling in the DOM.
// The renderer imports this and the function is a pure value-to-value transform.

import type { LoginFlowState } from "./music-types";

export interface MusicStatusSnapshot {
  backend: string;
  account: string;
  player: string;
  /** player 为 "unavailable" 时的细分错误码（如 E_MPV_NOT_FOUND），供前端展示针对性提示。 */
  playerErrorCode?: string;
  flow: LoginFlowState;
  profile?: { nickname?: string; avatarUrl?: string; avatar?: string } | null;
}

export type NeteaseViewState =
  | "backend_starting"
  | "backend_error"
  | "signed_out"
  | "creating_qr"
  | "waiting_scan"
  | "waiting_confirm"
  | "login_expired"
  | "login_failed"
  | "connected"
  | "connected_without_client";

export function deriveNeteaseViewState(snapshot: MusicStatusSnapshot): NeteaseViewState {
  if (snapshot.backend === "starting") return "backend_starting";
  if (snapshot.backend === "failed" || snapshot.backend === "incompatible") return "backend_error";
  // account 还没初始化完成（restoreSession 异步在进行）→ 显示"正在读取状态"
  if (snapshot.account === "unknown") return "backend_starting";
  if (
    snapshot.flow === "creating_qr" ||
    snapshot.flow === "waiting_scan" ||
    snapshot.flow === "waiting_confirm"
  ) {
    return snapshot.flow;
  }
  if (snapshot.flow === "expired") return "login_expired";
  if (snapshot.flow === "failed") return "login_failed";
  if (snapshot.account !== "signed_in") return "signed_out";
  // account === "signed_in" 但 player 还在初始化（mpv 启动中）→ 视为"已登录，但 mpv 未就绪"，
  // 不再返回 backend_starting，避免已登录用户看到"正在读取音乐服务状态…"。
  if (snapshot.player === "unknown") return "connected_without_client";
  return snapshot.player === "available" ? "connected" : "connected_without_client";
}
