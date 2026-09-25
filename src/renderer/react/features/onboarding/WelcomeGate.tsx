import { useState } from "react";
import { useTranslation } from "../../i18n";
import { Card } from "../../components/ui/Card";
import { DisclaimerSettingsPanel } from "../settings/DisclaimerSettingsPanel";
import { resolveAsset } from "../../../../shared/renderer-base";
import "./WelcomeGate.css";

export interface WelcomeGateProps {
  view: "loading" | "welcome" | "disclaimer";
  accepting: boolean;
  error: string;
  onViewDisclaimer: () => void;
  onBack: () => void;
  onAccept: () => void;
  onQuit: () => void;
}

export function WelcomeGate({
  view,
  accepting,
  error,
  onViewDisclaimer,
  onBack,
  onAccept,
  onQuit,
}: WelcomeGateProps) {
  const { t } = useTranslation();
  const [posterFailed, setPosterFailed] = useState(false);

  if (view === "loading") {
    return <main className="cy-onboarding cy-onboarding--loading" aria-busy="true" />;
  }

  return (
    <main className="cy-onboarding">
      <div className="cy-onboarding__window-controls">
        <button type="button" onClick={onQuit} aria-label={t("onboarding.quit")} title={t("onboarding.quit")}>
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" />
          </svg>
        </button>
      </div>

      {view === "welcome" ? (
        <Card as="section" className="cy-onboarding__welcome">
          {posterFailed ? (
            <div className="cy-onboarding__poster cy-onboarding__poster--fallback" role="img" aria-label={t("onboarding.posterAlt")}>
              {t("onboarding.posterUnavailable")}
            </div>
          ) : (
            <img className="cy-onboarding__poster" src={resolveAsset("cyrene-welcome.png")} alt={t("onboarding.posterAlt")} onError={() => setPosterFailed(true)} />
          )}
          <div className="cy-onboarding__welcome-copy">
            <p className="cy-onboarding__eyebrow">CYRENE AGENT</p>
            <h1>{t("onboarding.welcomeTitle")}</h1>
            <p className="cy-onboarding__tagline">{t("onboarding.tagline")}</p>
            <p className="cy-onboarding__notice">{t("onboarding.disclaimerNotice")}</p>
            <button className="cy-onboarding__button cy-onboarding__button--primary" type="button" onClick={onViewDisclaimer}>
              {t("onboarding.viewDisclaimer")}
            </button>
          </div>
        </Card>
      ) : (
        <Card as="section" className="cy-onboarding__terms">
          <div className="cy-onboarding__terms-scroll">
            <DisclaimerSettingsPanel />
          </div>
          <footer className="cy-onboarding__terms-footer">
            <button className="cy-onboarding__back" type="button" onClick={onBack} disabled={accepting}>
              {t("onboarding.back")}
            </button>
            {error && <p className="cy-onboarding__error" role="alert">{t(error)}</p>}
            <div className="cy-onboarding__actions">
              <button className="cy-onboarding__button" type="button" onClick={onQuit} disabled={accepting}>
                {t("onboarding.decline")}
              </button>
              <button className="cy-onboarding__button cy-onboarding__button--primary" type="button" onClick={onAccept} disabled={accepting}>
                {accepting ? t("onboarding.saving") : t("onboarding.accept")}
              </button>
            </div>
          </footer>
        </Card>
      )}
    </main>
  );
}
