// weather 工具缓存行为测试：城市解析缓存 24h + 天气结果缓存 30 分钟，
// 缓存命中时天气卡片照常回调。全部用 stub 的 fetch 桩，不发真实网络请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearWeatherCaches, setWeatherConfig, weatherTool, type WeatherCardData } from "./weather-tool";

/** 构造 fetch Response 形状的桩 */
function makeResp(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => json,
  } as unknown as Response;
}

/** Open-Meteo 城市解析桩数据 */
const OM_CITY = { name: "上海", latitude: 31.23, longitude: 121.47, country: "中国", admin1: "上海市" };

/** Open-Meteo 天气预报桩数据 */
const OM_FORECAST = {
  current: {
    temperature_2m: 22.5, relative_humidity_2m: 60, apparent_temperature: 21.8,
    precipitation: 0, weather_code: 1, wind_speed_10m: 12, wind_direction_10m: 135,
    surface_pressure: 1013, uv_index: 3, visibility: 10000,
  },
  daily: {
    time: ["2026-09-17"],
    temperature_2m_max: [26], temperature_2m_min: [18],
    weather_code: [1], wind_speed_10m_max: [15], wind_direction_10m_dominant: [135],
  },
};

let cards: WeatherCardData[] = [];

beforeEach(() => {
  clearWeatherCaches();
  cards = [];
  setWeatherConfig(
    () => "上海",
    () => "open-meteo",
    () => "",
    (card) => { cards.push(card); },
    () => true,
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** 装一个记录调用次数的 Open-Meteo 双 API 桩 */
function stubOpenMeteo() {
  const fetchCalls: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: unknown) => {
    const url = String(input);
    fetchCalls.push(url);
    if (url.includes("geocoding-api")) return makeResp({ results: [OM_CITY] });
    return makeResp(OM_FORECAST);
  }));
  return fetchCalls;
}

describe("weather 结果缓存", () => {
  it("同城市两次：解析 + 预报各只请求一次，第二次带 cached 标注，卡片照常回调", async () => {
    const fetchCalls = stubOpenMeteo();

    const first = JSON.parse(await weatherTool.execute({ city: "上海" })) as Record<string, unknown>;
    expect(first.cached).toBeUndefined();
    expect(cards).toHaveLength(1);

    const second = JSON.parse(await weatherTool.execute({ city: "上海" })) as Record<string, unknown>;
    expect(fetchCalls).toHaveLength(2); // geocoding 1 次 + forecast 1 次，没有新请求
    expect(second.cached).toBe(true);
    expect(typeof second.cachedAt).toBe("string");
    // 缓存命中也要发卡片，天气卡片不因缓存消失
    expect(cards).toHaveLength(2);
  });

  it("不同城市各自请求", async () => {
    const fetchCalls = stubOpenMeteo();

    await weatherTool.execute({ city: "上海" });
    await weatherTool.execute({ city: "北京" });
    expect(fetchCalls).toHaveLength(4);
  });

  it("天气结果过期后重查，但城市解析 24h 内仍命中缓存", async () => {
    vi.useFakeTimers();
    const fetchCalls = stubOpenMeteo();

    await weatherTool.execute({ city: "上海" });
    expect(fetchCalls).toHaveLength(2);

    // 过 31 分钟：天气缓存过期，但城市解析缓存（24h）仍在
    vi.advanceTimersByTime(31 * 60_000);
    const second = JSON.parse(await weatherTool.execute({ city: "上海" })) as Record<string, unknown>;

    // 只重新请求了 forecast，没有再打 geocoding
    expect(fetchCalls).toHaveLength(3);
    expect(fetchCalls[2]).toContain("api.open-meteo.com/v1/forecast");
    expect(second.cached).toBeUndefined();
  });
});
