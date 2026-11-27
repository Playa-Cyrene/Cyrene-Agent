import { describe, expect, it } from "vitest";
import { mapTerminateReason, mapTerminateReasonToTerminal } from "./terminal-mapper";

describe("harness terminal mapper", () => {
  it.each([
    [undefined, "no_tool"],
    ["cancelled", "no_tool"],
    ["timeout", "timeout"],
    ["max_rounds", "max_rounds"],
    ["error", "tool_error"],
  ] as const)("maps %s to completion reason %s", (reason, expected) => {
    expect(mapTerminateReason(reason)).toBe(expected);
  });

  it.each([undefined, false, true])("maps natural completion with uncertain effects = %s", (hasUncertainEffects) => {
    expect(mapTerminateReasonToTerminal(undefined, hasUncertainEffects)).toStrictEqual({
      status: "success",
      externalEffectsMayContinue: hasUncertainEffects ?? false,
    });
  });

  it.each([
    ["max_rounds", { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true }],
    ["timeout", { status: "timeout", reason: "timeout", externalEffectsMayContinue: true }],
    ["cancelled", { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true }],
    ["error", { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true }],
  ] as const)("maps %s to its canonical terminal", (reason, expected) => {
    expect(mapTerminateReasonToTerminal(reason)).toStrictEqual(expected);
    expect(mapTerminateReasonToTerminal(reason, false)).toStrictEqual(expected);
  });
});
