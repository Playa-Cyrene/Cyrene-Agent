// built-in-tools 拆分守护测试（characterization test）。
// 目的：把 built-in-tools.ts 拆成多个工具模块期间，锁死三件不能变的事：
//   1) 注册插入顺序 —— registry 是 Map，插入顺序 = 运行时工具目录 prompt 的生成顺序；
//   2) 每个 ToolDefinition 的全部模型可见字段（description 一字不变，直接进 prompt）；
//   3) run_shell 的纯拒绝路径 JSON 协议与 currentUserTimezone 的回退行为。
// 全部断言基于"拆分前"的现状生成，拆分过程中任何行为漂移都会让门禁变红。

import { describe, expect, it } from "vitest";
import { toolRegistry } from "./registry/tool-registry";
import {
  currentUserTimezone,
  setUserTimezoneConfig,
} from "./built-in-tools";

/** built-in-tools 注册的 9 个工具 id，严格按 built-in-tools.ts 的注册先后排序。
 *  registry 插入顺序 = 工具目录 prompt 顺序，拆分时 facade 的 import 顺序必须保持它。 */
const BUILT_IN_TOOL_IDS = [
  "fetch_url",
  "download_file",
  "read_image_url",
  "run_shell",
  "shell_job",
  "run_verification",
  "install_mcp_server",
  "weather",
  "web_search",
] as const;

describe("built-in-tools 注册快照", () => {
  it("按原注册顺序插入 registry（工具目录 prompt 顺序契约）", () => {
    const allIds = toolRegistry.getAllTools().map((t) => t.id);
    expect(allIds).not.toContain("play_live2d_action");
    // 只取 built-in-tools 这 7 个 id 的相对顺序做断言，对 registry 里其它模块的
    // 注册（tool-registry.ts 自带工具等）保持鲁棒。
    const positions = BUILT_IN_TOOL_IDS.map((id) => allIds.indexOf(id));
    positions.forEach((pos, i) => {
      expect(pos, `工具 ${BUILT_IN_TOOL_IDS[i]} 应已注册`).toBeGreaterThanOrEqual(0);
    });
    const sorted = [...positions].sort((a, b) => a - b);
    expect(positions, "注册插入顺序必须与原 built-in-tools.ts 一致").toEqual(sorted);
  });

  it.each(BUILT_IN_TOOL_IDS)("模型可见字段快照：%s", (id) => {
    const tool = toolRegistry.getById(id);
    expect(tool, `工具 ${id} 应已注册`).toBeDefined();
    expect(
      JSON.stringify({
        id: tool!.id,
        name: tool!.name,
        description: tool!.description,
        enabled: tool!.enabled,
        modes: tool!.modes,
        risk: tool!.risk,
        effectKind: tool!.effectKind,
        verificationPolicy: tool!.verificationPolicy,
        ledgerPolicy: tool!.ledgerPolicy,
        inputSchema: tool!.inputSchema,
      }),
    ).toMatchSnapshot();
  });
});

describe("run_shell 纯拒绝路径（不 spawn、不联网）", () => {
  const runShell = () => toolRegistry.getById("run_shell")!;

  it("空 command 拒绝", async () => {
    expect(await runShell().execute({ command: "" })).toBe("[错误] command 不能为空");
  });

  it("非法 shell 返回 SHELL_UNSUPPORTED 协议", async () => {
    const result = JSON.parse(await runShell().execute({ command: "git status", shell: "zsh" })) as Record<string, unknown>;
    expect(result).toMatchObject({
      command: "git status",
      shell: "zsh",
      errorCode: "SHELL_UNSUPPORTED",
      exitCode: -1,
      stdout: "",
      stderr: "[SHELL_UNSUPPORTED] shell 仅支持 cmd 或 bash",
      timedOut: false,
      captureTruncated: false,
      effect: "unknown",
      sandboxed: false,
    });
  });

  it("灾难命令无条件拒绝（档位判断之前）", async () => {
    const result = JSON.parse(await runShell().execute({ command: "format c:" })) as Record<string, unknown>;
    expect(result).toMatchObject({
      command: "format c:",
      exitCode: -1,
      stdout: "",
      stderr: "[拒绝] 该命令被系统禁止执行",
      timedOut: false,
      captureTruncated: false,
      effect: "unknown",
      sandboxed: false,
    });
  });
});

describe("currentUserTimezone 注入与回退", () => {
  it("未注入时回退 Asia/Shanghai，注入合法值后透传，非法值回退", () => {
    expect(currentUserTimezone()).toBe("Asia/Shanghai");

    setUserTimezoneConfig(() => "America/New_York");
    expect(currentUserTimezone()).toBe("America/New_York");

    setUserTimezoneConfig(() => "Not/A-Valid-Zone");
    expect(currentUserTimezone()).toBe("Asia/Shanghai");

    // 还原，避免影响同文件后续断言
    setUserTimezoneConfig(() => undefined);
    expect(currentUserTimezone()).toBe("Asia/Shanghai");
  });
});
