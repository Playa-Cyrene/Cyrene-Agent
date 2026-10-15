import { WorkspacePreviewContent, type WorkspacePreview } from "./WorkspacePreview";
// ChatPageInspector — 把 ChatPage 的标签状态组装成 RightInspector 的标签列表。
// 标签固定顺序：文件树（files）→ 文件预览（file:<路径>）→ Diff（diff:<run>:<路径>）→ 计划（plan:<会话>）。

import { Bot, ClipboardList, FileText, FolderOpen, Globe } from "lucide-react";
import { useTranslation } from "../../../i18n";
import { FileTreePanel, FilePreviewContent } from "./FileTreePanel";
import {
  DEMO_FILE_PREVIEW_CONTENT,
  DEMO_FILE_PREVIEW_DISPLAY_PATH,
  DEMO_FILE_PREVIEW_REL_PATH,
} from "./demoFilePreview";
import { PlanContent, planTabDotClass, planTabLabel, type PlanReviewPhase } from "./PlanReviewPanel";
import { ReviewDiffContent } from "./ReviewInspector";
import { RightInspector, type InspectorTab } from "./RightInspector";
import { TaskSessionInspector } from "./TaskSessionInspector";
import { BrowserPanel } from "./BrowserPanel";
import { vscodeIconForFile } from "./vscodeFileIcon";

/** 从路径取文件名做标签标题（兼容 / 与 \ 分隔） */
function fileBaseName(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash < 0 ? filePath : filePath.slice(lastSlash + 1);
}

function fileTabIcon(filePath: string) {
  const iconUrl = vscodeIconForFile(filePath);
  return iconUrl
    ? <img src={iconUrl} alt="" aria-hidden="true" />
    : <FileText size={15} strokeWidth={1.8} aria-hidden="true" />;
}

export interface ChatPageInspectorDiffTab {
  id: string;
  runId: string;
  fileIndex: number;
  filePath: string;
}

export interface ChatPageInspectorTaskTab {
  id: string;
  taskId: string;
  description: string;
  nickname: string;
  assetFileName: string;
}

export interface ChatPageInspectorFileTab {
  id: string;
  relPath: string;
  /** 从消息链接跳转过来时携带的定位行（1 起） */
  line?: number;
  /** 定位序号：同一标签重复点击不同行号时靠它触发重新滚动 */
  lineSeq?: number;
}

export interface ChatPageInspectorProps {
  preview?: WorkspacePreview | null;
  sessionId?: string;
  /** 工作区根路径（未绑定时为空，文件树显示引导态） */
  workspaceRoot?: string;
  filesTabOpen: boolean;
  browserTabOpen: boolean;
  /** 文件树标签被钉住（面板里还有其它标签时不可关） */
  filesTabPinned: boolean;
  fileTabs: ChatPageInspectorFileTab[];
  diffTabs: ChatPageInspectorDiffTab[];
  taskTabs?: ChatPageInspectorTaskTab[];
  activePlan: { content: string; phase: PlanReviewPhase } | null;
  planDrawerOpen: boolean;
  /** 计划标签 ID（plan:<会话>），由 ChatPage 统一计算 */
  planTabId: string;
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** 文件树里点击文件 → 打开/激活预览标签 */
  onOpenFile: (relPath: string) => void;
  preferredAddress?: string;
}

export function ChatPageInspector({
  preview,
  sessionId,
  workspaceRoot,
  filesTabOpen,
  browserTabOpen,
  filesTabPinned,
  fileTabs,
  diffTabs,
  taskTabs = [],
  activePlan,
  planDrawerOpen,
  planTabId,
  activeTabId,
  onTabChange,
  onCloseTab,
  onOpenFile,
  preferredAddress,
}: ChatPageInspectorProps) {
  const { t } = useTranslation();
  const tabs: InspectorTab[] = [];
  // 预览占用工作区标签，让 BrowserPanel 通过已有 active 路径隐藏原生网页层。
  if (preview) {
    tabs.push({
      id: "preview",
      label: preview.kind === "image" ? preview.attachment.name : t("messageList.diagramPreview"),
      content: (
        <WorkspacePreviewContent
          key={preview.kind === "image" ? preview.attachment.id : preview.svg}
          preview={preview}
          active={activeTabId === "preview" || activeTabId === null}
        />
      ),
    });
  }

  if (browserTabOpen) {
    tabs.push({
      id: "browser",
      label: t("browserPanel.title"),
      icon: <Globe size={15} strokeWidth={1.8} />,
      content: <BrowserPanel active={activeTabId === "browser" || (activeTabId === null && tabs.length === 0)} />,
    });
  }

  if (filesTabOpen && sessionId) {
    tabs.push({
      id: "files",
      label: t("fileTree.title"),
      icon: <FolderOpen size={15} strokeWidth={1.8} />,
      // 被钉住的文件树标签隐藏 chip 上的 ×，右上角关闭按钮也对它无效
      closable: !filesTabPinned,
      content: (
        <FileTreePanel
          sessionId={sessionId}
          workspaceRoot={workspaceRoot}
          onOpenFile={onOpenFile}
        />
      ),
    });
  }
  for (const tab of fileTabs) {
    tabs.push({
      id: tab.id,
      label: fileBaseName(tab.relPath),
      icon: fileTabIcon(tab.relPath),
      content: sessionId
        ? <FilePreviewContent
            sessionId={sessionId}
            relPath={tab.relPath}
            scrollToLine={tab.line}
            lineSeq={tab.lineSeq}
            contentOverride={sessionId === "preview-code" && tab.relPath === DEMO_FILE_PREVIEW_REL_PATH ? DEMO_FILE_PREVIEW_CONTENT : undefined}
            displayPath={sessionId === "preview-code" && tab.relPath === DEMO_FILE_PREVIEW_REL_PATH ? DEMO_FILE_PREVIEW_DISPLAY_PATH : undefined}
          />
        : null,
    });
  }
  for (const tab of diffTabs) {
    tabs.push({
      id: tab.id,
      label: tab.filePath ? fileBaseName(tab.filePath) : "Diff",
      icon: tab.filePath ? fileTabIcon(tab.filePath) : <FileText size={15} strokeWidth={1.8} aria-hidden="true" />,
      content: <ReviewDiffContent runId={tab.runId} fileIndex={tab.fileIndex} />,
    });
  }
  for (const tab of taskTabs) {
    tabs.push({
      id: tab.id,
      label: tab.description,
      icon: <Bot size={15} strokeWidth={1.8} />,
      content: sessionId
        ? <TaskSessionInspector
            taskId={tab.taskId}
            parentConversationId={sessionId}
            description={tab.description}
            nickname={tab.nickname}
            assetFileName={tab.assetFileName}
            preferredAddress={preferredAddress ?? ""}
            active={activeTabId === tab.id || (activeTabId === null && tabs.length === 0)}
          />
        : null,
    });
  }
  if (activePlan && planDrawerOpen) {
    tabs.push({
      id: planTabId,
      label: planTabLabel(activePlan.phase),
      icon: <ClipboardList size={15} strokeWidth={1.8} />,
      dotClass: planTabDotClass(activePlan.phase),
      content: <PlanContent content={activePlan.content} phase={activePlan.phase} />,
    });
  }
  if (tabs.length === 0) return null;

  return (
    <RightInspector
      tabs={tabs}
      activeTabId={activeTabId}
      onTabChange={onTabChange}
      onCloseTab={onCloseTab}
    />
  );
}
