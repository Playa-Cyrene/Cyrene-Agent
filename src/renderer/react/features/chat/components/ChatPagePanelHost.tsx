import type { ChatPagePanel } from "./ChatPageNavigation";
import { MomentsPanel } from "../../moments/MomentsPanel";
import { ScheduledTasksPanel } from "../../scheduler/ScheduledTasksPanel";

export function ChatPagePanelHost({
  panel,
  onPickWorkspace,
  onOpenSession,
}: {
  panel: ChatPagePanel;
  onPickWorkspace: () => Promise<{ ok: boolean; path?: string; displayName?: string; error?: string }>;
  onOpenSession: (sessionId: string) => void;
}) {
  switch (panel) {
    case "moments": return <MomentsPanel />;
    case "scheduledTasks": return <ScheduledTasksPanel onPickWorkspace={onPickWorkspace} onOpenSession={onOpenSession} />;
  }
}
