// Sandbox Runtime (SRT) 接入层 — Windows 命令执行沙箱
//
// 设计：
// - 启动时 initSandbox() 检测 SRT 安装状态；装了就启用 SandboxManager。
// - wrapWithSandbox(command, cwd) 把命令字符串包成 SandboxWrapOutcome 返回：
//   { ok: true, argv, env } 或 { ok: false, reason }（disabled / not_ready / wrap_failed）。
//   本层只归一化结果、不做 fallback 决策；拒绝还是降级由 run_shell 的 ExecutionPlan 路由
//   （不可因 wrap 失败而 fail-open：需要沙箱的命令在 wrap 成功前不允许 spawn）。
// - CYRENE_SRT=0 环境变量可强制禁用（reason: "disabled"）。
//
// SRT API 要点（已 PoC 验证）：
// - namespace import（无 default export）：`await import('@anthropic-ai/sandbox-runtime')`
// - resolveSrtWin({ path: VENDORED_SRT_WIN_EXE }) → { exe, prependArgs: ['--srt-win'] }
// - checkWindowsSandboxStatusAsync({ srtWin }) → { user: { provisioned, sid }, wfp: { state } }
//   wfp.state='cannot-read' 是非管理员正常降级，沙箱仍可用
// - installWindowsSandboxAsync({ srtWin }) → { user, wfp, cancelled? }
//   cancelled:true 表示用户没点 UAC（不报错）
// - SandboxManager.initialize(config) 一次性初始化
// - SandboxManager.wrapWithSandboxArgv(cmdStr, binShell?, customConfig?, abortSignal?, cwd?, options?)
//   → { argv, env }，调用方自己 spawn({ shell: false })
// - command 参数是字符串（SRT 内部用 cmd.exe /c 跑，inner shell 在沙箱里所以安全）
// - allowWrite 目录必须先 mkdirSync 存在，否则 ACL grant 被丢弃

import * as fs from "fs";
import * as path from "path";
import { logger, LogTag } from "../../logger";
import { getCurrentLevel } from "../../permission";
import type { AgentFileAccessLevel } from "../../permission-policy";

// ── 模块级单例 ──────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SrtModule = any;

let srtModule: SrtModule | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let srtWin: any = null;
/** 实际可执行的 srt-win.exe 路径（打包后指向 app.asar.unpacked 里的真实文件） */
let srtWinExePath: string | null = null;
let sandboxReady = false;
let sandboxDisabled = false;
let initAttempted = false;
let sandboxSessionKey: string | null = null;

/** ensure 连续失败上限：达到后本进程内不再重试，持续返回 not_ready（fail-closed） */
const ENSURE_MAX_FAILURES = 3;
let ensureFailCount = 0;
let lastFailedSessionKey: string | null = null;

// ── 环境开关 ────────────────────────────────────────────

function isSrtDisabledByEnv(): boolean {
  return process.env.CYRENE_SRT === "0" || process.env.CYRENE_SRT === "false";
}

function isWindows(): boolean {
  return process.platform === "win32";
}

/**
 * 打包后 vendor/srt-win 由 electron-builder 的 asarUnpack 解到 app.asar.unpacked，
 * 但包内 VENDORED_SRT_WIN_EXE 常量仍指向 app.asar 虚拟路径 ——
 * spawn 无法执行 asar 虚拟路径里的 exe（ENOENT），需重写到真实磁盘路径。
 */
function toUnpackedSrtWinPath(p: string): string {
  const asarSep = `${path.sep}app.asar${path.sep}`;
  return p.includes(asarSep)
    ? p.replace(asarSep, `${path.sep}app.asar.unpacked${path.sep}`)
    : p;
}

// ── 项目根检测 ──────────────────────────────────────────

/**
 * 从 cwd 向上查找项目根（.git / package.json / tsconfig.json）。
 * 找不到则回退到 cwd 本身。
 */
