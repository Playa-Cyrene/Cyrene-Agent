// 本机应用探测 + "用应用打开工作区" IPC。
//
// 探测逻辑移植自 deepseek-harness（MIT License, Copyright (c) 2026 DeepSeek），
// 原实现位于 packages/host/open-in-app（catalog + resolver）。核心设计：
// - 静态应用目录声明"找什么"（每个应用按平台列一串 locator，按序尝试）；
// - 运行时逐个 locator 验证"在不在"：注册表记录必须验证 exe 真实存在，
//   防卸载残留误报；PATH 查找用 stat 实现，不起 shell；
// - Windows 注册表一轮探测只读一次（reg.exe query 全量扫较慢），结果缓存
//   整个进程生命周期，菜单打开不再重复探测。
//
// 打开动作分两类：
// - "资源管理器打开"是固定项，直接走 Electron shell.openPath；
// - VSCode / Cursor 等按探测结果动态出现，用 spawn(detached) 启动。

import { execFile, spawn } from "node:child_process";
import { access, constants as fsConstants, realpath, stat } from "node:fs/promises";
import { homedir, platform as osPlatform } from "node:os";
import { join } from "node:path";
import { app, shell } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { OpenInAppEntry } from "../../shared/open-in-app-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as chatsStore from "./chats-store";

// ── 可注入的运行底座（测试用假实现替换，保持确定性） ─────────────────────

/** 无 shell 的命令执行边界：argv 数组，绝不拼接命令行字符串 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  signal: AbortSignal,
) => Promise<{ stdout: string; stderr: string }>;

/** execFile 封装：utf8 输出、abort 传播、Windows 下不弹窗 */
export const runCommand: CommandRunner = (command, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8", signal, windowsHide: true }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(Object.assign(new Error(error.message, { cause: error }), { code: error.code, stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });

/** 平台事实：全部可注入，默认取真实宿主 */
export interface DetectorInternals {
  platform?: NodeJS.Platform;
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  run?: CommandRunner;
  /** PATH 名字解析（返回可执行文件绝对路径，找不到为 null）；测试注入假实现 */
  resolveExecutable?: (name: string) => Promise<string | null>;
  /** 单条宿主命令（reg.exe）的超时上限 */
  probeTimeoutMs?: number;
}

/** 平台事实默认化的结果：探测链各环节共用（导出供测试构造） */
export interface ResolvedInternals {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
  run: CommandRunner;
  resolveExecutable: (name: string) => Promise<string | null>;
  probeTimeoutMs: number;
}

/** 进程内 PATH 名字解析：逐目录 stat，win32 按 PATHEXT 补扩展名，POSIX 检查可执行位 */
async function resolveExecutableOnPath(
  name: string,
  internals: ResolvedInternals,
): Promise<string | null> {
  const pathValue = internals.env.PATH ?? "";
  const exts = internals.platform === "win32"
    ? (internals.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "")
    : [""];
  for (const dir of pathValue.split(internals.platform === "win32" ? ";" : ":")) {
    if (dir === "") continue;
    for (const ext of exts) {
      const candidate = join(dir, name.endsWith(ext) || ext === "" ? name : name + ext.toLowerCase());
      try {
        if ((await stat(candidate)).isFile()) {
          if (internals.platform !== "win32") await access(candidate, fsConstants.X_OK);
          return candidate;
        }
      } catch {
        // 目录不存在 / 不可读 / 无执行权限：换下一个候选
      }
    }
  }
  return null;
}

/** 填充默认平台事实（导出供测试构造完整 internals） */
export function resolveInternals(internals: DetectorInternals): ResolvedInternals {
  const home = internals.home ?? homedir();
  const resolved: ResolvedInternals = {
    platform: internals.platform ?? osPlatform(),
    env: internals.env ?? process.env,
    home,
    run: internals.run ?? runCommand,
    resolveExecutable: internals.resolveExecutable ?? ((name) => resolveExecutableOnPath(name, resolved)),
    probeTimeoutMs: internals.probeTimeoutMs ?? 5000,
  };
  return resolved;
}

// ── 路径探测原语 ─────────────────────────────────────────────────────────

/** 探测路径是否为存在的普通文件；吞掉 ENOENT/EACCES（读不到 = 没装） */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 探测路径是否为存在的目录 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 展开候选路径模板中的 `${VAR}` 和开头的 `~/`；有变量未设置则返回 null */
export function expandCandidate(template: string, internals: ResolvedInternals): string | null {
  const unset: string[] = [];
  const expanded = template.replace(/\$\{([^}]+)\}/g, (token, name: string) => {
    const value = internals.env[name];
    if (value === undefined) unset.push(name);
    return value ?? token;
  });
  if (unset.length > 0) return null;
  return expanded.startsWith("~/") ? join(internals.home, expanded.slice(2)) : expanded;
}

