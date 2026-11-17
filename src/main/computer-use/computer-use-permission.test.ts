import { describe, expect, it, vi } from "vitest";
import type { AgentFileAccessLevel } from "../permission-policy";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";
import { ComputerUsePermission, EMERGENCY_STOP_REASON } from "./computer-use-permission";

const action = { screenshotRecipient: "主模型 m" };
const ctx = (overrides: Partial<ToolContext> = {}): ToolContext => ({ userQuery: "", conversationId: "c1", runId: "r1", mode: "work", ...overrides });

function setup(level: AgentFileAccessLevel = "full", answer: boolean | (() => Promise<boolean>) = true) {
  const requestSessionGrant = vi.fn(typeof answer === "function" ? answer : async () => answer);
  const permission = new ComputerUsePermission({ getLevel: () => level, requestSessionGrant });
  return { permission, requestSessionGrant };
}

describe("ComputerUsePermission", () => {
  it("full：每个会话首次使用时确认一次，同一会话后续动作不再询问", async () => {
    const { permission, requestSessionGrant } = setup("full");
    expect(await permission.authorize(ctx(), action)).toEqual({ ok: true });
    expect(await permission.authorize(ctx({ runId: "r2" }), action)).toEqual({ ok: true });
    expect(requestSessionGrant).toHaveBeenCalledTimes(1);
    expect(requestSessionGrant.mock.calls[0][0].description).toContain("主模型 m");
  });

  it("full：新会话重新询问", async () => {
    const { permission, requestSessionGrant } = setup("full");
    await permission.authorize(ctx(), action);
    await permission.authorize(ctx({ conversationId: "c2" }), action);
    expect(requestSessionGrant).toHaveBeenCalledTimes(2);
  });

  it("full：用户拒绝时不记住授权，下次仍会询问", async () => {
    const { permission, requestSessionGrant } = setup("full", false);
    expect((await permission.authorize(ctx(), action)).ok).toBe(false);
    expect((await permission.authorize(ctx(), action)).ok).toBe(false);
    expect(requestSessionGrant).toHaveBeenCalledTimes(2);
  });

  it("full：同一会话并发的首次调用只弹一次确认", async () => {
    let resolve!: (value: boolean) => void;
    const { permission, requestSessionGrant } = setup("full", () => new Promise<boolean>(r => { resolve = r; }));
    const first = permission.authorize(ctx(), action);
    const second = permission.authorize(ctx(), action);
    resolve(true);
    expect(await Promise.all([first, second])).toEqual([{ ok: true }, { ok: true }]);
    expect(requestSessionGrant).toHaveBeenCalledTimes(1);
  });

  it("per-action：每次审批已由通用权限层完成，这里不再追加会话确认", async () => {
    const { permission, requestSessionGrant } = setup("per-action");
    expect(await permission.authorize(ctx(), action)).toEqual({ ok: true });
    expect(requestSessionGrant).not.toHaveBeenCalled();
  });

  it.each(["scoped", "read-only", "project-read-only"] as const)("%s：禁用桌面工具", async (level) => {
    const { permission, requestSessionGrant } = setup(level);
    expect((await permission.authorize(ctx(), action)).ok).toBe(false);
    expect(requestSessionGrant).not.toHaveBeenCalled();
  });

  it.each([
    ["聊天模式", { mode: "chat" as const }],
    ["学习模式", { mode: "learn" as const }],
    ["allow_all 运行（渠道 / 定时任务）", { permissionMode: "allow_all" as const }],
    ["渠道运行", { channelRun: true as const }],
    ["只读子任务", { readOnly: true }],
    ["没有会话 ID", { conversationId: undefined }],
  ])("%s 拒绝，且不弹确认", async (_name, overrides) => {
    const { permission, requestSessionGrant } = setup("full");
    expect((await permission.authorize(ctx(overrides), action)).ok).toBe(false);
    expect(requestSessionGrant).not.toHaveBeenCalled();
  });

  it("无交互界面的运行不会弹出没人能看到的确认", async () => {
    const { permission, requestSessionGrant } = setup("full");
    expect((await permission.authorize(ctx({ allowUserInteraction: false }), action)).ok).toBe(false);
    expect(requestSessionGrant).not.toHaveBeenCalled();
  });

  it("急停撤销会话授权，急停时进行中的运行里排队的动作全部失败", async () => {
    const { permission, requestSessionGrant } = setup("full");
    await permission.authorize(ctx(), action);
    permission.emergencyStop();

    expect(await permission.authorize(ctx(), action)).toEqual({ ok: false, reason: EMERGENCY_STOP_REASON });
    expect(permission.isGranted("c1")).toBe(false);
    // 用户发起的新一轮运行重新询问授权。
    expect(await permission.authorize(ctx({ runId: "r2" }), action)).toEqual({ ok: true });
    expect(requestSessionGrant).toHaveBeenCalledTimes(2);
  });

  it("急停前发出、急停后才被同意的确认不会恢复授权", async () => {
    let resolve!: (value: boolean) => void;
    const { permission } = setup("full", () => new Promise<boolean>(r => { resolve = r; }));
    const pending = permission.authorize(ctx(), action);
    permission.emergencyStop();
    resolve(true);
    expect(await pending).toEqual({ ok: false, reason: EMERGENCY_STOP_REASON });
    expect(permission.isGranted("c1")).toBe(false);
  });
});
