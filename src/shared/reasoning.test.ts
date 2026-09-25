import { describe, expect, test } from "vitest";
import {
  MODEL_REASONING_RULES,
  normalizeReasoningPreference,
  resolveEffectiveReasoning,
  resolveReasoningCapability,
  type ReasoningCapability,
  type ReasoningPreference,
} from "./reasoning";

// ── A. 规则匹配优先级 ──────────────────────────────────────

describe("MODEL_REASONING_RULES — 规则匹配优先级", () => {
  test("Qwen qwen3-thinking 命中 /-thinking$/ → fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-thinking");
    expect(cap.control).toBe("fixed-on");
  });

  test("Qwen qwen3-max-thinking 命中 /-thinking$/ → fixed-on（结尾 -thinking）", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-max-thinking");
    expect(cap.control).toBe("fixed-on");
  });

  test("Qwen qwen3-max 命中 /^qwen3/ → toggle（不命中 /-thinking$/）", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-max");
    expect(cap.control).toBe("toggle");
  });

  // qwen3.8 全系（max/flash/2.4t-a95b 开源版，官方 2026-08 文档）：混合思考模式，
  // enable_thinking 可开关；Chat Completions 无 effort 档位 → 纯 toggle 命中系列规则
  test("Qwen qwen3.8-max / qwen3.8-flash / qwen3.8-2.4t-a95b → 命中 /^qwen3/ 系列 toggle", () => {
    for (const model of ["qwen3.8-max", "qwen3.8-flash", "qwen3.8-2.4t-a95b"]) {
      const cap = resolveReasoningCapability("qwen", model);
      expect(cap.control).toBe("toggle");
      expect(cap.requestStyle).toBe("qwen-enable-thinking");
      expect(cap.supportsDisable).toBe(true);
    }
  });

  test("Qwen qwen-max-thinking 命中 /-thinking$/ → fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen-max-thinking");
    expect(cap.control).toBe("fixed-on");
  });

  test("Kimi kimi-k3 → effort 控制 + openai-effort 风格 + 强制思考 + auto 映射 high", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k3");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.defaultEffort).toBe("high");
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
  });

  test("Kimi kimi-k2.6 命中精确 K2.6 正则", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.6");
    expect(cap.control).toBe("toggle");
    expect(cap.keepOnTools).toBe(true);
  });

  test("Kimi kimi-k2.5 命中精确 K2.5 正则，keepOnTools=false", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.5");
    expect(cap.control).toBe("toggle");
    expect(cap.keepOnTools).toBe(false);
  });

  test("Kimi kimi-k2.7-code 命中精确 K2.7-Code，control=fixed-on", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.7-code");
    expect(cap.control).toBe("fixed-on");
  });

  test("Kimi kimi-k2.7-code-highspeed 命中精确 K2.7-Code-HighSpeed，control=fixed-on", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.7-code-highspeed");
    expect(cap.control).toBe("fixed-on");
  });

  test("Kimi kimi-k2.5 不会被通用 kimi-k2-thinking 系列误命中（精确正则优先）", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.5");
    // 若是 kimi-k2-thinking 系列命中，会是 fixed-on；实际 K2.5 是 toggle
    expect(cap.control).toBe("toggle");
    expect(cap.control).not.toBe("fixed-on");
  });

  test("MiniMax MiniMax-M3 走 anthropic-adaptive（不是 thinking-type）", () => {
    const cap = resolveReasoningCapability("minimax", "MiniMax-M3");
    expect(cap.control).toBe("toggle");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
  });

  test("兜底：未知模型 → { control: 'none', requestStyle: 'none', supportsDisable: false }", () => {
    const cap = resolveReasoningCapability("unknown-provider", "anything");
    expect(cap.control).toBe("none");
    expect(cap.requestStyle).toBe("none");
    expect(cap.supportsDisable).toBe(false);
  });
});

// ── B. 9 家全部存在性 ──────────────────────────────────────