/** 展开注册表值中的 `%VAR%`；有变量未设置则返回 null */
function expandRegistryValue(value: string, internals: ResolvedInternals): string | null {
  const unset: string[] = [];
  const expanded = value.replace(/%([^%]+)%/g, (token, name: string) => {
    const found = internals.env[name];
    if (found === undefined) unset.push(name);
    return found ?? token;
  });
  return unset.length > 0 ? null : expanded;
}

// ── Windows 注册表视图（一轮探测只读一次） ───────────────────────────────

/** App Paths 根键：用户 hive 优先（每用户安装遮蔽机器安装） */
const APP_PATHS_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths",
] as const;

/** 卸载记录根键：用户 hive、64 位机器 hive、32 位机器视图 */
const UNINSTALL_ROOTS = [
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
] as const;

/** 一条卸载记录中与定位启动器有关的字段 */
interface WindowsInstallRecord {
  readonly displayName: string;
  readonly installLocation?: string | undefined;
  readonly displayIcon?: string | undefined;
}

/** 一轮探测共享的注册表事实 */
export interface WindowsRegistryView {
  /** 小写 exe 名 → App Paths 默认值指向的完整路径 */
  readonly appPaths: ReadonlyMap<string, string>;
  readonly installRecords: readonly WindowsInstallRecord[];
}

/**
 * 解析 `reg.exe query <root> /s` 的输出为"子键路径 → 值名 → 数据"两层映射。
 * 值行按 `REG_*` 类型标记识别，因为默认值标记会随系统语言本地化（(Default)/(默认)）。
 */
export function parseRegistryDump(
  dump: string,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const keys = new Map<string, Map<string, string>>();
  let current: Map<string, string> | undefined;
  for (const line of dump.split(/\r?\n/)) {
    if (/^HK/.test(line)) {
      current = new Map();
      keys.set(line.trim(), current);
      continue;
    }
    const value = /^\s+(.*?)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line);
    if (value === null || current === undefined) continue;
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- 正则捕获组匹配即存在
    const [name, data] = [value[1]!, value[3]!];
    // 默认值标记被 reg.exe 本地化，各语言都用圆括号包裹
    current.set(/^\(.*\)$/.test(name) ? "(Default)" : name, data.trim());
  }
  return keys;
}

/** 跑一条有超时的宿主命令；任何失败（spawn/非零退出/超时）一律归为"不可用"返回 null */
async function commandOutput(
  command: string,
  args: readonly string[],
  internals: ResolvedInternals,
): Promise<string | null> {
  try {
    const { stdout } = await internals.run(command, args, AbortSignal.timeout(internals.probeTimeoutMs));
    return stdout;
  } catch {
    return null;
  }
}

/** 读出本轮探测需要的注册表事实：每个根键一次 `reg.exe query /s` */
async function readWindowsRegistryView(internals: ResolvedInternals): Promise<WindowsRegistryView> {
  const appPaths = new Map<string, string>();
  const installRecords: WindowsInstallRecord[] = [];
  for (const root of APP_PATHS_ROOTS) {
    const dump = await commandOutput("reg.exe", ["query", root, "/s"], internals);
    if (dump === null) continue;
    for (const [key, values] of parseRegistryDump(dump)) {
      // 注册表子键路径在所有运行此解析的宿主上都以 '\' 分隔，直接取最后一段
      const exe = key.slice(key.lastIndexOf("\\") + 1).toLowerCase();
      const target = values.get("(Default)");
      if (!exe.endsWith(".exe") || target === undefined || appPaths.has(exe)) continue;
      const expanded = expandRegistryValue(target.replace(/^"|"$/g, ""), internals);
      if (expanded !== null) appPaths.set(exe, expanded);
    }
  }
  for (const root of UNINSTALL_ROOTS) {
    const dump = await commandOutput("reg.exe", ["query", root, "/s"], internals);
    if (dump === null) continue;
    for (const values of parseRegistryDump(dump).values()) {
      const displayName = values.get("DisplayName");
      if (displayName === undefined) continue;
      installRecords.push({
        displayName,
        installLocation: values.get("InstallLocation"),
        displayIcon: values.get("DisplayIcon"),
      });
    }
  }
  return { appPaths, installRecords };
}