function detectProjectRoot(cwd: string): string {
  const start = path.resolve(cwd);
  let dir = start;
  for (let i = 0; i < 20; i++) {
    const hasGit = fs.existsSync(path.join(dir, ".git"));
    const hasPkg = fs.existsSync(path.join(dir, "package.json"));
    const hasTs = fs.existsSync(path.join(dir, "tsconfig.json"));
    if (hasGit || hasPkg || hasTs) {
      const markers = [hasGit && ".git", hasPkg && "package.json", hasTs && "tsconfig.json"].filter(Boolean).join(",");
      logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: ${start} → ${dir} (found ${markers})`);
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 到达磁盘根
    dir = parent;
  }
  logger.info(LogTag.Runtime, `[Sandbox] detectProjectRoot: no project marker found from ${start}, fallback to cwd`);
  return path.resolve(cwd);
}

// ── 按档位构建 per-call filesystem 配置 ──────────────────

/**
 * Windows 的 allowRead/allowWrite 只能在 SandboxManager.initialize 时授权。
 * 每次命令只传 deny 规则，避免 SRT 拒绝 per-exec grant。
 * - full: 返回 null（不走沙箱，调用方直接 spawn）
 *
 * allowWrite 目录会先 mkdirSync 确保存在（ACL grant 依赖）。
 */
function buildFilesystemConfigForLevel(
  cwd: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): { filesystem: any } | null {
  const level = getCurrentLevel();
  logger.info(LogTag.Runtime, `[Sandbox] buildFilesystemConfigForLevel: level=${level} cwd=${cwd}`);

  switch (level) {
    case "project-read-only":
    case "read-only":
    case "scoped":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [${level}]: per-exec denies only; grants were applied at session initialization`);
      return {
        filesystem: {
          denyRead: [],
          denyWrite: [],
        },
      };
    case "per-action":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [per-action]: filesystem.disabled=true (user approved, fs unrestricted)`);
      return {
        filesystem: {
          disabled: true,
        },
      };
    case "full":
      logger.info(LogTag.Runtime, `[Sandbox] fs config [full]: null (no sandbox, direct spawn)`);
      return null;
  }
}

// ── SandboxManager 初始化 ──────────────────────────────

/**
 * 构建 SandboxManager.initialize 接受的 config。
 * allowWrite 目录必须先存在，否则 ACL grant 被丢弃。
 */
export function resolveSandboxSessionFilesystem(level: AgentFileAccessLevel, workspaceRoot: string): { allowRead?: string[]; allowWrite: string[]; denyRead: string[]; denyWrite: string[]; disabled?: boolean } {
  switch (level) {
    case "project-read-only":
      return { allowRead: [workspaceRoot], allowWrite: [], denyRead: [], denyWrite: [] };
    case "read-only":
      return { allowWrite: [], denyRead: [], denyWrite: [] };
    case "scoped":
      return { allowWrite: [workspaceRoot], denyRead: [], denyWrite: [] };
    case "per-action":
      // 用户已审批本次操作，但 Windows 仍须在会话初始化时授予该工作区访问权。
      return { allowWrite: [workspaceRoot], denyRead: [], denyWrite: [] };
    case "full":
      return { allowWrite: [], denyRead: [], denyWrite: [], disabled: true };
  }
}

function buildSandboxConfig(level: AgentFileAccessLevel, workspaceRoot: string): SrtModule["SandboxRuntimeConfig"] {
  // 确保 allowWrite 目录存在（ACL grant 依赖）
  try {
    fs.mkdirSync(workspaceRoot, { recursive: true });
  } catch (err) {
    logger.warn(LogTag.Runtime, `[Sandbox] mkdir workspace root failed: ${workspaceRoot}`, err);
  }
  return {
    network: {
      allowedDomains: [],
      deniedDomains: [],
    },
    filesystem: resolveSandboxSessionFilesystem(level, workspaceRoot),
    windows: {
      srtWin: { path: srtWinExePath ?? srtModule.VENDORED_SRT_WIN_EXE },
    },
  };
}

/**
 * 初始化 SandboxManager（装好之后调用）。
 * 不做安装，不做状态检查 — 调用方确保已 provisioned。
 */
async function initSandboxManager(level: AgentFileAccessLevel, cwd: string): Promise<void> {
  if (!srtModule) throw new Error("SRT module not loaded");
  const workspaceRoot = level === "project-read-only" ? detectProjectRoot(cwd) : path.resolve(cwd);
  const config = buildSandboxConfig(level, workspaceRoot);
  logger.info(LogTag.Runtime, `[Sandbox] initSandboxManager: cwd=${cwd} allowWrite=${config.filesystem.allowWrite.join(",")} srtWin=${config.windows.srtWin.path}`);
  await srtModule.SandboxManager.initialize(config);
  sandboxSessionKey = JSON.stringify({ level, workspaceRoot });
  logger.info(LogTag.Runtime, "[Sandbox] SandboxManager.initialize completed");
}

// ── 公开 API ───────────────────────────────────────────

/**
 * 启动时检测 SRT 安装状态。
 * - 装了 → 仅检查可用性；首次需要执行时才对实际工作区初始化 ACL
 * - 没装 → 留 not-ready（不主动安装，避免启动时弹 UAC）
 * - 出错 → 只记录日志，保持 not-ready（fail-closed，不伪装成用户显式禁用）
 *
 * 幂等：重复调用安全（initAttempted 守卫）。
 * 在 main/index.ts registerAllTools 前调用。
 */
export async function initSandbox(): Promise<void> {
  if (initAttempted) return;
  initAttempted = true;

  if (!isWindows()) {
    logger.info(LogTag.Runtime, "[Sandbox] non-Windows platform, skipping");
    return;
  }
  if (isSrtDisabledByEnv()) {
    logger.info(LogTag.Runtime, "[Sandbox] disabled by CYRENE_SRT env");
    sandboxDisabled = true;
    return;
  }

  try {
    // 无 default export，必须 namespace import
    srtModule = await import("@anthropic-ai/sandbox-runtime");
    srtWinExePath = toUnpackedSrtWinPath(srtModule.VENDORED_SRT_WIN_EXE as string);
    srtWin = srtModule.resolveSrtWin({ path: srtWinExePath });

    const status = await srtModule.checkWindowsSandboxStatusAsync({ srtWin });
    logger.info(LogTag.Runtime, `[Sandbox] status: user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);

    if (!status.user.provisioned) {
      // 未安装：不主动装，留待首次 workspace_mutation 命令时 lazy install
      logger.info(LogTag.Runtime, "[Sandbox] not provisioned, will lazy-install on first workspace_mutation command");
      return;
    }
    // wfp.state='cannot-read' 是非管理员正常降级，沙箱仍可用
    // wfp.state='absent' 表示 WFP 没装；provisioned 但 absent 时也能跑（fs 沙箱生效，network 放行）
    // 这里只在 user 已 provisioned 时即认为可用

    logger.info(LogTag.Runtime, "[Sandbox] provisioned; will initialize ACL for the active workspace on first sandboxed command");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 故障不伪装成"用户显式禁用"：保持 not_ready 语义（fail-closed），
    // 否则 run_shell 会把初始化失败当成 disabled 而 read 类命令降级直跑
    logger.error(LogTag.Runtime, `[Sandbox] init failed, staying not-ready: ${msg}`);
  }
}

