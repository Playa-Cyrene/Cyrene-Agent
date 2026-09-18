// 渲染层统一反馈契约：设置页 DOM 适配器与 React 适配器共享的语义类型与默认值。
// 两端只共享类型和常量，不共享运行时组件。

/** 轻提示默认持续时间（毫秒） */
export const FEEDBACK_NOTICE_DURATION_MS = 3000;

/** 同一窗口最多同时显示的轻提示条数 */
export const FEEDBACK_NOTICE_MAX_COUNT = 3;

/** 反馈语义：成功 / 信息 / 警告 / 错误 */
export type FeedbackTone = "success" | "info" | "warning" | "error";

/** 非阻塞轻提示参数 */
export interface NoticeOptions {
  tone: FeedbackTone;
  message: string;
  durationMs?: number;
  /** 字段校验时需要同步聚焦的输入元素 */
  focusTarget?: { focus: () => void } | null;
}

/** 单按钮阻塞弹窗参数（长错误或包含下一步操作） */
export interface AlertOptions {
  tone: FeedbackTone;
  title: string;
  message: string;
  /** 纯文本技术详情，以折叠区域展示 */
  details?: string;
  confirmText?: string;
}

/** 双按钮确认弹窗参数（危险操作需要 dangerous） */
export interface ConfirmOptions {
  tone?: Exclude<FeedbackTone, "success">;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  dangerous?: boolean;
}

/** 两套适配器必须暴露的一致接口 */
export interface FeedbackApi {
  notice: (options: NoticeOptions) => void;
  alert: (options: AlertOptions) => Promise<void>;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}
