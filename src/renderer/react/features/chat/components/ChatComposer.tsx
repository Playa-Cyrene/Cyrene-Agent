import { Sender } from "@ant-design/x";
import { Popover } from "antd";
import { useEffect, useRef, useState, type ClipboardEvent } from "react";
import { useTranslation } from "../../../i18n";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import { ContextUsageRing } from "./ContextUsageRing";
import { ReasoningControl } from "./ReasoningControl";
import { StyleControl } from "./StyleControl";
import { PermissionControl } from "./PermissionControl";
import { PlanModeToggle } from "./PlanModeToggle";
import { ModelSelector } from "./ModelSelector";
import chatWelcomeUrl from "../../../assets/welcome/chat.png?url";
import codeWelcomeUrl from "../../../assets/welcome/code.png?url";
import learnWelcomeUrl from "../../../assets/welcome/learn.png?url";
import workWelcomeUrl from "../../../assets/welcome/work.png?url";

interface ChatComposerProps {
  value: string;
  mode: string;
  docked: boolean;
  /** 当前会话 ID：用于上下文用量与计划模式状态。 */
  conversationId?: string;
  workspaceName?: string;
  /** 当前会话绑定的项目根路径：计划文件优先落到工作区 .cyrene/。 */
  workspaceRoot?: string;
  attachments: ComposerAttachment[];
  attachmentBusy?: boolean;
  modelBusy?: boolean;
  pendingQueue?: Array<{ id: string; content: string }>;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onQueueMessage?: (value: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onChooseWorkspace: () => void;
  onChooseFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onScreenshot: () => void;
  /** 粘贴图片（Ctrl+V 剪贴板含图片且无文本时触发）；由父级落临时文件并追加附件。 */
  onPasteImage?: (file: File) => void;
  onChooseSticker: (id: string) => void;
  activeModelProfileId?: string;
  onSelectModelProfile?: (id: string) => void;
  /** 上下文容量快照：运行中实时刷新，空闲时为最近一次终态快照；无快照不渲染圆环。 */
  contextUsage?: ContextUsageSnapshot;
}

export interface ComposerAttachment {
  name: string;
  kind: string;
  filePath?: string;
  mime?: string;
  previewUrl?: string;
  hasAnnotations?: boolean;
  caption?: string;
  status?: string;
  reason?: string;
  imageSendMode?: "direct" | "caption";
}

const WELCOME_IMAGE_BY_MODE: Record<string, string> = {
  chat: chatWelcomeUrl,
  code: codeWelcomeUrl,
  learn: learnWelcomeUrl,
  work: workWelcomeUrl,
};

/** 粘贴图片 MIME 白名单：与主进程截图临时文件的校验口径一致。 */
const PASTE_IMAGE_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function PlusIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>;
}

function ScreenshotIcon() {
  return (
    <svg className="cy-composer__screenshot-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M16 6H8C6.89543 6 6 6.89543 6 8V16" />
      <path d="M16 42H8C6.89543 42 6 41.1046 6 40V32" />
      <path d="M32 42H40C41.1046 42 42 41.1046 42 40V32" />
      <path d="M32 6H40C41.1046 6 42 6.89543 42 8V16" />
      <rect x="14" y="14" width="20" height="20" rx="2" />
    </svg>
  );
}

interface EnabledSticker {
  id: string;
  src: string;
  description?: string;
}

export function parseComposerMessage(mode: string, content: string): {
  rawContent: string;
  visibleContent: string;
  userSticker?: string;
} {
  const trimmed = content.trim();
  const stickerMatch = trimmed.match(/\[sticker:([^\]]+)\]/i);
  const visibleContent = trimmed.replace(/\[sticker:[^\]]+\]/gi, "").trim();
  if (mode === "code") {
    return { rawContent: visibleContent, visibleContent, userSticker: undefined };
  }
  return {
    rawContent: trimmed,
    visibleContent,
    userSticker: stickerMatch?.[1]?.trim() || undefined,
  };
}

function stickerUrl(src: string): string {
  return src.startsWith("/stickers/") ? resolveAsset(src) : src;
}

