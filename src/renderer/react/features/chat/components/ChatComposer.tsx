import { Sender, Suggestion } from "@ant-design/x";
import { Popover } from "antd";
import { AlertTriangle, BookOpen, ChevronDown, ExternalLink, FolderOpen, Package, Plus, ScanLine } from "lucide-react";
import { Dialog } from "radix-ui";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from "react";
import { useTranslation } from "../../../i18n";
import { useUserCallPreference } from "../../../hooks/useUserNickname";
import { resolveAsset } from "../../../../../shared/renderer-base";
import type { BrowserElementSelection } from "../../../../../shared/browser-panel-types";
import type { ContextUsageSnapshot } from "../../../../../shared/context-usage";
import type { ModelFailureInfo } from "../../../../../shared/model-error";
import type { SkillSuggestionItem, SkillSuggestionMode } from "../../../../../shared/skill-suggestions";
import {
  filterSlashSkillSuggestions,
  getActiveSlashSkillToken,
  replaceActiveSlashSkillToken,
  type ActiveSlashSkillToken,
} from "./slashSkillSuggestions";
import { ContextUsageRing } from "./ContextUsageRing";
import { ReasoningControl } from "./ReasoningControl";
import { StyleControl } from "./StyleControl";
import { PermissionControl } from "./PermissionControl";
import { PlanModeToggle } from "./PlanModeToggle";
import { ModelSelector } from "./ModelSelector";
import { PendingQueueDock, type PendingQueueDockItem } from "./PendingQueueDock";
import chatWelcomeUrl from "../../../assets/welcome/chat.png?url";
import codeWelcomeUrl from "../../../assets/welcome/code.png?url";
import learnWelcomeUrl from "../../../assets/welcome/learn.png?url";
import workWelcomeUrl from "../../../assets/welcome/work.png?url";
import { FileIcon, hasFileIconMapping } from "./file-icon";
import { vscodeIconForFile } from "./vscodeFileIcon";

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
  /** 压缩状态机回调：透传给 ContextUsageRing，让消息流渲染「正在触发压缩」占位条。 */
  onCompactPhaseChange?: (phase: "idle" | "running" | "done" | "error") => void;
  pendingQueue?: PendingQueueDockItem[];
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
  onQueueMessage?: (value: string) => void;
  onRemoveQueuedMessage?: (id: string) => void;
  onEditQueuedMessage?: (id: string, content: string) => Promise<boolean>;
  onAdjustQueuedMessage?: (id: string) => Promise<boolean>;
  onChooseWorkspace: () => void;
  /** 最近绑定的项目文件夹：非空时点击按钮先弹出下拉复选，空则直接弹系统选择框。 */
  recentProjects?: string[];
  /** 下拉打开时刷新最近项目列表。 */
  onOpenRecentProjects?: () => void;
  /** 从最近项目下拉直接选定历史项目。 */
  onSelectRecentProject?: (projectPath: string) => void;
  onChooseFiles: (files: File[]) => void;
  onRemoveAttachment: (index: number) => void;
  onScreenshot: () => void;
  /** 粘贴图片（Ctrl+V 剪贴板含图片且无文本时触发）；由父级落临时文件并追加附件。 */
  onPasteImage?: (file: File) => void;
  /** 粘贴文件管理器复制的本地文件；路径由主进程从系统剪贴板读取。 */
  onPasteFiles?: () => void;
  onChooseSticker: (id: string) => void;
  activeModelProfileId?: string;
  onSelectModelProfile?: (id: string) => void;
  /** 当前会话或欢迎页暂存的模型值（子下拉据此解析当前项）。 */
  activeSessionModel?: string;
  /** 切换当前模型；无会话时由父级暂存选择。 */
  onSelectSessionModel?: (model: string) => void;
  /** 上下文容量快照：运行中实时刷新，空闲时为最近一次终态快照；无快照不渲染圆环。 */
  contextUsage?: ContextUsageSnapshot;
  mainModelFailure?: ModelFailureInfo;
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
  element?: BrowserElementSelection;
}