/**
 * 沙箱是否可尝试执行（不触发 lazy install）。
 * 只要 SRT 已加载且未被禁用，就允许 run_shell 进入 wrapWithSandbox，
 * 由后者为实际工作区建立会话授权；初始化失败仍会被严格拒绝。
 */
export function isSandboxReady(): boolean {
  return !!srtModule && !sandboxDisabled;
}

/**
 * 确保沙箱就绪：未就绪时尝试 lazy install（可能弹 UAC）。
 * - 已就绪 → true
 * - 未安装 → installWindowsSandboxAsync（UAC），用户取消则返回 false（不计失败，下次还会再试）
 * - 其他错误 → 返回 false 且保持 not_ready 语义（fail-closed）；
 *   连续失败达到 ENSURE_MAX_FAILURES 次后本进程内不再重试，
 *   更换工作区或档位（会话 key 变化）会重置计数重新尝试
 *
 * UAC 取消不算错误（用户可能只是这次不想装），下次还会再试。
 */
export async function ensureSandboxReady(cwd: string = process.cwd()): Promise<boolean> {
  if (sandboxDisabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: skip (sandboxDisabled=${sandboxDisabled} isWindows=${isWindows()})`);
    return false;
  }
  const level = getCurrentLevel();
  const workspaceRoot = level === "project-read-only" ? detectProjectRoot(cwd) : path.resolve(cwd);
  const desiredSessionKey = JSON.stringify({ level, workspaceRoot });
  if (sandboxReady && sandboxSessionKey === desiredSessionKey) {
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: already ready");
    return true;
  }
  if (!srtModule || !srtWin) {
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: srtModule=${!!srtModule} srtWin=${!!srtWin}, cannot proceed`);
    return false;
  }

  // 会话 key 变化（换工作区/档位）→ 恢复重试预算，重新给初始化机会
  if (lastFailedSessionKey !== null && lastFailedSessionKey !== desiredSessionKey) {
    ensureFailCount = 0;
    lastFailedSessionKey = null;
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: session key changed, retry budget restored");
  }
  // 连续失败达到上限：不再重试，保持 not_ready（fail-closed），避免每条命令都撞墙
  if (ensureFailCount >= ENSURE_MAX_FAILURES) {
    logger.warn(LogTag.Runtime, `[Sandbox] ensureSandboxReady: ${ensureFailCount} consecutive failures, stop retrying in this process (fail-closed)`);
    return false;
  }

  try {
    logger.info(LogTag.Runtime, "[Sandbox] ensureSandboxReady: checking status...");
    const status = await srtModule.checkWindowsSandboxStatusAsync({ srtWin });
    logger.info(LogTag.Runtime, `[Sandbox] ensureSandboxReady: status user.provisioned=${status.user.provisioned} wfp.state=${status.wfp.state}`);
    if (!status.user.provisioned) {
      logger.info(LogTag.Runtime, "[Sandbox] not provisioned, attempting install (UAC may prompt)");
      const installResult = await srtModule.installWindowsSandboxAsync({ srtWin });
      if (installResult.cancelled) {
        logger.warn(LogTag.Runtime, "[Sandbox] install cancelled (UAC dismissed)");
        return false; // 不 disable，下次再试
      }
      logger.info(LogTag.Runtime, `[Sandbox] install completed: user.provisioned=${installResult.user?.provisioned} wfp.state=${installResult.wfp?.state}`);
    }
    if (sandboxReady) {
      await srtModule.SandboxManager.reset();
      sandboxReady = false;
      sandboxSessionKey = null;
    }
    await initSandboxManager(level, workspaceRoot);
    sandboxReady = true;
    ensureFailCount = 0;
    lastFailedSessionKey = null;
    logger.info(LogTag.Runtime, "[Sandbox] ready (lazy init)");
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 初始化故障保持 not_ready 语义（fail-closed），不伪装成"用户显式禁用"，
    // 否则 run_shell 会让 read 类命令绕过沙箱降级直跑
    ensureFailCount += 1;
    lastFailedSessionKey = desiredSessionKey;
    logger.error(LogTag.Runtime, `[Sandbox] lazy init failed (${ensureFailCount}/${ENSURE_MAX_FAILURES}), staying not-ready: ${msg}`);
    return false;
  }
}

