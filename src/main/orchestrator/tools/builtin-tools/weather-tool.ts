// ── 工具：weather（天气查询）─────────────────────────────
// 查指定城市的实时天气。城市参数可选——没传就读用户信息的默认城市。
// 支持两个天气源：
//   - open-meteo（免配置默认，海外开源 API）
//   - amap（高德天气，国内数据准，需填 key）
// 默认城市/天气源/高德key 通过 setWeatherConfig 注入（避免 import index.ts 造成循环依赖）。
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// weatherTool 常量，由 built-in-tools.ts facade 在原注册位置统一 toolRegistry.register，
// 显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，门禁见
// built-in-tools.snapshot.test.ts）。

import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { getDateLocale, getWeatherLanguage } from "../../../locale-context";
import { currentUserTimezone } from "./timezone";
import { TtlResultCache } from "./ttl-result-cache";

// ── 工具 4：weather（天气查询）─────────────────────────────
// 查指定城市的实时天气。城市参数可选——没传就读用户信息的默认城市。
// 支持两个天气源：
//   - open-meteo（免配置默认，海外开源 API）
//   - amap（高德天气，国内数据准，需填 key）
// 默认城市/天气源/高德key 通过 setWeatherConfig 注入（避免 import index.ts 造成循环依赖）。

const WEATHER_TIMEOUT_MS = 15_000;

// ── 天气查询缓存 ─────────────────────────────────────────
// 模型常被反复问"今天天气怎样"（伙伴场景高频问题），两层缓存：
// - 城市→坐标/adcode 解析：24 小时——城市不会搬家
// - 天气结果：30 分钟——天气半小时内变化有限，命中时补 cached/cachedAt 让模型自知新鲜度；
//   缓存同时保存卡片数据，命中时照常回调渲染端，天气卡片不因缓存消失
const WEATHER_CACHE_TTL_MS = 30 * 60_000;
const GEOCODE_CACHE_TTL_MS = 24 * 60 * 60_000;

interface WeatherCacheEntry {
  data: Record<string, unknown>;
  card: WeatherCardData | null;
}

const omCityCache = new TtlResultCache<OMCity>(GEOCODE_CACHE_TTL_MS);
const amapDistrictCache = new TtlResultCache<AmapDistrict>(GEOCODE_CACHE_TTL_MS);
const weatherCache = new TtlResultCache<WeatherCacheEntry>(WEATHER_CACHE_TTL_MS);

/** 清空天气相关缓存（测试隔离用） */
export function clearWeatherCaches(): void {
  omCityCache.clear();
  amapDistrictCache.clear();
  weatherCache.clear();
}

/** 注入的配置获取器（由 index.ts 启动时调 setWeatherConfig 设置）。 */
let weatherCityGetter: (() => string) | null = null;
let weatherSourceGetter: (() => string) | null = null;
let amapKeyGetter: (() => string) | null = null;
let weatherEnabledGetter: (() => boolean) | null = null;

/** 天气卡片数据回调：工具拿到结构化数据后调这个，由桥层发 Custom 事件给渲染端。 */
let weatherCardCallback: ((card: WeatherCardData, context?: ToolContext) => void) | null = null;

/** 天气卡片结构化数据（发给渲染端渲染 WeatherCard 用）。
 *  字段与 renderer 侧 weather-types.ts 中的 WeatherData 保持一致。
 */
export interface WeatherCardData {
  source: "open-meteo" | "amap";
  location: {
    province: string;
    city: string;
  };
  // Open-Meteo 字段
  weatherCode?: number;
  temp: number;
  feelsLike?: number;
  humidity: number;
  windDeg?: number;
  windSpeed?: number;
  precipitation?: number;
  pressure?: number;
  // 高德字段
  weather?: string;
  windDirection?: string;
  windPower?: string;
  reporttime?: string;
}

/**
 * index.ts 启动时调用，注入默认城市/天气源/高德key/卡片回调 的读取器。
 * source: "open-meteo"（免配置默认）| "amap"（高德）
 */
