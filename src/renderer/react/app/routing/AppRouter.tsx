import { useCallback, useEffect, useState } from "react";
import { ChatPage } from "../../features/chat/pages/ChatPage";
import { AppearanceSettingsPage, type SettingsSection } from "../../features/settings/AppearanceSettingsPage";
import { resolveSettingsDestination } from "./settingsNavigation";
import "./AppRouter.css";

export function AppRouter() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");
  const [scheduledTasksNavigation, setScheduledTasksNavigation] = useState(0);
  const [musicSettingsNavigation, setMusicSettingsNavigation] = useState(0);

  useEffect(() => window.settings?.onSwitchSection?.((requestedSection) => {
    const destination = resolveSettingsDestination(requestedSection);
    if (destination.kind === "scheduledTasks") {
      setSettingsOpen(false);
      setScheduledTasksNavigation((revision) => revision + 1);
      return;
    }
    setSettingsSection(destination.section);
    setMusicSettingsNavigation((revision) => revision + (destination.openMusicModal ? 1 : 0));
    setSettingsOpen(true);
  }), []);

  const openSettings = useCallback(() => {
    setSettingsSection("appearance");
    setSettingsOpen(true);
  }, []);

  return (
    <div className="cy-app-router">
      <div
        className={`cy-app-router__view ${settingsOpen ? "is-hidden" : ""}`}
        aria-hidden={settingsOpen}
        inert={settingsOpen}
      >
        <ChatPage onOpenSettings={openSettings} scheduledTasksNavigation={scheduledTasksNavigation} />
      </div>
      {settingsOpen && (
        <div className="cy-app-router__view">
          <AppearanceSettingsPage
            section={settingsSection}
            onSelectSection={setSettingsSection}
            onBackToWorkspace={() => setSettingsOpen(false)}
            musicSettingsNavigation={musicSettingsNavigation}
          />
        </div>
      )}
    </div>
  );
}