/**
 * wrapWithSandbox 的归一化结果。
 *
 * 本函数只回答"能不能把这个命令安全包装起来"，不做任何 fallback 策略决策：
 * 包装失败后是拒绝还是降级直跑，由调用方（run_shell 的 ExecutionPlan 路由）判定。
 *
 * - ok:false + reason:"disabled"    → 环境层面显式无沙箱（CYRENE_SRT=0 / 非 Windows / full 档），
 *                                     属于用户主动选择，调用方可按 effect 分流
 * - ok:false + reason:"not_ready"   → 沙箱本应可用但初始化失败（ensure 失败 / SRT 模块缺失）
 * - ok:false + reason:"wrap_failed" → wrap 阶段抛错或返回非法 argv
 */
export type SandboxWrapOutcome =
  | { ok: true; argv: string[]; env: NodeJS.ProcessEnv }
  | { ok: false; reason: "disabled" | "not_ready" | "wrap_failed"; detail?: string };

/**
 * 把命令字符串包成沙箱 argv + env。
 *
 * @param command 完整命令行字符串（如 "git status | findstr TODO"）
 * @param binShell 可选命令解释器；缺省时 SRT 在 Windows 使用 cmd.exe
 * @returns SandboxWrapOutcome；ok:false 时 reason 区分"显式禁用"与"故障失败"，
 *          调用方据此决定 fail-closed 还是降级（见 run-shell-tool.ts 的 ExecutionPlan）
 *
 * 流程：
 * 1. 沙箱未就绪 → 先 ensureSandboxReady(cwd)（可能弹 UAC，失败返回 not_ready）
 * 2. 调 wrapWithSandboxArgv(command, binShell, customConfig, undefined, cwd)
 *    工作区读写权限已在初始化阶段授予；customConfig 仅承载本次命令的 deny 规则
 */
