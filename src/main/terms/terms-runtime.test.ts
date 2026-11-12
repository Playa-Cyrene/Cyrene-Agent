import { describe, expect, it } from "vitest";
import { assertTermsExecutionAllowed, configureTermsExecutionGate, isTermsExecutionAllowed, TermsConsentRequiredError } from "./terms-runtime";

describe("terms execution gate", () => {
  it("reads current consent rather than capturing acceptance at run creation", () => {
    let accepted = true;
    const dispose = configureTermsExecutionGate(() => accepted);
    try {
      expect(isTermsExecutionAllowed()).toBe(true);
      accepted = false;
      expect(() => assertTermsExecutionAllowed()).toThrow(TermsConsentRequiredError);
      accepted = true;
      expect(() => assertTermsExecutionAllowed()).not.toThrow();
    } finally { dispose(); }
  });
  it("fails closed if the authoritative service fails", () => {
    const dispose = configureTermsExecutionGate(() => { throw new Error("unavailable"); });
    try { expect(isTermsExecutionAllowed()).toBe(false); } finally { dispose(); }
  });
});
