import React from "react";
import type { ChatSessionMeta, ConversationMode } from "../../../../../shared/chat-types";
import { ModeSwitch } from "../../../components/ui/ModeSwitch";
import { ModelModeButton } from "../../../components/ui/ModelModeButton";
import { MomentsModeButton } from "../../../components/ui/MomentsModeButton";
import { NewTaskButton } from "../../../components/ui/NewTaskButton";
import { PluginModeButton } from "../../../components/ui/PluginModeButton";
import { SettingsButton } from "../../../components/ui/SettingsButton";
import { SidebarToggle } from "../../../components/ui/SidebarToggle";
import { SkillModeButton } from "../../../components/ui/SkillModeButton";
import { ToolModeButton } from "../../../components/ui/ToolModeButton";
import { UserAvatar } from "../../../components/ui/UserAvatar";
import { WindowControls } from "../../../components/ui/WindowControls";
import { AppUpdateEntry } from "./AppUpdateEntry";
import { ConversationSidebar } from "./ConversationSidebar";
import { reportChatPerfRender } from "./chat-perf-probe";

export type ChatPagePanel = "tool" | "skill" | "model" | "plugin" | "moments";

export interface ChatPageNavigationProps {
  collapsed: boolean;
  activePanel: ChatPagePanel | null;
  mode: ConversationMode;
  sessions: ChatSessionMeta[];
  activeSessionId?: string;
  onToggleCollapsed: () => void;
  onModeChange: (mode: string) => void;
  onNewTask: () => void;
  onTogglePanel: (panel: ChatPagePanel) => void;
  onSelectSession: (sessionId: string) => void;
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
  collapsed,
  activePanel,
  mode,
  sessions,
  activeSessionId,
  onToggleCollapsed,
  onModeChange,
  onNewTask,
  onTogglePanel,
  onSelectSession,
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

  return (
    <>
      <div className="cy-page-toggle">
        <SidebarToggle collapsed={collapsed} onToggle={onToggleCollapsed} />
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
          <ToolModeButton active={activePanel === "tool"} onClick={() => onTogglePanel("tool")} />
          <SkillModeButton active={activePanel === "skill"} onClick={() => onTogglePanel("skill")} />
          <ModelModeButton active={activePanel === "model"} onClick={() => onTogglePanel("model")} />
          <PluginModeButton active={activePanel === "plugin"} onClick={() => onTogglePanel("plugin")} />
          <MomentsModeButton active={activePanel === "moments"} onClick={() => onTogglePanel("moments")} />
        </div>
        <div className="cy-page-conversations">
          <ConversationSidebar
            mode={mode}
            sessions={sessions}
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
    </>
  );
});
