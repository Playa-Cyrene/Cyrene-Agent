/**
 * QQ（NapCat OneBot 反向 WebSocket）监听模式与鉴权判定的共享契约。
 *
 * 为什么必须放在 shared 且判定只能由主进程给出：
 * 「监听地址是否回环、是否需要 Access Token」取决于机器上的网络接口
 * （auto 模式在存在 WSL 虚拟网卡时会解析为非回环地址），渲染进程拿不到该输入。
 * 因此渲染端不得自行复制这份判据 —— 一旦复制就会漂移，症状是设置页不提示、
 * 用户直接被主进程硬拒绝。
 */

/** 监听模式。渲染端只负责把用户选择原样交给主进程。 */
export type QqListenMode = "auto" | "loopback" | "wsl" | "custom";

/** 把持久化值或表单值收敛到合法监听模式（缺省 auto）。 */
export function normalizeQqListenMode(value: unknown): QqListenMode {
  return value === "loopback" || value === "wsl" || value === "custom" ? value : "auto";
}

/**
 * 主进程给出的权威鉴权预检结果。
 *
 * `ok === false` 表示当前参数连监听地址都解析不出来（例如 wsl 模式但机器上
 * 没有 WSL 虚拟网卡、custom 模式但地址为空），此时 `error` 是可直接展示的原因。
 * `requiresAccessToken` 只回答「是否需要 token」，不代表参数合法。
 */
export interface QqListenAuthRequirement {
  ok: boolean;
  requiresAccessToken: boolean;
  /** 解析出的实际监听地址（ok 为 true 时存在） */
  resolvedHost?: string;
  /** 实际生效的模式：auto 可能被解析为 wsl 或 loopback */
  resolvedMode?: QqListenMode;
  /** ok 为 false 时的原因 */
  error?: string;
}
