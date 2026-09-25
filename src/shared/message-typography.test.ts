import { describe, expect, it } from "vitest";
import {
  DEFAULT_MESSAGE_TYPOGRAPHY,
  normalizeMessageTypography,
} from "./message-typography";

describe("normalizeMessageTypography", () => {
  it("keeps valid values and clamps out-of-range numbers", () => {
    expect(normalizeMessageTypography({ fontSize: 16, lineHeight: 2, letterSpacing: 1, fontWeight: 500 }))
      .toEqual({ fontSize: 16, lineHeight: 2, letterSpacing: 1, fontWeight: 500 });
    expect(normalizeMessageTypography({ fontSize: 99, lineHeight: 9, letterSpacing: -1, fontWeight: 100 }))
      .toEqual({ fontSize: 20, lineHeight: 2.2, letterSpacing: 0, fontWeight: 300 });
  });

  it("falls back per-field for missing or invalid entries (旧配置兼容)", () => {
    expect(normalizeMessageTypography(undefined)).toEqual(DEFAULT_MESSAGE_TYPOGRAPHY);
    expect(normalizeMessageTypography({ fontSize: 18, lineHeight: "invalid" }))
      .toEqual({ ...DEFAULT_MESSAGE_TYPOGRAPHY, fontSize: 18 });
  });
});