export async function wrapWithSandbox(
  command: string,
  cwd?: string,
  binShell?: string,
): Promise<SandboxWrapOutcome> {
  const level = getCurrentLevel();
  logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: command="${command}" cwd=${cwd || "(undefined)"} level=${level}`);

  if (sandboxDisabled || !isWindows()) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: skip (sandboxDisabled=${sandboxDisabled} isWindows=${isWindows()})`);
    return { ok: false, reason: "disabled", detail: `sandboxDisabled=${sandboxDisabled} isWindows=${isWindows()}` };
  }

  // full 档位不走沙箱（正常情况下调用方已提前分流，这里是防御性兜底）
  if (level === "full") {
    logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: full level, skipping sandbox (direct spawn)");
    return { ok: false, reason: "disabled", detail: "full level" };
  }

  const resolvedCwd = cwd || process.cwd();
  const ready = await ensureSandboxReady(resolvedCwd);
  if (!ready || !srtModule) {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: sandbox not ready (ready=${ready} srtModule=${!!srtModule}), returning not_ready`);
    return { ok: false, reason: "not_ready", detail: `ready=${ready} srtModule=${!!srtModule}` };
  }

  try {
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: command="${command}" resolvedCwd=${resolvedCwd}`);

    // 确保 cwd 存在（ACL grant 依赖；mkdirSync recursive 是幂等的）
    try {
      fs.mkdirSync(resolvedCwd, { recursive: true });
    } catch (err) {
      logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: mkdir cwd failed: ${resolvedCwd}`, err);
    }

    // per-call customConfig：按当前权限档位选 fs 配置
    const customConfig = buildFilesystemConfigForLevel(resolvedCwd);
    if (!customConfig) {
      logger.info(LogTag.Runtime, "[Sandbox] wrapWithSandbox: customConfig is null (full level fallback), returning not_ready");
      return { ok: false, reason: "not_ready", detail: "customConfig is null" };
    }

    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: calling wrapWithSandboxArgv...`);
    const wrapped = await srtModule.SandboxManager.wrapWithSandboxArgv(
      command,       // 完整命令字符串，SRT 内部 cmd.exe /c 执行
      binShell,      // undefined=Windows 默认 cmd.exe；Bash 模式传入已探测的 bash.exe
      customConfig,
      undefined,     // abortSignal
      resolvedCwd,
      undefined,     // options
    );
    if (!wrapped || !Array.isArray(wrapped.argv) || wrapped.argv.length === 0) {
      logger.warn(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap returned empty argv for: ${command} (wrapped=${JSON.stringify(wrapped)})`);
      return { ok: false, reason: "wrap_failed", detail: "empty argv" };
    }
    logger.info(LogTag.Runtime, `[Sandbox] wrapWithSandbox: success, argv.length=${wrapped.argv.length} argv[0]=${wrapped.argv[0]}`);
    return { ok: true, argv: wrapped.argv, env: wrapped.env };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(LogTag.Runtime, `[Sandbox] wrapWithSandbox: wrap failed: ${msg}`);
    return { ok: false, reason: "wrap_failed", detail: msg };
  }
}

/**
 * 释放沙箱资源（进程退出前 SRT 自己会处理，这里仅兜底）。
 */
export async function resetSandbox(): Promise<void> {
  if (!srtModule || !sandboxReady) return;
  try {
    await srtModule.SandboxManager.reset();
  } catch {
    // 退出时忽略
  }
}
