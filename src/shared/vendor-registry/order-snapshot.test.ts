// 两套厂商顺序分别是兼容约束；型号能力由 rule-contracts 和真实请求用例保护。
import { describe, expect, test } from "vitest";
import { REASONING_VENDOR_ORDER, VENDOR_REGISTRY } from "./index";

describe("厂商聚合的两个独立顺序", () => {
  test("界面与能力顺序保持历史排列", () => {
    expect(VENDOR_REGISTRY.map((entry) => entry.capability.id)).toEqual([
      "minimax", "deepseek", "doubao", "glm", "kimi", "qwen", "chatgpt", "claude", "mimo", "grok", "gemini",
    ]);
  });

  test("推理与跨厂商推断保持独立的首条命中顺序", () => {
    expect(REASONING_VENDOR_ORDER.map((entry) => entry.capability.id)).toEqual([
      "chatgpt", "claude", "deepseek", "glm", "qwen", "kimi", "minimax", "mimo", "doubao", "grok", "gemini",
    ]);
  });
});
