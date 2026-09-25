import React from "react";
import { Search } from "lucide-react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import type { SidebarOrganizationDraft, SidebarOrganizationSnapshot } from "../../../../../shared/sidebar-organization";
import { useTranslation } from "../../../i18n";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { MomentsModeButton } from "../../../components/ui/MomentsModeButton";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { ScheduledTasksModeButton } from "../../../components/ui/ScheduledTasksModeButton";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { WindowControls } from "../../../components/ui/WindowControls";
import { AppUpdateEntry } from "./AppUpdateEntry";
import { ConversationSidebar } from "./ConversationSidebar";
import { SidebarSearchDialog } from "./SidebarSearchDialog";
import { reportChatPerfRender } from "./chat-perf-probe";

export type ChatPagePanel = "moments" | "scheduledTasks";

export interface ChatPageNavigationProps {
  activePanel: ChatPagePanel | null;
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  sidebarSessions: ChatSessionMeta[];
  sidebarOrganization: SidebarOrganizationSnapshot | null;
  activeSessionId?: string;
  onToggleCollapsed: () => void;
  onModeChange: (mode: string) => void;
  onNewTask: () => void;
  onTogglePanel: (panel: ChatPagePanel) => void;
  onSelectSession: (sessionId: string, mode?: ConversationMode) => void;
  onSaveSidebarOrganization: (draft: SidebarOrganizationDraft) => Promise<boolean>;
  onOpenProject: (workspaceRoot: string) => void;
  onRenameSession: (sessionId: string, newTitle: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onTogglePinSession: (sessionId: string, pinned: boolean) => void;
  onMinimize: () => void;
  onMaximize: () => void;
  onCloseWindow: () => void;
  onOpenSettings: () => void;
}

// 阶段 1A：memo 隔离——ChatPage 流式重渲染时，只要 props 引用稳定（sessions/回调由父级保证），
// 导航子树（含内嵌的 ConversationSidebar）整体跳过执行，流式期间执行次数应为 0（探针验收）。
export const ChatPageNavigation = React.memo(function ChatPageNavigation({
  activePanel,
  mode,
  sessions,
  sidebarSessions,
  sidebarOrganization,
  activeSessionId,
  onToggleCollapsed,
  onModeChange,
  onNewTask,
  onTogglePanel,
  onSelectSession,
  onSaveSidebarOrganization,
  onOpenProject,
  onRenameSession,
  onDeleteSession,
  onTogglePinSession,
  onMinimize,
  onMaximize,
  onCloseWindow,
  onOpenSettings,
}: ChatPageNavigationProps) {
  // 性能探针：perf harness 注册后统计导航子树执行次数（阶段 1A 验收：流式期间应为 0）
  reportChatPerfRender("navigationRenders");
  const hasOpenPanel = activePanel !== null;
  const { t } = useTranslation();
  const [searchOpen, setSearchOpen] = React.useState(false);

  React.useEffect(() => {
    function onSearchShortcut(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLocaleLowerCase() !== "k") return;
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onSearchShortcut);
    return () => window.removeEventListener("keydown", onSearchShortcut);
  }, []);

  function selectSearchSession(session: ChatSessionMeta) {
    setSearchOpen(false);
    const normalizeRoot = (root: string) => root.replace(/[\\/]+$/, "").toLocaleLowerCase();
    const hiddenProject = session.workspaceRoot && sidebarOrganization?.projects.find((project) =>
      project.hidden && normalizeRoot(project.workspaceRoot) === normalizeRoot(session.workspaceRoot!),
    );
    if (hiddenProject && sidebarOrganization) {
      void onSaveSidebarOrganization({
        ...sidebarOrganization,
        projects: sidebarOrganization.projects.map((project) => project.id === hiddenProject.id ? { ...project, hidden: false } : project),
      }).then(() => onSelectSession(session.id, session.mode));
      return;
    }
    onSelectSession(session.id, session.mode);
  }

  return (
    <>
      <div className="cy-page-toggle">
        <SidebarToggle onToggle={onToggleCollapsed} />
      </div>
      <div className="cy-page-top-center">
        {!hasOpenPanel && <ModeSwitch value={mode} onChange={onModeChange} />}
      </div>
      <div className="cy-page-windows">
        <WindowControls onMinimize={onMinimize} onMaximize={onMaximize} onClose={onCloseWindow} />
      </div>
      <div className="cy-page-sidebar">
        <div className="cy-page-newtask">
          <NewTaskButton onClick={onNewTask} />
          <button className="cy-side-action cy-side-action--search" onClick={() => setSearchOpen(true)} type="button">
            <span className="cy-side-action-icon"><Search size={18} strokeWidth={1.8} /></span>
            <span className="cy-side-action-label">{t("sidebar.searchAction")}</span>
            <kbd>Ctrl+K</kbd>
          </button>
          <ScheduledTasksModeButton active={activePanel === "scheduledTasks"} onClick={() => onTogglePanel("scheduledTasks")} />
          <MomentsModeButton active={activePanel === "moments"} onClick={() => onTogglePanel("moments")} />
        </div>
        <div className="cy-page-conversations">
          <ConversationSidebar
            mode={mode}
            sessions={sessions}
            sidebarSessions={sidebarSessions}
            organization={sidebarOrganization}
            onSaveOrganization={onSaveSidebarOrganization}
            activeSessionId={activeSessionId}
            onSelect={onSelectSession}
            onOpenProject={onOpenProject}
            onRename={onRenameSession}
            onDelete={onDeleteSession}
            onTogglePin={onTogglePinSession}
          />
        </div>
        <AppUpdateEntry />
        <div className="cy-page-sidebar-bottom">
          <UserAvatar />
          <SettingsButton onClick={onOpenSettings} />
        </div>
      </div>
      <SidebarSearchDialog
        open={searchOpen}
        sessions={sidebarSessions}
        activeSessionId={activeSessionId}
        onClose={() => setSearchOpen(false)}
        onSelect={selectSearchSession}
      />
    </>
  );
});
