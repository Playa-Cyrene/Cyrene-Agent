import { useCallback, useEffect, useRef, useState } from "react";
import { CURRENT_DISCLAIMER_VERSION, hasCurrentDisclaimerConsent } from "../../../../shared/disclaimer";
import { WelcomeGate } from "./WelcomeGate";

export function StandaloneOnboarding() {
  const [view, setView] = useState<"welcome" | "disclaimer">("welcome");
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState("");

  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const accept = useCallback(async () => {
    if (pending.current || !mounted.current) return;
    pending.current = true;
    setAccepting(true);
    setError("");
    try {
      if (!window.settings?.saveGeneral) throw new Error("Settings are unavailable");
      const saved = await window.settings.saveGeneral({ disclaimerAcceptedVersion: CURRENT_DISCLAIMER_VERSION });
      if (!saved || typeof saved !== "object"
        || !hasCurrentDisclaimerConsent((saved as { disclaimerAcceptedVersion?: unknown }).disclaimerAcceptedVersion)) {
        throw new Error("Disclaimer consent was not saved");
      }
    } catch {
      pending.current = false;
      if (!mounted.current) return;
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
