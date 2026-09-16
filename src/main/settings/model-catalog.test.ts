import { describe, expect, it } from "vitest";
import { addModelProfile, updateModelProfile, resolveDefaultModelProfile } from "./model-catalog";
import { normalizeModelSettings, getDefaultModelProfile, getPublicModelConfig, resolveModelSettingsProfile } from "./model-settings";
import { resolveCaptionVisionConfig } from "../orchestrator/image-router";

describe("model catalog", () => {
  it("keeps the first saved model as the default and rejects a duplicate key plus model", () => {
    const first = addModelProfile([], {
      id: "openai-1",
      provider: "ChatGPT（OpenAI）",
      displayName: "我的 GPT",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-same",
      model: "gpt-5.6",
      explicitTransport: "openai",
    });

    expect(first.added).toBe(true);
    expect(resolveDefaultModelProfile(first.profiles, undefined)?.id).toBe("openai-1");

    const duplicate = addModelProfile(first.profiles, {
      ...first.profiles[0],
      id: "openai-2",
      displayName: "重复项",
    });

    expect(duplicate.added).toBe(false);
    expect(duplicate.profiles).toHaveLength(1);
  });

  it("allows the same key and model on a different baseUrl (官方 API + 中转站共存)", () => {
    const official = addModelProfile([], {
      id: "glm-official",
      provider: "GLM（智谱）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-same",
      model: "glm-4.7",
    });
    const relay = addModelProfile(official.profiles, {
      id: "glm-relay",
      provider: "GLM（智谱）",
      baseUrl: "https://relay.example.com/v1",
      apiKey: "sk-same",
      model: "glm-4.7",
    });

    expect(relay.added).toBe(true);
    expect(relay.profiles).toHaveLength(2);
  });

  it("updates a profile in place by id without dedup interference", () => {
    const base = [{
      id: "glm-1",
      provider: "GLM（智谱）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-old",
      model: "glm-4.7",
    }];
    const updated = updateModelProfile(base, {
      id: "glm-1",
      provider: "GLM（智谱）",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      apiKey: "sk-new",
      model: "glm-4.7",
      displayName: "GLM 官方",
      contextWindowTokens: 128000,
      multimodal: true,
    });

    expect(updated).toHaveLength(1);
    expect(updated?.[0]).toMatchObject({ apiKey: "sk-new", displayName: "GLM 官方", contextWindowTokens: 128000, multimodal: true });

    expect(updateModelProfile(base, { id: "missing", provider: "GLM（智谱）", baseUrl: "", apiKey: "", model: "" })).toBeNull();
  });

  it("marks the public status connected when a saved model exists even if the legacy mirror is empty", () => {
    const settings = normalizeModelSettings({
      provider: "ChatGPT（OpenAI）",
      apiKey: "",
      model: "",
      modelProfiles: [{
        id: "saved-model",
        provider: "ChatGPT（OpenAI）",
        displayName: "我的模型",
        apiKey: "sk-saved",
        model: "gpt-5.6",
        baseUrl: "https://api.openai.com/v1",
      }],
    });
    expect(getPublicModelConfig(settings).connected).toBe(true);
  });

  it("migrates an existing configured model into the default catalog entry", () => {
    const settings = normalizeModelSettings({
      provider: "ChatGPT（OpenAI）",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-existing",
      model: "gpt-5.6",
    });

    expect(getDefaultModelProfile(settings)).toMatchObject({
      provider: "ChatGPT（OpenAI）",
      model: "gpt-5.6",
    });
  });

  it("migrates every configured provider into profiles with readable ids, idempotently", () => {
    const legacy = {
      provider: "GLM（智谱）",
      perProvider: {
        "GLM（智谱）": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-glm", model: "glm-4.7" },
        "DeepSeek（深度求索）": { baseUrl: "https://api.deepseek.com", apiKey: "sk-ds", model: "deepseek-chat" },
        "Kimi（月之暗面）": { baseUrl: "https://api.moonshot.cn/v1", apiKey: "", model: "kimi-k2" }, // 无 Key 跳过
      },
    };

    const first = normalizeModelSettings(legacy);
    expect(first.modelProfiles).toHaveLength(2);
    expect(first.modelProfiles?.map((p) => p.id)).toEqual(["profile-GLM____-1", "profile-DeepSeek______-1"]);

    // 幂等：normalize 已持久化的结果不会重复建档
    const second = normalizeModelSettings(first);
    expect(second.modelProfiles).toHaveLength(2);
  });

  it("does not resurrect profiles from perProvider after the user cleared the catalog", () => {
    const legacy = normalizeModelSettings({
      provider: "GLM（智谱）",
      perProvider: {
        "GLM（智谱）": { baseUrl: "https://open.bigmodel.cn/api/paas/v4", apiKey: "sk-glm", model: "glm-4.7" },
      },
    });
    expect(legacy.modelProfiles).toHaveLength(1);

    // 用户删光档案（modelProfiles: []）→ 重启后不得从 perProvider 复活
    const cleared = normalizeModelSettings({ ...legacy, modelProfiles: [] });
    expect(cleared.modelProfiles).toHaveLength(0);
  });

  it("resolves profile-scoped context window and multimodal with global fallback", () => {
    const settings = normalizeModelSettings({
      provider: "GLM（智谱）",
      contextWindowTokens: 256000,
      multimodal: false,
      modelProfiles: [
        { id: "p-full", provider: "GLM（智谱）", baseUrl: "https://a.com", apiKey: "k", model: "m", contextWindowTokens: 128000, multimodal: true },
        { id: "p-legacy", provider: "GLM（智谱）", baseUrl: "https://b.com", apiKey: "k2", model: "m2" },
      ],
    });

    const full = resolveModelSettingsProfile(settings, "p-full");
    expect(full.contextWindowTokens).toBe(128000);
    expect(full.multimodal).toBe(true);

    // 老档案无档案级字段 → 回退全局值
    const legacyProfile = resolveModelSettingsProfile(settings, "p-legacy");
    expect(legacyProfile.contextWindowTokens).toBe(256000);
    expect(legacyProfile.multimodal).toBe(false);

    // 未持久化 multimodal → 默认 true（多模态模型用户开箱即直发图片，
    // 判错有服务端 400 + caption 自动降级兜底）；显式 false 保留
    const defaulted = normalizeModelSettings({ provider: "GLM（智谱）" });
    expect(defaulted.multimodal).toBe(true);
    const optedOut = normalizeModelSettings({ provider: "GLM（智谱）", multimodal: false });
    expect(optedOut.multimodal).toBe(false);

    // 档案展开 + 图片路由：顶层空壳 provider 不再把多模态主模型误判为"看不了图"
    const shellSettings = normalizeModelSettings({
      provider: "MiniMax",
      baseUrl: "",
      apiKey: "",
      model: "",
      modelProfiles: [{
        id: "glm-default",
        provider: "GLM（智谱）",
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "sk-glm",
        model: "glm-5.3-flash",
        multimodal: true,
      }],
      defaultModelProfileId: "glm-default",
    });
    expect(resolveCaptionVisionConfig(resolveModelSettingsProfile(shellSettings))).toEqual({
      ok: true,
      config: {
        baseUrl: "https://open.bigmodel.cn/api/paas/v4",
        apiKey: "sk-glm",
        model: "glm-5.3-flash",
      },
    });

    // multimodal=false 时仍走独立视觉模型配置（档案展开不吞掉全局 vision 字段）
    const visionSettings = normalizeModelSettings({
      provider: "MiniMax",
      modelProfiles: [{
        id: "text-model",
        provider: "MiniMax",
        apiKey: "sk-main",
        model: "MiniMax-M3",
        baseUrl: "https://api.minimax.chat/v1",
        multimodal: false,
      }],
      defaultModelProfileId: "text-model",
      vision: { baseUrl: "https://vi.example.com/v1", apiKey: "sk-v", model: "vi-model" },
    });
    expect(resolveCaptionVisionConfig(resolveModelSettingsProfile(visionSettings))).toEqual({
      ok: true,
      config: {
        baseUrl: "https://vi.example.com/v1",
        apiKey: "sk-v",
        model: "vi-model",
      },
    });

    // 未传 id → 展开默认档案（第一个建档项 p-full），不再退回顶层镜像——
    // 顶层镜像可能是全空的空壳，channel bot 等不带 profileId 的调用方曾因此拿到空 baseUrl
    const defaultResolved = resolveModelSettingsProfile(settings, undefined);
    expect(defaultResolved.contextWindowTokens).toBe(128000);
    expect(defaultResolved.multimodal).toBe(true);
    expect(defaultResolved.baseUrl).toBe("https://a.com");
  });

  it("cleans invalid profile-scoped fields back to undefined", () => {
    const settings = normalizeModelSettings({
      provider: "GLM（智谱）",
      modelProfiles: [
        {
          id: "p-bad",
          provider: "GLM（智谱）",
          baseUrl: "https://a.com",
          apiKey: "k",
          model: "m",
          contextWindowTokens: 100, // 低于 4096 下限 → 清洗为 undefined
          multimodal: "yes", // 非布尔 → 清洗为 undefined
        } as never,
      ],
    });
    expect(settings.modelProfiles?.[0].contextWindowTokens).toBeUndefined();
    expect(settings.modelProfiles?.[0].multimodal).toBeUndefined();
  });
});
