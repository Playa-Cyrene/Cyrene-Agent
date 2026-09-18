/**
 * IPC 契约对账。
 *
 * `src/preload` 是渲染进程访问主进程的唯一出口，但「发」与「接」分别写在
 * `src/preload` 与 `src/main` 两个目录里，只能靠人工对齐。通道名写错、
 * 主进程注册被删、只在某条启动路径下才注册 —— 这类接线错误在运行时表现
 * 为「点了没反应」，且只在特定窗口/操作顺序下暴露，复查成本极高。
 *
 * 校验三个方向，方向与主进程侧要求严格一一对应：
 *   - preload `invoke` → 主进程必须 `handle`（send 不能被 handle 接收，反之亦然）
 *   - preload `send`   → 主进程必须 `on`
 *   - preload `on`     → 主进程必须外发（send / broadcast / emit）
 *
 * 扫描基于 TypeScript 语法树（见 `ipc-contract-scanner.ts`），注释与字符串里的
 * 伪注册不会被计入；并额外校验注册点确属组合根可达的装配路径。
 *
 * 注意：本测试只做「接线存在性」校验，不断言载荷形状与通道语义。
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectReachableFiles,
  findIpcChannelUses,
  type IpcChannelUse,
  type IpcChannelUseKind,
} from "./ipc-contract-scanner";

const repoRoot = process.cwd();

/** 渲染进程访问主进程的唯一出口。 */
const RENDERER_DIR = "src/preload";
/** 主进程侧源码目录：插件管理器位于 src/plugins，但其注册落在主进程。 */
const MAIN_DIRS = ["src/main", "src/plugins"];
/** 生产装配入口（组合根）：只有从这里可达的模块才算真正被装配。 */
const COMPOSITION_ROOT = "src/main/index.ts";

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function listSourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
      const absoluteChild = path.join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        walk(absoluteChild);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      if (/\.(?:test|spec)\.tsx?$/.test(entry.name) || entry.name.endsWith(".d.ts")) continue;
      files.push(absoluteChild);
    }
  };
  walk(path.join(repoRoot, relativeDir));
  return files.sort();
}

function collectUses(relativeDirs: string[]): IpcChannelUse[] {
  return relativeDirs.flatMap((relativeDir) =>
    listSourceFiles(relativeDir).flatMap((file) =>
      findIpcChannelUses(toPosix(path.relative(repoRoot, file)), fs.readFileSync(file, "utf8")),
    ),
  );
}

interface ChannelUse {
  /** 首个引用位置，用于失败时定位。 */
  first: IpcChannelUse;
  /** 全部引用位置。 */
  sites: IpcChannelUse[];
}

/** 按方向筛选并按键名归并。 */
function indexUses(uses: IpcChannelUse[], kind: IpcChannelUseKind): Map<string, ChannelUse> {
  const byKey = new Map<string, ChannelUse>();
  for (const use of uses) {
    if (use.kind !== kind) continue;
    const existing = byKey.get(use.channel);
    if (existing) existing.sites.push(use);
    else byKey.set(use.channel, { first: use, sites: [use] });
  }
  return byKey;
}

const rendererUses = collectUses([RENDERER_DIR]);
const mainUses = collectUses(MAIN_DIRS);

const preloadInvoke = indexUses(rendererUses, "invoke");
const preloadSend = indexUses(rendererUses, "send");
const preloadListen = indexUses(rendererUses, "listen");
const mainHandle = indexUses(mainUses, "handle");
const mainOn = indexUses(mainUses, "on");
const mainOutbound = indexUses(mainUses, "outbound");

function sortedKeys(uses: Map<string, ChannelUse>): string[] {
  return [...uses.keys()].sort();
}

/** 输出可读的缺失清单，失败时直接给出通道键、引用位置与引用处数。 */
function describeMissing(missing: string[], side: Map<string, ChannelUse>, counterpart: string): string {
  if (missing.length === 0) return "";
  const lines = missing.map((key) => {
    const use = side.get(key)!;
    return `  - ${key} (IPC.${key}) ← ${use.first.file}:${use.first.line}，共 ${use.sites.length} 处引用`;
  });
  return `\n以下通道在主进程侧找不到${counterpart}：\n${lines.join("\n")}\n`;
}

