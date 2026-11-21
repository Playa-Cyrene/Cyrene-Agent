import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureToolResultImageDirectory, parseToolResultImages } from "../orchestrator/tool-result-images";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";
import { createComputerTools, parseLocateReply, type ComputerToolDependencies, type ComputerViewing } from "./computer-tools";
import { EMERGENCY_STOP_REASON } from "./computer-use-permission";
import { ComputerHelperError } from "./helper-client";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const ctx: ToolContext = { userQuery: "", conversationId: "c1", runId: "r1", mode: "work" };

let directory: string;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-computer-tools-"));
  fs.writeFileSync(path.join(directory, "shot-1-1.png"), PNG);
  configureToolResultImageDirectory(directory);
});
afterEach(() => {
  configureToolResultImageDirectory(undefined);
  fs.rmSync(directory, { recursive: true, force: true });
});

function setup(options: {
  client?: Partial<ComputerToolDependencies["client"]>;
  viewing?: ComputerViewing;
  authorize?: ComputerToolDependencies["authorize"];
  vision?: string;
} = {}) {
  const client = {
    screenshot: vi.fn(async () => ({ fileName: "shot-1-1.png", width: 1568, height: 882, screenWidth: 2560, screenHeight: 1440 })),
    click: vi.fn(async () => undefined),
    typeText: vi.fn(async () => undefined),
    scroll: vi.fn(async () => undefined),
    ...options.client,
  };
  const order: string[] = [];
  const askVision = vi.fn(async () => options.vision ?? "前台是记事本，右上角有保存按钮。");
  const onScreenshotCaptured = vi.fn();
  const tools = createComputerTools({
    client,
    authorize: options.authorize ?? (async () => ({ ok: true })),
    resolveViewing: () => options.viewing ?? { mode: "direct", recipient: "主模型 m" },
    askVision,
    withOverlaysHidden: async (action) => {
      order.push("hide");
      try { return await action(); } finally { order.push("show"); }
    },
    onScreenshotCaptured,
  });
  const run = (id: string, args: Record<string, unknown> = {}, context: ToolContext = ctx) =>
    tools.find(tool => tool.id === id)!.execute(args, context);
  return { client, tools, run, askVision, order, onScreenshotCaptured };
}

