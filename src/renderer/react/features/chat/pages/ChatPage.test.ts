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

describe("ChatPage 首条消息暂存工作区绑定", () => {
  // 复现"新开对话 → 最近项目选了历史工作区 → 发消息却报未绑定工作区"：
  // 欢迎页暂存路径不验证目录存在，sendMessage 里 setWorkspace 失败（如目录已被
  // 移动/删除）时若静默跳过，消息仍会入队，随后被主进程派发守卫拒绝。
  const start = chatPageSource.indexOf("async function sendMessage(content: string)");
  const end = chatPageSource.indexOf("async function submitTextToSession", start);
  const sendMessageSource = chatPageSource.slice(start, end);

  it("sendMessage 中暂存工作区绑定必须存在失败分支", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(sendMessageSource).toContain("setWorkspace(");
  });

  it("绑定失败必须提示用户并中止发送，不得静默入队后由派发守卫拒绝", () => {
    // 失败分支：可见反馈（错误弹窗）+ 不继续入队（块级 return；按缩进区分回调内的 return next）
    expect(sendMessageSource).toMatch(
      /workspaceResult[\s\S]{0,1200}?\} else \{[\s\S]{0,600}?feedback\.alert\([\s\S]{0,800}?\n        return;/,
    );
  });

  it("欢迎页从最近项目选定工作区时必须验证目录可用，失效路径不得显示为已选上", () => {
    // selectRecentProject → applyWorkspaceSelection（最近项目与系统选择框共用落地
    // 路径）：选中即走主进程 validateWorkspacePath 验证；目录已消失时提示重选，
    // 而不是让 UI 显示"已选上"、等发消息才被派发守卫拒绝
    const selectionStart = chatPageSource.indexOf("async function applyWorkspaceSelection");
    const selectionEnd = chatPageSource.indexOf("async function createNewTask", selectionStart);
    const selectionSource = chatPageSource.slice(selectionStart, selectionEnd);
    expect(selectionStart).toBeGreaterThan(-1);
    expect(selectionEnd).toBeGreaterThan(selectionStart);
    expect(selectionSource).toMatch(/validateWorkspacePath\(/);
    // 验证失败必须阻断落地（不设置 workspaceNames、不暂存）
    expect(selectionSource).toMatch(
      /if \(!validated\?\.ok\) \{[\s\S]{0,400}?return;/,
    );
  });
});
