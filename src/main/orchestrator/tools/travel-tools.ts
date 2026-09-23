// 🚗 出行工具 —— 路线规划（驾车/步行/骑行/公交）。
//
// 设计原则：
// - 复用 GeneralSettings 中已有的 amapKey（高德 Web 服务 API Key）
// - 用高德地理编码将地名转坐标，再调用路径规划 API
// - 返回易读的中文路线描述
// - 不引入新依赖，复用全局 fetch

import { toolRegistry } from "./registry/tool-registry";
import { logger, LogTag } from "../../logger";

const LOG_PREFIX = "[TravelTools]";
const TRAVEL_TIMEOUT_MS = 15000;

// ══════════════════════════════════════════════════════════
// 配置注入
// ══════════════════════════════════════════════════════════

let amapKeyGetter: (() => string) | null = null;
let travelEnabledGetter: (() => boolean) | null = null;

/** index.ts 启动时注入 amapKey 获取器。 */
export function setTravelConfig(amapKeyFn: () => string, enabledFn?: () => boolean): void {
  amapKeyGetter = amapKeyFn;
  travelEnabledGetter = enabledFn ?? null;
}

// ══════════════════════════════════════════════════════════
// 高德地理编码：地名 → "经度,纬度"
// ══════════════════════════════════════════════════════════

async function geocode(address: string, key: string): Promise<string | null> {
  const url = `https://restapi.amap.com/v3/geocode/geo?address=${encodeURIComponent(address)}&output=JSON&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const data = await resp.json() as { status?: string; geocodes?: Array<{ location: string }> };
    if (data.status !== "1" || !data.geocodes || data.geocodes.length === 0) return null;
    return data.geocodes[0].location; // 格式 "116.397428,39.90923"
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════
// 各出行方式 API 封装
// ══════════════════════════════════════════════════════════

/** 驾车路径规划。 */
async function planDriving(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/driving?origin=${origin}&destination=${destination}&extensions=base&strategy=0&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 驾车路线查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { paths?: Array<{ distance: string; duration: string; tolls: string; toll_distance: string; traffic_lights: string }> };
    };
    if (!data.route?.paths?.length) return "[错误] 未找到驾车路线";
    const path = data.route.paths[0];
    const distKm = (Number(path.distance) / 1000).toFixed(1);
    const durMin = Math.round(Number(path.duration) / 60);
    const toll = Number(path.tolls);
    const lines = [
      `🚗 驾车路线`,
      `距离：${distKm} 公里`,
      `预计用时：${durMin} 分钟`,
      toll > 0 ? `路费：${toll.toFixed(0)} 元` : `路费：免费`,
      `红绿灯：${path.traffic_lights || 0} 个`,
    ];
    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 驾车路线查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 步行路径规划（最长 100km）。 */
async function planWalking(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/walking?origin=${origin}&destination=${destination}&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 步行路线查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { paths?: Array<{ distance: string; duration: string }> };
    };
    if (!data.route?.paths?.length) return "[错误] 未找到步行路线";
    const path = data.route.paths[0];
    const distM = Number(path.distance);
    const durMin = Math.round(Number(path.duration) / 60);
    const distStr = distM >= 1000 ? `${(distM / 1000).toFixed(1)} 公里` : `${distM.toFixed(0)} 米`;
    return [
      `🚶 步行路线`,
      `距离：${distStr}`,
      `预计用时：${durMin} 分钟`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 步行路线查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 骑行路径规划（最长 500km）。 */
async function planCycling(origin: string, destination: string, key: string): Promise<string> {
  const url = `https://restapi.amap.com/v4/direction/bicycling?origin=${origin}&destination=${destination}&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 骑行路线查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      data?: { paths?: Array<{ distance: string; duration: string }> };
    };
    if (!data.data?.paths?.length) return "[错误] 未找到骑行路线";
    const path = data.data.paths[0];
    const distKm = (Number(path.distance) / 1000).toFixed(1);
    const durMin = Math.round(Number(path.duration) / 60);
    return [
      `🚲 骑行路线`,
      `距离：${distKm} 公里`,
      `预计用时：${durMin} 分钟`,
    ].join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 骑行路线查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