describe("MODEL_REASONING_RULES — 9 家全部存在性", () => {
  test("chatgpt gpt-6-astra → effort 五档 + supportsDisable=false + supportsProMode（2026-09-03 新旗舰）", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-astra");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // 官方迁移说明：不支持 none 档 → UI 不显示"关闭"，off 折叠为 on 落 defaultEffort
    expect(cap.supportsDisable).toBe(false);
    // 官方迁移指南：pro mode 与 5.6 一致继续支持
    expect(cap.supportsProMode).toBe(true);
  });

  test("chatgpt gpt-6-sol → effort 五档 + 可关闭（none 档）+ supportsProMode（2026-09-22 发布）", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-sol");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // 官方模型页：effort 支持 none → 可关闭，与 Astra（不支持 none）不同
    expect(cap.supportsDisable).toBe(true);
    expect(cap.supportsProMode).toBe(true);
  });

  test("chatgpt gpt-6-luna → 与 Sol 同规则（专属条目优先于 Astra 的 ^gpt-6）", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-6-luna");
    expect(cap.control).toBe("effort");
    // 若被 ^gpt-6（Astra）规则先吞，supportsDisable 会是 false
    expect(cap.supportsDisable).toBe(true);
    expect(cap.defaultEffort).toBe("medium");
  });

  test("chatgpt gpt-5.6 → effort + openai-effort + supportedEfforts 含 max + supportsProMode", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-5.6");
    expect(cap.control).toBe("effort");
    expect(cap.requestStyle).toBe("openai-effort");
    expect(cap.supportedEfforts).toContain("max");
    expect(cap.supportsDisable).toBe(true);
    // Responses API reasoning.mode:"pro"（gpt-5.6-sol 别名同规则）
    expect(cap.supportsProMode).toBe(true);
    expect(resolveReasoningCapability("chatgpt", "gpt-5.6-sol").supportsProMode).toBe(true);
  });

  test("chatgpt gpt-5 → effort + supportedEfforts 含 minimal", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-5");
    expect(cap.supportedEfforts).toContain("minimal");
  });

  test("chatgpt o1 → effort + supportedEfforts", () => {
    const cap = resolveReasoningCapability("chatgpt", "o1-preview");
    expect(cap.control).toBe("effort");
  });

  test("chatgpt o3 → effort", () => {
    const cap = resolveReasoningCapability("chatgpt", "o3-mini");
    expect(cap.control).toBe("effort");
  });

  test("chatgpt o4 → effort", () => {
    const cap = resolveReasoningCapability("chatgpt", "o4");
    expect(cap.control).toBe("effort");
  });

  test("chatgpt gpt-4o 兜底 → none", () => {
    const cap = resolveReasoningCapability("chatgpt", "gpt-4o");
    expect(cap.control).toBe("none");
  });

  test("claude claude-fable-5 → toggle-effort + anthropic-adaptive（2026.6 新旗舰）", () => {
    const cap = resolveReasoningCapability("claude", "claude-fable-5");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
    expect(cap.supportedEfforts).toContain("max");
  });

  test("claude claude-sonnet-5 → toggle-effort + anthropic-adaptive", () => {
    const cap = resolveReasoningCapability("claude", "claude-sonnet-5");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
  });

  test("deepseek deepseek-flash（V4.1 Flash，2026-09-10）→ toggle-effort + thinking-type + [low,high,max] + autoEffort=high", () => {
    const cap = resolveReasoningCapability("deepseek", "deepseek-flash");
    expect(cap.control).toBe("toggle-effort");
    // 官方思考模式文档：effort 原生 low/high/max 三档；medium/xhigh 映射为 high、minimal 映射为 low
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.autoEffort).toBe("high");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportsDisable).toBe(true);
  });

  test("deepseek deepseek-v4-pro → 命中统一规则（旧名官方路由到 V4.1 Flash）", () => {
    const cap = resolveReasoningCapability("deepseek", "deepseek-v4-pro");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.autoEffort).toBe("high");
  });

  test("deepseek deepseek-v4-flash-vision-exp（2026-08-21 视觉实验版）→ 命中统一规则", () => {
    const cap = resolveReasoningCapability("deepseek", "deepseek-v4-flash-vision-exp");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.autoEffort).toBe("high");
    expect(cap.requestStyle).toBe("thinking-type");
  });

  test("glm glm-5.2 → toggle-effort + 可关闭 + autoEffort=high", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.2");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.supportedEfforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    expect(cap.supportsDisable).toBe(true);
    expect(cap.autoEffort).toBe("high");
  });

  test("glm glm-5.3 → toggle-effort + 强制思考（不可关闭）+ [low,high,max] + autoEffort=high", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    // 官方文档 2026-08-26：GLM-5.3 不再支持关闭思考（thinking.type=disabled 报错）
    expect(cap.supportsDisable).toBe(false);
    // auto 不发字段 ≡ 服务端默认 max → 显式映射 high
    expect(cap.autoEffort).toBe("high");
  });

  test("glm glm-5.3-flash → 与 5.3 同规则（z.ai 文档：FLASH 同为强制思考，首个原生图片输入的 GLM-5）", () => {
    const cap = resolveReasoningCapability("glm", "glm-5.3-flash");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
    expect(cap.requestStyle).toBe("thinking-type");
  });

  test("glm glm-4.7 → toggle only", () => {
    const cap = resolveReasoningCapability("glm", "glm-4.7");
    expect(cap.control).toBe("toggle");
    expect(cap.supportedEfforts).toBeUndefined();
  });

  test("qwen qwen3-max → toggle + qwen-enable-thinking", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-max");
    expect(cap.control).toBe("toggle");
    expect(cap.requestStyle).toBe("qwen-enable-thinking");
  });

  test("qwen qwen3-thinking → fixed-on", () => {
    const cap = resolveReasoningCapability("qwen", "qwen3-thinking");
    expect(cap.control).toBe("fixed-on");
  });

  test("kimi kimi-k2.5 → toggle", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.5");
    expect(cap.control).toBe("toggle");
  });

  test("kimi kimi-k2.6 → toggle + keepOnTools=true", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.6");
    expect(cap.control).toBe("toggle");
    expect(cap.keepOnTools).toBe(true);
  });

  test("kimi kimi-k2.7-code → fixed-on + requestStyle=none", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.7-code");
    expect(cap.control).toBe("fixed-on");
    expect(cap.requestStyle).toBe("none");
  });

  test("kimi kimi-k2.7-code-highspeed → fixed-on + requestStyle=none", () => {
    const cap = resolveReasoningCapability("kimi", "kimi-k2.7-code-highspeed");
    expect(cap.control).toBe("fixed-on");
    expect(cap.requestStyle).toBe("none");
  });

  test("minimax MiniMax-M3 → toggle + anthropic-adaptive", () => {
    const cap = resolveReasoningCapability("minimax", "MiniMax-M3");
    expect(cap.requestStyle).toBe("anthropic-adaptive");
  });

  test("minimax MiniMax-M2.7 → fixed-on", () => {
    const cap = resolveReasoningCapability("minimax", "MiniMax-M2.7");
    expect(cap.control).toBe("fixed-on");
  });

  test("mimo mimo-v2.5-pro → toggle + thinking-type", () => {
    const cap = resolveReasoningCapability("mimo", "mimo-v2.5-pro");
    expect(cap.control).toBe("toggle");
    expect(cap.requestStyle).toBe("thinking-type");
  });

  test("mimo v2.6 全系（pro/flash/pro-ultraspeed）→ 复用 v2 系列 toggle（2026-09-22 发布，与 2.5 同控制面）", () => {
    for (const model of ["mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed"]) {
      const cap = resolveReasoningCapability("mimo", model);
      expect(cap.control).toBe("toggle");
      expect(cap.requestStyle).toBe("thinking-type");
      expect(cap.supportsDisable).toBe(true);
    }
  });

  test("doubao seed 2.1 → toggle + thinking-type", () => {
    const cap = resolveReasoningCapability("doubao", "doubao-seed-2-1-pro-260628");
    expect(cap.control).toBe("toggle");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportsDisable).toBe(true);
  });

  test("未知 provider + 任意 model → none", () => {
    const cap = resolveReasoningCapability("unknown", "anything");
    expect(cap.control).toBe("none");
  });
});