describe("IPC 契约：preload ↔ main 通道对账", () => {
  it("对账双方均被成功扫描（防扫描器失效导致真空通过）", () => {
    // 扫描器一旦因源码写法变化而失效，集合会缩小甚至清空，
    // 后续断言就会全部「无人可对」地通过。这里用下界把它钉住。
    expect(preloadInvoke.size, "preload invoke 通道数").toBeGreaterThan(100);
    expect(preloadSend.size, "preload send 通道数").toBeGreaterThan(10);
    expect(preloadListen.size, "preload listen 通道数").toBeGreaterThan(20);
    expect(mainHandle.size, "main handle 通道数").toBeGreaterThan(100);
    expect(mainOn.size, "main on 通道数").toBeGreaterThan(10);
    expect(mainOutbound.size, "main 外发通道数").toBeGreaterThan(20);
  });

  it("preload 以 invoke 调用的通道，主进程都有 handle 注册", () => {
    const missing = sortedKeys(preloadInvoke).filter((key) => !mainHandle.has(key));
    expect(missing, describeMissing(missing, preloadInvoke, "handle 注册")).toEqual([]);
  });

  it("preload 以 send 发出的通道，主进程都有 on 注册", () => {
    // send 是单向消息，只有 ipcMain.on 能收到；handle 不会响应 send。
    const missing = sortedKeys(preloadSend).filter((key) => !mainOn.has(key));
    expect(missing, describeMissing(missing, preloadSend, "on 注册")).toEqual([]);
  });

  it("preload 监听的通道，主进程都有外发", () => {
    const missing = sortedKeys(preloadListen).filter((key) => !mainOutbound.has(key));
    expect(missing, describeMissing(missing, preloadListen, "外发")).toEqual([]);
  });

  it("同一通道没有被重复 handle 注册", () => {
    // createIpcScope 默认包裹全局 ipcMain，同通道二次 handle 会在启动时抛错，
    // 但只有走到那条注册路径才会暴露；这里提前静态拦住。
    const duplicated = [...mainHandle.entries()]
      .filter(([, use]) => use.sites.length > 1)
      .map(
        ([key, use]) =>
          `${key} (IPC.${key}) 注册 ${use.sites.length} 次：` +
          use.sites.map((site) => `${site.file}:${site.line}`).join("、"),
      )
      .sort();
    expect(duplicated).toEqual([]);
  });

  it("主进程外发的通道，preload 侧都有监听（反向对账）", () => {
    // 前面的断言只覆盖 preload → main 方向。若渲染端监听被误删，主进程会继续
    // 外发而 UI 静默不再更新 —— 这里守住反向。
    //
    // 不留白名单：主进程外发却无人监听就是死信道，应删掉发送端，
    // 而不是给它开豁免（白名单会把死代码合法化）。
    const orphan = sortedKeys(mainOutbound).filter((key) => !preloadListen.has(key));
    expect(orphan, describeMissing(orphan, mainOutbound, "对应的 preload 监听")).toEqual([]);
  });

  it("所有 IPC 注册点都位于组合根可达的装配路径内", () => {
    // 「源码里出现过注册表达式」不等于「生产启动会走到它」：只在测试或废弃模块里
    // 出现的注册同样满足前四条断言。这里沿相对 import 从组合根求可达集，把死模块拦掉。
    const reachable = new Set(
      [...collectReachableFiles(path.join(repoRoot, COMPOSITION_ROOT))].map((file) =>
        toPosix(path.relative(repoRoot, file)),
      ),
    );
    const registrationFiles = [
      ...new Set(
        [...mainHandle.values(), ...mainOn.values(), ...mainOutbound.values()].flatMap((use) =>
          use.sites.map((site) => site.file),
        ),
      ),
    ].sort();

    expect(registrationFiles.length, "被扫描到的注册文件数").toBeGreaterThan(20);
    expect(registrationFiles.filter((file) => !reachable.has(file))).toEqual([]);
  });
});

describe("ipc-contract-scanner", () => {
  it("按方向归类调用，且忽略注释与字符串里的伪注册", () => {
    const source = [
      "ipcRenderer.invoke(IPC.A);",
      "ipcRenderer.send(IPC.B);",
      "ipcRenderer.on(IPC.C, h);",
      "ipcRenderer.removeListener(IPC.C, h);",
      "ipc.handle(IPC.D, h);",
      "ipc.on(IPC.E, h);",
      "win.webContents.send(IPC.F, p);",
      "sendToPetWindow(IPC.G, p);",
      "runtime.registerIpc(IPC.H, h);",
      "// ipc.handle(IPC.COMMENTED, h);",
      'const label = "ipc.handle(IPC.STRING, h)";',
      "sendToPetWindow(channel, p);",
      "webContents.send(channel, p);",
    ].join("\n");

    expect(findIpcChannelUses("sample.ts", source).map((use) => `${use.kind}:${use.channel}`))
      .toEqual([
        "invoke:A",
        "send:B",
        "listen:C",
        "listen:C",
        "handle:D",
        "on:E",
        "outbound:F",
        "outbound:G",
        "handle:H",
      ]);
  });
});
