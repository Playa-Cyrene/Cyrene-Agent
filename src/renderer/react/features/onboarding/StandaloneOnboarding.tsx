import { useCallback, useState } from "react";
import { CURRENT_DISCLAIMER_VERSION } from "../../../../shared/disclaimer";
import { WelcomeGate } from "./WelcomeGate";

export function StandaloneOnboarding() {
  const [view, setView] = useState<"welcome" | "disclaimer">("welcome");
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  const accept = useCallback(async () => {
    setAccepting(true);
    setError("");
    try {
      if (!window.settings?.saveGeneral) throw new Error("Settings are unavailable");
      await window.settings.saveGeneral({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
    } catch {
      setError("onboarding.saveFailed");
      setAccepting(false);
    }
  }, []);

  return (
    <WelcomeGate
      view={view}
      accepting={accepting}
      error={error}
      onViewDisclaimer={() => setView("disclaimer")}
      onBack={() => { setError(""); setView("welcome"); }}
      onAccept={() => { void accept(); }}
      onQuit={() => window.cyrene?.quit()}
    />
  );
}
