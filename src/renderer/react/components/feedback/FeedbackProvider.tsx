// React 反馈适配层：基于 Ant Design Modal/message 复用成熟弹窗能力，
// 对外暴露与设置页 DOM 适配器一致的 FeedbackApi 语义（feedback-types.ts）。
// 阻塞弹窗按先进先出串行，组件卸载时自动收尾并恢复可解析状态。

import { CheckCircleOutlined, CloseCircleOutlined, InfoCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Modal, message } from "antd";
import * as React from "react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { FEEDBACK_NOTICE_DURATION_MS, FEEDBACK_NOTICE_MAX_COUNT, type AlertOptions, type ConfirmOptions, type FeedbackApi, type FeedbackTone } from "../../../shared/feedback-types";
import "./Feedback.css";

type ModalApi = ReturnType<typeof Modal.useModal>[0];

function toneIcon(tone: FeedbackTone): ReactNode {
  const icons: Record<FeedbackTone, ReactNode> = {
    success: <CheckCircleOutlined />,
    info: <InfoCircleOutlined />,
    warning: <WarningOutlined />,
    error: <CloseCircleOutlined />,
  };
  return icons[tone];
}

/** 错误信息弹窗内容：正文 + 折叠详情（与设置页弹窗同构） */
function FeedbackAlertContent({ message: text, details }: Pick<AlertOptions, "message" | "details">) {
  return (
    <div className="cy-feedback-alert__content">
      <p>{text}</p>
      {details ? <details><summary>查看详情</summary><pre>{details}</pre></details> : null}
    </div>
  );
}

/** 确认弹窗：返回 Promise<boolean>，注册幂等取消闭包供卸载收尾 */
function createConfirmPromise(
  modal: ModalApi,
  pending: Set<() => void>,
  options: ConfirmOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      pending.delete(cancel);
      resolve(value);
    };
    const cancel = () => settle(false);
    pending.add(cancel);
    modal.confirm({
      title: options.title,
      content: options.message,
      icon: toneIcon(options.tone ?? (options.dangerous ? "error" : "warning")),
      okText: options.confirmText ?? "确定",
      cancelText: options.cancelText ?? "取消",
      maskClosable: false,
      autoFocusButton: options.dangerous ? "cancel" : "ok",
      okButtonProps: options.dangerous ? { danger: true } : undefined,
      rootClassName: `cy-feedback-modal${options.dangerous ? " cy-feedback-modal--danger" : ""}`,
      onOk: () => settle(true),
      onCancel: cancel,
    });
  });
}

const FeedbackContext = createContext<FeedbackApi | null>(null);

export function useFeedback(): FeedbackApi {
  const api = useContext(FeedbackContext);
  if (!api) throw new Error("useFeedback 必须在 FeedbackProvider 内使用");
  return api;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [modal, modalHolder] = Modal.useModal();
  const [messageApi, messageHolder] = message.useMessage({ maxCount: FEEDBACK_NOTICE_MAX_COUNT });
  const pending = useRef(new Set<() => void>());
  const blockingTail = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);

  // 阻塞弹窗串行队列：单一 Promise 链，上一条关闭后才打开下一条。
  // 不做"空闲时同步打开"的优化——双状态（空闲标记 + 链尾）存在微任务竞态：
  // 调用方 await 当前弹窗后立即请求新弹窗，会抢在已排队的前一条之前打开。
  // 首条晚一个微任务打开无可感知影响，换来严格的先进先出保证。
  // 卸载后调用直接按取消收尾。
  const enqueueBlocking = useCallback(<T,>(open: () => Promise<T>, fallback: T): Promise<T> => {
    const run = () => mounted.current ? open() : Promise.resolve(fallback);
    const result = blockingTail.current.then(run, run);
    blockingTail.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const api = useMemo<FeedbackApi>(() => ({
    notice(options) {
      options.focusTarget?.focus();
      void messageApi.open({
        key: `${options.tone}:${options.message}`,
        type: options.tone,
        content: options.message,
        duration: (options.durationMs ?? FEEDBACK_NOTICE_DURATION_MS) / 1000,
        className: "cy-feedback-notice",
      });
    },
    alert(options) {
      return enqueueBlocking(() => new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) return;
          settled = true;
          pending.current.delete(settle);
          resolve();
        };
        pending.current.add(settle);
        modal.confirm({
          title: options.title,
          content: <FeedbackAlertContent message={options.message} details={options.details} />,
          icon: toneIcon(options.tone),
          cancelButtonProps: { style: { display: "none" } },
          okText: options.confirmText ?? "知道了",
          maskClosable: false,
          autoFocusButton: "ok",
          rootClassName: `cy-feedback-modal cy-feedback-modal--${options.tone}`,
          onOk: settle,
          onCancel: settle,
        });
      }), undefined);
    },
    confirm(options) {
      return enqueueBlocking(
        () => createConfirmPromise(modal, pending.current, options),
        false,
      );
    },
  }), [enqueueBlocking, messageApi, modal]);

  // 卸载收尾：未决弹窗按取消/结束解析，避免组件销毁后 Promise 悬挂
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const settle of pending.current) settle();
      pending.current.clear();
    };
  }, []);

  return <FeedbackContext.Provider value={api}>{messageHolder}{modalHolder}{children}</FeedbackContext.Provider>;
}
