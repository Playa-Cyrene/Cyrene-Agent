// resolver 行为基准（golden）—— 直测 resolveReasoningCapability 的四类关键场景。
//
// 与 order-snapshot 的分工：snapshot 证明"数据没变"，本文件证明"行为没变"。
// 数据一致但行为退化（例如恒等判断被破坏）只有这里能抓住。
import { describe, expect, test } from "vitest";
import { resolveReasoningCapability } from "../reasoning";
import { UNKNOWN_REASONING_CAPABILITY } from "./fallback";

describe("resolveReasoningCapability — 行为基准", () => {
  test("同厂商精确命中：glm + glm-5.3 → 强制思考 + autoEffort=high", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
  });

  test("厂商内排序敏感：qwen + qwen3-thinking → /-thinking$/ 先于 /^qwen3/ 命中 fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-thinking");
    expect(cap.control).toBe("fixed-on");
    expect(cap.requestStyle).toBe("none");
  });

  test("托管端点跨家族二轮：doubao + glm-5.3（方舟上跑 GLM）→ 找回 glm 家族规则", () => {
    const cap = resolveReasoningCapability("doubao", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.autoEffort).toBe("high");
  });

  test("跨家族二轮另一向：glm + gpt-6 → 找回 chatgpt 家族规则", () => {
    const cap = resolveReasoningCapability("glm", "gpt-6");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
  });

  test("未知模型落兜底：glm + 完全不匹配的模型名 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("glm", "totally-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    expect(cap.control).toBe("none");
  });

  test("未知厂商 + 未知模型 → 共享兜底单例（恒等）", () => {
    const cap = resolveReasoningCapability("some-unknown-vendor", "some-unknown-model");
    expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
  });

  test("兜底单例全局唯一：所有厂商表尾 /.*/ 引用同一实例", () => {
    for (const vendorId of ["chatgpt", "claude", "deepseek", "glm", "qwen", "kimi", "minimax", "mimo", "doubao"]) {
      const cap = resolveReasoningCapability(vendorId, "zzz-no-such-model");
      expect(cap).toBe(UNKNOWN_REASONING_CAPABILITY);
    }
  });
});