export function setWeatherConfig(
  cityGetter: () => string,
  sourceGetter: () => string,
  amapKeyFn: () => string,
  cardCb?: (card: WeatherCardData, context?: ToolContext) => void,
  enabledGetter?: () => boolean,
): void {
  weatherCityGetter = cityGetter;
  weatherSourceGetter = sourceGetter;
  amapKeyGetter = amapKeyFn;
  weatherEnabledGetter = enabledGetter ?? null;
  if (cardCb) weatherCardCallback = cardCb;
}

// ── Open-Meteo 实现（免 key 免配置）──

interface OMCity { name: string; latitude: number; longitude: number; country: string; admin1?: string }

/** Open-Meteo 城市查询（Geocoding API，免费免 key）。结果缓存 24 小时。 */
async function omResolveCity(city: string): Promise<OMCity | null> {
  const cacheKey = city + "|" + getWeatherLanguage();
  const hit = omCityCache.get(cacheKey);
  if (hit) return hit.value;
  const params = new URLSearchParams({ name: city, count: "1", language: getWeatherLanguage(), format: "json" });
  const url = `https://geocoding-api.open-meteo.com/v1/search?${params}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { results?: OMCity[] };
    if (!data.results || data.results.length === 0) return null;
    // 只有解析成功才写缓存；null 可能是网络失败也可能是真找不到，都不缓存
    omCityCache.set(cacheKey, data.results[0]);
    return data.results[0];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Open-Meteo 实时天气查询（免费免 key）。结果缓存 30 分钟。 */
async function omFetchWeather(city: string, context?: ToolContext): Promise<string> {
  // 缓存命中：照常发卡片给渲染端，文本补 cached/cachedAt 标注
  const cacheKey = "open-meteo|" + city;
  const hit = weatherCache.get(cacheKey);
  if (hit) {
    if (hit.value.card && weatherCardCallback) {
      weatherCardCallback(hit.value.card, context);
    }
    return JSON.stringify({
      ...hit.value.data,
      cached: true,
      cachedAt: new Date(hit.at).toISOString(),
    });
  }

  const loc = await omResolveCity(city);
  if (!loc) {
    return `[错误] 找不到城市"${city}"，请确认城市名（支持中文/拼音）。`;
  }
  const currentParams = [
    "temperature_2m", "relative_humidity_2m", "apparent_temperature",
    "precipitation", "weather_code", "wind_speed_10m", "wind_direction_10m",
    "surface_pressure", "uv_index", "visibility",
  ].join(",");
  const dailyParams = ["temperature_2m_max", "temperature_2m_min", "weather_code", "wind_speed_10m_max", "wind_direction_10m_dominant"].join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.latitude}&longitude=${loc.longitude}&current=${currentParams}&daily=${dailyParams}&timezone=auto`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 天气查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      current?: {
        temperature_2m: number; relative_humidity_2m: number; apparent_temperature: number;
        precipitation: number; weather_code: number; wind_speed_10m: number;
        wind_direction_10m: number; surface_pressure: number;
        uv_index: number; visibility: number;
      };
      daily?: {
        time: string[];
        temperature_2m_max: number[];
        temperature_2m_min: number[];
        weather_code: number[];
        wind_speed_10m_max: number[];
        wind_direction_10m_dominant: number[];
      };
    };
    const c = data.current;
    if (!c) return "[错误] 天气查询失败：Open-Meteo 未返回数据";
    const wmoText = omWeatherCodeText(c.weather_code);
    const windDir = omWindDir(c.wind_direction_10m);
    const adm = loc.admin1 ? `${loc.admin1}` : loc.country;

    const weatherData = {
      city: loc.name,
      region: adm,
      weather: wmoText,
      temperature: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windDirection: windDir,
      windSpeed: `${c.wind_speed_10m}km/h`,
      precipitation: c.precipitation,
      pressure: Math.round(c.surface_pressure),
      uv: c.uv_index,
      visibility: Math.round(c.visibility / 1000), // m → km
      source: "Open-Meteo",
      updateTime: new Date().toLocaleString(getDateLocale(), { hour: "2-digit", minute: "2-digit", timeZone: currentUserTimezone() }),
    };

    // 发送天气卡片数据给渲染端（与 renderer 侧 WeatherData 结构对齐）。
    // 卡片数据随缓存一起保存：命中时照常回调，天气卡片不因缓存消失
    const card: WeatherCardData = {
      source: "open-meteo",
      location: { province: adm, city: loc.name },
      weatherCode: c.weather_code,
      temp: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      windDeg: c.wind_direction_10m,
      windSpeed: c.wind_speed_10m,
      precipitation: c.precipitation,
      pressure: Math.round(c.surface_pressure),
    };
    weatherCache.set(cacheKey, { data: weatherData, card });
    if (weatherCardCallback) {
      weatherCardCallback(card, context);
    }

    return JSON.stringify(weatherData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 天气查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** WMO 天气代码 → 中文描述（Open-Meteo 用 WMO 标准代码）。 */
function omWeatherCodeText(code: number): string {
  const map: Record<number, string> = {
    0: "晴", 1: "晴间多云", 2: "多云", 3: "阴",
    45: "雾", 48: "雾凇",
    51: "小雨", 53: "中雨", 55: "大雨",
    56: "冻雨", 57: "强冻雨",
    61: "小雨", 63: "中雨", 65: "大雨",
    66: "冻雨", 67: "强冻雨",
    71: "小雪", 73: "中雪", 75: "大雪",
    77: "雪粒",
    80: "阵雨", 81: "强阵雨", 82: "暴雨",
    85: "阵雪", 86: "强阵雪",
    95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹",
  };
  return map[code] ?? `未知（代码${code}）`;
}

/** 风向角度 → 中文方位。 */
function omWindDir(deg: number): string {
  const dirs = ["北", "东北偏北", "东北", "东北偏东", "东", "东南偏东", "东南", "东南偏南",
    "南", "西南偏南", "西南", "西南偏西", "西", "西北偏西", "西北", "西北偏北"];
  return dirs[Math.round(deg / 22.5) % 16];
}

// ── 高德天气实现（需 key，国内数据准）──

interface AmapDistrict { adcode: string; name: string; level: string }

/** 高德行政区查询：城市名 → adcode。结果缓存 24 小时。 */
async function amapResolveAdcode(city: string, key: string): Promise<AmapDistrict | null> {
  const hit = amapDistrictCache.get(city);
  if (hit) return hit.value;
  const url = `https://restapi.amap.com/v3/config/district?keywords=${encodeURIComponent(city)}&subdistrict=0&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { status?: string; districts?: AmapDistrict[] };
    if (data.status !== "1" || !data.districts || data.districts.length === 0) return null;
    // 只有解析成功才写缓存；null 可能是网络失败也可能是真找不到，都不缓存
    amapDistrictCache.set(city, data.districts[0]);
    return data.districts[0];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 高德实时天气查询。结果缓存 30 分钟。 */
async function amapFetchWeather(city: string, key: string, context?: ToolContext): Promise<string> {
  // 缓存命中：照常发卡片给渲染端，文本补 cached/cachedAt 标注
  const cacheKey = "amap|" + city;
  const hit = weatherCache.get(cacheKey);
  if (hit) {
    if (hit.value.card && weatherCardCallback) {
      weatherCardCallback(hit.value.card, context);
    }
    return JSON.stringify({
      ...hit.value.data,
      cached: true,
      cachedAt: new Date(hit.at).toISOString(),
    });
  }

  const district = await amapResolveAdcode(city, key);
  if (!district) {
    return `[错误] 找不到城市"${city}"，请确认城市名（支持中文，如"无锡"）。`;
  }

  // 请求实况天气
  const baseUrl = `https://restapi.amap.com/v3/weather/weatherInfo?city=${district.adcode}&key=${key}&extensions=base`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WEATHER_TIMEOUT_MS);
  try {
    const baseResp = await fetch(baseUrl, { signal: ctrl.signal });
    if (!baseResp.ok) return `[错误] 天气查询失败：HTTP ${baseResp.status}`;
    const baseData = await baseResp.json() as { status?: string; lives?: Array<{
      province: string; city: string; weather: string; temperature: string;
      winddirection: string; windpower: string; humidity: string; reporttime: string;
    }> };
    if (baseData.status !== "1" || !baseData.lives || baseData.lives.length === 0) {
      return `[错误] 天气查询失败：高德返回 status=${baseData.status ?? "?"}`;
    }
    const w = baseData.lives[0];

    const weatherData = {
      city: w.city,
      region: w.province,
      weather: w.weather,
      temperature: Number(w.temperature),
      humidity: Number(w.humidity),
      windDirection: w.winddirection,
      windSpeed: `${w.windpower}级`,
      source: "高德天气",
      updateTime: w.reporttime.slice(11, 16) || new Date().toLocaleString(getDateLocale(), { hour: "2-digit", minute: "2-digit" }),
    };

    // 发送天气卡片数据给渲染端（与 renderer 侧 WeatherData 结构对齐）。
    // 卡片数据随缓存一起保存：命中时照常回调，天气卡片不因缓存消失
    const card: WeatherCardData = {
      source: "amap",
      location: { province: w.province, city: w.city },
      weather: w.weather,
      temp: Number(w.temperature),
      humidity: Number(w.humidity),
      windDirection: w.winddirection,
      windPower: w.windpower,
      reporttime: w.reporttime,
    };
    weatherCache.set(cacheKey, { data: weatherData, card });
    if (weatherCardCallback) {
      weatherCardCallback(card, context);
    }

    return JSON.stringify(weatherData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 天气查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

async function executeWeather(args: Record<string, unknown>, context?: ToolContext): Promise<string> {
  if (weatherEnabledGetter && !weatherEnabledGetter()) {
    return "[错误] 天气查询功能未启用，请在设置里开启";
  }

  const source = weatherSourceGetter?.() ?? "open-meteo";

  // 城市：参数优先，没传读用户信息默认城市
  let city = String(args.city ?? "").trim();
  if (!city) {
    city = (weatherCityGetter?.() ?? "").trim();
  }
  // 城市解析日志：用于确认模型是否仍自行传入"上海"。
  // 脱敏：仅记城市名（公开地理名）+ 来源标签；不带用户 ID/任何凭证。
  const argsCityRaw = String(args.city ?? "").trim();
  const defaultCityRaw = (weatherCityGetter?.() ?? "").trim();
  const source2: "arg" | "default" | "none" = argsCityRaw
    ? "arg"
    : defaultCityRaw
      ? "default"
      : "none";
  console.log(
    `[Weather] city resolution: argsCity=${argsCityRaw || "(empty)"} defaultCity=${defaultCityRaw || "(empty)"} final=${city || "(empty)"} source=${source2}`,
  );
  if (!city) {
    return "[提示] 没有指定城市，也没设置默认城市。请告诉用户：在 设置 → 我的信息 填默认城市，或直接说出要查的城市名。";
  }

  // 按天气源分支
  if (source === "open-meteo") {
    return omFetchWeather(city, context);
  }
  if (source === "amap") {
    const amapKey = amapKeyGetter?.() ?? "";
    if (!amapKey) {
      return "[错误] 还没有配置高德天气 Key。请在 设置 → 插件 → 天气查询 填入高德 Key，或切换天气源为 Open-Meteo（免配置）。";
    }
    return amapFetchWeather(city, amapKey, context);
  }

  // 未知天气源
  return `[错误] 未知的天气源"${source}"。请在 设置 → 插件 → 天气查询 选择 Open-Meteo 或 高德天气。`;
}

export const weatherTool: ToolDefinition = {
  id: "weather",
  name: "查天气",
  description:
    "查询指定城市的实时天气。返回温度、体感温度、湿度、风速风向、降水、日出日落、AQI、UV 等。\n\n" +
    "何时用：\n" +
    "- 用户问'今天天气怎样''外面冷不冷''热不热''要不要带伞''穿什么'\n" +
    "- 用户提到城市名 + 天气相关词\n" +
    "- 用户问'周末适合出去玩吗'且涉及天气判断\n\n" +
    "不要用于：\n" +
    "- 历史天气（'上周北京天气'）—— 做不到，直接告诉用户\n" +
    "- 逐小时精确预报\n" +
    "- 完全跟天气无关的问题\n\n" +
    "参数：city（可选，城市名中文或拼音；不传则用用户设置的默认城市）。",
  enabled: true,
  risk: "network",
  modes: ["work"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      city: { type: "string", description: "要查询的城市名（中文或拼音），不传则用用户默认城市" },
    },
    required: [],
  },
  execute: executeWeather,
};

