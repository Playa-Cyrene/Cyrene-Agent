// 贴纸描述纯函数测试：解析优先级与模型侧文本组装。
// 设计：UI 展示图片，但模型侧只收到一段纯文本（用户原话 + internal_context 提示）。
import { describe, expect, it } from "vitest";
import { buildStickerUserModelText, resolveStickerPhrase } from "./sticker-descriptions";

describe("resolveStickerPhrase 贴纸自然语言解析", () => {
  it("用户自定义 phrases 优先，多条用顿号拼接，忽略空白项", () => {
    expect(resolveStickerPhrase("custom-1", {
      "custom-1": { phrases: ["开心", "  ", " 高兴 "], description: "被 description 覆盖前不应读到" },
    })).toBe("开心，高兴");
  });

  it("无 phrases 时回退用户 description", () => {
    expect(resolveStickerPhrase("custom-2", { "custom-2": { description: "摸鱼中" } })).toBe("摸鱼中");
  });

  it("非自定义贴纸回退内置描述", () => {
    expect(resolveStickerPhrase("HI")).toBe("嗨，想我了吗");
    expect(resolveStickerPhrase("playful", { "other": { description: "无关条目" } })).toBe("你看人家嘛");
  });

  it("未知贴纸回退 id：模型侧永远能看到一段纯文本", () => {
    expect(resolveStickerPhrase("unknown-x")).toBe("unknown-x");
  });
});

describe("buildStickerUserModelText 模型侧文本组装", () => {
  it("用户原话 + 系统提示式表情包说明，说明包在 internal_context 里", () => {
    expect(buildStickerUserModelText("帮我看看文件", "加油，你可以的")).toBe(
      "帮我看看文件\n\n<internal_context>用户发送表情包：加油，你可以的</internal_context>",
    );
  });

  it("纯表情包消息（无用户原话）只有提示本身", () => {
    expect(buildStickerUserModelText("   ", "来，抱抱你")).toBe(
      "<internal_context>用户发送表情包：来，抱抱你</internal_context>",
    );
  });
});
