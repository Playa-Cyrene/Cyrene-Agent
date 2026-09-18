// @vitest-environment jsdom
// 功能测试：用 jsdom 模拟 DOM，实际运行 showHtmlModal/showInputModal/showModal
// 验证 MCP 面板自定义端点模态框的弹出 → 内容 → 关闭完整交互链路。

import { describe, it, expect, beforeEach } from "vitest";
import { showHtmlModal, showInputModal, showModal } from "../shared/modal";
import { modalState } from "../shared/modal-state";
import { CUSTOM_ENDPOINT_GUIDE_BODY } from "./panel";

// 重置全部 overlay / 队列状态，避免跨用例残留
function resetModalState(): void {
  modalState.cyOverlay = null;
  modalState.cyHtmlOverlay = null;
  modalState.cyInputOverlay = null;
  modalState.noticeContainer = null;
  modalState.blockingQueue = [];
  modalState.blockingActive = false;
  document.body.innerHTML = "";
}

describe("自定义端点接入说明模态框 - 完整交互", () => {
  beforeEach(() => {
    resetModalState();
  });

  it("调用 showHtmlModal 后 overlay 创建并显示（is-hidden 被移除）", async () => {
    void showHtmlModal({
      title: "模型服务接入说明",
      icon: '<svg width="22" height="22"></svg>',
      htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
    });

    const overlay = document.getElementById("cy-html-modal-overlay");
    expect(overlay).toBeTruthy();
    expect(overlay?.classList.contains("is-hidden")).toBe(false);
    expect(overlay?.querySelector(".cy-html-modal")?.getAttribute("role")).toBe("dialog");
    expect(overlay?.querySelector(".cy-html-modal")?.getAttribute("aria-modal")).toBe("true");
  });

  it("模态框标题和图标正确渲染", async () => {
    void showHtmlModal({
      title: "模型服务接入说明",
      icon: '<svg data-testid="guide-icon"></svg>',
      htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
    });

    const title = document.getElementById("cy-html-modal-title");
    expect(title?.textContent).toBe("模型服务接入说明");

    const icon = document.getElementById("cy-html-modal-icon");
    expect(icon?.innerHTML).toContain("<svg");
  });

  it("模态框 body 包含全部章节内容", async () => {
    void showHtmlModal({
      title: "测试",
      htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
    });

    const body = document.getElementById("cy-html-modal-body");
    // 官方云端模型章节
    expect(body?.innerHTML).toContain("官方云端模型");
    expect(body?.innerHTML).toContain("OpenAI、Claude、Kimi、DeepSeek、MiniMax、智谱 GLM");
    // 自定义端点高级章节
    expect(body?.innerHTML).toContain("自定义端点");
    expect(body?.innerHTML).toContain("OpenAI 或 Anthropic 兼容接口");
    // 边界警告
    expect(body?.innerHTML).toContain("本地模型与自定义端点不在官方技术支持范围内");
    expect(body?.innerHTML).toContain("系统不会扫描端口、探测模型或自动升级能力档位");
    // API Key 安全说明
    expect(body?.innerHTML).toContain("你的 API Key 仅存储在本地设备");
    expect(body?.innerHTML).toContain("不会上传至昔涟的服务器");
    // 三个 FAQ
    expect(body?.innerHTML).toContain("本地模型回复格式异常");
    expect(body?.innerHTML).toContain("MiniMax 思考模式失效");
    expect(body?.innerHTML).toContain("Claude 配置项比其他厂商少");
  });

  it("点击“知道了”按钮 → overlay 隐藏 → Promise resolve", async () => {
    const promise = showHtmlModal({
      title: "模型服务接入说明",
      htmlBody: CUSTOM_ENDPOINT_GUIDE_BODY,
    });

    const overlay = document.getElementById("cy-html-modal-overlay");
    expect(overlay?.classList.contains("is-hidden")).toBe(false);

    const confirmBtn = document.getElementById("cy-html-modal-confirm") as HTMLButtonElement;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn.textContent).toBe("知道了");

    confirmBtn.click();

    // Promise 应该 resolve（不抛异常即表示 resolve）
    await expect(promise).resolves.toBeUndefined();
    expect(overlay?.classList.contains("is-hidden")).toBe(true);
  });
});