/** 公交路径规划（支持公交/地铁/火车综合换乘）。 */
async function planTransit(
  origin: string,
  destination: string,
  city: string,
  key: string,
): Promise<string> {
  const url = `https://restapi.amap.com/v3/direction/transit/integrated?origin=${origin}&destination=${destination}&city=${encodeURIComponent(city)}&strategy=0&extensions=base&key=${key}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TRAVEL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return `[错误] 公交路线查询失败：HTTP ${resp.status}`;
    const data = await resp.json() as {
      route?: { transits?: Array<{
        cost: string; duration: string; walking_distance: string;
        segments?: Array<{
          walking?: { distance: string; duration: string };
          bus?: { buslines?: Array<{ name: string; depart_stop: { name: string }; arrival_stop: { name: string } }> };
        }>;
      }>; taxi_cost?: string };
    };
    if (!data.route?.transits?.length) return "[错误] 未找到公交路线";
    const transit = data.route.transits[0];
    const durMin = Math.round(Number(transit.duration) / 60);
    const price = Number(transit.cost).toFixed(0);
    const walkDist = Number(transit.walking_distance);
    const walkStr = walkDist > 0 ? `（步行 ${walkDist.toFixed(0)} 米）` : "";

    // 提取换乘方案简述
    const steps = transit.segments?.map((seg, i) => {
      if (seg.bus?.buslines?.length) {
        const bus = seg.bus.buslines[0];
        return `  ${i + 1}. 乘 ${bus.name}：${bus.depart_stop.name} → ${bus.arrival_stop.name}`;
      }
      if (seg.walking) {
        return `  ${i + 1}. 步行 ${Number(seg.walking.distance).toFixed(0)} 米`;
      }
      return "";
    }).filter(Boolean) || [];

    const lines = [
      `🚌 公交路线`,
      `预计用时：${durMin} 分钟`,
      `票价：${price} 元${walkStr}`,
      data.route.taxi_cost ? `打车参考价：${data.route.taxi_cost} 元` : "",
      ...(steps.length ? [`换乘方案：`, ...steps] : []),
    ].filter(Boolean);

    return lines.join("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 公交路线查询失败：" + msg;
  } finally {
    clearTimeout(timer);
  }
}

// ══════════════════════════════════════════════════════════
// 工具入口
// ══════════════════════════════════════════════════════════

async function executePlanTrip(args: Record<string, unknown>): Promise<string> {
  if (travelEnabledGetter && !travelEnabledGetter()) {
    return "[错误] 出行工具未启用，请在设置里开启";
  }

  const amapKey = amapKeyGetter?.() ?? "";
  if (!amapKey) {
    return "[提示] 高德 API Key 未配置。可在 设置→插件 中找到 🚗出行工具，填入高德 Web 服务 API Key（注册地址：https://lbs.amap.com）。";
  }

  const origin = String(args.origin ?? "").trim();
  const destination = String(args.destination ?? "").trim();
  if (!origin || !destination) {
    return "[错误] 请提供起点和终点";
  }

  const mode = String(args.mode ?? "驾车").trim();

  // 地理编码：地名 → 坐标
  const [origLoc, destLoc] = await Promise.all([
    geocode(origin, amapKey),
    geocode(destination, amapKey),
  ]);
  if (!origLoc) return `[错误] 无法解析起点「${origin}」的位置，请尝试更具体的名称`;
  if (!destLoc) return `[错误] 无法解析终点「${destination}」的位置，请尝试更具体的名称`;

  console.log(LOG_PREFIX, `规划路线：「${origin}」→「${destination}」, 方式=${mode}`);

  switch (mode) {
    case "驾车":
    case "开车":
      return planDriving(origLoc, destLoc, amapKey);

    case "步行":
    case "走路":
      return planWalking(origLoc, destLoc, amapKey);

    case "骑行":
    case "骑车":
    case "自行车":
      return planCycling(origLoc, destLoc, amapKey);

    case "公交":
    case "公共交通":
    case "地铁":
    case "公交地铁": {
      const city = String(args.city ?? "").trim();
      if (!city) return "[错误] 公交路线必须提供城市（参数 city），例如 city='北京'";
      return planTransit(origLoc, destLoc, city, amapKey);
    }

    default:
      return `[错误] 不支持的出行方式「${mode}」。支持：驾车、步行、骑行、公交`;
  }
}

// ══════════════════════════════════════════════════════════
// 注册
// ══════════════════════════════════════════════════════════

/** 注册出行工具。index.ts startup 调一次。 */
export function registerTravelTools(): void {
  toolRegistry.register({
    id: "plan_trip",
    name: "🚗出行工具",
    description:
      "路线规划，查驾车/步行/骑行/公交的路线、距离和预计时间。\n\n" +
      "何时用：\n" +
      "- 用户问「从 A 到 B 怎么走」「去 X 怎么坐车」「到 Y 多远」\n" +
      "- 用户想知道驾车/公交/骑行/步行的路线和耗时\n" +
      "- 用户问「打车要多少钱」「骑自行车去 X 多久」\n\n" +
      "不要用于：\n" +
      "- 查天气（用 weather 工具）\n" +
      "- 查具体公交线路信息或时刻表（不支持）\n" +
      "- 查路况（不支持）\n\n" +
      "参数：\n" +
      "- origin（必填）：起点，如「故宫」「北京市天安门」\n" +
      "- destination（必填）：终点\n" +
      "- mode（可选，默认驾车）：出行方式——驾车/开车、步行/走路、骑行/骑车/自行车、公交/公共交通/地铁\n" +
      "- city（公交必填）：城市名，如「北京」「上海」。仅公交模式需要",
    enabled: true,
    effectKind: "read",
    risk: "network",
    modes: ["work"],
    inputSchema: {
      type: "object",
      properties: {
        origin:       { type: "string", description: "起点，如「故宫」「北京市天安门」" },
        destination:  { type: "string", description: "终点" },
        mode:         { type: "string", description: "出行方式：驾车/开车、步行/走路、骑行/骑车/自行车、公交/公共交通/地铁（默认驾车）" },
        city:         { type: "string", description: "城市名，如「北京」「上海」，公交模式必填" },
      },
      required: ["origin", "destination"],
    },
    execute: executePlanTrip,
  });

  logger.info(LogTag.TravelTools, "registered: plan_trip");
}
