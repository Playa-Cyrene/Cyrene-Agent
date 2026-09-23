// 用户选择往返机制 —— 仿 permission.ts 的 requestApproval 模式。
// 工具执行中调 requestUserChoice()，阻塞等待用户在聊天卡片里选一个选项。
//
// 数据流：
//   工具 execute → requestUserChoice() → 通过回调发 CUSTOM 事件给渲染端
//   → 渲染端显示选项卡片 → 用户点选项 → invoke(IPC.CHOICE_RESOLVE) 回传
//   → main 查 pending map → resolve Promise → 工具拿到用户选择继续执行
//
// 回调注入模式（仿 weatherCardCallback）：main/index.ts 启动时注入一个
// (cardData) => void 回调，user-choice.ts 持有它，工具调用时触发。
// 这样避免直接 import electron/index.ts 造成循环依赖。

import { IPC } from "../shared/ipc-channels";
import { createIpcScope, type IpcScope } from "./application/ipc-scope";
import type {
  AskCardPayload,
  AskCardSubmission,
  AskClarificationCard,
  AskUserAnswer,
} from "../shared/ask-clarification";
import {
  publishAskCard,
  resolveAskCardSubmission,
  validateAskUserAnswer,
} from "./orchestrator/ask-card";
import { getTimeoutSettings } from "./timeout-manager";
import { createAbortError } from "./abort-utils";
import { toastEvents } from "./toast/toast-events";

const LOG_PREFIX = "[UserChoice]";
// 卡片等待超时统一取 timeout-settings：普通询问卡用 userChoiceTimeout（设置页「询问等待时间」可调，默认 60s），
// 审批卡（waitTimeoutTone="plan_approval"）用 planApprovalTimeout（默认 10 分钟，审批要通读计划）。

/** 选项结构。 */
export interface ChoiceOption {
  label: string;
  value: string;
  description?: string;
}

/** 发给渲染端的卡片数据。 */
export interface LegacyChoiceCardData {
  id: string;
  question: string;
  options: ChoiceOption[];
  default?: string;
}

export type ChoiceCardData = LegacyChoiceCardData | AskCardPayload;

export type ChoiceSettlementReason = "answered" | "timeout" | "unavailable" | "cancelled";

export interface ChoiceSettlement {
  id: string;
  /** 关联 runId；老版 requestUserChoice 无 run 上下文时缺省。 */
  runId?: string;
  revision: number;
  reason: ChoiceSettlementReason;
}

interface PendingChoice {
  resolve: (value: unknown) => boolean;
  reject?: (error: Error) => void;
  onSettled?: (settlement: ChoiceSettlement) => void;
  revision?: number;
  timer: NodeJS.Timeout;
  status: "open" | "resolving";
  /** 关联的 canonical runId，用于 cancelPendingChoicesForRun。 */
  runId?: string;
}

const pendingChoices = new Map<string, PendingChoice>();
let choiceCounter = 0;

/** 注入的卡片回调：由 index.ts 启动时设置，把 ChoiceCardData 包成 CUSTOM 事件发给渲染端。 */
let choiceCardSender: ((card: ChoiceCardData) => void) | null = null;

/** 注入的结算回调：由 index.ts 启动时设置，老版选择卡超时结算时通知渲染端清卡。 */
let choiceDismissSender: ((settlement: ChoiceSettlement) => void) | null = null;

/** index.ts 启动时调用，注入卡片发送回调。 */
export function setChoiceCardSender(sender: (card: ChoiceCardData) => void): void {
  choiceCardSender = sender;
}

/** index.ts 启动时调用，注入结算通知回调。 */
export function setChoiceDismissSender(sender: (settlement: ChoiceSettlement) => void): void {
  choiceDismissSender = sender;
}

/** 从两种卡片载荷里抽取统一身份：id 与单行摘要 */
function extractCardIdentity(card: ChoiceCardData): { cardId: string; intro: string } {
  if ("interactionId" in card) {
    return { cardId: card.interactionId, intro: card.intro };
  }
  return { cardId: card.id, intro: card.question };
}

/**
 * 发起一次用户选择请求，阻塞等待用户在聊天卡片里选一个选项。
 * 超时（userChoiceTimeout，默认 60s）返回 defaultValue 或空串，并广播 dismiss 让渲染端清卡。
 */
export function requestUserChoice(
  question: string,
  options: ChoiceOption[],
  defaultValue?: string,
): Promise<string> {
  return new Promise<string>((resolve) => {
    const id = "choice-" + (++choiceCounter) + "-" + Date.now();
    const choiceTimeout = getTimeoutSettings().userChoiceTimeout;

    const timer = setTimeout(() => {
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "选择超时（" + choiceTimeout + "ms），使用默认值:", defaultValue ?? "(空)");
      // 通知渲染端清卡：超时已用默认值结算，卡片再点也只会得到 ok:false
      choiceDismissSender?.({ id, revision: 1, reason: "timeout" });
      // 注意力提醒：超时结算通知 ToastService 清 toast
      toastEvents.publishChoiceDismiss({ cardId: id, revision: 1, reason: "timeout" });
      resolve(defaultValue ?? "");
    }, choiceTimeout);

    pendingChoices.set(id, {
      resolve: (value) => {
        resolve(typeof value === "string" ? value : defaultValue ?? "");
        // 注意力提醒：用户作答即结算，通知 ToastService 清 toast
        toastEvents.publishChoiceDismiss({ cardId: id, revision: 1, reason: "answered" });
        return true;
      },
      timer,
      status: "open",
      runId: undefined,
    });

    const payload: ChoiceCardData = { id, question, options, default: defaultValue };
    console.log(LOG_PREFIX, "发送选择请求:", id, question);

    if (choiceCardSender) {
      choiceCardSender(payload);
      // 注意力提醒：选择卡发布通知 ToastService
      toastEvents.publishChoiceCard({ ...extractCardIdentity(payload), revision: 1 });
    } else {
      // 没注入回调（理论上不会发生），直接返回默认值
      clearTimeout(timer);
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "未注入卡片回调，使用默认值");
      resolve(defaultValue ?? "");
    }
  });
}

