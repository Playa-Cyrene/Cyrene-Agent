import { describe, expect, test } from "vitest";
import { resolveAutomaticToolChoicePolicy, resolveToolChoicePolicy } from "./tool-choice-policy";

describe("resolveToolChoicePolicy", () => {
  test("uses MiniMax documented auto-only OpenAI tool choice", () => {
    expect(resolveToolChoicePolicy({
      providerId: "minimax", model: "MiniMax-M3", transport: "openai",
      reasoning: { mode: "on" }, requestedToolName: "music_search",
    })).toEqual({ kind: "auto" });
  });

  test("omits tool_choice for DeepSeek thinking but names the tool when thinking is off", () => {
    expect(resolveToolChoicePolicy({
      providerId: "deepseek", model: "deepseek-v4-pro", transport: "openai",
      reasoning: { mode: "on", effort: "high" }, requestedToolName: "music_search",
    })).toEqual({ kind: "omit" });
    expect(resolveToolChoicePolicy({
      providerId: "deepseek", model: "deepseek-v4-pro", transport: "openai",
      reasoning: { mode: "off" }, requestedToolName: "music_search",
    })).toEqual({ kind: "named", name: "music_search" });
  });

  test("uses auto for fixed-thinking Kimi and thinking-enabled Anthropic", () => {
    expect(resolveToolChoicePolicy({
      providerId: "kimi", model: "kimi-k2.7-code", transport: "openai",
      reasoning: { mode: "off" }, requestedToolName: "music_search",
    })).toEqual({ kind: "auto" });
    expect(resolveToolChoicePolicy({
      providerId: "claude", model: "claude-sonnet-4-6", transport: "anthropic",
      reasoning: { mode: "on", effort: "high" }, requestedToolName: "music_search",
    })).toEqual({ kind: "auto" });
  });

  // Fable 5.1 / Opus 5.5 / Sonnet 5.5 对 tool_choice any / tool 返回 400；它们的思考不能关闭，
  // 即使用户选了「关闭」，must-call 也必须落到 auto。
  test.each(["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"])("%s must-call always uses auto, even with thinking set to off", (model) => {
    for (const reasoning of [{ mode: "off" as const }, { mode: "on" as const, effort: "high" as const }]) {
      expect(resolveToolChoicePolicy({
        providerId: "claude", model, transport: "anthropic", reasoning, requestedToolName: "music_search",
      })).toEqual({ kind: "auto" });
    }
  });

  test("supports required/any as a transport-neutral policy result", () => {
    expect(resolveToolChoicePolicy({
      providerId: "required-only", model: "m", transport: "openai",
      reasoning: { mode: "off" }, requestedToolName: "music_search",
      supportedModes: ["required"],
    })).toEqual({ kind: "required" });
  });

  test("chooses the strongest available mode instead of assuming named support", () => {
    expect(resolveToolChoicePolicy({
      providerId: "qwen", model: "qwen3-7b", transport: "openai",
      reasoning: { mode: "off" }, requestedToolName: "music_search",
      supportedModes: ["required", "auto"],
    })).toEqual({ kind: "required" });
    expect(resolveToolChoicePolicy({
      providerId: "qwen", model: "qwen3-7b", transport: "openai",
      reasoning: { mode: "off" }, requestedToolName: "music_search",
      supportedModes: ["omit"],
    })).toEqual({ kind: "omit" });
  });

  test("keeps ordinary Function Calling on auto except when the active mode rejects tool_choice", () => {
    expect(resolveAutomaticToolChoicePolicy({
      providerId: "openai", model: "gpt", transport: "openai",
      reasoning: { mode: "off" },
    })).toBe("auto");
    expect(resolveAutomaticToolChoicePolicy({
      providerId: "deepseek", model: "deepseek-v4-pro", transport: "openai",
      reasoning: { mode: "on" },
    })).toBe("omit");
  });
});
