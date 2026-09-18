// open-in-app 探测逻辑单测：注册表解析、路径模板展开、应用探测三路验证链。
// 全部通过注入假 runner / 环境变量实现确定性，不依赖真实安装的软件。

import fs from "fs";
import os from "os";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// electron：探测逻辑只用 shell.openPath（IPC 路径），这里给空实现
vi.mock("electron", () => ({
  shell: { openPath: vi.fn(async () => "") },
}));
// chats-store：本测试不经过 IPC，只需要模块能加载
vi.mock("./chats-store", () => ({
  getWorkspaceBinding: vi.fn(() => null),
}));

import {
  expandCandidate,
  parseRegistryDump,
  resolveInternals,
  resolveOpenInApps,
  type DetectorInternals,
} from "./open-in-app";

// ── 工具：构造注入了假环境的 internals ──────────────────────────────────

function makeInternals(overrides: Partial<DetectorInternals> = {}): DetectorInternals {
  return {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\t\\AppData\\Local", ProgramFiles: "C:\\Program Files", PATH: "", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
    home: "C:\\Users\\t",
    ...overrides,
  };
}

/** App Paths 根键的 reg.exe 输出（子键名 = exe 名，默认值指向安装路径） */
function appPathsDump(entries: readonly { exe: string; target: string }[]): string {
  const root = "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths";
  return entries
    .map((e) => `${root}\\${e.exe}\r\n    (默认)    REG_SZ    ${e.target}\r\n`)
    .join("");
}

/** Uninstall 根键的 reg.exe 输出 */
function uninstallDump(
  entries: readonly { displayName: string; installLocation?: string; displayIcon?: string }[],
): string {
  const root = "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
  return entries
    .map((e) => {
      const lines = [`${root}\\{${e.displayName}}`, `    DisplayName    REG_SZ    ${e.displayName}`];
      if (e.installLocation !== undefined) lines.push(`    InstallLocation    REG_SZ    ${e.installLocation}`);
      if (e.displayIcon !== undefined) lines.push(`    DisplayIcon    REG_SZ    ${e.displayIcon}`);
      return lines.join("\r\n") + "\r\n";
    })
    .join("");
}

