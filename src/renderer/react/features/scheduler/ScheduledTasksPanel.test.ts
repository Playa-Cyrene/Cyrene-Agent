import { describe, expect, it } from "vitest";
import { scheduleFromEditor, type EditorValues } from "./ScheduledTasksPanel";

const base: EditorValues = {
  title: "task", prompt: "do it", mode: "work", enabled: true, kind: "daily", runAt: "",
  timeOfDay: "08:00", dayOfWeek: 1, every: 1, unit: "hours", limitTools: false, allowedToolIds: [],
};

describe("scheduleFromEditor", () => {
  it("creates recurring schedules from the selected mode", () => {
    expect(scheduleFromEditor({ ...base, kind: "weekly", timeOfDay: "09:30", dayOfWeek: 5 }))
      .toEqual({ kind: "weekly", timeOfDay: "09:30", dayOfWeek: 5 });
    expect(scheduleFromEditor({ ...base, kind: "interval", every: 2, unit: "hours" }))
      .toEqual({ kind: "interval", every: 2, unit: "hours" });
  });

  it("rejects invalid clock values and out-of-range intervals", () => {
    expect(() => scheduleFromEditor({ ...base, kind: "daily", timeOfDay: "25:90" })).toThrow("HH:mm");
    expect(() => scheduleFromEditor({ ...base, kind: "interval", every: 169, unit: "hours" })).toThrow("间隔");
  });

  it("requires a one-time run to be in the future", () => {
    expect(() => scheduleFromEditor({ ...base, kind: "once", runAt: "2000-01-01T00:00" })).toThrow("晚于当前时间");
  });
});
