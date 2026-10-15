import { describe, expect, it } from "vitest";
import { getBuiltinModels } from "./catalog";
import { MINIMAX_REGISTRY } from "./entries/minimax";

describe("内置静态型号目录", () => {
  it("保持推荐顺序，并保留运行默认与候选首项的区别", () => {
    expect(getBuiltinModels("minimax", "chat")).toEqual([
      "MiniMax-M3.1-Flash-Preview", "MiniMax-M3", "MiniMax-M2.7", "MiniMax-M2.5",
    ]);
    expect(MINIMAX_REGISTRY.capability.defaultModel).toBe("MiniMax-M3");
    expect(MINIMAX_REGISTRY.capability.baseUrl).toBe("https://api.minimaxi.com/anthropic");
  });

  it("视觉推荐单独筛选，历史型号不自动推荐或改写", () => {
    expect(getBuiltinModels("mimo", "vision")).toEqual(["mimo-v2.6-pro", "mimo-v2.6-flash"]);
    expect(getBuiltinModels("mimo", "chat")).toEqual([
      "mimo-v2.6-pro", "mimo-v2.6-flash", "mimo-v2.6-pro-ultraspeed",
    ]);
    expect(getBuiltinModels("deepseek", "chat")).toEqual(["deepseek-flash", "deepseek-v4-pro"]);
    expect(getBuiltinModels("deepseek", "vision")).toEqual([]);
  });

  it("调用方改动返回数组不会污染后续查询", () => {
    const models = getBuiltinModels("qwen", "chat") as string[];
    const original = [...models];
    models.pop();
    expect(getBuiltinModels("qwen", "chat")).toEqual(original);
    expect(getBuiltinModels("qwen", "chat")).not.toBe(models);
  });
});
