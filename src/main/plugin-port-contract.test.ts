// 插件端口契约（运行时兜底）。
//
// 编译期子集关系冻结在 plugin-port-contract.ts（tsc 门禁）；本文件锁的是
// 插件对象"省略可选字段"时宿主侧的运行时行为契约：默认值兜底必须确定、
// 权限路由必须对插件可声明的每档 risk 都有定义、注册表必须原样保留插件对象。
// 任何一条被破坏，插件不是静默走错分支就是深夜爆炸，这里让它在 CI 就炸。
import { describe, expect, it } from "vitest";
import {
  resolveEffectKind,
  resolveVerificationPolicy,
  toolRegistry,
  type ToolDefinition,
} from "./orchestrator/tools/registry/tool-registry";
import { policyFor, type AgentFileAccessLevel } from "./permission-policy";
import type { PluginTool } from "../plugins/types";

/** 与 plugins/api.ts 声明的六档 risk 保持一致（编译期子集由契约文件保证）。 */
const PLUGIN_RISKS = [
  "safe",
  "fs-read",
  "fs-write",
  "shell",
  "network",
  "input-control",
] as const;

const HOST_LEVELS = [
  "project-read-only",
  "read-only",
  "scoped",
  "per-action",
  "full",
] as const satisfies readonly AgentFileAccessLevel[];

/** 最小合法插件工具：仅必填字段（PluginTool 契约承诺可选字段全部可省略）。 */
const minimalPluginTool: PluginTool = {
  id: "contract_probe_tool",
  name: "契约探针",
  description: "锁死插件端口契约的运行时探针，测试结束即注销",
  enabled: true,
  inputSchema: { type: "object", properties: {} },
  execute: async () => "ok",
};

describe("插件端口契约（运行时兜底）", () => {
  it("省略全部可选字段的插件工具可注册且对象原样保留", () => {
    toolRegistry.register(minimalPluginTool as ToolDefinition);
    try {
      const stored = toolRegistry.getById("contract_probe_tool");
      expect(stored).toBe(minimalPluginTool);
      expect(toolRegistry.getEnabledTools()).toContain(minimalPluginTool);
    } finally {
      expect(toolRegistry.unregister("contract_probe_tool")).toBe(true);
    }
    expect(toolRegistry.getById("contract_probe_tool")).toBeUndefined();
  });

  it("插件工具省略 effectKind / verificationPolicy 时默认值确定", () => {
    expect(resolveEffectKind(undefined, {})).toBe("unknown");
    expect(resolveVerificationPolicy(undefined, {})).toBe("none");
    // 注册后的插件工具（省略字段）走同样默认值，不因注册路径而不同
    expect(resolveEffectKind(minimalPluginTool as ToolDefinition, {})).toBe("unknown");
    expect(
      resolveVerificationPolicy(minimalPluginTool as ToolDefinition, {}),
    ).toBe("none");
  });

  it("插件侧每档 risk 在宿主所有权限档位都有定义的路由", () => {
    for (const risk of PLUGIN_RISKS) {
      for (const level of HOST_LEVELS) {
        const decision = policyFor(level, risk);
        expect(["allow", "ask", "deny"]).toContain(decision);
      }
    }
  });

  it("插件默认 risk=safe 在所有权限档位直接放行", () => {
    for (const level of HOST_LEVELS) {
      expect(policyFor(level, "safe")).toBe("allow");
    }
  });
});
