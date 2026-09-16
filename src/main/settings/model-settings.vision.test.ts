// multimodal 旧配置一次性迁移的回归测试：
// 旧文件（无 schemaVersion）首次 normalize 时执行三层判定并把结果随 schemaVersion: 2 落盘；
// 已迁移文件（schemaVersion >= 2）不再进迁移分支，multimodal 只认显式字段。
// Anthropic 协议降级场景由 image-router.test.ts 的 resolveCaptionVisionConfig 用例覆盖。
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-test" } }));

import { normalizeModelSettings, type ModelSettings, type VisionModelConfig } from "./model-settings";

// 旧版 vision 配置带 syncWithMain 标记（迁移用），比 VisionModelConfig 多一个可选字段
type LegacyVision = VisionModelConfig & { syncWithMain?: boolean };

const MINIMAX_BASE = {
  provider: "MiniMax（稀宇科技）",
  baseUrl: "https://api.minimaxi.com/anthropic",
  model: "MiniMax-M3",
  apiKey: "sk-test",
  explicitTransport: "anthropic",
} as const;

const COMPLETE_VISION: LegacyVision = {
  baseUrl: "https://api.minimaxi.com/v1",
  apiKey: "sk-vision",
  model: "MiniMax-M3",
};

describe("normalizeModelSettings 旧配置一次性迁移（schemaVersion 1 → 2）", () => {
  it("旧配置无 multimodal 字段 + 独立视觉模型齐全 → multimodal 落 false（不静默旁路），并打上 schemaVersion: 2", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(false);
    expect(s.schemaVersion).toBe(2);
  });

  it("旧配置 syncWithMain=true → multimodal 落 true（与主模型同步）", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { ...COMPLETE_VISION, syncWithMain: true },
    });
    expect(s.multimodal).toBe(true);
    expect(s.schemaVersion).toBe(2);
  });

  it("旧配置无视觉模型 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE });
    expect(s.multimodal).toBe(true);
  });

  it("multimodal 已持久化 → 不被迁移翻转（用户显式选择优先）", () => {
    const s = normalizeModelSettings({ ...MINIMAX_BASE, multimodal: true, vision: COMPLETE_VISION });
    expect(s.multimodal).toBe(true);
  });

  it("旧配置视觉模型不齐全 → multimodal 维持默认 true", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      vision: { baseUrl: "https://api.minimaxi.com/v1", apiKey: "", model: "MiniMax-M3" },
    });
    expect(s.multimodal).toBe(true);
  });

  it("迁移落盘后（schemaVersion: 2）重启 → 不再进迁移分支，syncWithMain 被忽略", () => {
    // 模拟第二轮启动：上一轮迁移结果（multimodal: false）已持久化，vision 里残留的
    // syncWithMain 标记不再有任何效果
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      schemaVersion: 2,
      multimodal: false,
      vision: { ...COMPLETE_VISION, syncWithMain: true },
    } as Partial<ModelSettings>);
    expect(s.multimodal).toBe(false);
    expect(s.schemaVersion).toBe(2);
  });

  it("schemaVersion: 2 且无 multimodal 字段 → 缺省 true，不被视觉模型配置旁路", () => {
    const s = normalizeModelSettings({
      ...MINIMAX_BASE,
      schemaVersion: 2,
      vision: COMPLETE_VISION,
    } as Partial<ModelSettings>);
    expect(s.multimodal).toBe(true);
  });
});
