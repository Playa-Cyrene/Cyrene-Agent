import { AppRouter } from "./app/routing/AppRouter";
import { StandaloneOnboarding } from "./features/onboarding/StandaloneOnboarding";

export function App() {
  if (new URLSearchParams(window.location.search).has("onboarding")) {
    return <StandaloneOnboarding />;
  }
  return <AppRouter />;
}
