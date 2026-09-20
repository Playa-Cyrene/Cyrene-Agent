import { useEffect, useRef, useState, type DragEvent } from "react";
import type { ComposerAttachment } from "../components/ChatComposer";
import { t } from "../../../i18n";
import type { ScreenshotInsertPayload } from "../../../../../shared/ipc-channels";
import { arrayBufferToBase64, containsFiles, PASTE_IMAGE_MAX_BYTES } from "../pages/attachment-utils";
import { useFeedback } from "../../../components/feedback/FeedbackProvider";

/** window.chat 中附件链路用到的子集（桥模式：显式 cast，不依赖全局 Window 声明）。 */
interface ComposerChatApi {
  ingestDroppedFiles: (files: File[]) => Promise<ComposerAttachment[]>;
  saveScreenshotTemp: (base64: string, mime: string) => Promise<{ filePath: string }>;
  startScreenshot: () => Promise<{ ok: boolean; reason?: string } | undefined>;
  onScreenshotInsert: (callback: (data: ScreenshotInsertPayload) => void) => () => void;
  getImageSendStrategy: (sessionId: string) => Promise<{ mode: "direct" | "caption" }>;
  captionImage: (filePath: string, hasAnnotations: boolean) => Promise<{ ok: boolean; caption?: string; error?: string }>;
}

function composerChatApi(): ComposerChatApi | undefined {
  return (window as typeof window & { chat?: ComposerChatApi }).chat;
}

export interface ComposerDragHandlers {
  onDragEnter: (event: DragEvent<HTMLElement>) => void;
  onDragOver: (event: DragEvent<HTMLElement>) => void;
  onDragLeave: (event: DragEvent<HTMLElement>) => void;
  onDrop: (event: DragEvent<HTMLElement>) => void;
}

export interface ComposerAttachmentsApi {
  /** 当前 scope（会话 id 或 mode:xxx）的附件列表 */
  attachments: ComposerAttachment[];
  attachmentBusy: boolean;
  isDraggingFiles: boolean;
  chooseFiles: (files: File[]) => Promise<void>;
  handlePastedImage: (file: File) => Promise<void>;
  handleScreenshot: () => Promise<void>;
  removeAttachment: (index: number) => void;
  /** 消息落盘后的图片预处理：direct 直传 / caption 视觉描述，结果写回消息上的附件条目 */
  prepareImageAttachments: (sessionId: string, messageId: string, attachments: ComposerAttachment[]) => Promise<void>;
  /**
   * 消息入队确认成功后清理附件：只移除 sent 快照里的条目，空快照不清任何附件
   * （请求期间新加的保留；语音提交 keepComposer 场景不调用）。
   */
  clearScopeAttachments: (sent: ComposerAttachment[]) => void;
  /** 新建任务：删除整个 mode scope 的暂存附件 */
  deleteScopeAttachments: (scope: string) => void;
  dragHandlers: ComposerDragHandlers;
}

/**
 * Composer 附件子系统：按 scope（会话 id 或 mode:xxx）存储，
 * 覆盖选择文件、粘贴图片、截图按钮、拖拽投递、截图插入监听与图片发送预处理。
 * caption 结果写回消息卡片通过注入的 patchMessageAttachments 完成，附件域不直接持有消息状态。
 */
