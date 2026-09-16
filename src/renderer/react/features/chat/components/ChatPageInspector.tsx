// ChatPageInspector — 把 ChatPage 的标签状态组装成 RightInspector 的标签列表。
// 标签固定顺序：文件树（files）→ 文件预览（file:<路径>）→ Diff（diff:<run>:<路径>）→ 计划（plan:<会话>）。

import { useTranslation } from "../../../i18n";
import { FileTreePanel, FilePreviewContent } from "./FileTreePanel";
import { PlanContent, planTabDotClass, planTabLabel, type PlanReviewPhase } from "./PlanReviewPanel";
import { ReviewDiffContent } from "./ReviewInspector";
import { RightInspector, type InspectorTab } from "./RightInspector";

/** 从路径取文件名做标签标题（兼容 / 与 \ 分隔） */
function fileBaseName(filePath: string): string {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return lastSlash < 0 ? filePath : filePath.slice(lastSlash + 1);
}

export interface ChatPageInspectorDiffTab {
  id: string;
  runId: string;
  fileIndex: number;
  filePath: string;
}

export interface ChatPageInspectorFileTab {
  id: string;
  relPath: string;
}

export interface ChatPageInspectorProps {
  sessionId?: string;
  /** 工作区根路径（未绑定时为空，文件树显示引导态） */
  workspaceRoot?: string;
  filesTabOpen: boolean;
  fileTabs: ChatPageInspectorFileTab[];
  diffTabs: ChatPageInspectorDiffTab[];
  activePlan: { content: string; phase: PlanReviewPhase } | null;
  planDrawerOpen: boolean;
  /** 计划标签 ID（plan:<会话>），由 ChatPage 统一计算 */
  planTabId: string;
  activeTabId: string | null;
  onTabChange: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** 文件树里点击文件 → 打开/激活预览标签 */
  onOpenFile: (relPath: string) => void;
}

export function ChatPageInspector({
  sessionId,
  workspaceRoot,
  filesTabOpen,
  fileTabs,
  diffTabs,
  activePlan,
  planDrawerOpen,
  planTabId,
  activeTabId,
  onTabChange,
  onCloseTab,
  onOpenFile,
}: ChatPageInspectorProps) {
  const { t } = useTranslation();
  const tabs: InspectorTab[] = [];

  if (filesTabOpen && sessionId) {
    tabs.push({
      id: "files",
      label: t("fileTree.title"),
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
      content: sessionId ? <FilePreviewContent sessionId={sessionId} relPath={tab.relPath} /> : null,
    });
  }
  for (const tab of diffTabs) {
    tabs.push({
      id: tab.id,
      label: tab.filePath ? fileBaseName(tab.filePath) : "Diff",
      content: <ReviewDiffContent runId={tab.runId} fileIndex={tab.fileIndex} />,
    });
  }
  if (activePlan && planDrawerOpen) {
    tabs.push({
      id: planTabId,
      label: planTabLabel(activePlan.phase),
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
