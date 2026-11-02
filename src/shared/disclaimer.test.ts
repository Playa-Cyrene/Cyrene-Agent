import { describe, expect, it } from "vitest";
import { CURRENT_DISCLAIMER_VERSION, hasCurrentDisclaimerConsent } from "./disclaimer";

describe("versioned disclaimer consent", () => {
  it.each([undefined, null, "", "2026-09-27", "future", true, 1])("requires consent for %s", version => {
    expect(hasCurrentDisclaimerConsent(version)).toBe(false);
  });
  it("accepts only the exact current version", () => {
    expect(hasCurrentDisclaimerConsent(CURRENT_DISCLAIMER_VERSION)).toBe(true);
    expect(hasCurrentDisclaimerConsent(` ${CURRENT_DISCLAIMER_VERSION}`)).toBe(false);
  });
});
