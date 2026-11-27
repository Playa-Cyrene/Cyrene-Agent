import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const chatPageSource = fs.readFileSync(fileURLToPath(new URL("./ChatPage.tsx", import.meta.url)), "utf8");

it("列表撤回连接到会继续消费队列的流程入口", () => {
  expect(chatPageSource).toContain("onRemoveQueuedMessage={(id) => activeSessionId && void queueFlow.removeMessage(mode, activeSessionId, id)}");
});

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
    expect(chatPageSource).toMatch(/transcriptRewind:\s*\{\s*anchorUserTurnId:\s*expectedUserMessageId,\s*expectedAssistantMessageId,\s*disposition,?\s*\}/);
  });

});

describe("ChatPage 上下文压缩呼吸条接线", () => {
  it("订阅主进程推送的压缩阶段，并与手动压缩共用同一条尾部呼吸提示", () => {
    // 自动压缩发生在 run 开始前的主进程侧，渲染端没有 AG-UI 事件可听，只能订阅 IPC 推送
    expect(chatPageSource).toContain("onCompactionPhase");
    // 自动压缩只在本会话命中时才显示，避免切到别的会话还挂着呼吸条
    expect(chatPageSource).toMatch(/compacting=\{[^}]*autoCompactingSessionId === activeSessionId[^}]*\}/);
  });
});

describe("ChatPage 对话级模型切换接线", () => {
  it("切模型与切档案走同一 operation token 切换器，不各自直连 IPC", () => {
    expect(chatPageSource).toContain("createSessionModelSwitcher");
    expect(chatPageSource).toMatch(/onSelectSessionModel=\{\(model\) => \{[\s\S]{0,300}?modelSwitcher\.switchModel\(/);
    const profileSelectionStart = chatPageSource.indexOf("onSelectModelProfile={(modelProfileId) => {");
    const profileSelectionEnd = chatPageSource.indexOf("\n            }}", profileSelectionStart);
    const profileSelectionSource = chatPageSource.slice(profileSelectionStart, profileSelectionEnd);
    expect(profileSelectionStart).toBeGreaterThan(-1);
    expect(profileSelectionEnd).toBeGreaterThan(profileSelectionStart);
    expect(profileSelectionSource).toContain("modelSwitcher.switchProfile(activeSessionId, modelProfileId)");
    expect(profileSelectionSource).toContain("setPendingModelProfileByMode");
    expect(profileSelectionSource).toContain("delete next[mode]");
    expect(chatPageSource).toContain("setPendingSessionModelByMode((current) => ({ ...current, [mode]: model }))");
    expect(chatPageSource).toContain("store.setSessionModel(session.id, pendingSessionModel)");
  });
});

describe("后台结算失败的页面接线", () => {
  it("删除和现有会话换目录都显示可操作提示，绑定失败不更新目录名", () => {
    const selection = chatPageSource.slice(chatPageSource.indexOf("  async function applyWorkspaceSelection("), chatPageSource.indexOf("  async function chooseWorkspace()"));
    expect(selection).toContain("isShellCompletionSettlementPending(result.error)");
    expect(selection.indexOf("if (!result.ok)")).toBeLessThan(selection.indexOf("setWorkspaceNames"));
    const deletion = chatPageSource.slice(chatPageSource.indexOf("  async function handleDeleteSession("), chatPageSource.indexOf("  async function handleTogglePinSession("));
    expect(deletion).toContain("isShellCompletionSettlementPending(error)");
    expect(deletion).toContain('message: t("chatPage.backgroundSettlementPending")');
  });
});