// ── C. normalize 白名单 ──────────────────────────────────────

describe("normalizeReasoningPreference — 白名单", () => {
  test("完全合法 → 原样", () => {
    expect(normalizeReasoningPreference({ mode: "on", effort: "high" }))
      .toEqual({ mode: "on", effort: "high" });
  });

  test("mode 不在白名单 → undefined", () => {
    expect(normalizeReasoningPreference({ mode: "banana", effort: "high" }))
      .toBeUndefined();
  });

  test("effort 不在白名单 → mode 保留、effort 丢弃", () => {
    expect(normalizeReasoningPreference({ mode: "on", effort: "ultra" }))
      .toEqual({ mode: "on" });
  });

  test("effort 缺省 → 只返 mode", () => {
    expect(normalizeReasoningPreference({ mode: "auto" }))
      .toEqual({ mode: "auto" });
  });

  test("effort 为 null → 只返 mode", () => {
    expect(normalizeReasoningPreference({ mode: "off", effort: null }))
      .toEqual({ mode: "off" });
  });

  test("完全非法对象（null）→ undefined", () => {
    expect(normalizeReasoningPreference(null)).toBeUndefined();
  });

  test("完全非法对象（undefined）→ undefined", () => {
    expect(normalizeReasoningPreference(undefined)).toBeUndefined();
  });

  test("非对象（字符串）→ undefined", () => {
    expect(normalizeReasoningPreference("on")).toBeUndefined();
  });

  test("mode 缺省 → undefined", () => {
    expect(normalizeReasoningPreference({ effort: "high" })).toBeUndefined();
  });

  test("effort 合法（6 个值之一）→ 保留", () => {
    for (const e of ["minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(normalizeReasoningPreference({ mode: "on", effort: e }))
        .toEqual({ mode: "on", effort: e });
    }
  });

  test("proMode=true → 保留", () => {
    expect(normalizeReasoningPreference({ mode: "on", proMode: true }))
      .toEqual({ mode: "on", proMode: true });
  });

  test("proMode 非法（字符串/null）→ 丢弃 proMode，其余保留", () => {
    expect(normalizeReasoningPreference({ mode: "on", effort: "high", proMode: "yes" }))
      .toEqual({ mode: "on", effort: "high" });
    expect(normalizeReasoningPreference({ mode: "on", proMode: null }))
      .toEqual({ mode: "on" });
  });
});

// ── D. resolveEffectiveReasoning ──────────────────────────────────────

describe("resolveEffectiveReasoning", () => {
  const fixedOnCap: ReasoningCapability = {
    control: "fixed-on",
    requestStyle: "none",
    supportsDisable: false,
  };
  const toggleEffortCap: ReasoningCapability = {
    control: "toggle-effort",
    supportedEfforts: ["high", "max"],
    defaultEffort: "high",
    requestStyle: "thinking-type",
    supportsDisable: true,
  };
  const toggleEffortNoDisableCap: ReasoningCapability = {
    control: "toggle-effort",
    supportedEfforts: ["high", "max"],
    defaultEffort: "high",
    requestStyle: "thinking-type",
    supportsDisable: false,
  };
  const noneCap: ReasoningCapability = {
    control: "none",
    requestStyle: "none",
    supportsDisable: false,
  };
  const dynamicCap: ReasoningCapability = {
    control: "dynamic",
    requestStyle: "none",
    supportsDisable: false,
  };
  const toggleCap: ReasoningCapability = {
    control: "toggle",
    requestStyle: "thinking-type",
    supportsDisable: true,
  };

  test("none + any → { mode: 'auto' }", () => {
    expect(resolveEffectiveReasoning({ mode: "on" }, noneCap))
      .toEqual({ mode: "auto" });
  });

  test("dynamic + any → { mode: 'auto' }", () => {
    expect(resolveEffectiveReasoning({ mode: "on" }, dynamicCap))
      .toEqual({ mode: "auto" });
  });

  test("fixed-on + { mode: 'auto' } → { mode: 'on' }", () => {
    expect(resolveEffectiveReasoning({ mode: "auto" }, fixedOnCap))
      .toEqual({ mode: "on" });
  });

  test("fixed-on + { mode: 'off' } → { mode: 'on' }", () => {
    expect(resolveEffectiveReasoning({ mode: "off" }, fixedOnCap))
      .toEqual({ mode: "on" });
  });

  test("fixed-on + { mode: 'on' } → { mode: 'on' }", () => {
    expect(resolveEffectiveReasoning({ mode: "on" }, fixedOnCap))
      .toEqual({ mode: "on" });
  });

  test("fixed-on 不读 pref.effort（即使 pref 带 effort 也丢弃）", () => {
    const result = resolveEffectiveReasoning(
      { mode: "off", effort: "high" },
      fixedOnCap,
    );
    expect(result).toEqual({ mode: "on" });
    expect(result.effort).toBeUndefined();
  });

  test("toggle-effort + supportsDisable=false + { mode: 'off' } → 默认档位", () => {
    expect(resolveEffectiveReasoning({ mode: "off" }, toggleEffortNoDisableCap))
      .toEqual({ mode: "on", effort: "high" });
  });

  test("toggle-effort + { mode: 'on', effort: 'max' } + supportedEfforts=[high] → { mode: 'on', effort: 'high' }", () => {
    // supportedEfforts 不含 max（cap.6 是 ["high","max"] 包含 max，这条用单独的 cap）
    const capWithoutMax: ReasoningCapability = {
      ...toggleEffortCap,
      supportedEfforts: ["high"],
      defaultEffort: "high",
    };
    expect(resolveEffectiveReasoning({ mode: "on", effort: "max" }, capWithoutMax))
      .toEqual({ mode: "on", effort: "high" });
  });

  test("toggle-effort + { mode: 'on', effort: 'xhigh' } + supportedEfforts=[high,max] → { mode: 'on', effort: 'xhigh' }（保留）", () => {
    const cap: ReasoningCapability = {
      ...toggleEffortCap,
      supportedEfforts: ["high", "max", "xhigh"],
    };
    expect(resolveEffectiveReasoning({ mode: "on", effort: "xhigh" }, cap))
      .toEqual({ mode: "on", effort: "xhigh" });
  });

  test("toggle-effort + { mode: 'on' } + defaultEffort='high' → { mode: 'on', effort: 'high' }（填默认）", () => {
    expect(resolveEffectiveReasoning({ mode: "on" }, toggleEffortCap))
      .toEqual({ mode: "on", effort: "high" });
  });

  test("toggle + 旧 auto 偏好 → 开启且清除旧 effort", () => {
    expect(resolveEffectiveReasoning({ mode: "auto", effort: "high" }, toggleCap))
      .toEqual({ mode: "on" });
  });

  test("toggle + { mode: 'off', effort: 'high' } → { mode: 'off' }（mode !== on 不保留 effort）", () => {
    expect(resolveEffectiveReasoning({ mode: "off", effort: "high" }, toggleCap))
      .toEqual({ mode: "off" });
  });

  test("preference 缺省 → 可调模型默认开启", () => {
    expect(resolveEffectiveReasoning(undefined, toggleCap))
      .toEqual({ mode: "on" });
  });

  test("saved 与 effective 不同步：saved 仍保留原 effort", () => {
    const saved: ReasoningPreference = { mode: "on", effort: "max" };
    const cap: ReasoningCapability = {
      control: "toggle-effort",
      supportedEfforts: ["high"],
      defaultEffort: "high",
      requestStyle: "thinking-type",
      supportsDisable: true,
    };
    // effective 用 defaultEffort "high" 替代了 "max"
    expect(resolveEffectiveReasoning(saved, cap)).toEqual({ mode: "on", effort: "high" });
    // saved 不动
    expect(saved).toEqual({ mode: "on", effort: "max" });
  });

  // ── proMode（Responses API reasoning.mode="pro"，gpt-5.6 系列）──

  const proCap: ReasoningCapability = {
    control: "effort",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    defaultEffort: "medium",
    requestStyle: "openai-effort",
    supportsDisable: true,
    supportsProMode: true,
  };

  test("supportsProMode + {on, proMode:true} → 保留 proMode", () => {
    expect(resolveEffectiveReasoning({ mode: "on", proMode: true }, proCap))
      .toEqual({ mode: "on", effort: "medium", proMode: true });
  });

  test("supportsProMode + {on, effort:'high', proMode:true} → effort 与 proMode 共存", () => {
    expect(resolveEffectiveReasoning({ mode: "on", effort: "high", proMode: true }, proCap))
      .toEqual({ mode: "on", effort: "high", proMode: true });
  });

  test("capability 不支持（supportsProMode 未声明）→ proMode 丢弃", () => {
    expect(resolveEffectiveReasoning({ mode: "on", proMode: true }, toggleEffortCap))
      .toEqual({ mode: "on", effort: "high" });
  });

  test("旧 auto 与 off 偏好均丢弃 proMode", () => {
    expect(resolveEffectiveReasoning({ mode: "auto", proMode: true }, proCap))
      .toEqual({ mode: "on", effort: "medium" });
    expect(resolveEffectiveReasoning({ mode: "off", proMode: true }, proCap))
      .toEqual({ mode: "off" });
  });
});

// ── E. 规则表数据完整性 ──────────────────────────────────────

describe("MODEL_REASONING_RULES — 数据完整性", () => {
  test("所有 providerId 与 capabilities.ts 的 id 一致", () => {
    const known = new Set([
      "chatgpt", "claude", "deepseek", "glm", "kimi",
      "qwen", "minimax", "mimo", "doubao", "grok", "gemini",
    ]);
    const providerIds = new Set(MODEL_REASONING_RULES.map(r => r.providerId));
    for (const id of providerIds) {
      expect(known.has(id), `未知 providerId: ${id}`).toBe(true);
    }
  });

  test("每条 capability 都有 supportsDisable 字段（不留空）", () => {
    for (const rule of MODEL_REASONING_RULES) {
      expect(typeof rule.capability.supportsDisable).toBe("boolean");
    }
  });

  test("正则不带 g 标志（避免 .test() 状态污染）", () => {
    for (const rule of MODEL_REASONING_RULES) {
      expect(rule.modelPattern.flags.includes("g")).toBe(false);
    }
  });
});

// ── F. foldReasoning 三态 + 优先级（用户第三轮修订 #4）──

import { foldReasoning } from "./reasoning";

describe("foldReasoning — 持久化折叠（用户第三轮修订 #4）", () => {
  test("H1 缺省（hasIncomingKey=false）→ 保留旧值", () => {
    const existing = { mode: "on" as const, effort: "high" as const };
    expect(foldReasoning(undefined, existing, false)).toEqual(existing);
  });

  test("H1b 缺省 + existing 为 undefined → 返 undefined", () => {
    expect(foldReasoning(undefined, undefined, false)).toBeUndefined();
  });

  test("H2 显式 auto（合法）→ 写盘为 {mode:'auto'}，清掉旧 effort", () => {
    const existing = { mode: "on" as const, effort: "high" as const };
    expect(foldReasoning({ mode: "auto" }, existing, true)).toEqual({ mode: "auto" });
  });

  test("H3 非法值（hasIncomingKey=true 但 normalize 后 undefined）→ 保留旧值（防覆盖）", () => {
    const existing = { mode: "on" as const, effort: "high" as const };
    expect(foldReasoning({ mode: "banana" }, existing, true)).toEqual(existing);
    expect(foldReasoning("not an object", existing, true)).toEqual(existing);
  });

  test("H3b 合法 mode + 非法 effort → normalize 后是 {mode}，作为更新（清掉非法 effort）", () => {
    const existing = { mode: "on" as const, effort: "high" as const };
    expect(foldReasoning({ mode: "on", effort: "ultra" }, existing, true)).toEqual({ mode: "on" });
  });

  test("H4 显式 undefined/null → 视作用户主动清空，返 undefined", () => {
    expect(foldReasoning(undefined, { mode: "on" as const, effort: "high" as const }, true))
      .toBeUndefined();
    expect(foldReasoning(null, { mode: "on" as const, effort: "high" as const }, true))
      .toBeUndefined();
  });

  test("H5 perProfile 优先于顶层 reasoning（H5 模拟 foldReasoning 调用：选 perProfile）", () => {
    // 模拟 saveModelSettings 决策：perProfile.reasoning 存在时 → 选 perProfile
    const perProfileReasoning = { mode: "off" as const };
    const topLevelReasoning = { mode: "on" as const, effort: "low" as const };
    const existing = { mode: "auto" as const };

    // 决策 1：选 perProfile → foldReasoning(perProfileReasoning, existing, true)
    const r1 = foldReasoning(perProfileReasoning, existing, true);
    expect(r1).toEqual({ mode: "off" });

    // 决策 2：没 perProfile 时选 topLevel → foldReasoning(topLevelReasoning, existing, true)
    const r2 = foldReasoning(topLevelReasoning, existing, true);
    expect(r2).toEqual({ mode: "on", effort: "low" });

    // 决策 3：都没选 → foldReasoning(undefined, existing, false) → 保留旧值
    const r3 = foldReasoning(undefined, existing, false);
    expect(r3).toEqual(existing);
  });

  test("H6 顶层 reasoning 在没有 perProfile 写入时生效", () => {
    const topLevel = { mode: "on" as const, effort: "low" as const };
    const existing = undefined;
    // 模拟决策：incomingProfileForReasoning 不带 reasoning → hasProfileReasoning=false，
    // 顶层 settings.reasoning 存在 → hasTopLevelReasoning=true
    // → foldReasoning(topLevel, undefined, true)
    expect(foldReasoning(topLevel, existing, true)).toEqual({ mode: "on", effort: "low" });
  });
});

describe("resolveReasoningCapability — 厂商/模型家族错配时按模型名推断", () => {
  test("I1 自定义端点托管 glm-5.3-flash（方舟 coding plan 场景）→ 命中 glm-5.3 强制思考规则", () => {
    const cap = resolveReasoningCapability("unknown", "glm-5.3-flash");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.supportsDisable).toBe(false);
    expect(cap.autoEffort).toBe("high");
  });

  test("I2 自定义端点托管 glm-5.3 → 同一规则", () => {
    const cap = resolveReasoningCapability("unknown", "glm-5.3");
    expect(cap.control).toBe("toggle-effort");
  });

  test("I3 托管 doubao-seed 系列 → 命中豆包 toggle 规则", () => {
    const cap = resolveReasoningCapability("unknown", "doubao-seed-2-1-pro-260628");
    expect(cap.control).toBe("toggle");
    expect(cap.supportsDisable).toBe(true);
  });

  test("I4 未识别模型名 → 保持 UNKNOWN 兜底（control=none）", () => {
    const cap = resolveReasoningCapability("unknown", "some-homemade-endpoint-model");
    expect(cap.control).toBe("none");
    expect(cap.requestStyle).toBe("none");
  });

  test("I5 厂商家族无真实规则 + 模型名也未识别 → 仍 UNKNOWN（不误匹配）", () => {
    const cap = resolveReasoningCapability("glm", "not-a-real-glm-model");
    expect(cap.control).toBe("none");
    expect(cap.requestStyle).toBe("none");
  });

  test("I6 家族错配回归：豆包档案跑 glm-5.3-flash（方舟 coding plan 真实场景）→ 按模型名命中 glm 规则", () => {
    const cap = resolveReasoningCapability("doubao", "glm-5.3-flash");
    expect(cap.control).toBe("toggle-effort");
    expect(cap.requestStyle).toBe("thinking-type");
    expect(cap.supportedEfforts).toEqual(["low", "high", "max"]);
    expect(cap.supportsDisable).toBe(false);
  });
});