/** 一轮探测的惰性注册表读取器：多个 locator 共享，至多读一次 */
class RegistryViewOnce {
  private view: Promise<WindowsRegistryView> | null = null;
  constructor(private readonly internals: ResolvedInternals) {}

  read(): Promise<WindowsRegistryView> {
    this.view ??= readWindowsRegistryView(this.internals);
    return this.view;
  }
}

// ── 应用目录（静态数据：声明"找什么"） ──────────────────────────────────

/** 单个 locator：一种"如何找到并验证启动器"的方式 */
type Locator =
  | { kind: "cli"; name: string }
  | { kind: "file"; candidates: readonly string[] }
  | { kind: "app-paths"; exe: string }
  | { kind: "install-record"; displayNamePrefix: string; relativeLauncher?: string }
  | { kind: "app"; fsNames: readonly string[] };

/** 应用目录条目：id 是 IPC 往来的标识，name 是展示名（专有名词） */
interface CatalogApp {
  readonly id: string;
  readonly name: string;
  readonly platforms: Readonly<Partial<Record<"win32" | "darwin" | "linux", readonly Locator[]>>>;
}

/** 应用目录：探测按此顺序，菜单顺序与之一致 */
const CATALOG: readonly CatalogApp[] = [
  {
    id: "vscode",
    name: "VSCode",
    platforms: {
      // 三级探测链：注册表 App Paths → 卸载记录 → 常见安装路径兜底
      win32: [
        { kind: "app-paths", exe: "Code.exe" },
        { kind: "install-record", displayNamePrefix: "Microsoft Visual Studio Code", relativeLauncher: "Code.exe" },
        {
          kind: "file",
          candidates: [
            "${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe",
            "${ProgramFiles}/Microsoft VS Code/Code.exe",
          ],
        },
      ],
      darwin: [{ kind: "app", fsNames: ["Visual Studio Code.app"] }],
      linux: [{ kind: "cli", name: "code" }],
    },
  },
  {
    id: "vscode-insiders",
    name: "VSCode Insiders",
    platforms: {
      win32: [
        { kind: "app-paths", exe: "Code - Insiders.exe" },
        { kind: "install-record", displayNamePrefix: "Microsoft Visual Studio Code Insiders", relativeLauncher: "Code - Insiders.exe" },
        {
          kind: "file",
          candidates: ["${LOCALAPPDATA}/Programs/Microsoft VS Code Insiders/Code - Insiders.exe"],
        },
      ],
      darwin: [{ kind: "app", fsNames: ["Visual Studio Code - Insiders.app"] }],
      linux: [{ kind: "cli", name: "code-insiders" }],
    },
  },
  {
    id: "cursor",
    name: "Cursor",
    platforms: {
      win32: [
        { kind: "app-paths", exe: "Cursor.exe" },
        { kind: "install-record", displayNamePrefix: "Cursor" },
        { kind: "file", candidates: ["${LOCALAPPDATA}/Programs/cursor/Cursor.exe"] },
      ],
      darwin: [{ kind: "app", fsNames: ["Cursor.app"] }],
      linux: [{ kind: "cli", name: "cursor" }],
    },
  },
];

/** macOS 应用目录根：用户 Applications 优先级低于系统 */
const DARWIN_APP_ROOTS = ["/Applications", "~/Applications"];

// ── 定位解析（运行时验证"在不在"） ──────────────────────────────────────

/** 解析成功的一个启动器：command + 基础 argv，打开目标路径时再追加到 args 末尾 */
export interface ResolvedLaunch {
  readonly command: string;
  readonly args: readonly string[];
}

/** 卸载记录证明的启动器：InstallLocation + 相对路径优先，DisplayIcon 兜底；必须验证文件存在 */
async function recordLauncher(
  record: WindowsInstallRecord,
  relativeLauncher: string | undefined,
  internals: ResolvedInternals,
): Promise<string | null> {
  if (relativeLauncher !== undefined && record.installLocation !== undefined && record.installLocation !== "") {
    const expanded = expandRegistryValue(record.installLocation.replace(/^"|"$/g, ""), internals);
    if (expanded !== null) {
      const candidate = join(expanded, relativeLauncher);
      if (await isFile(candidate)) return candidate;
    }
  }
  if (record.displayIcon !== undefined) {
    // DisplayIcon 可能带 ",<图标序号>" 后缀和引号
    const bare = record.displayIcon.replace(/,-?\d+$/, "").replace(/^"|"$/g, "").trim();
    const expanded = expandRegistryValue(bare, internals);
    if (expanded !== null && expanded.toLowerCase().endsWith(".exe") && await isFile(expanded)) return expanded;
  }
  return null;
}

