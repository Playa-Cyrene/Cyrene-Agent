import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FEEDBACK_NOTICE_DURATION_MS,
  FEEDBACK_NOTICE_MAX_COUNT,
  type FeedbackApi,
} from "./feedback-types";

describe("renderer feedback contract", () => {
  it("uses the approved notice defaults", () => {
    expect(FEEDBACK_NOTICE_DURATION_MS).toBe(3000);
    expect(FEEDBACK_NOTICE_MAX_COUNT).toBe(3);
  });

  it("keeps confirm and alert results asynchronous", () => {
    // 纯类型断言：不在运行时访问 api 实例
    expectTypeOf<FeedbackApi["confirm"]>().returns.toEqualTypeOf<Promise<boolean>>();
    expectTypeOf<FeedbackApi["alert"]>().returns.toEqualTypeOf<Promise<void>>();
  });
});
