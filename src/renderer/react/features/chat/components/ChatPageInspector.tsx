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
  /** 从消息链接跳转过来时携带的定位行（1 起） */
  line?: number;
  /** 定位序号：同一标签重复点击不同行号时靠它触发重新滚动 */
  lineSeq?: number;
}

export interface ChatPageInspectorProps {
  sessionId?: string;
  /** 工作区根路径（未绑定时为空，文件树显示引导态） */
  workspaceRoot?: string;
  filesTabOpen: boolean;
  /** 文件树标签被钉住（面板里还有其它标签时不可关） */
  filesTabPinned: boolean;
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
  filesTabPinned,
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
      content: sessionId
        ? <FilePreviewContent sessionId={sessionId} relPath={tab.relPath} scrollToLine={tab.line} lineSeq={tab.lineSeq} />
        : null,
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