describe("MCP Server 添加流程模态框 - 交互", () => {
  beforeEach(() => {
    resetModalState();
  });

  it("showInputModal 弹出输入框，点击确定返回输入值", async () => {
    const promise = showInputModal({
      title: "添加 MCP Server",
      message: "输入启动命令",
      placeholder: "node path\\to\\server.js",
    });

    const overlay = document.getElementById("cy-input-overlay");
    expect(overlay?.classList.contains("is-hidden")).toBe(false);

    const title = document.getElementById("cy-input-title");
    expect(title?.textContent).toBe("添加 MCP Server");

    const input = document.getElementById("cy-input-field") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(document.activeElement).toBe(input);
    input.value = "node C:\\mcp\\index.js --port 3000";

    const confirmBtn = document.getElementById("cy-input-confirm") as HTMLButtonElement;
    confirmBtn.click();

    const result = await promise;
    expect(result).toBe("node C:\\mcp\\index.js --port 3000");
    expect(overlay?.classList.contains("is-hidden")).toBe(true);
  });

  it("showInputModal 按 Enter 确认返回值", async () => {
    const promise = showInputModal({
      title: "MCP Server 名称",
      message: "给这个 MCP server 起个名字",
    });

    const input = document.getElementById("cy-input-field") as HTMLInputElement;
    input.value = "天气工具";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    const result = await promise;
    expect(result).toBe("天气工具");
  });

  it("showInputModal 按 Esc 取消返回 null", async () => {
    const promise = showInputModal({
      title: "测试",
      message: "输入",
    });

    const input = document.getElementById("cy-input-field") as HTMLInputElement;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const result = await promise;
    expect(result).toBeNull();
  });

  it("showInputModal 点击取消按钮返回 null", async () => {
    const promise = showInputModal({
      title: "测试",
      message: "输入",
    });

    const cancelBtn = document.getElementById("cy-input-cancel") as HTMLButtonElement;
    cancelBtn.click();

    const result = await promise;
    expect(result).toBeNull();
  });

  it("showModal 兼容入口映射为 warning 确认弹窗，点击确定返回 true", async () => {
    const promise = showModal({
      title: "提示",
      message: '"天气工具" 已连接，发现 5 个工具。详情见终端日志。',
    });

    const overlay = document.getElementById("cy-modal-overlay");
    expect(overlay?.classList.contains("is-hidden")).toBe(false);
    // 兼容入口默认落到 warning 色调的自绘弹窗，不再使用 emoji 图标
    expect(overlay?.querySelector(".cy-modal")?.className).toContain("cy-modal--warning");
    expect(overlay?.querySelector("#cy-modal-icon")?.innerHTML).toContain("<svg");
    expect(overlay?.querySelector("#cy-modal-icon")?.className).toContain("cy-modal__icon--warning");

    const msg = document.getElementById("cy-modal-message");
    expect(msg?.textContent).toContain("已连接，发现 5 个工具");

    const confirmBtn = document.getElementById("cy-modal-confirm") as HTMLButtonElement;
    confirmBtn.click();

    const result = await promise;
    expect(result).toBe(true);
    expect(overlay?.classList.contains("is-hidden")).toBe(true);
  });

  it("showModal 兼容入口点击取消返回 false", async () => {
    const promise = showModal({
      title: "添加失败",
      message: "启动命令无效（详情见终端日志）",
    });

    const cancelBtn = document.getElementById("cy-modal-cancel") as HTMLButtonElement;
    cancelBtn.click();

    const result = await promise;
    expect(result).toBe(false);
  });
});
