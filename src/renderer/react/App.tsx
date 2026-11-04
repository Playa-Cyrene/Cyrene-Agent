import { AppRouter } from "./app/routing/AppRouter";
import { TermsConsentBoundary } from "./features/onboarding/TermsConsentBoundary";
import { StandaloneOnboarding } from "./features/onboarding/StandaloneOnboarding";

export function App() {
  if (new URLSearchParams(window.location.search).has("onboarding")) {
    return <StandaloneOnboarding />;
  }
  return <TermsConsentBoundary><AppRouter /></TermsConsentBoundary>;
}
