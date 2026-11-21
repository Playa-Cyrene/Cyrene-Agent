import { isBoundedJson, strictObject } from "./qq-module/validation";

export type QqLifecycleDiagnosticStatus = "absent" | "locked" | "incomplete" | "corrupt" | "unavailable" | "dirty" | "clean-retired" | "recorded";
export interface QqLifecycleStoreDiagnostic { status: QqLifecycleDiagnosticStatus; phase?: "prepared" | "legacy-stopped" | "module-staged" | "selected" | "committed" | "rolled-back" | "disabled" }
export interface QqLifecycleDiagnostics {
  schemaVersion: 1;
  startupMode: "legacy" | "blocked";
  manualReviewRequired: boolean;
  stores: Record<"migration" | "firstSetup" | "recovery" | "driverOwnership" | "adoption", QqLifecycleStoreDiagnostic>;
}
const statuses = ["absent", "locked", "incomplete", "corrupt", "unavailable", "dirty", "clean-retired", "recorded"];
const phases = ["prepared", "legacy-stopped", "module-staged", "selected", "committed", "rolled-back", "disabled"];
export function validateQqLifecycleDiagnostics(value: unknown): value is QqLifecycleDiagnostics {
  if (!isBoundedJson(value)) return false;
  const item = (v: unknown): boolean => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    return strictObject(v, { status: s => statuses.includes(s as string) }, { phase: p => phases.includes(p as string) })
      && (r.status === "recorded" ? phases.includes(r.phase as string) : r.phase === undefined);
  };
  if (!strictObject(value, { schemaVersion: v => v === 1, startupMode: v => v === "legacy" || v === "blocked", manualReviewRequired: v => typeof v === "boolean",
    stores: v => strictObject(v, { migration: item, firstSetup: item, recovery: item, driverOwnership: item, adoption: item }) })) return false;
  const v = value as QqLifecycleDiagnostics;
  const blocked = Object.values(v.stores).some(s => s.status !== "absent");
  return v.startupMode === (blocked ? "blocked" : "legacy") && v.manualReviewRequired === Object.values(v.stores).some(s => ["dirty", "locked", "incomplete", "corrupt", "unavailable"].includes(s.status));
}
