/**
 * Memory LLM 共享工具 — 模型配置解析 + 文本处理。
 *
 * 配置来源优先级：
 *   1. 专用 Memory 模型配置（预留接口，当前未启用）
 *   2. 继承主模型配置
 *   3. 旧 DeepSeek 兼容配置（已迁移的用户）
 *   4. 都不可用则抛 MemoryLlmConfigurationError
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { loadModelSettings, resolveModelSettingsProfile } from "../settings/model-settings";

// ── 模型配置 ──

export type MemoryModelConfigSource =
  | "dedicated"
  | "inherited-main"
  | "legacy-deepseek";

export interface MemoryModelConfig {
  source: MemoryModelConfigSource;
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "responses" | "auto";
}

/** 旧 DeepSeek 默认值 — 仅用于兼容已迁移用户的配置文件。 */
const LEGACY_DEEPSEEK: MemoryModelConfig = {
  source: "legacy-deepseek",
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
};

function getSettingsPath(): string {
  return path.join(app.getPath("userData"), "model-settings.json");
}

interface RawSettings {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  explicitTransport?: string;
  memoryProvider?: string;
  memoryBaseUrl?: string;
  memoryModel?: string;
  memoryApiKey?: string;
}

function parseTransport(value: unknown): MemoryModelConfig["explicitTransport"] {
  return value === "openai" || value === "anthropic" || value === "responses" || value === "auto" ? value : undefined;
}

/**
 * 解析 Memory 模型配置。
 *
 * 优先级：
 *   1. 专用 memory* 字段（dedicated）— 当前未在 UI 暴露，但解析层已预留
 *   2. 主模型配置（inherited-main）— 先展开默认档案再读顶层镜像
 *   3. 旧 DeepSeek 配置（legacy-deepseek）— 有 DeepSeek provider 但可能是旧配置
 *   4. 都不满足 → 抛 MemoryLlmConfigurationError
 */
export function loadMemoryModelConfig(): MemoryModelConfig {
  // 1. 专用 Memory 模型配置（预留）：memory* 字段不在 ModelSettings schema 里，单独从原始 JSON 读
  try {
    const filePath = getSettingsPath();
    if (fs.existsSync(filePath)) {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as RawSettings;
      if (raw.memoryProvider && raw.memoryApiKey) {
        return {
          source: "dedicated",
          provider: raw.memoryProvider,
          baseUrl: raw.memoryBaseUrl ?? "",
          model: raw.memoryModel ?? "",
          apiKey: raw.memoryApiKey,
          explicitTransport: parseTransport(raw.explicitTransport),
        };
      }
    }
  } catch {
    // 读不到/解析失败 → 继续走主模型继承
  }

  // 2. 继承主模型配置：先展开默认档案再读顶层镜像（与 channel bot 同策略）。
  // 顶层镜像可能指向空壳 provider（真实配置在默认档案里），直接读会把已配置的用户
  // 误判为"无 API key"并落到 legacy-deepseek 兜底。
  const settings = resolveModelSettingsProfile(loadModelSettings());
  const mainProvider = settings.provider.trim();
  const mainApiKey = settings.apiKey.trim();
  if (mainProvider && mainApiKey) {
    return {
      source: "inherited-main",
      provider: mainProvider,
      baseUrl: settings.baseUrl.trim(),
      model: settings.model.trim(),
      apiKey: mainApiKey,
      explicitTransport: parseTransport(settings.explicitTransport),
    };
  }

  // 3. 旧 DeepSeek 兼容
  return { ...LEGACY_DEEPSEEK };
}

// ── 文本处理 ──

/**
 * 去除推理模型的 <think> 块。
 * 仅用于旧链路兼容；新 Structured Output 链路由统一 Pipeline 处理。
 */
export function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim();
}
