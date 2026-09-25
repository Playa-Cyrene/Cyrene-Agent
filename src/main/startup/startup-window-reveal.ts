export interface StartupWindowLike {
  close(): void;
  isDestroyed(): boolean;
  show(): void;
}

export interface RevealStartupWindowsOptions {
  /** Loading 窗口；创建失败时为 null，跳过关闭与最短展示等待。 */
  splashWindow: StartupWindowLike | null;
  /** 聊天窗口（主窗口）；reveal 只负责显示，不加载页面。 */
  chatWindow: StartupWindowLike;
  /** 首次启动时展示的独立欢迎窗口；提供时可取代聊天窗口作为首次可见窗口。 */
  onboardingWindow?: StartupWindowLike | null;
  showOnboardingWindow?: boolean;
  /** Loading 实际 show() 的单调时钟时刻；undefined 表示未记录（跳过最短等待）。 */
  loadingShownAt?: number;
  minimumDurationMs: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

/**
 * 关闭 Loading 并显示聊天窗口，或首次启动时显示独立欢迎窗口。
 * 最短展示时长按“实际显示时刻起的剩余时间”计算，核心就绪较晚时不重复整段等待。
 * 桌宠不属于通用 reveal：其创建与显示由启动编排器按 petVisible 单独处理。
 */
export async function revealStartupWindows(options: RevealStartupWindowsOptions): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const remaining = options.loadingShownAt === undefined
    ? 0
    : Math.max(0, options.minimumDurationMs - (now() - options.loadingShownAt));
  if (remaining > 0) {
    await sleep(remaining);
  }

  if (options.splashWindow && !options.splashWindow.isDestroyed()) {
    options.splashWindow.close();
  }
  if (options.showOnboardingWindow && options.onboardingWindow && !options.onboardingWindow.isDestroyed()) {
    options.onboardingWindow.show();
  } else if (!options.chatWindow.isDestroyed()) {
    options.chatWindow.show();
  }
}
