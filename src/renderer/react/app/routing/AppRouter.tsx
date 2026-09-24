import { useCallback, useState } from "react";
import { ChatPage } from "../../features/chat/pages/ChatPage";
import { AppearanceSettingsPage, type SettingsSection } from "../../features/settings/AppearanceSettingsPage";
import "./AppRouter.css";

export function AppRouter() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("appearance");

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
        <ChatPage onOpenSettings={openSettings} />
      </div>
      {settingsOpen && (
        <div className="cy-app-router__view">
          <AppearanceSettingsPage
            section={settingsSection}
            onSelectSection={setSettingsSection}
            onBackToWorkspace={() => setSettingsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