function StickerPicker({ onChoose }: { onChoose: (id: string) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [stickers, setStickers] = useState<EnabledSticker[]>([]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.chat?.getEnabledStickers?.().then((items) => {
      if (active) setStickers(items);
    }).catch(() => {
      if (active) setStickers([]);
    });
    return () => {
      active = false;
    };
  }, [open]);

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="topLeft"
      rootClassName="cy-sticker-popover"
      content={(
        <div className="cy-sticker-picker" aria-label={t("composer.stickerList")}>
          {stickers.length === 0 && <span className="cy-sticker-picker__empty">{t("composer.stickerEmpty")}</span>}
          {stickers.map((sticker) => (
            <button
              type="button"
              key={sticker.id}
              title={sticker.description ?? sticker.id}
              onClick={() => {
                onChoose(sticker.id);
                setOpen(false);
              }}
            >
              <img src={stickerUrl(sticker.src)} alt={sticker.description ?? sticker.id} draggable={false} />
            </button>
          ))}
        </div>
      )}
    >
      <button type="button" className="cy-composer__icon-button cy-composer__sticker-button" aria-label={t("composer.stickerPicker")} title={t("composer.stickerPicker")}>
        <img src={resolveAsset("icons/sticker-picker.png")} alt="" aria-hidden="true" draggable={false} />
      </button>
    </Popover>
  );
}

function FolderIcon() {
  return (
    <svg className="cy-composer__terminal-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5 8C5 6.89543 5.89543 6 7 6H19L24 12H41C42.1046 12 43 12.8954 43 14V40C43 41.1046 42.1046 42 41 42H7C5.89543 42 5 41.1046 5 40V8Z" />
      <path d="M14 22L19 27L14 32" />
      <path d="M26 32H34" />
    </svg>
  );
}

function CodeFolderIcon() {
  return (
    <svg className="cy-composer__code-folder-icon" width="24" height="24" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M43 23V14C43 12.8954 42.1046 12 41 12H24L19 6H7C5.89543 6 5 6.89543 5 8V40C5 41.1046 5.89543 42 7 42H22" />
      <path d="M38 29L43 34L38 39" />
      <path d="M30 29L25 34L30 39" />
    </svg>
  );
}

function ChevronIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>;
}

function ObsidianVaultIcon() {
  return (
    <svg className="cy-composer__obsidian-icon" height="1em" style={{ flex: "none", lineHeight: 1 }} viewBox="0 0 24 24" width="1em" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <title>Obsidian</title>
      <path d="M9.643 14.012c.615-.183 1.605-.465 2.745-.534-.684-1.725-.849-3.235-.716-4.579.153-1.552.7-2.847 1.234-3.95.114-.235.223-.454.328-.664.149-.297.289-.577.42-.86.217-.47.378-.885.46-1.27.08-.38.08-.719-.014-1.044-.095-.325-.297-.675-.681-1.06a1.6 1.6 0 00-1.475.36l-4.95 4.453a1.602 1.602 0 00-.512.952l-.427 2.83c.67.592 2.327 2.317 3.335 4.71.09.213.174.432.253.656zM5.855 9.937c-.024.1-.057.197-.099.29L3.14 16.058a1.602 1.602 0 00.313 1.772l4.117 4.24c2.102-3.102 1.795-6.02.835-8.3-.728-1.73-1.832-3.083-2.55-3.833z" fill="#A88BFA" />
      <path d="M8.52 22.57c.073.01.146.018.22.02.781.023 2.095.091 3.16.288.87.16 2.593.642 4.011 1.056 1.082.316 2.197-.548 2.354-1.664.115-.814.33-1.735.725-2.58l-.009.004c-.67-1.87-1.523-3.077-2.417-3.847a5.294 5.294 0 00-2.777-1.258c-1.541-.216-2.952.189-3.841.45.532 2.218.368 4.828-1.425 7.53z" fill="#A88BFA" />
      <path d="M19.676 18.538a69.072 69.072 0 001.858-2.952.811.811 0 00-.061-.901c-.516-.684-1.504-2.075-2.042-3.362-.554-1.323-.636-3.378-.64-4.378a1.708 1.708 0 00-.359-1.051L15.235 1.83a3.757 3.757 0 01-.076.545c-.107.503-.307 1.004-.536 1.498-.135.29-.29.601-.446.915-.105.21-.21.42-.31.626-.517 1.068-.998 2.227-1.132 3.59-.125 1.262.046 2.73.814 4.484.128.01.257.025.386.043a6.364 6.364 0 013.327 1.506c.916.79 1.743 1.921 2.414 3.5z" fill="#A88BFA" />
    </svg>
  );
}

