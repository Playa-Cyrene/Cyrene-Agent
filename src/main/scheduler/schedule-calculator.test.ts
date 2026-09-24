import { describe, expect, it } from "vitest";
import {
  computeInitialNextFireAt,
  computeNextFireAtAfter,
  normalizeOverdueNextFireAt,
} from "./schedule-calculator";
import type { ScheduleConfig } from "./types";

const iso = (value: Date | null): string | null => value ? value.toISOString() : null;

describe("schedule calculator", () => {
  it("uses the once runAt when it is in the future", () => {
    const now = new Date("2026-06-22T08:00:00.000Z");
    const schedule: ScheduleConfig = { kind: "once", runAt: "2026-06-22T09:00:00.000Z" };
    expect(iso(computeInitialNextFireAt(schedule, now))).toBe("2026-06-22T09:00:00.000Z");
  });

  it("returns null for once runAt in the past", () => {
    const now = new Date("2026-06-22T10:00:00.000Z");
    const schedule: ScheduleConfig = { kind: "once", runAt: "2026-06-22T09:00:00.000Z" };
    expect(computeInitialNextFireAt(schedule, now)).toBeNull();
  });

  it("computes daily today when time has not passed", () => {
    const now = new Date(2026, 5, 22, 7, 30, 0, 0);
    const next = computeInitialNextFireAt({ kind: "daily", timeOfDay: "08:00" }, now);
    expect(next?.getFullYear()).toBe(2026);
    expect(next?.getMonth()).toBe(5);
    expect(next?.getDate()).toBe(22);
    expect(next?.getHours()).toBe(8);
    expect(next?.getMinutes()).toBe(0);
  });

  it("computes daily tomorrow when time has passed", () => {
    const now = new Date(2026, 5, 22, 8, 30, 0, 0);
    const next = computeInitialNextFireAt({ kind: "daily", timeOfDay: "08:00" }, now);
    expect(next?.getDate()).toBe(23);
    expect(next?.getHours()).toBe(8);
  });

  it("computes weekly next matching weekday", () => {
    const monday = new Date(2026, 5, 22, 7, 0, 0, 0);
    expect(monday.getDay()).toBe(1);
    const next = computeInitialNextFireAt({ kind: "weekly", dayOfWeek: 3, timeOfDay: "09:30" }, monday);
    expect(next?.getDate()).toBe(24);
    expect(next?.getDay()).toBe(3);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(30);
  });

  it("computes weekdays without firing on a weekend", () => {
    const friday = new Date(2026, 5, 26, 18, 0, 0, 0);
    const next = computeInitialNextFireAt({ kind: "weekdays", timeOfDay: "09:00" }, friday);
    expect(next?.getDay()).toBe(1);
    expect(next?.getDate()).toBe(29);
    expect(next?.getHours()).toBe(9);
  });

  it("computes monthly and yearly calendar schedules", () => {
    const now = new Date(2026, 0, 20, 12, 0, 0, 0);
    const monthly = computeInitialNextFireAt({ kind: "monthly", dayOfMonth: 15, timeOfDay: "08:30" }, now);
    const yearly = computeInitialNextFireAt({ kind: "yearly", month: 3, dayOfMonth: 1, timeOfDay: "10:00" }, now);
    expect(monthly?.getMonth()).toBe(1);
    expect(monthly?.getDate()).toBe(15);
    expect(yearly?.getMonth()).toBe(2);
    expect(yearly?.getDate()).toBe(1);
  });

  it("uses scheduledFireAt as interval baseline to avoid drift", () => {
    const scheduledFireAt = new Date("2026-06-22T08:00:00.000Z");
    const schedule: ScheduleConfig = { kind: "interval", every: 1, unit: "hours" };
    expect(iso(computeNextFireAtAfter(schedule, scheduledFireAt))).toBe("2026-06-22T09:00:00.000Z");
  });

  it("normalizes overdue interval by rolling forward without backfilling", () => {
    const now = new Date("2026-06-22T12:15:00.000Z");
    const overdue = new Date("2026-06-22T08:00:00.000Z");
    const schedule: ScheduleConfig = { kind: "interval", every: 1, unit: "hours" };
    expect(iso(normalizeOverdueNextFireAt(schedule, overdue, now))).toBe("2026-06-22T13:00:00.000Z");
  });

  it("normalizes very old minute intervals without returning a still-overdue time", () => {
    const now = new Date("2026-06-22T12:00:00.000Z");
    const overdue = new Date("2025-01-01T00:00:00.000Z");
    const schedule: ScheduleConfig = { kind: "interval", every: 1, unit: "minutes" };
    const next = normalizeOverdueNextFireAt(schedule, overdue, now);
    expect(next?.getTime()).toBeGreaterThan(now.getTime());
    expect(iso(next)).toBe("2026-06-22T12:01:00.000Z");
  });
});
