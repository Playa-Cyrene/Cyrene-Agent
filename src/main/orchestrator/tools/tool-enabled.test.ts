import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../index", () => ({
  sendToLive2DWindow: vi.fn(),
}));
import { setWeatherConfig } from "./built-in-tools";
import { setTravelConfig, registerTravelTools } from "./travel-tools";
import { toolRegistry } from "./registry/tool-registry";

registerTravelTools();

describe("plugin enabled gates", () => {
  beforeEach(() => {
    setWeatherConfig(
      () => "北京",
      () => "amap",
      () => "",
      () => false,
    );
    setTravelConfig(
      () => "fake-amap-key",
      () => false,
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("does not execute weather lookup when the weather plugin is disabled", async () => {
    const weather = toolRegistry.getById("weather");

    await expect(weather?.execute({ city: "北京" })).resolves.toBe("[错误] 天气查询功能未启用，请在设置里开启");
  });

  it("does not execute travel lookup when the travel plugin is disabled", async () => {
    const travel = toolRegistry.getById("plan_trip");

    await expect(travel?.execute({ origin: "A", destination: "B" })).resolves.toBe("[错误] 出行工具未启用，请在设置里开启");
  });
});