const WELCOME_IMAGE_BY_MODE: Record<string, string> = {
  chat: chatWelcomeUrl,
  code: codeWelcomeUrl,
  learn: learnWelcomeUrl,
  work: workWelcomeUrl,
};

const WELCOME_GREETING_BOUNDARY_HOURS = [5, 9, 12, 14, 18, 23] as const;
const SKILL_SUGGESTION_STATUS_VALUE = "__cyrene_skill_suggestion_status__";

function isSkillSuggestionMode(mode: string): mode is SkillSuggestionMode {
  return mode === "work" || mode === "code" || mode === "learn";
}

function slashSkillTokenKey(mode: string, value: string, token: ActiveSlashSkillToken): string {
  return `${mode}:${value.slice(token.start, token.end)}`;
}

function getWelcomeGreetingKey(date: Date) {
  const hour = date.getHours();
  if (hour >= 5 && hour < 9) return "composer.greetingMorningEarly";
  if (hour >= 9 && hour < 12) return "composer.greetingMorning";
  if (hour >= 12 && hour < 14) return "composer.greetingNoon";
  if (hour >= 14 && hour < 18) return "composer.greetingAfternoon";
  if (hour >= 18 && hour < 23) return "composer.greetingEvening";
  return "composer.greetingLateNight";
}

function getNextWelcomeGreetingDelayMs(date: Date) {
  const nextBoundary = WELCOME_GREETING_BOUNDARY_HOURS
    .map((hour) => {
      const boundary = new Date(date);
      boundary.setHours(hour, 0, 0, 0);
      return boundary;
    })
    .find((boundary) => boundary.getTime() > date.getTime());

  if (nextBoundary) return nextBoundary.getTime() - date.getTime();

  const tomorrowMorning = new Date(date);
  tomorrowMorning.setDate(tomorrowMorning.getDate() + 1);
  tomorrowMorning.setHours(WELCOME_GREETING_BOUNDARY_HOURS[0], 0, 0, 0);
  return tomorrowMorning.getTime() - date.getTime();
}

/** 粘贴图片 MIME 白名单：与主进程截图临时文件的校验口径一致。 */
const PASTE_IMAGE_MIME_WHITELIST = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

function ComposerAttachmentFileIcon({ fileName }: { fileName: string }) {
  const editorIcon = hasFileIconMapping(fileName) ? null : vscodeIconForFile(fileName);
  return editorIcon
    ? <img src={editorIcon} alt="" aria-hidden="true" draggable={false} className="cy-composer__attachment-icon" />
    : <FileIcon fileName={fileName} className="cy-composer__attachment-icon" />;
}

interface EnabledSticker {
  id: string;
  src: string;
  description?: string;
}

