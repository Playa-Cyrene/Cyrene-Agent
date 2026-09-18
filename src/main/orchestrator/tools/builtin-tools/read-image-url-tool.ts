// ── 工具：read_image_url ─────────────────────────────────────
// 把公网图片 URL 直传给视觉模型分析，返回文字描述。
//
// 与 read_image / download_file 的分工：
// - read_image：本地图片文件 → base64 → 视觉模型（fs-tools.ts，落盘链路）
// - read_image_url：公网 URL → 原样直传视觉模型，厂商服务器自行拉图
//   （本机不下载、不转 base64，省流量省内存）
// - download_file：要把图片存到本地时用（要副本，不是要"看"）
//
// 协议构造全部委托 vision-captioner（唯一多模态协议层），本文件只做
// 参数校验 + 视觉配置检查 + 调用，不碰 image_url 格式细节。

import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";
import { TtlResultCache } from "./ttl-result-cache";

const LOG_PREFIX = "[BuiltinTools]";

// ── 视觉描述缓存 ─────────────────────────────────────────
// 每次调用都是真金白银的视觉模型请求。模型对同一张图反复看（"再看下那个图…"）
// 时直接复用 30 分钟内的描述。key 必须带 userQuery：同一个图不同问题的描述不同。
const CAPTION_CACHE_TTL_MS = 30 * 60_000;
const captionCache = new TtlResultCache<string>(CAPTION_CACHE_TTL_MS);

/** 清空视觉描述缓存（测试隔离用） */
export function clearImageCaptionCache(): void {
  captionCache.clear();
}

/** 懒加载图片转述视觉配置：动态 import，规避注册期副作用。路由判定收口在 image-router。 */
async function loadCaptionVisionConfigLazy(): Promise<import("../../image-router").CaptionVisionConfig> {
  const settingsMod = await import("../../../settings/model-settings");
  const settings = settingsMod.resolveModelSettingsProfile(settingsMod.loadModelSettings());
  const router = await import("../../image-router");
  return router.resolveCaptionVisionConfig(settings);
}

async function executeReadImageUrl(
  args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }

  // 缓存命中：直接复用并标注生成时间（命中时连视觉模型配置都不用加载）
  const userQuery = ctx?.userQuery ?? "";
  const cacheKey = url + "||" + userQuery;
  const hit = captionCache.get(cacheKey);
  if (hit) {
    const generatedAt = new Date(hit.at).toLocaleString("zh-CN", { hour12: false });
    return "[缓存] 此描述生成于 " + generatedAt + "，30 分钟内复用\n\n" + hit.value;
  }

  const captionVision = await loadCaptionVisionConfigLazy();
  if (!captionVision.ok) {
    return "[错误·配置] " + captionVision.error;
  }

  console.log(LOG_PREFIX, "read_image_url:", url);

  // URL 直传：厂商服务器自行拉图，本机不下载
  const { captionImage } = await import("../../vision-captioner");
  const result = await captionImage({ url }, userQuery, captionVision.config);
  // 只有成功描述才写缓存；错误描述（[错误 开头）不缓存，下次重试
  if (!result.startsWith("[错误")) {
    captionCache.set(cacheKey, result);
  }
  return result;
}

export const readImageUrlTool: ToolDefinition = {
  id: "read_image_url",
  name: "读取网络图片",
  description:
    "把公网图片 URL 交给视觉模型分析，返回文字描述。图片由模型厂商服务器直接拉取，" +
    "本机不下载，适合快速看一眼网上的图。\n\n" +
    "何时用：\n" +
    "- 对话/网页里出现图片 URL，用户问'这图里是什么'\n" +
    "- web_search 或 fetch_url 拿到图片链接，想看内容\n\n" +
    "不要用于：\n" +
    "- 本地图片文件 → read_image\n" +
    "- 用户想把图片保存到本地 → download_file\n" +
    "- 厂商拉不到的 URL（内网/失效/防盗链会报错，此时可用 download_file 下载后再 read_image）\n\n" +
    "若未配置视觉模型会返回错误，届时如实告诉用户看不了。" +
    "参数：url (必填，完整 http(s) 图片地址)。",
  enabled: true,
  risk: "network",
  modes: ["learn", "code", "work"],
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  needsContext: true,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要分析的图片完整 URL（必须包含 https:// 或 http://）" },
    },
    required: ["url"],
  },
  execute: executeReadImageUrl,
};
