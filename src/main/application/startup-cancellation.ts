import type { ShutdownCoordinator } from "./shutdown";

/** 仅由启动边界抛出，不放宽 readiness 的退出状态迁移。 */
export class StartupCancelledError extends Error {
  constructor() {
    super("startup cancelled by shutdown");
    this.name = "StartupCancelledError";
  }
}

export function checkStartupActive(shutdown: Pick<ShutdownCoordinator, "isStopping">): void {
  if (shutdown.isStopping()) throw new StartupCancelledError();
}

/** 只在已请求退出、且正在等待 Electron 页面加载时使用。 */
export function isCancelledPageLoad(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const loadError = error as Error & { code?: string; errno?: number };
  return (loadError.code === "ERR_FAILED" && loadError.errno === -2)
    || (loadError.code === "ERR_ABORTED" && loadError.errno === -3)
    || /^ERR_FAILED \(-2\) loading /.test(error.message)
    || /^ERR_ABORTED \(-3\) loading /.test(error.message);
}