describe("computer use 工具", () => {
  it("默认关闭、统一 input-control 风险，且只在 Work / Code 模式提供", () => {
    const { tools } = setup();
    expect(tools.map(tool => [tool.id, tool.enabled, tool.risk, tool.modes])).toEqual([
      ["computer_screenshot", false, "input-control", ["work", "code"]],
      ["computer_locate", false, "input-control", ["work", "code"]],
      ["computer_click", false, "input-control", ["work", "code"]],
      ["computer_type", false, "input-control", ["work", "code"]],
      ["computer_scroll", false, "input-control", ["work", "code"]],
    ]);
  });

  it("直发：截图结果能被工具结果图片解析器识别，并记到所属会话", async () => {
    const { tools, run, onScreenshotCaptured, order } = setup();
    const output = await run("computer_screenshot");
    expect(parseToolResultImages(tools[0], output)).toEqual([
      { fileName: "shot-1-1.png", mediaType: "image/png", width: 1568, height: 882 },
    ]);
    expect(onScreenshotCaptured).toHaveBeenCalledWith("c1", "shot-1-1.png");
    expect(order).toEqual(["hide", "show"]);
  });

  it("转述：截图交给视觉模型，主模型只收到文字，不带图片引用", async () => {
    const { tools, run, askVision } = setup({ viewing: { mode: "relay", recipient: "视觉模型 v" } });
    const output = await run("computer_screenshot");
    expect(parseToolResultImages(tools[0], output)).toBeUndefined();
    expect(output).toContain("视觉模型「视觉模型 v」的转述");
    expect(output).toContain("右上角有保存按钮");
    expect(askVision).toHaveBeenCalledWith({ base64: PNG.toString("base64"), mime: "image/png" }, expect.stringContaining("1568×882"));
  });

  it("两种方式都不可用时拒绝截图，不把桌面画面发出去", async () => {
    const { run, client } = setup({ viewing: { mode: "unavailable", reason: "请配置视觉模型。" } });
    expect(await run("computer_screenshot")).toBe("[错误·配置] 请配置视觉模型。");
    expect(client.screenshot).not.toHaveBeenCalled();
  });

  it("未授权时不截图、不点击", async () => {
    const { run, client } = setup({ authorize: async () => ({ ok: false, reason: "[拒绝] 未授权" }) });
    expect(await run("computer_screenshot")).toBe("[拒绝] 未授权");
    expect(await run("computer_click", { x: 1, y: 1 })).toBe("[拒绝] 未授权");
    expect(client.screenshot).not.toHaveBeenCalled();
    expect(client.click).not.toHaveBeenCalled();
  });

  it("没有截图时拒绝点击和滚动", async () => {
    const { run, client } = setup();
    expect(await run("computer_click", { x: 10, y: 10 })).toContain("请先调用 computer_screenshot");
    expect(await run("computer_scroll", { x: 10, y: 10, direction: "down" })).toContain("请先调用 computer_screenshot");
    expect(client.click).not.toHaveBeenCalled();
    expect(client.scroll).not.toHaveBeenCalled();
  });

  it("坐标系按会话隔离：另一个会话的截图不能当作本会话的参照", async () => {
    const { run, client } = setup();
    await run("computer_screenshot", {}, { ...ctx, conversationId: "other" });
    expect(await run("computer_click", { x: 10, y: 10 })).toContain("请先调用 computer_screenshot");
    expect(client.click).not.toHaveBeenCalled();
  });

  it("点击使用最近一次截图的尺寸作为坐标系，并在隐藏悬浮层期间执行", async () => {
    const { run, client, order } = setup();
    await run("computer_screenshot");
    expect(await run("computer_click", { x: 100, y: 200, button: "right", double: true })).toBe("已在 (100, 200) 双击。请重新截图确认结果。");
    expect(client.click).toHaveBeenCalledWith({ x: 100, y: 200, spaceWidth: 1568, spaceHeight: 882, button: "right", count: 2 });
    expect(order).toEqual(["hide", "show", "hide", "show"]);
  });

  it("滚动带方向和格数，默认 3 格", async () => {
    const { run, client } = setup();
    await run("computer_screenshot");
    expect(await run("computer_scroll", { x: 5, y: 6, direction: "down" })).toBe("已在 (5, 6) 向下滚动 3 格。请重新截图确认结果。");
    expect(client.scroll).toHaveBeenCalledWith({ x: 5, y: 6, spaceWidth: 1568, spaceHeight: 882, direction: "down", amount: 3 });
  });

  it.each([
    ["computer_click", { x: -1, y: 0 }],
    ["computer_click", { x: 1.5, y: 0 }],
    ["computer_click", { x: "10", y: 0 }],
    ["computer_click", { x: 1, y: 1, button: "middle" }],
    ["computer_click", { x: 1568, y: 0 }],
    ["computer_scroll", { x: 1, y: 1, direction: "diagonal" }],
    ["computer_scroll", { x: 1, y: 1, direction: "up", amount: 0 }],
    ["computer_scroll", { x: 1, y: 1, direction: "up", amount: 21 }],
  ])("拒绝无效参数 %s %j", async (id, args) => {
    const { run, client } = setup();
    await run("computer_screenshot");
    expect(await run(id, args)).toMatch(/^\[错误\]/);
    expect(client.click).not.toHaveBeenCalled();
    expect(client.scroll).not.toHaveBeenCalled();
  });

  it("目标窗口已提权时停止并让用户手动操作", async () => {
    const { run } = setup({ client: { click: vi.fn(async () => { throw new ComputerHelperError("ELEVATED_TARGET", "elevated"); }) } });
    await run("computer_screenshot");
    const output = await run("computer_click", { x: 1, y: 1 });
    expect(output).toContain("以管理员身份运行");
    expect(output).toContain("不要重试");
  });

  it("急停打断正在执行的动作时，告诉模型不要再调用桌面工具", async () => {
    const { run } = setup({ client: { typeText: vi.fn(async () => { throw new ComputerHelperError("EMERGENCY_STOP", ""); }) } });
    expect(await run("computer_type", { text: "你好" })).toBe(EMERGENCY_STOP_REASON);
  });

  it("拒绝空文本和超长文本，按字符统计长度", async () => {
    const { run, client } = setup();
    expect(await run("computer_type", { text: "" })).toBe("[错误] text 不能为空。");
    expect(await run("computer_type", { text: "字".repeat(4001) })).toContain("文本过长");
    expect(client.typeText).not.toHaveBeenCalled();
    expect(await run("computer_type", { text: "你好😀" })).toBe("已输入 3 个字符。请重新截图确认结果。");
  });

  describe("computer_locate", () => {
    it("高置信定位返回可交给 computer_click 的坐标", async () => {
      const { run } = setup({ viewing: { mode: "relay", recipient: "视觉模型 v" },
        vision: '{"found":true,"x":1500,"y":20,"confidence":"high","label":"保存"}' });
      await run("computer_screenshot");
      expect(await run("computer_locate", { target: "保存按钮" })).toContain("x=1500, y=20");
    });

    it("定位不确定时停下，不给坐标", async () => {
      const { run } = setup({ vision: '{"found":true,"x":1500,"y":20,"confidence":"low"}' });
      await run("computer_screenshot");
      const output = await run("computer_locate", { target: "保存按钮" });
      expect(output).toMatch(/^\[错误\]/);
      expect(output).toContain("不要猜坐标");
      expect(output).not.toContain("1500");
    });

    it("没有截图时不调用视觉模型", async () => {
      const { run, askVision } = setup();
      expect(await run("computer_locate", { target: "保存" })).toContain("请先调用 computer_screenshot");
      expect(askVision).not.toHaveBeenCalled();
    });
  });
});

describe("parseLocateReply", () => {
  it.each([
    ["不是 JSON", "没有按要求"],
    ['{"found":false,"reason":"看不到"}', "看不到"],
    ['{"found":true,"x":10,"y":10,"confidence":"medium"}', "不能确定"],
    ['{"found":true,"x":100,"y":10,"confidence":"high"}', "不在截图范围内"],
    ['{"found":true,"x":1.5,"y":10,"confidence":"high"}', "不在截图范围内"],
  ])("%s → 不算定位成功", (reply, reason) => {
    const result = parseLocateReply(reply, 100, 50);
    expect(result.found).toBe(false);
    expect(result.found === false && result.reason).toContain(reason);
  });

  it("容忍 JSON 前后的多余文字", () => {
    expect(parseLocateReply('结果：{"found":true,"x":3,"y":4,"confidence":"high","label":"OK"} 完毕', 100, 50))
      .toEqual({ found: true, x: 3, y: 4, label: "OK" });
  });
});