/** 解析单个 locator；验证不过返回 null（表示该途径没找到） */
async function locate(
  locator: Locator,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<ResolvedLaunch | null> {
  switch (locator.kind) {
    case "cli": {
      const found = await internals.resolveExecutable(locator.name);
      return found === null ? null : { command: found, args: [] };
    }
    case "file": {
      for (const candidate of locator.candidates) {
        const path = expandCandidate(candidate, internals);
        if (path !== null && await isFile(path)) return { command: path, args: [] };
      }
      return null;
    }
    case "app-paths": {
      const target = (await registry.read()).appPaths.get(locator.exe.toLowerCase());
      if (target === undefined || !(await isFile(target))) return null;
      return { command: target, args: [] };
    }
    case "install-record": {
      for (const record of (await registry.read()).installRecords) {
        if (!record.displayName.startsWith(locator.displayNamePrefix)) continue;
        const launcher = await recordLauncher(record, locator.relativeLauncher, internals);
        if (launcher !== null) return { command: launcher, args: [] };
      }
      return null;
    }
    case "app": {
      for (const rootTemplate of DARWIN_APP_ROOTS) {
        const root = expandCandidate(rootTemplate, internals);
        if (root === null) continue;
        for (const fsName of locator.fsNames) {
          const bundle = join(root, fsName);
          if (await isDirectory(bundle)) return { command: "open", args: ["-a", bundle] };
        }
      }
      return null;
    }
  }
}

/** 解析一个应用在本机的启动器：按目录声明的 locator 顺序，先验证成功者胜 */
async function resolveApp(
  app: CatalogApp,
  registry: RegistryViewOnce,
  internals: ResolvedInternals,
): Promise<ResolvedLaunch | null> {
  const locators = internals.platform === "win32" || internals.platform === "darwin" || internals.platform === "linux"
    ? app.platforms[internals.platform]
    : undefined;
  if (locators === undefined) return null;
  for (const locator of locators) {
    const found = await locate(locator, registry, internals);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 探测整个应用目录：返回 id → 已验证启动器（目录顺序）。
 * Windows 注册表整轮只读一次。
 */
export async function resolveOpenInApps(
  internals: DetectorInternals = {},
): Promise<Map<string, ResolvedLaunch & { id: string; name: string }>> {
  const resolved = resolveInternals(internals);
  const registry = new RegistryViewOnce(resolved);
  const results = await Promise.all(
    CATALOG.map(async (app) => {
      const launch = await resolveApp(app, registry, resolved);
      return launch === null ? null : { id: app.id, name: app.name, ...launch };
    }),
  );
  const map = new Map<string, ResolvedLaunch & { id: string; name: string }>();
  for (const entry of results) {
    if (entry !== null) map.set(entry.id, entry);
  }
  return map;
}

// ── 探测缓存（进程生命周期一次；启动失败时失效重探） ─────────────────────

let cachedDetection: Promise<Map<string, ResolvedLaunch & { id: string; name: string }>> | null = null;

function detectApps(): Promise<Map<string, ResolvedLaunch & { id: string; name: string }>> {
  cachedDetection ??= resolveOpenInApps().catch(() => new Map());
  return cachedDetection;
}

// ── 应用图标提取（exe → data URL，进程内缓存一次） ───────────────────────

/** 图标缓存：exe 路径 → data URL（undefined = 提取失败，同样缓存防重复尝试） */
const iconCache = new Map<string, string | undefined>();

/** 从 exe 提取小尺寸图标为 data URL；失败返回 undefined（渲染层显示占位方块） */
async function extractIcon(exePath: string): Promise<string | undefined> {
  try {
    const image = await app.getFileIcon(exePath, { size: "small" });
    return image.isEmpty() ? undefined : image.toDataURL();
  } catch {
    return undefined;
  }
}

/** 取一个启动器 exe 的图标（带缓存）；非 exe 启动器（如 macOS open）没有图标 */
async function iconFor(command: string): Promise<string | undefined> {
  if (!command.toLowerCase().endsWith(".exe")) return undefined;
  if (!iconCache.has(command)) iconCache.set(command, await extractIcon(command));
  return iconCache.get(command);
}

/** 资源管理器固定项：Windows 下从系统目录的 explorer.exe 取图标 */
async function explorerIcon(): Promise<string | undefined> {
  if (process.platform !== "win32") return undefined;
  return iconFor(join(process.env.SystemRoot ?? "C:\\Windows", "explorer.exe"));
}

// ── 选择记忆（主按钮跟随上次成功使用的应用；进程内记忆，重启回落资源管理器） ──

let preferredAppId: string | null = null;

// ── 启动（detached spawn + 短观察窗） ────────────────────────────────────

/**
 * 以 detached 子进程启动一个应用并传入手柄目标路径：
 * 只在观察窗内捕获"立即失败"（spawn 报错 / 秒退非零），窗口结束仍存活即算成功，
 * 不等待应用退出——IDE 类进程会常驻前台整个窗口生命周期。
 */
export function launchDetachedApp(command: string, args: readonly string[], watchMs = 1500): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watch);
      child.unref();
      outcome();
    };
    const watch = setTimeout(() => settle(resolve), watchMs);
    child.on("error", (error) => settle(() => reject(error)));
    child.on("exit", (code) => {
      if (code === 0) settle(resolve);
      else settle(() => reject(new Error(`launcher exited with code ${String(code)}`)));
    });
  });
}

