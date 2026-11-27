import { describe, expect, it } from "vitest";
import { resolveComputerViewing } from "./computer-viewing";

const vision = { baseUrl: "https://v.test/v1", apiKey: "k", model: "vl-max" };

describe("resolveComputerViewing", () => {
  it("选直发且主模型能看图 → 截图发给主模型", () => {
    expect(resolveComputerViewing("direct", { model: "gpt-5.6", multimodal: true, vision }))
      .toEqual({ mode: "direct", recipient: "主模型 gpt-5.6" });
  });

  it("主模型只支持文本时，即使选了直发也走视觉模型转述", () => {
    expect(resolveComputerViewing("direct", { model: "text-only", multimodal: false, vision }))
      .toEqual({ mode: "relay", recipient: "视觉模型 vl-max" });
  });

  it("选转述时交给视觉模型", () => {
    expect(resolveComputerViewing("relay", { model: "gpt-5.6", multimodal: true, vision }))
      .toEqual({ mode: "relay", recipient: "视觉模型 vl-max" });
  });

  it.each([
    ["relay", { model: "gpt-5.6", multimodal: true }, "还没有配置视觉模型"],
    ["direct", { model: "text-only", multimodal: false }, "不能直接看图"],
    ["relay", { model: "m", vision: { ...vision, apiKey: "" } }, "还没有配置视觉模型"],
  ] as const)("%s 走不通时给出原因", (mode, settings, reason) => {
    const viewing = resolveComputerViewing(mode, settings);
    expect(viewing.mode).toBe("unavailable");
    expect(viewing.mode === "unavailable" && viewing.reason).toContain(reason);
  });
});