interface SkillSuggestionMenuItem {
  value: string;
  label: ReactNode;
  icon?: ReactNode;
  extra?: ReactNode;
  disabled?: boolean;
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
      arrow={false}
      rootClassName="cy-composer-menu-popover"
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

/** 工作文件夹按钮：有最近项目时点击弹出下拉（历史项目 + 选择其他文件夹），否则直接弹系统选择框。 */
function WorkspaceFolderButton({
  icon,
  label,
  ariaLabel,
  recentProjects,
  onOpenRecentProjects,
  onSelectRecentProject,
  onChooseWorkspace,
}: {
  icon: ReactNode;
  label: string;
  ariaLabel: string;
  recentProjects?: string[];
  onOpenRecentProjects?: () => void;
  onSelectRecentProject?: (projectPath: string) => void;
  onChooseWorkspace: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const projects = recentProjects ?? [];
  const showMenu = projects.length > 0 && Boolean(onSelectRecentProject);

  const button = (
    <button type="button" className="cy-composer__footer-button" aria-label={ariaLabel}
      onClick={showMenu ? undefined : onChooseWorkspace}>
      {icon}
      <span>{label}</span>
      <ChevronDown />
    </button>
  );
  if (!showMenu) return button;
  return (
    <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) onOpenRecentProjects?.(); }} trigger="click" placement="topLeft" arrow={false} rootClassName="cy-composer-menu-popover"
      content={
        <div className="cy-recent-projects__menu">
          {projects.map((projectPath) => {
            const folderName = projectPath.split(/[\\/]/).filter(Boolean).pop() ?? projectPath;
            return (
              <button type="button" key={projectPath} className="cy-recent-projects__item" title={projectPath}
                onClick={() => { setOpen(false); onSelectRecentProject?.(projectPath); }}>
                <strong>{folderName}</strong>
                <small>{projectPath}</small>
              </button>
            );
          })}
          <button type="button" className="cy-recent-projects__item cy-recent-projects__item--choose-other"
            onClick={() => { setOpen(false); onChooseWorkspace(); }}>
            {t("composer.chooseOtherFolder")}
          </button>
        </div>
      }>
      {button}
    </Popover>
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
  onCompactPhaseChange,
  pendingQueue = [],
  onChange,
  onSubmit,
  onCancel,
  onQueueMessage,
  onRemoveQueuedMessage,
  onEditQueuedMessage,
  onAdjustQueuedMessage,
  onChooseWorkspace,
  recentProjects,
  onOpenRecentProjects,
  onSelectRecentProject,
  onChooseFiles,
  onRemoveAttachment,
  onScreenshot,
  onPasteImage,
  onPasteFiles,
  onChooseSticker,
  activeModelProfileId,
  onSelectModelProfile,
  activeSessionModel,
  onSelectSessionModel,
  contextUsage,
  mainModelFailure,
}: ChatComposerProps) {
  const { t } = useTranslation();
  const preferredAddress = useUserCallPreference();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const compositionActiveRef = useRef(false);
  const latestComposerValueRef = useRef(value);
  const slashTokenRef = useRef<ActiveSlashSkillToken | null>(null);
  const slashOpenRef = useRef(false);
  const slashRequestIdRef = useRef(0);
  const slashSuppressedTokenKeyRef = useRef<string | null>(null);
  const selectedSkillForCloseRef = useRef<string | null>(null);
  const lastSkillModeRef = useRef(mode);
  const skillSuggestionsRef = useRef<SkillSuggestionItem[]>([]);
  const filteredSkillSuggestionsRef = useRef<SkillSuggestionItem[]>([]);
  const [activeSlashToken, setActiveSlashToken] = useState<ActiveSlashSkillToken | null>(null);
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestionItem[]>([]);
  const [skillSuggestionsLoading, setSkillSuggestionsLoading] = useState(false);
  const [slashSuggestionsOpen, setSlashSuggestionsOpen] = useState(false);
  const [activeSlashSuggestionIndex, setActiveSlashSuggestionIndex] = useState(0);
  const [welcomeGreetingDate, setWelcomeGreetingDate] = useState(() => new Date());
  const [enabledStickers, setEnabledStickers] = useState<EnabledSticker[]>([]);
  const supportsWorkFiles = ["work", "code"].includes(mode);
  const supportsObsidianLibrary = mode === "learn";
  // 会话开启且已绑定工作区即锁定：工作区按钮只作为"开始对话前"的选择入口，
  // 保留给未绑定会话仅作补救（换工作区 = 新开对话，避免运行中换绑与旧引用失效）
  const workspaceSelectable = !conversationId || !workspaceRoot;
  const supportsPermission = supportsWorkFiles || supportsObsidianLibrary;
  const supportsPlanToggle = mode === "code";
  const supportsStyle = mode === "chat" || mode === "learn";
  const supportsStickers = mode !== "code";
  const welcomeImageUrl = WELCOME_IMAGE_BY_MODE[mode] ?? chatWelcomeUrl;
  const welcomeGreeting = t(getWelcomeGreetingKey(welcomeGreetingDate), { name: preferredAddress });
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

  useEffect(() => {
    const timeout = window.setTimeout(() => setWelcomeGreetingDate(new Date()), getNextWelcomeGreetingDelayMs(welcomeGreetingDate));
    return () => window.clearTimeout(timeout);
  }, [welcomeGreetingDate]);

  const removeSelectedSticker = (id: string, targetIndex: number) => {
    let index = -1;
    const nextValue = value.replace(/\[sticker:([^\]]+)\]/gi, (marker, rawId: string) => {
      if (rawId.trim() !== id) return marker;
      index += 1;
      return index === targetIndex ? "" : marker;
    });
    onChange(nextValue.replace(/ {2,}/g, " ").trim());
  };

  const hasComposerHeader = attachments.length > 0 || selectedStickers.length > 0;

  latestComposerValueRef.current = value;

  const getComposerTextarea = () => fileInputRef.current?.parentElement?.querySelector("textarea") ?? null;

  const closeSkillSuggestions = (suppressCurrentToken: boolean) => {
    const token = slashTokenRef.current;
    if (suppressCurrentToken && token) {
      slashSuppressedTokenKeyRef.current = slashSkillTokenKey(mode, latestComposerValueRef.current, token);
    }
    slashRequestIdRef.current += 1;
    slashOpenRef.current = false;
    setSlashSuggestionsOpen(false);
    setSkillSuggestionsLoading(false);
  };

  const synchronizeSlashSkillToken = (
    nextValue: string,
    selectionStart?: number,
    selectionEnd?: number,
  ) => {
    latestComposerValueRef.current = nextValue;
    if (!isSkillSuggestionMode(mode) || compositionActiveRef.current) {
      slashTokenRef.current = null;
      setActiveSlashToken(null);
      closeSkillSuggestions(false);
      return;
    }

    const textarea = getComposerTextarea();
    const start = selectionStart ?? textarea?.selectionStart ?? nextValue.length;
    const end = selectionEnd ?? textarea?.selectionEnd ?? start;
    const previousToken = slashTokenRef.current;
    const token = getActiveSlashSkillToken(nextValue, start, end);
    slashTokenRef.current = token;
    setActiveSlashToken(token);

    if (!token) {
      slashSuppressedTokenKeyRef.current = null;
      setActiveSlashSuggestionIndex(0);
      closeSkillSuggestions(false);
      return;
    }

    const tokenKey = slashSkillTokenKey(mode, nextValue, token);
    if (previousToken && slashSkillTokenKey(mode, nextValue, previousToken) !== tokenKey) {
      setActiveSlashSuggestionIndex(0);
    }
    if (slashSuppressedTokenKeyRef.current === tokenKey) {
      closeSkillSuggestions(false);
      return;
    }
    if (slashOpenRef.current) return;

    slashOpenRef.current = true;
    setSlashSuggestionsOpen(true);
    setSkillSuggestionsLoading(true);
    setSkillSuggestions([]);
    skillSuggestionsRef.current = [];
    setActiveSlashSuggestionIndex(0);
    const requestId = ++slashRequestIdRef.current;
    const request = window.chat?.getSkillSuggestions?.(mode);
    if (!request) {
      setSkillSuggestionsLoading(false);
      return;
    }
    void request.then((items) => {
      if (requestId !== slashRequestIdRef.current || !slashOpenRef.current) return;
      skillSuggestionsRef.current = items;
      setSkillSuggestions(items);
    }).catch(() => {
      if (requestId !== slashRequestIdRef.current || !slashOpenRef.current) return;
      skillSuggestionsRef.current = [];
      setSkillSuggestions([]);
    }).finally(() => {
      if (requestId === slashRequestIdRef.current) setSkillSuggestionsLoading(false);
    });
  };

  const filteredSkillSuggestions = useMemo(
    () => filterSlashSkillSuggestions(skillSuggestions, activeSlashToken?.query ?? ""),
    [activeSlashToken?.query, skillSuggestions],
  );
  filteredSkillSuggestionsRef.current = filteredSkillSuggestions;

  const slashSuggestionItems = useMemo<SkillSuggestionMenuItem[]>(() => {
    if (skillSuggestionsLoading) {
      return [{
        value: SKILL_SUGGESTION_STATUS_VALUE,
        disabled: true,
        label: <span className="cy-skill-suggestion__status">{t("composer.skillSuggestionLoading")}</span>,
      }];
    }
    if (filteredSkillSuggestions.length === 0) {
      return [{
        value: SKILL_SUGGESTION_STATUS_VALUE,
        disabled: true,
        label: <span className="cy-skill-suggestion__status">{t("composer.skillSuggestionEmpty")}</span>,
      }];
    }
    return filteredSkillSuggestions.map((skill) => ({
      value: skill.id,
      label: (
        <span className="cy-skill-suggestion__label">
          <strong>{skill.name || skill.id}</strong>
          <small>/{skill.id}{skill.description ? ` · ${skill.description}` : ""}</small>
        </span>
      ),
      icon: <Package size={15} aria-hidden="true" />,
      extra: (
        <span className="cy-skill-suggestion__source">
          {t(skill.source === "user" ? "composer.skillSuggestionSourceUser" : "composer.skillSuggestionSourceBuiltin")}
        </span>
      ),
    }));
  }, [filteredSkillSuggestions, skillSuggestionsLoading, t]);

  const applySkillSuggestion = (skillId: string, selectedFromMenu: boolean) => {
    const skill = skillSuggestionsRef.current.find((item) => item.id === skillId);
    const token = slashTokenRef.current;
    if (!skill || !token) return;

    const currentValue = latestComposerValueRef.current;
    const completion = replaceActiveSlashSkillToken(currentValue, token, skill.id);
    selectedSkillForCloseRef.current = selectedFromMenu ? skill.id : null;
    slashSuppressedTokenKeyRef.current = slashSkillTokenKey(mode, completion.value, {
      start: token.start,
      end: token.start + skill.id.length + 1,
      query: skill.id,
    });
    slashTokenRef.current = null;
    setActiveSlashToken(null);
    closeSkillSuggestions(false);
    onChange(completion.value);
    window.requestAnimationFrame(() => {
      const textarea = getComposerTextarea();
      if (!textarea) return;
      textarea.focus();
      textarea.setSelectionRange(completion.cursor, completion.cursor);
    });
  };

  const handleSkillSuggestionsOpenChange = (open: boolean) => {
    if (!open) {
      const selectedSkillId = selectedSkillForCloseRef.current;
      selectedSkillForCloseRef.current = null;
      if (selectedSkillId) {
        slashSuppressedTokenKeyRef.current = `${mode}:/${selectedSkillId}`;
      } else {
        const token = slashTokenRef.current;
        if (token) slashSuppressedTokenKeyRef.current = slashSkillTokenKey(mode, latestComposerValueRef.current, token);
      }
      closeSkillSuggestions(false);
      return;
    }
    slashOpenRef.current = true;
    setSlashSuggestionsOpen(true);
  };

  const handleComposerValueChange = (nextValue: string, event?: { target?: EventTarget | null }) => {
    const target = event?.target as HTMLTextAreaElement | undefined;
    onChange(nextValue);
    synchronizeSlashSkillToken(nextValue, target?.selectionStart, target?.selectionEnd);
  };

  useEffect(() => {
    if (lastSkillModeRef.current !== mode) {
      lastSkillModeRef.current = mode;
      slashTokenRef.current = null;
      closeSkillSuggestions(false);
    }
    const textarea = getComposerTextarea();
    synchronizeSlashSkillToken(value, textarea?.selectionStart, textarea?.selectionEnd);
    // Value and mode are the controlled inputs; the latest textarea selection is read after render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, value]);

  // Sender 的 onKeyDown 声明在 Element 层级；函数体只用基类属性，参数随组件声明放宽
  const handleSenderKeyDown = (
    event: KeyboardEvent<Element>,
    suggestionKeyDown?: (event: KeyboardEvent<Element>) => void,
  ) => {
    const nativeEvent = event.nativeEvent as globalThis.KeyboardEvent;
    const composing = compositionActiveRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;
    const hasModifier = event.shiftKey || event.ctrlKey || event.altKey || event.metaKey;
    if (slashOpenRef.current && !composing && (event.key !== "Enter" || !hasModifier)) {
      suggestionKeyDown?.(event);
    }
    if (slashOpenRef.current && !composing && event.key === "Enter" && !hasModifier) {
      event.preventDefault();
      const skill = filteredSkillSuggestionsRef.current[activeSlashSuggestionIndex];
      if (skill) applySkillSuggestion(skill.id, false);
      return false;
    }
    if (slashOpenRef.current && !composing && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const count = Math.max(filteredSkillSuggestionsRef.current.length, 1);
      setActiveSlashSuggestionIndex((current) => (current + (event.key === "ArrowDown" ? 1 : count - 1)) % count);
    }
    if (!modelBusy || event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
    if (composing) return;
    event.preventDefault();
    if (value.trim()) onQueueMessage?.(value);
    // Sender 会先调用 onKeyDown；返回 false 可阻止它继续执行内建提交逻辑。
    return false;
  };

  // Ctrl+V 粘贴图片：仅当剪贴板无 text/plain 且含白名单图片时才拦截默认粘贴行为——
  // 浏览器剪贴板常同时带 text/plain + image/png（复制网页富文本），
  // 粗暴拦截会把用户想粘的文字吃掉。大小/临时文件由父级 handlePastedImage 负责。
  const handlePaste = (event: ClipboardEvent<HTMLElement>) => {
    const data = event.clipboardData;
    if (!data) return;
    const types = Array.from(data.types);
    const hasPlainText = types.includes("text/plain");
    const uriList = types.includes("text/uri-list") ? data.getData("text/uri-list") : "";
    const hasFileUri = uriList.split(/\r?\n/).some((line) => line.trim().toLowerCase().startsWith("file://"));
    const clipboardFiles = Array.from(data.files);
    const hasImageFileItem = Array.from(data.items).some((item) => item.kind === "file" && item.type.startsWith("image/"));

    // 文件管理器复制的本地文件使用系统 URI 列表；路径由主进程安全读取。
    if (onPasteFiles && (
      hasFileUri
      || (types.includes("text/uri-list") && !hasPlainText && !hasImageFileItem)
      || (types.includes("Files") && clipboardFiles.length === 0 && !hasImageFileItem)
    )) {
      event.preventDefault();
      onPasteFiles();
      return;
    }

    const itemFiles = clipboardFiles.length > 0
      ? clipboardFiles
      : Array.from(data.items)
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => file !== null);
    const nonImageFiles = itemFiles.filter((file) =>
      !file.type.startsWith("image/") && !/\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name));
    if (nonImageFiles.length > 0) {
      event.preventDefault();
      onChooseFiles(itemFiles);
      return;
    }

    if (!onPasteImage || hasPlainText) return;
    const imageItem = Array.from(data.items).find((item) =>
      item.kind === "file" && PASTE_IMAGE_MIME_WHITELIST.has(item.type));
    if (!imageItem) return;
    const file = imageItem.getAsFile();
    if (!file) return;
    event.preventDefault();
    onPasteImage(file);
  };

  const handleCompositionEndCapture = () => {
    compositionActiveRef.current = false;
    window.requestAnimationFrame(() => {
      const textarea = getComposerTextarea();
      synchronizeSlashSkillToken(
        textarea?.value ?? latestComposerValueRef.current,
        textarea?.selectionStart,
        textarea?.selectionEnd,
      );
    });
  };

  return (
    <div
      className={`cy-composer-stack ${docked ? "is-docked" : "is-centered"}`}
      onCompositionStartCapture={() => { compositionActiveRef.current = true; }}
      onCompositionEndCapture={handleCompositionEndCapture}
      onMouseUpCapture={(event) => {
        const textarea = getComposerTextarea();
        if (event.target !== textarea || !textarea) return;
        synchronizeSlashSkillToken(textarea.value, textarea.selectionStart, textarea.selectionEnd);
      }}
    >
      {!docked && <img className="cy-composer-welcome" src={welcomeImageUrl} alt="" />}
      {!docked && (
        <div className="cy-composer-greeting">
          <p className="cy-composer-greeting__text">{welcomeGreeting}</p>
        </div>
      )}
      <PendingQueueDock
        items={pendingQueue}
        adjustmentAvailable={modelBusy}
        onEdit={onEditQueuedMessage}
        onAdjust={onAdjustQueuedMessage}
        onRemove={onRemoveQueuedMessage}
      />
      {mainModelFailure && <ModelFailureNotice failure={mainModelFailure} />}
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
        <Suggestion
        open={slashSuggestionsOpen}
        onOpenChange={handleSkillSuggestionsOpenChange}
        items={slashSuggestionItems}
        onSelect={(skillId) => applySkillSuggestion(skillId, true)}
        popupAlign={{ points: ["bc", "tc"] }}
        block
        rootClassName="cy-skill-suggestion"
        classNames={{ content: "cy-skill-suggestion__content", popup: "cy-skill-suggestion__popup" }}
        >
        {({ onKeyDown: handleSuggestionKeyDown }) => (
        <Sender
        rootClassName="cy-composer"
        value={value}
        placeholder={modelBusy ? t("composer.placeholderBusy") : placeholder}
        // 忙态使用 Sender 自带的停止按钮；Enter 入队由 onKeyDown 在内建提交前处理。
        loading={modelBusy}
        disabled={!modelBusy && requiresWorkspace && !workspaceName}
        autoSize={{ minRows: 3, maxRows: 7 }}
        onChange={handleComposerValueChange}
        onCancel={onCancel}
        onPaste={handlePaste}
        onKeyUp={(event) => synchronizeSlashSkillToken(event.currentTarget.value, event.currentTarget.selectionStart, event.currentTarget.selectionEnd)}
        onKeyDown={(event) => handleSenderKeyDown(event, handleSuggestionKeyDown)}
        onSubmit={(submitValue) => {
          if (!submitValue.trim()) return;
          onSubmit(submitValue);
        }}
        suffix={(actionNode, { components }) => modelBusy ? (
          <components.LoadingButton
            title={t("composer.stopRun")}
            aria-label={t("composer.stopRun")}
          />
        ) : actionNode}
        header={hasComposerHeader ? (
          <div className="cy-composer__attachments" aria-label={t("composer.attachmentsLabel")}>
            {attachments.map((attachment, index) => (
              <div className={`cy-composer__attachment ${attachment.kind === "image" && attachment.previewUrl ? "is-image" : ""}${attachment.kind === "web-element" ? " is-web-element" : ""}`} key={`${attachment.filePath ?? attachment.name}-${index}`}>
                {attachment.kind === "web-element" && attachment.element ? (
                  <span className="cy-composer__web-element" title={attachment.element.snapshotLine}>
                    <ScanLine size={15} />
                    <span><strong>{attachment.element.name}</strong><small>{attachment.element.pageTitle || attachment.element.pageUrl}</small></span>
                  </span>
                ) : attachment.kind === "image" && attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt="" draggable={false} />
                ) : (
                  <>
                    <ComposerAttachmentFileIcon fileName={attachment.name} />
                    <span title={attachment.name}>{attachment.name}</span>
                  </>
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
              <Plus size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="cy-composer__icon-button"
              aria-label={t("composer.screenshot")}
              title={t("composer.screenshotShortcut")}
              onClick={onScreenshot}
            >
              <ScanLine size={20} aria-hidden="true" />
            </button>
            {supportsStickers && <StickerPicker onChoose={onChooseSticker} />}
          </div>
        }
        />
        )}
        </Suggestion>
        <div className="cy-composer__footer">
        {supportsWorkFiles && workspaceSelectable && (
          <WorkspaceFolderButton
            icon={<FolderOpen />}
            label={workspaceName ?? (docked ? t("composer.workspaceFolder") : t("composer.workspaceEnter"))}
            ariaLabel={t("composer.workspaceChoose")}
            recentProjects={recentProjects}
            onOpenRecentProjects={onOpenRecentProjects}
            onSelectRecentProject={onSelectRecentProject}
            onChooseWorkspace={onChooseWorkspace}
          />
        )}
        {supportsObsidianLibrary && workspaceSelectable && (
          <WorkspaceFolderButton
            icon={<BookOpen />}
            label={workspaceName ?? t("composer.obsidianLibrary")}
            ariaLabel={t("composer.obsidianChoose")}
            recentProjects={recentProjects}
            onOpenRecentProjects={onOpenRecentProjects}
            onSelectRecentProject={onSelectRecentProject}
            onChooseWorkspace={onChooseWorkspace}
          />
        )}
        {supportsPlanToggle && conversationId && (
          <PlanModeToggle conversationId={conversationId} workspaceRoot={workspaceRoot} />
        )}
        {supportsPlanToggle && conversationId && <span className="cy-composer__footer-separator" />}
        {supportsPermission && (
          <PermissionControl />
        )}
        {supportsStyle && <StyleControl />}
        {onSelectModelProfile && <ModelSelector hasSession={Boolean(conversationId)} activeProfileId={activeModelProfileId} sessionModel={activeSessionModel} onSelect={onSelectModelProfile} onSelectModel={onSelectSessionModel} />}
        <span className="cy-composer__footer-spacer" />
        <ContextUsageRing usage={contextUsage} sessionId={conversationId} busy={modelBusy} onCompactPhaseChange={onCompactPhaseChange} />
        <ReasoningControl sessionId={conversationId} modelProfileId={activeModelProfileId} model={activeSessionModel} />
        </div>
      </div>
    </div>
  );
}

const MODEL_ERROR_CATEGORY_KEYS: Record<ModelFailureInfo["category"], string> = {
  AUTH: "auth", PERMISSION: "permission", BILLING: "billing", QUOTA: "quota",
  RATE_LIMIT: "rateLimit", INVALID_REQUEST: "invalidRequest", NOT_FOUND: "notFound",
  CONTEXT_LIMIT: "contextLimit", PAYLOAD_TOO_LARGE: "payloadTooLarge", CONTENT_POLICY: "contentPolicy",
  CONFLICT: "conflict", TIMEOUT: "timeout", NETWORK: "network", OVERLOADED: "overloaded",
  SERVER_ERROR: "serverError", UNAVAILABLE: "unavailable", CANCELLED: "cancelled", UNKNOWN: "unknown",
};

function ModelFailureNotice({ failure }: { failure: ModelFailureInfo }) {
  const { t } = useTranslation();
  const categoryKey = MODEL_ERROR_CATEGORY_KEYS[failure.category] ?? "unknown";
  return (
    <Dialog.Root>
      <div className="cy-model-error-item" data-slot="item" role="status">
        <span className="cy-model-error-item__icon"><AlertTriangle size={16} aria-hidden="true" /></span>
        <span className="cy-model-error-item__summary" data-slot="item-content">
          {t(`composer.modelError.categories.${categoryKey}`)}
          {failure.status ? <span className="cy-model-error-item__status">HTTP {failure.status}</span> : null}
        </span>
        <Dialog.Trigger asChild>
          <button className="cy-model-error-item__action" type="button">{t("composer.modelError.viewDetails")}</button>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal>
        <Dialog.Overlay className="cy-model-error-dialog__overlay" />
        <Dialog.Content className="cy-model-error-dialog" aria-describedby="cy-model-error-description">
          <Dialog.Title className="cy-model-error-dialog__title">{t("composer.modelError.title")}</Dialog.Title>
          <Dialog.Description id="cy-model-error-description" className="cy-model-error-dialog__description">
            {t(`composer.modelError.categories.${categoryKey}`)}
          </Dialog.Description>
          <dl className="cy-model-error-dialog__details">
            <dt>{t("composer.modelError.provider")}</dt><dd>{failure.provider}</dd>
            <dt>{t("composer.modelError.model")}</dt><dd>{failure.model}</dd>
            {failure.status && <><dt>{t("composer.modelError.status")}</dt><dd>{failure.status}</dd></>}
            {failure.vendorCode && <><dt>{t("composer.modelError.code")}</dt><dd>{failure.vendorCode}</dd></>}
            {failure.vendorType && <><dt>{t("composer.modelError.type")}</dt><dd>{failure.vendorType}</dd></>}
            {failure.requestId && <><dt>{t("composer.modelError.requestId")}</dt><dd>{failure.requestId}</dd></>}
          </dl>
          <p className="cy-model-error-dialog__hint">{failure.category === "UNKNOWN"
            ? t("composer.modelError.unknownHint")
            : t("composer.modelError.hint")}</p>
          <div className="cy-model-error-dialog__footer">
            {failure.docsUrl && <a href={failure.docsUrl} target="_blank" rel="noreferrer">{t("composer.modelError.vendorDocs")} <ExternalLink size={14} /></a>}
            <Dialog.Close className="cy-model-error-dialog__close">{t("common.close")}</Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
