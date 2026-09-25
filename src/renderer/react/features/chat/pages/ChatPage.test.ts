import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chatPageSource = fs.readFileSync(fileURLToPath(new URL("./ChatPage.tsx", import.meta.url)), "utf8");
const runControllerSource = fs.readFileSync(fileURLToPath(new URL("./run/AgentRunController.ts", import.meta.url)), "utf8");

describe("ChatPage feedback", () => {
  it("统一反馈入口承接错误上报与确认流程，不残留浏览器默认弹窗", () => {
    expect(chatPageSource).toContain("useFeedback");
    // 错误上报与失败提示走轻提示 / 模态框
    expect(chatPageSource).toMatch(/feedback\.notice\(\{\s*tone:\s*"error"/);
    expect(chatPageSource).toMatch(/feedback\.alert\(\{/);
    expect(chatPageSource).toMatch(/feedback\.confirm\(\{/);
    // 破坏性选择走确认弹窗
    expect(chatPageSource).not.toContain("window.alert");
    expect(chatPageSource).not.toContain("window.confirm");
  });
});

describe("ChatPage 轨迹回退派发（CTA Phase 1）", () => {
  it("edit 派发 replace_user、regenerate 派发 keep_user，锚点保留原 user 消息 ID", () => {
    // restartLastChatTurn 接收必填 disposition：edit 传 replace_user，regenerate 传 keep_user
    expect(chatPageSource).toMatch(/restartLastChatTurn\(\s*[\w.]+,\s*[\w.]+,\s*"replace_user"/);
    expect(chatPageSource).toMatch(/restartLastChatTurn\(\s*[\w.]+,\s*[\w.]+,\s*"keep_user"/);
    // 派发 input 携带轨迹回退元数据：锚点 = 通过校验的原 user 消息 ID
    expect(chatPageSource).toMatch(/transcriptRewind:\s*\{\s*anchorUserTurnId:\s*expectedUserMessageId,\s*disposition,?\s*\}/);
  });

  it("桌面四模式的 run 入口只允许结构化 currentUser，不把完整 UI 历史作为输入", () => {
    expect(runControllerSource).toContain("currentUser");
    expect(runControllerSource).not.toMatch(/run\(\{[\s\S]*messages:/);
  });
});

describe("ChatPage 对话级模型切换接线", () => {
  it("发送入口先等待模型切换屏障，保证切完立刻发送读到的是新模型", () => {
    // sendMessage 第一件事即 await barrier()：不等任何 UI 反馈也要保证因果序
    expect(chatPageSource).toMatch(/async function sendMessage\(content: string\) \{[\s\S]{0,300}?await modelSwitcher\.barrier\(\);/);
  });

  it("切模型与切档案走同一 operation token 切换器，不各自直连 IPC", () => {
    expect(chatPageSource).toContain("createSessionModelSwitcher");
    expect(chatPageSource).toMatch(/onSelectSessionModel=\{\(model\) => \{[\s\S]{0,300}?modelSwitcher\.switchModel\(/);
    expect(chatPageSource).toMatch(/onSelectModelProfile=\{\(modelProfileId\) => \{[\s\S]{0,400}?modelSwitcher\.switchProfile\(/);
  });
});
