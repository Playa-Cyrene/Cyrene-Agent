// 副作用映射表测试：effectKind → SideEffectKind 的语义边界。
// verification ≠ 无副作用（有产物、跑项目脚本，退出并发池但可安全重跑）；
// unknown 一律按最危险处理（fail-closed），修复"未声明被当作只读"的旧映射。

import { describe, expect, it } from "vitest";
import type { ToolDefinition } from "../tools/registry/tool-registry";
import { resolveSideEffect } from "./side-effect-resolver";
import { decideRetry } from "./retry-policy";

function tool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    id: "t",
    name: "t",
    description: "t",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "ok",
    ...overrides,
  };
}

describe("resolveSideEffect 映射", () => {
  it("read → read_only", () => {
    expect(resolveSideEffect(tool({ effectKind: "read" }), {})).toBe("read_only");
  });

  it("verification → idempotent_mutation：验证有产物、退出并发 read 池，但可安全重跑", () => {
    expect(resolveSideEffect(tool({ effectKind: "verification" }), {})).toBe("idempotent_mutation");
  });

  it("mutation → idempotent_mutation（不变）", () => {
    expect(resolveSideEffect(tool({ effectKind: "mutation" }), {})).toBe("idempotent_mutation");
  });

  it("external_side_effect → non_idempotent_side_effect（不变）", () => {
    expect(resolveSideEffect(tool({ effectKind: "external_side_effect" }), {})).toBe("non_idempotent_side_effect");
  });

  it("unknown → non_idempotent_side_effect：修复「未声明被当作只读」的旧映射", () => {
    expect(resolveSideEffect(tool({ effectKind: "unknown" }), {})).toBe("non_idempotent_side_effect");
  });

  it("未声明 effectKind 的工具（MCP/插件来源）→ non_idempotent_side_effect（fail-closed）", () => {
    expect(resolveSideEffect(tool(), {})).toBe("non_idempotent_side_effect");
    expect(resolveSideEffect(undefined, {})).toBe("non_idempotent_side_effect");
  });

  it("effectResolver 优先于静态 effectKind", () => {
    const dynamic = tool({ effectKind: "mutation", effectResolver: () => "read" });
    expect(resolveSideEffect(dynamic, {})).toBe("read_only");
  });

  it("effectResolver 返回非法值 → non_idempotent_side_effect（fail-closed 兜底）", () => {
    const bad = tool({ effectKind: "read", effectResolver: () => "weird" as ToolDefinition["effectKind"] });
    expect(resolveSideEffect(bad, {})).toBe("non_idempotent_side_effect");
  });
});

describe("重试语义（验证清单 #18 / #19 的完整链路）", () => {
  it("#18 run_verification 因 timeout/transient 失败可自动重试", () => {
    const sideEffect = resolveSideEffect(tool({ effectKind: "verification" }), {});
    expect(decideRetry("timeout", sideEffect)).toBe("retry");
    expect(decideRetry("transient", sideEffect)).toBe("retry");
    expect(decideRetry("rate_limited", sideEffect)).toBe("retry");
  });

  it("#19 未声明 effectKind 的工具 timeout 不自动重试", () => {
    const sideEffect = resolveSideEffect(tool(), {});
    expect(decideRetry("timeout", sideEffect)).toBe("no_retry");
    expect(decideRetry("transient", sideEffect)).toBe("no_retry");
  });
});
