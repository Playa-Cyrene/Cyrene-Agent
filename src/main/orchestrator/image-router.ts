// image-router —— 全项目唯一的图片路由。
// 回到最初设计：纯文本主模型配 VLM 转文字进上下文；多模态主模型直接进图。
// 所有图片入口（附件 / 工具 / 频道 / 动态）先问这里，不允许各自判断。
//
// 三种结果，不允许模糊状态：
// - direct：直发主模型（协议差异交给 transport 适配层，路由层不关心协议）
// - caption：交给独立视觉模型转述成文字
// - reject：当前配置看不了图，reason 是面向用户的人话提示

import type { VisionConfig } from "./vision-captioner";

/** 图片入口来源，用于日志和针对性提示。 */
export type ImageSource = "attachment" | "tool" | "channel" | "moments";

/** 路由所需的最小设置视图（完整 ModelSettings 与各处 Lite 型都结构兼容）。 */
export interface ImageRouteSettings {
  /** 主模型是否多模态。undefined 按 true 处理（与旧逻辑一致）。 */
  multimodal?: boolean;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 独立视觉模型配置（可选）。 */
  vision?: { baseUrl: string; apiKey: string; model: string };
}

/** 路由结果：三选一。 */
export type ImageRoute =
  | { mode: "direct" }
  | { mode: "caption"; config: VisionConfig }
  | { mode: "reject"; reason: string };

/**
 * 统一路由判定。
 * @param source 图片来源
 * @param settings 已展开档案的模型设置（调用方负责 resolveModelSettingsProfile）
 */
export function resolveImageRoute(
  source: ImageSource,
  settings: ImageRouteSettings,
): ImageRoute {
  // ── 分支一：主模型多模态 → 直发 ──
  if (settings.multimodal !== false) {
    return { mode: "direct" };
  }

  // ── 分支二：纯文本主模型 + 已配独立视觉模型 → 转述 ──
  const v = settings.vision;
  if (v?.baseUrl && v.apiKey && v.model) {
    return { mode: "caption", config: { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model } };
  }

  // ── 分支三：拒绝，说人话 ──
  return {
    mode: "reject",
    reason:
      "当前主模型不是多模态，且未配置独立视觉模型。" +
      "请在「设置 → API 设置 → 视觉模型」中配置，或切换到多模态主模型。",
  };
}

/** 图片转述的视觉端点：成功给出可调配置，失败给出人话错误。 */
export type CaptionVisionConfig =
  | { ok: true; config: VisionConfig }
  | { ok: false; error: string };

/**
 * 解析"谁来转述这张图"（read_image / read_image_url 工具、直发失败的 caption 兜底、频道收图共用）：
 * 转述产物是纯文本，主模型无法直发看图，必须解析出一个可调的 VLM 端点。
 *
 * - 纯文本主模型 → 跟随统一路由（已配 VLM 则转述，否则拒绝）
 * - 多模态 + OpenAI 兼容 → 主模型自己兼职看图（沿用现状）
 * - 多模态 + Anthropic → 视觉链路只拼 /chat/completions，复用主模型地址必然 404，
 *   已配 VLM 则用 VLM；没配则显式拒绝，不返回注定失败的配置
 */
export function resolveCaptionVisionConfig(settings: ImageRouteSettings): CaptionVisionConfig {
  const route = resolveImageRoute("tool", settings);

  if (route.mode === "caption") {
    return { ok: true, config: route.config };
  }
  if (route.mode === "reject") {
    return { ok: false, error: route.reason };
  }

  // direct：多模态主模型。OpenAI 兼容时主模型兼职看图（现状保留）
  if (settings.explicitTransport !== "anthropic") {
    return { ok: true, config: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model } };
  }

  // 多模态 + Anthropic：视觉链路只拼 OpenAI 兼容格式，优先独立 VLM，没配则显式拒绝
  const v = settings.vision;
  if (v?.baseUrl && v.apiKey && v.model) {
    return { ok: true, config: { baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model } };
  }
  return {
    ok: false,
    error:
      "主模型走 Anthropic 协议，图片转述需要 OpenAI 兼容的独立视觉模型。" +
      "请在「设置 → API 设置 → 视觉模型」中配置。",
  };
}
