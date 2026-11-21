import { describe, expect, it } from "vitest";
import builtin from "./builtin-terms.json";
import { CURRENT_DISCLAIMER_VERSION } from "./disclaimer";
import zh from "../renderer/react/i18n/zh-CN.json";
import en from "../renderer/react/i18n/en.json";
import ja from "../renderer/react/i18n/ja-JP.json";

describe("bundled terms fallback", () => {
  it("preserves the current consent version without silently requiring new agreement", () => {
    expect(builtin.consentVersion).toBe(CURRENT_DISCLAIMER_VERSION);
  });
  it.each([["zh-CN", zh], ["en", en], ["ja-JP", ja]] as const)("matches the full existing %s text", (locale, resource) => {
    const { heading, sections } = resource.settingsPage.disclaimer;
    expect(builtin.locales[locale]).toEqual({ heading, sections });
  });
});
