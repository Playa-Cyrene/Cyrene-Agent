import { describe, expect, test } from "vitest";
import { PROVIDER_CAPABILITIES, getCapability } from "./capabilities";
import { getAdapterForConfig } from "./index";

describe("PROVIDER_CAPABILITIES — schema smoke", () => {
  test.each([
    ["ChatGPT（OpenAI）订阅", "chatgpt"],
    ["Claude（Anthropic）订阅", "claude"],
    ["Grok（xAI）订阅", "grok"],
  ])("resolves the %s subscription label to %s without adding preset entries", (label, id) => {
    expect(getCapability(label)?.id).toBe(id);
    expect(PROVIDER_CAPABILITIES.some((capability) => capability.displayName === label)).toBe(false);
  });
  test("每条 capability 都有 id 与 displayName，且非空", () => {
    for (const cap of PROVIDER_CAPABILITIES) {
      expect(cap.id, `entry missing id`).toBeTruthy();
      expect(cap.displayName, `entry ${cap.id} missing displayName`).toBeTruthy();
    }
  });

  test("id 唯一（不允许两条 capability 共享同一 id）", () => {
    const ids = PROVIDER_CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("displayName 唯一（不允许两条 capability 共享同一显示名）", () => {
    const names = PROVIDER_CAPABILITIES.map((c) => c.displayName);
    expect(new Set(names).size).toBe(names.length);
  });

  test("MiMo（小米）条目存在且关键字段齐全", () => {
    const mimo = getCapability("MiMo（小米）");
    expect(mimo).toBeDefined();
    expect(mimo?.id).toBe("mimo");
    expect(mimo?.displayName).toBe("MiMo（小米）");
  });

  test("豆包替换火山 AgentPlan，使用官方方舟 Chat Completions 入口", () => {
    expect(getCapability("豆包（火山方舟）")).toMatchObject({
      id: "doubao",
      transport: "openai",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      defaultModel: "doubao-seed-2-1-pro-260628",
    });
    expect(getCapability("火山 AgentPlan（火山引擎）")).toBeUndefined();
    expect(PROVIDER_CAPABILITIES.some((capability) => capability.id === "volcengine")).toBe(false);
  });
});

describe("PROVIDER_CAPABILITIES — 已知条目存在性回归", () => {
  test("MiniMax 默认使用官方优先的 Anthropic 入口", () => {
    expect(getCapability("MiniMax（稀宇科技）")).toMatchObject({
      transport: "anthropic",
      baseUrl: "https://api.minimaxi.com/anthropic",
      authStyle: "bearer",
      anthropicAuthStyle: "x-api-key",
    });
  });

  test("MiniMax 默认配置生成 Anthropic messages 与 x-api-key 请求", () => {
    const cfg = {
      provider: "MiniMax（稀宇科技）",
      baseUrl: "https://api.minimaxi.com/anthropic",
      model: "MiniMax-M3",
      apiKey: "test-key",
      explicitTransport: "auto" as const,
    };
    const adapter = getAdapterForConfig(cfg);
    const request = adapter.buildRequest(
      { model: cfg.model, messages: [{ role: "user", content: "ping" }] },
      cfg,
    );

    expect(adapter.transport).toBe("anthropic");
    expect(request.url).toBe("https://api.minimaxi.com/anthropic/v1/messages");
    expect(request.headers["x-api-key"]).toBe("test-key");
    expect(request.headers.Authorization).toBeUndefined();
  });

  test.each([
    ["MiniMax（稀宇科技）", "https://api.minimaxi.com/anthropic", "MiniMax-M3"],
    ["DeepSeek（深度求索）", "https://api.deepseek.com/anthropic", "deepseek-v4-pro"],
  ])("%s 的 A口使用 messages 与 x-api-key", (provider, baseUrl, model) => {
    const cfg = { provider, baseUrl, model, apiKey: "test-key", explicitTransport: "anthropic" as const };
    const request = getAdapterForConfig(cfg).buildStreamRequest(
      { model, messages: [{ role: "user", content: "ping" }], stream: true },
      cfg,
    );
    expect(request.url).toBe(`${baseUrl}/v1/messages`);
    expect(request.headers["x-api-key"]).toBe("test-key");
    expect(request.headers.Authorization).toBeUndefined();
    expect(JSON.parse(request.body)).toMatchObject({ stream: true });
  });

  test("9 家 provider 的 displayName 都在表中", () => {
    const names = new Set(PROVIDER_CAPABILITIES.map((c) => c.displayName));
    for (const expected of [
      "MiniMax（稀宇科技）",
      "DeepSeek（深度求索）",
      "豆包（火山方舟）",
      "GLM（智谱）",
      "Kimi（月之暗面）",
      "Qwen（通义千问）",
      "ChatGPT（OpenAI）",
      "Claude（Anthropic）",
      "MiMo（小米）",
    ]) {
      expect(names.has(expected), `missing displayName: ${expected}`).toBe(true);
    }
  });
});