/** 假 runner：按 reg.exe 的 root 参数分流返回预置输出，其它命令一律失败 */
function fakeRunner(appPaths: string, uninstall: string): DetectorInternals["run"] {
  return async (_command, args) => {
    const root = String(args[1] ?? "");
    if (root.includes("App Paths")) return { stdout: appPaths, stderr: "" };
    if (root.includes("Uninstall")) return { stdout: uninstall, stderr: "" };
    throw new Error("unexpected command");
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-open-in-app-"));
}

beforeEach(() => {
  vi.resetModules();
});

// ── 注册表输出解析 ───────────────────────────────────────────────────────

describe("parseRegistryDump", () => {
  it("解析子键与 REG_SZ 值，默认值标记按本地化圆括号识别", () => {
    const dump = [
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe",
      "    (默认)    REG_SZ    C:\\Program Files\\Microsoft VS Code\\Code.exe",
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe",
      "    (Default)    REG_EXPAND_SZ    \"C:\\Users\\t\\AppData\\Local\\Programs\\cursor\\Cursor.exe\"",
    ].join("\r\n");
    const keys = parseRegistryDump(dump);
    expect(keys.size).toBe(2);
    const code = keys.get("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Code.exe");
    expect(code?.get("(Default)")).toBe("C:\\Program Files\\Microsoft VS Code\\Code.exe");
    const cursor = keys.get("HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\Cursor.exe");
    expect(cursor?.get("(Default)")).toBe("\"C:\\Users\\t\\AppData\\Local\\Programs\\cursor\\Cursor.exe\"");
  });

  it("非字符串类型（REG_DWORD 等）的行被忽略", () => {
    const dump = [
      "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{X}",
      "    NoModify    REG_DWORD    0x1",
      "    DisplayName    REG_SZ    Something",
    ].join("\r\n");
    const values = [...parseRegistryDump(dump).values()][0]!;
    expect(values.get("DisplayName")).toBe("Something");
    expect(values.has("NoModify")).toBe(false);
  });
});

// ── 路径模板展开 ─────────────────────────────────────────────────────────

describe("expandCandidate", () => {
  it("展开 ${VAR}；有变量未设置时返回 null", () => {
    const resolved = resolveInternals(makeInternals());
    expect(expandCandidate("${LOCALAPPDATA}/Programs/x", resolved)).toBe("C:\\Users\\t\\AppData\\Local/Programs/x");
    expect(expandCandidate("${UNSET_VAR}/x", resolved)).toBeNull();
  });

  it("展开开头的 ~/ 为用户主目录", () => {
    const resolved = resolveInternals(makeInternals());
    expect(expandCandidate("~/scripts/x", resolved)).toBe(path.join("C:\\Users\\t", "scripts/x"));
  });
});

// ── 应用探测三路验证链 ───────────────────────────────────────────────────

describe("resolveOpenInApps", () => {
  it("探测链一级：App Paths 注册表命中且 exe 真实存在 → 解析成功", async () => {
    const dir = tempDir();
    const exe = path.join(dir, "Code.exe");
    fs.writeFileSync(exe, "");
    const internals = makeInternals({
      run: fakeRunner(appPathsDump([{ exe: "Code.exe", target: exe }]), uninstallDump([])),
    });
    const apps = await resolveOpenInApps(internals);
    expect(apps.get("vscode")?.command).toBe(exe);
    expect(apps.has("cursor")).toBe(false);
  });

  it("注册表记录指向不存在的 exe 时不算数：降级到卸载记录 / 常见路径兜底", async () => {
    const dir = tempDir();
    // 兜底路径 ${LOCALAPPDATA}/Programs/Microsoft VS Code/Code.exe 存在，其余全指向不存在的位置
    const fallback = path.join(dir, "local", "Programs", "Microsoft VS Code", "Code.exe");
    fs.mkdirSync(path.dirname(fallback), { recursive: true });
    fs.writeFileSync(fallback, "");
    const internals = makeInternals({
      env: { LOCALAPPDATA: path.join(dir, "local"), ProgramFiles: path.join(dir, "pf"), PATH: "", PATHEXT: ".EXE" },
      run: fakeRunner(
        // App Paths 指向已被卸载删除的路径
        appPathsDump([{ exe: "Code.exe", target: path.join(dir, "gone", "Code.exe") }]),
        // 卸载记录的 InstallLocation 里也没有 Code.exe
        uninstallDump([{ displayName: "Microsoft Visual Studio Code", installLocation: path.join(dir, "empty") }]),
      ),
    });
    const apps = await resolveOpenInApps(internals);
    // 模板候选路径保留 `/` 分隔符（Win32 API 接受），只断言前缀展开正确
    expect(apps.get("vscode")?.command).toBe(`${path.join(dir, "local")}/Programs/Microsoft VS Code/Code.exe`);
  });

  it("探测链二级：卸载记录 DisplayIcon 验证通过 → 解析成功（Cursor）", async () => {
    const dir = tempDir();
    const exe = path.join(dir, "cursor", "Cursor.exe");
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, "");
    const internals = makeInternals({
      run: fakeRunner(appPathsDump([]), uninstallDump([
        // DisplayIcon 带 ",0" 图标序号后缀，应被剥掉再验证
        { displayName: "Cursor", displayIcon: `${exe},0` },
      ])),
    });
    const apps = await resolveOpenInApps(internals);
    expect(apps.get("cursor")?.command).toBe(exe);
  });

  it("全部途径都未命中 → 对应应用不在结果里", async () => {
    const internals = makeInternals({ run: fakeRunner(appPathsDump([]), uninstallDump([])) });
    const apps = await resolveOpenInApps(internals);
    expect(apps.size).toBe(0);
  });
});