export function requestUserClarification(
  card: AskClarificationCard,
  sender?: (card: ChoiceCardData) => void,
  onSettled?: (settlement: ChoiceSettlement) => void,
  identity: { runId: string; revision: number } = { runId: "legacy", revision: 1 },
): Promise<AskUserAnswer> {
  return new Promise<AskUserAnswer>((resolve, reject) => {
    const id = "choice-" + (++choiceCounter) + "-" + Date.now();
    const emptyAnswer: AskUserAnswer = { requestId: id, answers: [] };
    const publication = publishAskCard(card, { interactionId: id, ...identity });
    // 审批卡等待独立计时：planApprovalTimeout；普通询问卡维持快问快答配置
    const timeout = card.waitTimeoutTone === "plan_approval"
      ? getTimeoutSettings().planApprovalTimeout
      : getTimeoutSettings().userChoiceTimeout;
    // 结算统一出口：先通知调用方（渲染端清卡），再通知 ToastService 清 toast
    const notifySettled = (settlement: ChoiceSettlement): void => {
      onSettled?.(settlement);
      toastEvents.publishChoiceDismiss({
        cardId: settlement.id,
        runId: settlement.runId,
        revision: settlement.revision,
        reason: settlement.reason,
      });
    };
    const timer = setTimeout(() => {
      const pending = pendingChoices.get(id);
      if (!pending || pending.status !== "open") return;
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "澄清超时（" + timeout + "ms）");
      notifySettled({ id, ...identity, reason: "timeout" });
      resolve(emptyAnswer);
    }, timeout);
    pendingChoices.set(id, {
      resolve: (value) => {
        try {
          const submitted = value as Record<string, unknown> | null;
          const answer = submitted && typeof submitted === "object" && "interactionId" in submitted
            ? resolveAskCardSubmission(publication, value as AskCardSubmission)
            : validateAskUserAnswer(card, id, value as AskUserAnswer);
          resolve(answer);
          notifySettled({ id, ...identity, reason: "answered" });
          return true;
        } catch {
          return false;
        }
      },
      reject,
      onSettled: notifySettled,
      revision: identity.revision,
      timer,
      status: "open",
      runId: identity.runId,
    });
    console.log(LOG_PREFIX, "发送结构化澄清:", id);
    const cardSender = sender ?? choiceCardSender;
    if (cardSender) {
      cardSender(publication.payload);
      // 注意力提醒：结构化卡片发布通知 ToastService（计划流的去重互斥由其内部处理）
      toastEvents.publishChoiceCard({
        ...extractCardIdentity(publication.payload),
        runId: identity.runId,
        revision: identity.revision,
      });
    } else {
      clearTimeout(timer);
      pendingChoices.delete(id);
      console.warn(LOG_PREFIX, "未注入卡片回调，返回空澄清");
      notifySettled({ id, ...identity, reason: "unavailable" });
      resolve(emptyAnswer);
    }
  });
}

/** 注册 CHOICE_RESOLVE handler（core bootstrap 启动时调一次）。 */
export function registerChoiceIpc(ipcOption?: IpcScope): void {
  const ipc = ipcOption ?? createIpcScope();
  ipc.handle(IPC.CHOICE_RESOLVE, (
    _event,
    payload: { id: string; value?: string; answer?: AskUserAnswer | AskCardSubmission },
  ) => {
    const pending = pendingChoices.get(payload?.id);
    if (!pending || pending.status !== "open") {
      console.warn(LOG_PREFIX, "选择回传未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    pending.status = "resolving";
    const resolved = payload.answer ?? payload.value ?? "";
    console.log(LOG_PREFIX, "用户回答 payload:", JSON.stringify({ id: payload.id, hasAnswer: !!payload.answer, valueType: typeof payload.value, resolved: JSON.stringify(resolved).slice(0, 200) }));
    const accepted = pending.resolve(resolved);
    if (!accepted) {
      pending.status = "open";
      console.warn(LOG_PREFIX, "用户选择校验失败:", payload.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingChoices.delete(payload.id);
    console.log(LOG_PREFIX, "用户选择:", payload.id);
    return { ok: true };
  });
}

/**
 * 取消指定 runId 关联的所有 pending choice。
 * 在 AGUI_CANCEL abort signal 后调用，清理 ask_user 卡片的 pending 状态与 timer。
 * 渲染端通过 RUN_FINISHED(result.status="cancelled") 自然收到卡片关闭信号。
 */
export function cancelPendingChoicesForRun(runId: string): void {
  for (const [id, pending] of pendingChoices) {
    if (pending.runId === runId && pending.status === "open") {
      clearTimeout(pending.timer);
      pendingChoices.delete(id);
      pending.onSettled?.({ id, runId, revision: pending.revision ?? 1, reason: "cancelled" });
      pending.reject?.(createAbortError());
      console.log(LOG_PREFIX, "cancelPendingChoicesForRun 清理:", id, "runId=", runId);
    }
  }
}

