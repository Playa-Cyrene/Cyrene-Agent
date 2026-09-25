import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../../components/ui/SidebarToggle", () => ({
  SidebarToggle: () => createElement("span", null, "sidebar-toggle"),
}));
vi.mock("../../../components/ui/ModeSwitch", () => ({
  ModeSwitch: () => createElement("span", null, "mode-switch"),
}));
vi.mock("../../../components/ui/MomentsModeButton", () => ({
  MomentsModeButton: () => createElement("span", null, "moments-button"),
}));
vi.mock("../../../components/ui/ScheduledTasksModeButton", () => ({
  ScheduledTasksModeButton: () => createElement("span", null, "scheduled-tasks-button"),
}));
vi.mock("../../../components/ui/WindowControls", () => ({
  WindowControls: () => createElement("span", null, "window-controls"),
}));
vi.mock("../../../components/ui/SettingsButton", () => ({
  SettingsButton: () => createElement("span", null, "settings-button"),
}));
vi.mock("../../../components/ui/UserAvatar", () => ({ UserAvatar: () => createElement("span", null, "user-avatar") }));
vi.mock("../../../components/ui/NewTaskButton", () => ({
  NewTaskButton: () => createElement("span", null, "new-task-button"),
}));
vi.mock("./AppUpdateEntry", () => ({ AppUpdateEntry: () => createElement("span", null, "app-update-entry") }));
vi.mock("./ConversationSidebar", () => ({
  ConversationSidebar: () => createElement("span", null, "conversation-sidebar"),
}));

import { ChatPageNavigation } from "./ChatPageNavigation";

describe("ChatPageNavigation", () => {
  it("hides the mode switch while a panel is open", () => {
    const html = renderToStaticMarkup(createElement(ChatPageNavigation, {
      activePanel: "moments",
      mode: "chat",
      sessions: [],
      activeSessionId: undefined,
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    }));

    expect(html).not.toContain("mode-switch");
    expect(html).toContain("moments-button");
    expect(html).toContain("scheduled-tasks-button");
    expect(html.indexOf("new-task-button")).toBeLessThan(html.indexOf("scheduled-tasks-button"));
    expect(html.indexOf("scheduled-tasks-button")).toBeLessThan(html.indexOf("moments-button"));
    expect(html).toContain("conversation-sidebar");
  });

  it("does not expose model management in the chat sidebar", () => {
    const html = renderToStaticMarkup(createElement(ChatPageNavigation, {
      activePanel: null,
      mode: "chat",
      sessions: [],
      activeSessionId: undefined,
      onToggleCollapsed: () => undefined,
      onModeChange: () => undefined,
      onNewTask: () => undefined,
      onTogglePanel: () => undefined,
      onSelectSession: () => undefined,
      onOpenProject: () => undefined,
      onRenameSession: () => undefined,
      onDeleteSession: () => undefined,
      onTogglePinSession: () => undefined,
      onMinimize: () => undefined,
      onMaximize: () => undefined,
      onCloseWindow: () => undefined,
      onOpenSettings: () => undefined,
    }));

    expect(html).not.toContain("model-button");
    expect(html).toContain("moments-button");
    expect(html).toContain("mode-switch");
  });
});