export function useComposerAttachments(input: {
  scopeKey: string;
  /** 读取当前激活 scope（读取 ref 的回调，供只订阅一次的截图插入监听使用） */
  getActiveScope: () => string;
  /** 消息域 patch 通道：direct/caption 结果写回消息上的附件条目 */
  patchMessageAttachments: (
    sessionId: string,
    messageId: string,
    updater: (attachments: ComposerAttachment[]) => ComposerAttachment[],
  ) => void;
}): ComposerAttachmentsApi {
  const { scopeKey, getActiveScope, patchMessageAttachments } = input;
  // 统一反馈入口：附件链路的失败/提示走非阻塞轻提示
  const feedback = useFeedback();
  const [attachmentsByScope, setAttachmentsByScope] = useState<Record<string, ComposerAttachment[]>>({});
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const dragDepthRef = useRef(0);
  const localPreviewUrlsRef = useRef(new Set<string>());

  // 卸载时释放本地 objectURL，防止泄漏
  useEffect(() => () => {
    for (const url of localPreviewUrlsRef.current) URL.revokeObjectURL(url);
    localPreviewUrlsRef.current.clear();
  }, []);

  // 截图工具落盘后由主进程推送插入事件：追加到当前激活 scope。
  // 只订阅一次；getActiveScope 在回调触发时读取最新 scope。
  useEffect(() => composerChatApi()?.onScreenshotInsert?.((data) => {
    const targetScope = getActiveScope();
    const attachment: ComposerAttachment = {
      kind: "image",
      name: t("chatPage.screenshotAttachmentName", { ts: Date.now() }),
      filePath: data.filePath,
      mime: data.mime,
      previewUrl: data.previewUrl,
      hasAnnotations: data.hasAnnotations,
    };
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: [...(current[targetScope] ?? []), attachment],
    }));
  }), []);

  async function chooseFiles(files: File[]) {
    const targetScope = scopeKey;
    const chat = composerChatApi();
    if (!chat || files.length === 0) return;
    setAttachmentBusy(true);
    const previewsByName = new Map<string, string[]>();
    for (const file of files) {
      if (!file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name)) continue;
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      previewsByName.set(file.name, [...(previewsByName.get(file.name) ?? []), previewUrl]);
    }
    try {
      const results = await chat.ingestDroppedFiles(files);
      if (results.length > 0) {
        const hydratedResults = results.map((attachment) => {
          if (attachment.kind !== "image") return attachment;
          const previews = previewsByName.get(attachment.name);
          const localPreview = previews?.shift();
          return localPreview ? { ...attachment, previewUrl: localPreview } : attachment;
        });
        setAttachmentsByScope((current) => ({
          ...current,
          [targetScope]: [...(current[targetScope] ?? []), ...hydratedResults],
        }));
      }
    } catch (error) {
      // 导入失败：简短失败反馈，非阻塞错误轻提示
      feedback.notice({ tone: "error", message: t("chatPage.ingestFilesFailed", { error: error instanceof Error ? error.message : String(error) }) });
    } finally {
      setAttachmentBusy(false);
    }
  }

  /**
   * Ctrl+V 粘贴图片：落主进程 screenshots/ 临时文件（复用截图链路），
   * 构造与按钮截图相同的 ComposerAttachment 追加进当前 scope。
   */
  async function handlePastedImage(file: File) {
    const targetScope = scopeKey;
    const chat = composerChatApi();
    if (!chat?.saveScreenshotTemp) return;
    if (file.size > PASTE_IMAGE_MAX_BYTES) {
      // 超大图片已跳过：提示性反馈，非阻塞警告轻提示
      feedback.notice({ tone: "warning", message: t("chatPage.pastedImageTooLargeSkipped") });
      return;
    }
    setAttachmentBusy(true);
    try {
      const base64 = arrayBufferToBase64(await file.arrayBuffer());
      const { filePath } = await chat.saveScreenshotTemp(base64, file.type);
      const previewUrl = URL.createObjectURL(file);
      localPreviewUrlsRef.current.add(previewUrl);
      const attachment: ComposerAttachment = {
        kind: "image",
        name: file.name && file.name !== "image.png" ? file.name : t("chatPage.pastedImageAttachmentName", { ts: Date.now() }),
        filePath,
        mime: file.type,
        previewUrl,
      };
      setAttachmentsByScope((current) => ({
        ...current,
        [targetScope]: [...(current[targetScope] ?? []), attachment],
      }));
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      const text = raw === "SCREENSHOT_TOO_LARGE"
        ? t("chatPage.pastedImageTooLarge")
        : raw === "INVALID_SCREENSHOT_IMAGE"
          ? t("chatPage.pastedImageInvalid")
          : t("chatPage.pastedImageFailed", { error: raw });
      // 粘贴失败：简短失败反馈，非阻塞错误轻提示
      feedback.notice({ tone: "error", message: text });
    } finally {
      setAttachmentBusy(false);
    }
  }

  /** 截图按钮：失败不再静默，按 reason 给可读提示。 */
  async function handleScreenshot() {
    const result = await composerChatApi()?.startScreenshot();
    if (!result || result.ok) return;
    const reason = typeof result.reason === "string" ? result.reason : "";
    let text: string;
    let tone: "info" | "error" = "error";
    if (reason.startsWith("HELPER_")) {
      text = t("chatPage.screenshotHelperNotReady");
    } else if (reason.startsWith("SCREENSHOT_CANCELLED")) {
      text = t("chatPage.screenshotCancelled");
      // 用户主动取消：信息性反馈而非错误
      tone = "info";
    } else if (reason === "SCREENSHOT_FILE_PATH_REQUIRED") {
      text = t("chatPage.screenshotFileMissing");
    } else {
      text = t("chatPage.screenshotFailed", { reason: reason || t("chatPage.unknownError") });
    }
    // 截图失败：非阻塞轻提示（取消为 info，其余为 error）
    feedback.notice({ tone, message: text });
  }

  async function prepareImageAttachments(
    sessionId: string,
    messageId: string,
    attachments: ComposerAttachment[],
  ) {
    const images = attachments.filter((attachment) => attachment.kind === "image" && attachment.filePath);
    const chat = composerChatApi();
    if (images.length === 0 || !chat) return;

    let strategy: { mode: "direct" | "caption" } = { mode: "caption" };
    try {
      // 传 sessionId：会话绑定的档案若声明 multimodal 则按档案裁决，否则回退全局
      strategy = await chat.getImageSendStrategy(sessionId);
    } catch (error) {
      console.warn("[Cyrene React] 获取图片发送策略失败，回退视觉描述:", error);
    }

    if (strategy.mode === "direct") {
      const paths = new Set(images.map((image) => image.filePath));
      patchMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
        paths.has(attachment.filePath)
          ? { ...attachment, imageSendMode: "direct", status: "done" }
          : attachment
      )));
      return;
    }

    for (const image of images) {
      patchMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? { ...attachment, imageSendMode: "caption", status: "processing" }
          : attachment
      )));
      let result: { ok: boolean; caption?: string; error?: string };
      try {
        result = await chat.captionImage(image.filePath!, image.hasAnnotations === true);
      } catch (error) {
        result = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      patchMessageAttachments(sessionId, messageId, (current) => current.map((attachment) => (
        attachment.filePath === image.filePath
          ? result.ok && result.caption
            ? { ...attachment, imageSendMode: "caption", status: "done", caption: result.caption, reason: undefined }
            : { ...attachment, imageSendMode: "caption", status: "error", reason: result.error ?? t("chatPage.imageCaptionFailed") }
          : attachment
      )));
    }
  }

  function removeAttachment(index: number) {
    const targetScope = scopeKey;
    setAttachmentsByScope((current) => ({
      ...current,
      [targetScope]: (current[targetScope] ?? []).filter((_, itemIndex) => itemIndex !== index),
    }));
  }

  /**
   * 消息入队确认成功后清理附件：只移除随消息提交的 sent 快照里的条目
   * （按 filePath/name 对账）。空快照（发送时本就没有附件）什么都不清——
   * 入队请求期间用户新加的附件必须保留，与草稿清理守卫同口径。
   */
  function clearScopeAttachments(sent: ComposerAttachment[]) {
    setAttachmentsByScope((current) => {
      if (sent.length === 0) return current;
      const sentKeys = new Set(sent.map((attachment) => attachment.filePath ?? attachment.name));
      return {
        ...current,
        [scopeKey]: (current[scopeKey] ?? []).filter(
          (attachment) => !sentKeys.has(attachment.filePath ?? attachment.name),
        ),
      };
    });
  }

  function deleteScopeAttachments(scope: string) {
    setAttachmentsByScope((current) => {
      const next = { ...current };
      delete next[scope];
      return next;
    });
  }

  function handleDragEnter(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handleDragLeave(event: DragEvent<HTMLElement>) {
    if (!containsFiles(event.dataTransfer)) return;
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    // 无条件拦截默认行为：即使拖入的不是文件（如 URL/富文本），也不允许窗口意外导航
    event.preventDefault();
    if (!containsFiles(event.dataTransfer)) return;
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) {
      void chooseFiles(files);
    } else {
      // 声称携带文件但实际为空（部分应用拖出的富内容）：给出提示而非静默丢弃
      feedback.notice({ tone: "warning", message: t("chatPage.dropNoFiles") });
    }
  }

  return {
    attachments: attachmentsByScope[scopeKey] ?? [],
    attachmentBusy,
    isDraggingFiles,
    chooseFiles,
    handlePastedImage,
    handleScreenshot,
    removeAttachment,
    prepareImageAttachments,
    clearScopeAttachments,
    deleteScopeAttachments,
    dragHandlers: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}