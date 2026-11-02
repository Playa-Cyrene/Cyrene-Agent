/** Increment this when disclaimer terms change and existing users must consent again. */
export const CURRENT_DISCLAIMER_VERSION = "2026-11-02";

/** Legacy, missing, and unknown versions require explicit consent to the current terms. */
export function hasCurrentDisclaimerConsent(version: unknown): boolean {
  return version === CURRENT_DISCLAIMER_VERSION;
}
