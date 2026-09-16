// read_image_url 测试：URL 校验 + 视觉路由门控 + URL 直传协议（不下载、不 base64）。
// captionImage 与 image-router 全部 mock，不发真实请求。

import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../../settings/model-settings", () => ({
  loadModelSettings: vi.fn(),
  resolveModelSettingsProfile: vi.fn(),
}));

vi.mock("../image-router", () => ({
  resolveCaptionVisionConfig: vi.fn(),
}));

vi.mock("../vision-captioner", () => ({
  captionImage: vi.fn(),
}));

import { readImageUrlTool } from "./builtin-tools/read-image-url-tool";
import { captionImage } from "../vision-captioner";
import { resolveCaptionVisionConfig } from "../image-router";
import type { ToolContext } from "./registry/tool-context";

const mockedCaption = vi.mocked(captionImage);
const mockedResolveCaptionVision = vi.mocked(resolveCaptionVisionConfig);

const FAKE_CONFIG = { baseUrl: "https://api.example.com/v1", apiKey: "k", model: "gpt-4o" };
const CTX: ToolContext = { userQuery: "这图里是什么" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("read_image_url 拒绝路径", () => {
  it("非 http(s) 协议拒绝", async () => {
    await expect(readImageUrlTool.execute({ url: "ftp://example.com/a.png" }, CTX))
      .resolves.toBe("[错误] url 必须以 http:// 或 https:// 开头");
    expect(mockedCaption).not.toHaveBeenCalled();
  });

  it("路由拒绝时返回配置错误（纯文本主模型 + 未配视觉模型）", async () => {
    mockedResolveCaptionVision.mockReturnValue({
      ok: false,
      error: "当前主模型不是多模态，且未配置独立视觉模型。请在「设置 → API 设置 → 视觉模型」中配置，或切换到多模态主模型。",
    });
    const result = await readImageUrlTool.execute({ url: "https://example.com/a.png" }, CTX);
    expect(result).toContain("[错误·配置]");
    expect(result).toContain("视觉模型");
    expect(mockedCaption).not.toHaveBeenCalled();
  });

  it("多模态 Anthropic 主模型未配视觉模型时明确拒绝（原为必然 404）", async () => {
    mockedResolveCaptionVision.mockReturnValue({
      ok: false,
      error: "主模型走 Anthropic 协议，工具读图需要 OpenAI 兼容的独立视觉模型。请在「设置 → API 设置 → 视觉模型」中配置。",
    });
    const result = await readImageUrlTool.execute({ url: "https://example.com/a.png" }, CTX);
    expect(result).toContain("Anthropic");
    expect(mockedCaption).not.toHaveBeenCalled();
  });
});

describe("read_image_url URL 直传", () => {
  it("以 { url } 形式调 captionImage，不走 base64", async () => {
    mockedResolveCaptionVision.mockReturnValue({ ok: true, config: FAKE_CONFIG });
    mockedCaption.mockResolvedValue("一只橘猫趴在键盘上");

    const result = await readImageUrlTool.execute(
      { url: "https://example.com/cat.png" },
      CTX,
    );

    expect(result).toBe("一只橘猫趴在键盘上");
    expect(mockedCaption).toHaveBeenCalledTimes(1);
    const [image, query, config] = mockedCaption.mock.calls[0];
    expect(image).toEqual({ url: "https://example.com/cat.png" });
    expect(image).not.toHaveProperty("base64");
    expect(query).toBe("这图里是什么");
    expect(config).toEqual(FAKE_CONFIG);
  });

  it("无 ToolContext 时 userQuery 回退空串", async () => {
    mockedResolveCaptionVision.mockReturnValue({ ok: true, config: FAKE_CONFIG });
    mockedCaption.mockResolvedValue("描述");

    await readImageUrlTool.execute({ url: "https://example.com/a.jpg" });

    expect(mockedCaption.mock.calls[0][1]).toBe("");
  });
});
