// 桌面工具的授权策略（#328 确认的档位矩阵）：
//
// | 档位                 | 行为                                                         |
// |----------------------|--------------------------------------------------------------|
// | full                 | 每个会话首次使用时确认一次；新会话重新询问                   |
// | per-action           | 每次截图、点击、输入或滚动都单独询问（由通用 checkPermission 完成） |
// | scoped / 两个只读档  | 禁用                                                         |
//
// 通用权限层在 full 档位下对 input-control 直接放行，所以「每会话一次」只能在这里补上。
// 急停会撤销全部会话授权，并让急停时正在进行的运行里排队的桌面动作全部失败。

import type { AgentFileAccessLevel } from "../permission-policy";
import type { ToolContext } from "../orchestrator/tools/registry/tool-context";

export type ComputerUseDecision = { ok: true } | { ok: false; reason: string };

export interface ComputerUsePermissionDependencies {
  getLevel(): AgentFileAccessLevel;
  /** 弹出一次会话级授权确认；用户同意返回 true。 */
  requestSessionGrant(input: { conversationId: string; runId?: string; description: string }): Promise<boolean>;
}

export interface ComputerUseAction {
  /** 给用户看的授权说明里要写明截图会发给哪个模型。 */
  screenshotRecipient: string;
}

export const EMERGENCY_STOP_REASON =
  "[已急停] 用户按下了桌面操作的紧急停止快捷键，本次运行里的桌面动作已全部取消。" +
  "不要再调用任何 computer_* 工具，请告诉用户已停止，等待用户的下一步指示。";

export class ComputerUsePermission {
  /** full 档位下已经确认过的会话。 */
  private readonly grantedConversations = new Set<string>();
  /** 正在使用桌面工具的运行；急停时整体转入 stoppedRuns。 */
  private readonly activeRuns = new Set<string>();
  private readonly stoppedRuns = new Set<string>();
  /** 同一会话里并发的首次授权共用一次弹窗。 */
  private readonly pendingGrants = new Map<string, Promise<boolean>>();
  /** 急停计数：授权弹窗在急停前发出、急停后才被同意时，不能把授权重新放回去。 */
  private stopEpoch = 0;

  constructor(private readonly deps: ComputerUsePermissionDependencies) {}

  async authorize(ctx: ToolContext | undefined, action: ComputerUseAction): Promise<ComputerUseDecision> {
    if (ctx?.mode !== "work" && ctx?.mode !== "code") {
      return { ok: false, reason: "[错误·配置] 桌面操作只在工作模式和代码模式中可用。" };
    }
    const conversationId = ctx.conversationId;
    // 渠道、定时任务和插件代理以 allow_all 运行，桌面前没有人能确认，也没有人能按急停。
    if (!conversationId || ctx.permissionMode === "allow_all" || ctx.channelRun || ctx.readOnly) {
      return { ok: false, reason: "[错误·权限] 桌面操作只能在桌面端的前台会话里由用户授权后使用。" };
    }
    if (ctx.runId && this.stoppedRuns.has(ctx.runId)) return { ok: false, reason: EMERGENCY_STOP_REASON };

    const level = this.deps.getLevel();
    if (level === "per-action") {
      // 通用权限层已对每次调用单独询问。
      this.track(ctx.runId);
      return { ok: true };
    }
    if (level !== "full") {
      return {
        ok: false,
        reason: "[错误·权限] 当前权限档位不允许桌面操作。需要用户在「设置 → 昔涟 → 本地文件权限」切换到「每次审批」或「完全访问」。",
      };
    }
    if (!this.grantedConversations.has(conversationId)) {
      // 没有交互界面的运行弹出的确认没人能看到，只会让运行一直挂起。
      if (ctx.allowUserInteraction === false) {
        return { ok: false, reason: "[错误·权限] 本会话还没有授权桌面操作，而当前运行无法向用户请求授权。请回到会话里重新发起。" };
      }
      const epoch = this.stopEpoch;
      const granted = await this.requestGrant(conversationId, ctx.runId, action);
      if (epoch !== this.stopEpoch || (ctx.runId && this.stoppedRuns.has(ctx.runId))) {
        return { ok: false, reason: EMERGENCY_STOP_REASON };
      }
      if (!granted) return { ok: false, reason: "[拒绝] 用户没有授权本会话使用桌面操作。不要重试，请询问用户希望怎么继续。" };
      this.grantedConversations.add(conversationId);
    }
    this.track(ctx.runId);
    return { ok: true };
  }

  /** 急停：撤销所有会话授权，急停时正在使用桌面工具的运行不再允许任何桌面动作。 */
  emergencyStop(): void {
    this.stopEpoch++;
    this.grantedConversations.clear();
    for (const runId of this.activeRuns) this.stoppedRuns.add(runId);
    this.activeRuns.clear();
  }

  /** 关闭功能或删除会话时撤销授权。 */
  revoke(conversationId?: string): void {
    if (conversationId === undefined) this.grantedConversations.clear();
    else this.grantedConversations.delete(conversationId);
  }

  isGranted(conversationId: string): boolean {
    return this.grantedConversations.has(conversationId);
  }

  private track(runId: string | undefined): void {
    if (runId) this.activeRuns.add(runId);
  }

  private requestGrant(conversationId: string, runId: string | undefined, action: ComputerUseAction): Promise<boolean> {
    const pending = this.pendingGrants.get(conversationId);
    if (pending) return pending;
    const description =
      "允许本会话使用桌面操作：截取主显示器画面并发送给「" + action.screenshotRecipient + "」，" +
      "以及在桌面上点击、输入文本和滚动。授权只对本会话有效，新会话会重新询问；" +
      "按紧急停止快捷键可随时撤销。";
    const request = this.deps.requestSessionGrant({ conversationId, runId, description })
      .catch(() => false)
      .finally(() => this.pendingGrants.delete(conversationId));
    this.pendingGrants.set(conversationId, request);
    return request;
  }
}
