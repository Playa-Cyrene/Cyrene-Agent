// 档案模型清单（models）六步 normalize 契约 + 会话级解析④（resolveSessionModelSettings）
// 的单元测试。对应方案测试矩阵：
//   #1-4/#8/#9 normalize 全矩阵、#5 旧档案 roundtrip 零变化、
//   #14 raw 失效回退、#19 stale 不串档、#25 legacy 跟随默认（④组合层视角）。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" } }));

import { normalizeModelSettings, resolveSessionModelSettings } from "./model-settings";

const GLM_BASE = {
  provider: "GLM（智谱）",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  model: "glm-5.3",
  apiKey: "sk-test",
  explicitTransport: "openai",
} as const;

/** 只带一个档案走 normalize，返回该档案的清洗结果。 */
function normalizeProfile(profile: Record<string, unknown>) {
  const settings = normalizeModelSettings({
    ...GLM_BASE,
    modelProfiles: [profile as never],
  } as never);
  return settings.modelProfiles![0];
}

describe("normalize 六步契约（档案模型清单）", () => {
  it("#1 trim + 稳定去重（保持首现顺序）+ 不 lower-case", () => {
    const profile = normalizeProfile({
      id: "p1", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "a", models: [" a ", "a", "", "b"],
    });
    expect(profile.models).toEqual(["a", "b"]);
    // 大小写原样：同名不同大小写视为两个模型，不合并
    const caseProfile = normalizeProfile({
      id: "p2", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "GPT-5.6", models: ["GPT-5.6", "gpt-5.6"],
    });
    expect(caseProfile.models).toEqual(["GPT-5.6", "gpt-5.6"]);
  });

  it("#2 清单清洗后全空 → 字段移除、model 保留", () => {
    const profile = normalizeProfile({
      id: "p3", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "keep-me", models: ["", "   "],
    });
    expect(profile).not.toHaveProperty("models");
    expect(profile.model).toBe("keep-me");
  });

  it("#3 model ∉ models → 顺位取首项，列表顺序不变", () => {
    const profile = normalizeProfile({
      id: "p4", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "x", models: ["m2", "m1"],
    });
    expect(profile.model).toBe("m2");
    expect(profile.models).toEqual(["m2", "m1"]);
  });

  it("#4 清单长度 ≤ 1 → 剥除字段（单模型档案 JSON 零变化）", () => {
    const single = normalizeProfile({
      id: "p5", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "m1", models: ["m1"],
    });
    expect(single).not.toHaveProperty("models");
    // 去重后只剩一项同样剥除
    const deduped = normalizeProfile({
      id: "p6", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "m1", models: ["m1", "m1"],
    });
    expect(deduped).not.toHaveProperty("models");
  });

  it("#5 旧档案（无 models）只做 normalize → 输出不出现 models 字段", () => {
    const profile = normalizeProfile({
      id: "p7", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "glm-5.3",
    });
    expect(profile).not.toHaveProperty("models");
    expect(profile.model).toBe("glm-5.3");
  });

  it("#8 删除当前模型后保存 → fallback 顺位首项且列表顺序不变", () => {
    const profile = normalizeProfile({
      id: "p8", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "a1", models: ["a2", "a3"],
    });
    expect(profile.model).toBe("a2");
    expect(profile.models).toEqual(["a2", "a3"]);
  });

  it("#9 删除非当前模型后保存 → model 不变", () => {
    const profile = normalizeProfile({
      id: "p9", provider: GLM_BASE.provider, baseUrl: GLM_BASE.baseUrl, apiKey: "k",
      model: "a2", models: ["a1", "a2"],
    });
    expect(profile.model).toBe("a2");
    expect(profile.models).toEqual(["a1", "a2"]);
  });
});

describe("resolveSessionModelSettings（④：绑定 + effective model 组合）", () => {
  function buildSettings(defaultModelProfileId: string, profiles: Array<Record<string, unknown>>) {
    return normalizeModelSettings({
      ...GLM_BASE,
      modelProfiles: profiles as never,
      defaultModelProfileId,
    } as never);
  }

  // A 多模型；B 单模型（验证④对单模型档案同样成立）
  const settings = buildSettings("p-a", [
    { id: "p-a", provider: "GLM（智谱）", baseUrl: "https://a.example", apiKey: "sk-a", model: "a1", models: ["a1", "a2", "x"] },
    { id: "p-b", provider: "GLM（智谱）", baseUrl: "https://b.example", apiKey: "sk-b", model: "b1" },
  ]);

  it("命中绑定 + 会话模型在清单内 → 会话模型 + 该档案连接配置", () => {
    const resolved = resolveSessionModelSettings(settings, { modelProfileId: "p-a", model: "a2" });
    expect(resolved.model).toBe("a2");
    expect(resolved.baseUrl).toBe("https://a.example");
    expect(resolved.apiKey).toBe("sk-a");
  });

  it("#14 会话模型不在绑定档案清单内 → 回退档案默认（raw 不清理）", () => {
    const resolved = resolveSessionModelSettings(settings, { modelProfileId: "p-a", model: "ghost" });
    expect(resolved.model).toBe("a1");
  });

  it("#19 绑定失效 → 回退默认档案默认模型，回退档案含同名 raw 模型也不串档", () => {
    const resolved = resolveSessionModelSettings(settings, { modelProfileId: "p-deleted", model: "x" });
    expect(resolved.model).toBe("a1");
    expect(resolved.baseUrl).toBe("https://a.example");
  });

  it("#25 legacy 会话无 model 字段 → 跟随绑定档案默认（兼容性例外）", () => {
    const resolved = resolveSessionModelSettings(settings, { modelProfileId: "p-b" });
    expect(resolved.model).toBe("b1");
    expect(resolved.baseUrl).toBe("https://b.example");
  });

  it("一个档案都没有 → settings 原样返回（顶层镜像，保持旧行为）", () => {
    const empty = buildSettings("p-none", []);
    const session = { modelProfileId: "p-a", model: "a2" };
    expect(resolveSessionModelSettings(empty, session)).toBe(empty);
  });
});