// ── IPC ─────────────────────────────────────────────────────────────────

/** 校验会话工作区：返回 realpath 后的根目录；无绑定/目录不存在回传错误 code */
async function validatedWorkspaceRoot(sessionId: string): Promise<{ root: string } | { code: string }> {
  const binding = chatsStore.getWorkspaceBinding(sessionId);
  if (!binding) return { code: "NO_WORKSPACE" };
  try {
    const root = await realpath(binding.workspaceRoot);
    return { root };
  } catch {
    return { code: "WORKSPACE_MISSING" };
  }
}

/**
 * 注册"打开工作区"IPC：
 * - LIST：探测本机可用应用（不含固定项——资源管理器由渲染层自行加，恒可用）；
 * - OPEN：执行打开动作（explorer 走 shell.openPath，其余走 detached spawn）。
 */
export function registerOpenInAppIpc(ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();

  ipc.handle(IPC.WORKSPACE_OPEN_IN_LIST_APPS, async (_event, payload: { sessionId?: string }) => {
    if (!payload?.sessionId) return { ok: false as const, code: "NO_WORKSPACE" as const };
    const workspace = await validatedWorkspaceRoot(payload.sessionId);
    if ("code" in workspace) return { ok: false as const, code: workspace.code as "NO_WORKSPACE" };
    const detected = await detectApps();
    // 固定项资源管理器放最前（统一由主进程回传，方便带图标与选择记忆）
    const apps: OpenInAppEntry[] = [
      { id: "explorer", name: "资源管理器", icon: await explorerIcon() },
    ];
    for (const entry of detected.values()) {
      apps.push({ id: entry.id, name: entry.name, icon: await iconFor(entry.command) });
    }
    return { ok: true as const, apps, preferred: preferredAppId ?? "explorer" };
  });

  ipc.handle(IPC.WORKSPACE_OPEN_IN, async (_event, payload: { sessionId?: string; appId?: string }) => {
    if (!payload?.sessionId || !payload?.appId) {
      return { ok: false as const, code: "WORKSPACE_MISSING" as const };
    }
    const workspace = await validatedWorkspaceRoot(payload.sessionId);
    if ("code" in workspace) return { ok: false as const, code: workspace.code as "NO_WORKSPACE" };
    const { root } = workspace;

    // 固定项：资源管理器直接打开工作区目录（目录的默认应用即 Explorer）
    if (payload.appId === "explorer") {
      const error = await shell.openPath(root);
      if (error) return { ok: false as const, code: "LAUNCH_FAILED" as const, error };
      preferredAppId = "explorer";
      return { ok: true as const };
    }

    const detected = await detectApps();
    const launch = detected.get(payload.appId);
    if (!launch) return { ok: false as const, code: "APP_NOT_FOUND" as const };
    try {
      await launchDetachedApp(launch.command, [...launch.args, root]);
      preferredAppId = payload.appId;
      return { ok: true as const };
    } catch (err) {
      // 启动失败（如探测缓存指向的 exe 已被卸载删除）：失效缓存，下次重新探测
      cachedDetection = null;
      return {
        ok: false as const,
        code: "LAUNCH_FAILED" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
}
