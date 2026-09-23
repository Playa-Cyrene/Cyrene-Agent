import { useState } from "react";
import { createRoot } from "react-dom/client";
import { AppearanceSettingsPage, type AppearanceSettingsPageProps } from "./features/settings/AppearanceSettingsPage";

const asrSettings = {
  asrEngine: "aliyun",
  asrAliyunAppKey: "example-app-key",
  asrAliyunAccessKeyId: "example-access-key-id",
  asrAliyunAccessKeySecret: "example-secret",
  ttsMosslandKey: "example-mossland-key",
  asrLanguage: "zh",
  asrVadSilenceMs: 1400,
  asrVadThreshold: 0.02,
  asrShowTranscript: true,
};

Object.assign(window, {
  settings: { getGeneral: async () => ({ windowCornerRadius: 16 }) },
  tts: {
    loadSettings: async () => ({ ...asrSettings }),
    saveSettings: async (patch: Record<string, unknown>) => Object.assign(asrSettings, patch),
  },
});

function Preview() {
  const [section, setSection] = useState<AppearanceSettingsPageProps["section"]>("asr");
  return <AppearanceSettingsPage section={section} onSelectSection={setSection} onBackToWorkspace={() => {}} />;
}

createRoot(document.getElementById("cyrene-react-root")!).render(<Preview />);