export function ChatComposer({
  value,
  mode,
  docked,
  conversationId,
  workspaceName,
  workspaceRoot,
  attachments,
  attachmentBusy = false,
  modelBusy = false,
  pendingQueue = [],
  onChange,
  onSubmit,
  onCancel,
  onQueueMessage,
  onRemoveQueuedMessage,
  onChooseWorkspace,
  onChooseFiles,
  onRemoveAttachment,
  onScreenshot,
  onPasteImage,
  onChooseSticker,
  activeModelProfileId,
  onSelectModelProfile,
  contextUsage,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const supportsWorkFiles = ["work", "code"].includes(mode);
  const supportsObsidianLibrary = mode === "learn";
  const supportsPermission = supportsWorkFiles || supportsObsidianLibrary;
  const supportsPlanToggle = mode === "code";
  const supportsStyle = mode === "chat" || mode === "learn";
  const supportsStickers = mode !== "code";
  const welcomeImageUrl = WELCOME_IMAGE_BY_MODE[mode] ?? chatWelcomeUrl;
  const requiresWorkspace = supportsWorkFiles;
  const placeholder = mode === "chat"
    ? t("composer.placeholderChat")
    : requiresWorkspace && !workspaceName
      ? t("composer.placeholderTaskNoWorkspace")
      : t("composer.placeholderTask");
  const selectedStickerIds = supportsStickers ? [...value.matchAll(/\[sticker:([^\]]+)\]/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean) : [];
  const stickerOccurrences = new Map<string, number>();
  const selectedStickers = selectedStickerIds.map((id) => {
    const occurrence = stickerOccurrences.get(id) ?? 0;
    stickerOccurrences.set(id, occurrence + 1);
    return {
      id,
      occurrence,
      sticker: enabledStickers.find((item) => item.id === id),
    };
  }).filter((item): item is { id: string; occurrence: number; sticker: EnabledSticker } => Boolean(item.sticker));

  useEffect(() => {
    let active = true;
    void window.chat?.getEnabledStickers?.().then((items) => {
      if (active) setEnabledStickers(items);
    }).catch(() => {
      if (active) setEnabledStickers([]);
    });
    return () => {
      active = false;
    };
  }, []);

  const removeSelectedSticker = (id: string, targetIndex: number) => {
    let index = -1;
    const nextValue = value.replace(/\[sticker:([^\]]+)\]/gi, (marker, rawId: string) => {
      if (rawId.trim() !== id) return marker;
      index += 1;
      return index === targetIndex ? "" : marker;
    });
    onChange(nextValue.replace(/ {2,}/g, " ").trim());
  };

  const hasComposerHeader = attachments.length > 0 || selectedStickers.length > 0 || pendingQueue.length > 0;

  // Ctrl+V 粘贴图片：仅当剪贴板无 text/plain 且含白名单图片时才拦截默认粘贴行为——
  // 浏览器剪贴板常同时带 text/plain + image/png（复制网页富文本），
  // 粗暴拦截会把用户想粘的文字吃掉。大小/临时文件由父级 handlePastedImage 负责。
  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    if (!onPasteImage) return;
    const data = event.clipboardData;
    if (!data || Array.from(data.types).includes("text/plain")) return;
    const imageItem = Array.from(data.items).find((item) =>
      item.kind === "file" && PASTE_IMAGE_MIME_WHITELIST.has(item.type));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    onPasteImage(file);
  };

  return (
    <div className={`cy-composer-stack ${docked ? "is-docked" : "is-centered"}`}>
      {!docked && <img className="cy-composer-welcome" src={welcomeImageUrl} alt="" />}
      <div className="cy-composer-shell">
        <input
          ref={fileInputRef}
          className="cy-composer__file-input"
          type="file"
          accept=".txt,.md,.json,.csv,.log,.png,.jpg,.jpeg,.webp,.gif,.bmp"
          multiple
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            if (files.length > 0) onChooseFiles(files);
            event.currentTarget.value = "";
          }}
        />
        <Sender
        rootClassName="cy-composer"
        value={value}
        placeholder={modelBusy ? t("composer.placeholderBusy") : placeholder}
        // 不能用 loading 承载忙态：Sender 源码在 loading 时直接拦截 onSubmit 并把发送键
        // 换成内建停止键，运行中的排队入口会被整体切断。忙态改由 onSubmit 路由 + suffix
        // 自定义按钮表达，输入仍可编辑。
        // 运行中绝不禁用输入区：独立的停止按钮必须始终可点。
        disabled={!modelBusy && requiresWorkspace && !workspaceName}
        autoSize={{ minRows: 3, maxRows: 7 }}
        onChange={onChange}
        onCancel={onCancel}
        onPaste={handlePaste}
        onSubmit={(submitValue) => {
          // 空内容直接忽略：显式传 disabled=false 会让 Sender 内建的空值保护
          // （onSendDisabled）在 disabled 合并链中被短路，必须在路由入口自行拦截。
          if (!submitValue.trim()) return;
          // 忙闲路由：空闲正常发送；运行中加入当前会话的待发队列。
          // Shift+Enter 换行、输入法组合期间不提交，均由 Sender 内建键盘逻辑保证。
          if (modelBusy) {
            onQueueMessage?.(submitValue);
          } else {
            onSubmit(submitValue);
          }
        }}
        suffix={(actionNode, { components }) => {
          if (!modelBusy) return actionNode;
          // 运行中：发送键变为“加入待发队列”，旁边是独立的停止按钮。
          // LoadingButton 内建的 onCancelDisabled 是 !loading，本项目不再传 loading，
          // 必须显式 disabled={false} 才能保持停止键可点。
          return (
            <div className="cy-composer__busy-actions">
              <components.SendButton title={t("composer.queueSend")} aria-label={t("composer.queueSend")} />
              <components.LoadingButton title={t("composer.stopRun")} aria-label={t("composer.stopRun")} disabled={false} />
            </div>
          );
        }}
        header={hasComposerHeader ? (
          <div className="cy-composer__attachments" aria-label={t("composer.attachmentsLabel")}>
            {pendingQueue.length > 0 && (
              <div className="cy-composer__queue" aria-label={t("composer.queueLabel")}>
                {pendingQueue.map((item) => (
                  <div className="cy-composer__queue-item" key={item.id}>
                    <span className="cy-composer__queue-text" title={item.content}>{item.content.slice(0, 40)}{item.content.length > 40 ? "..." : ""}</span>
                    <button type="button" aria-label={t("composer.removeQueuedMessage")} onClick={() => onRemoveQueuedMessage?.(item.id)}>×</button>
                  </div>
                ))}
              </div>
            )}
            {attachments.map((attachment, index) => (
              <div className={`cy-composer__attachment ${attachment.kind === "image" && attachment.previewUrl ? "is-image" : ""}`} key={`${attachment.filePath ?? attachment.name}-${index}`}>
                {attachment.kind === "image" && attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" draggable={false} />
                ) : (
                  <span title={attachment.name}>{attachment.name}</span>
                )}
                <button type="button" aria-label={t("composer.removeAttachment", { name: attachment.name })} onClick={() => onRemoveAttachment(index)}>×</button>
              </div>
            ))}
            {selectedStickers.map(({ id, occurrence, sticker }) => (
              <div className="cy-composer__attachment cy-composer__attachment--sticker" key={`${id}-${occurrence}`}>
                <img src={stickerUrl(sticker.src)} alt={sticker.description ?? t("composer.stickerSelected")} draggable={false} />
                <button type="button" aria-label={t("composer.removeSticker")} onClick={() => removeSelectedSticker(id, occurrence)}>×</button>
              </div>
            ))}
          </div>
        ) : undefined}
        prefix={
          <div className="cy-composer__prefix-actions">
            <button
              type="button"
              className="cy-composer__icon-button"
              aria-label={t("composer.uploadFile")}
              title={t("composer.uploadFile")}
              disabled={attachmentBusy}
              onClick={() => fileInputRef.current?.click()}
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className="cy-composer__icon-button"
              aria-label={t("composer.screenshot")}
              title={t("composer.screenshotShortcut")}
              onClick={onScreenshot}
            >
              <ScreenshotIcon />
            </button>
            {supportsStickers && <StickerPicker onChoose={onChooseSticker} />}
          </div>
        }
        />
        <div className="cy-composer__footer">
        {supportsWorkFiles && (
          <button type="button" className="cy-composer__footer-button" aria-label={t("composer.workspaceChoose")} onClick={onChooseWorkspace}>
            {mode === "code" ? <CodeFolderIcon /> : <FolderIcon />}
            <span>{workspaceName ?? (docked ? t("composer.workspaceFolder") : t("composer.workspaceEnter"))}</span>
            <ChevronIcon />
          </button>
        )}
        {supportsObsidianLibrary && (
          <button type="button" className="cy-composer__footer-button" aria-label={t("composer.obsidianChoose")} onClick={onChooseWorkspace}>
            <ObsidianVaultIcon />
            <span>{workspaceName ?? t("composer.obsidianLibrary")}</span>
            <ChevronIcon />
          </button>
        )}
        {supportsPlanToggle && conversationId && (
          <PlanModeToggle conversationId={conversationId} workspaceRoot={workspaceRoot} />
        )}
        {supportsPlanToggle && conversationId && <span className="cy-composer__footer-separator" />}
        {supportsPermission && (
          <PermissionControl />
        )}
        {supportsStyle && <StyleControl />}
        {onSelectModelProfile && <ModelSelector activeProfileId={activeModelProfileId} onSelect={onSelectModelProfile} />}
        <span className="cy-composer__footer-spacer" />
        <ContextUsageRing usage={contextUsage} sessionId={conversationId} busy={modelBusy} />
        <ReasoningControl sessionId={conversationId} modelProfileId={activeModelProfileId} />
        </div>
      </div>
    </div>
  );
}
