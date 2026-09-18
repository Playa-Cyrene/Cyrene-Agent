// read_image_url 工具缓存行为测试：同一 URL+同一问题 30 分钟内复用视觉描述，
// 错误描述不缓存。视觉链路全部 vi.mock 打桩，不发真实请求。

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../registry/tool-context";
import { clearImageCaptionCache, readImageUrlTool } from "./read-image-url-tool";
import { captionImage } from "../../vision-captioner";

// 视觉配置链路打桩：设置读取 → 路由判定 → 视觉调用
vi.mock("../../../settings/model-settings", () => ({
  loadModelSettings: () => ({}),
  resolveModelSettingsProfile: () => ({}),
}));
vi.mock("../../image-router", () => ({
  resolveCaptionVisionConfig: () => ({ ok: true, config: { model: "vision-test" } }),
}));
vi.mock("../../vision-captioner", () => ({
  captionImage: vi.fn(),
}));

const captionImageMock = vi.mocked(captionImage);

function ctxWith(query: string): ToolContext {
  return { userQuery: query } as ToolContext;
}

beforeEach(() => {
  clearImageCaptionCache();
  captionImageMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("read_image_url 结果缓存", () => {
  it("同 URL 同问题两次只调一次视觉模型，第二次带 [缓存] 标注", async () => {
    captionImageMock.mockResolvedValue("图里是一只趴着的橘猫。");

    const first = await readImageUrlTool.execute(
      { url: "https://cache-test.example.com/cat.jpg" },
      ctxWith("图里有什么"),
    );
    expect(first).toContain("橘猫");
    expect(first.startsWith("[缓存]")).toBe(false);

    const second = await readImageUrlTool.execute(
      { url: "https://cache-test.example.com/cat.jpg" },
      ctxWith("图里有什么"),
    );
    expect(captionImageMock).toHaveBeenCalledTimes(1);
    expect(second.startsWith("[缓存]")).toBe(true);
    expect(second).toContain("橘猫");
  });

  it("同 URL 不同问题分开调用（key 含 userQuery）", async () => {
    captionImageMock.mockResolvedValue("描述");

    await readImageUrlTool.execute({ url: "https://cache-test.example.com/pic.png" }, ctxWith("图里有什么"));
    await readImageUrlTool.execute({ url: "https://cache-test.example.com/pic.png" }, ctxWith("图里有几个人"));
    expect(captionImageMock).toHaveBeenCalledTimes(2);
  });

  it("错误描述不进缓存：第一次失败，第二次成功则正常返回", async () => {
    captionImageMock
      .mockResolvedValueOnce("[错误] 厂商拉不到这张图")
      .mockResolvedValueOnce("图是一片星空。");

    const first = await readImageUrlTool.execute(
      { url: "https://cache-test.example.com/sky.jpg" },
      ctxWith("图里是什么"),
    );
    expect(first.startsWith("[错误")).toBe(true);

    const second = await readImageUrlTool.execute(
      { url: "https://cache-test.example.com/sky.jpg" },
      ctxWith("图里是什么"),
    );
    expect(second).toContain("星空");
    expect(second.startsWith("[缓存]")).toBe(false);
  });
});
