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
type StoreKind = keyof QqLifecycleDiagnostics["stores"];
/** Only phases that do not themselves call for manual review in this store.
 * A recorded choice still does not prove that any driver is safe to start. */
export function isRecordedQqLifecyclePhase(kind: StoreKind, phase: unknown): boolean {
  switch (kind) {
    case "migration":
    case "firstSetup":
      return phase === "selected";
    case "recovery":
      return phase === "selected" || phase === "disabled" || phase === "rolled-back";
    case "adoption":
      return phase === "prepared";
    case "driverOwnership":
      return false;
  }
}
export function validateQqLifecycleDiagnostics(value: unknown): value is QqLifecycleDiagnostics {
  if (!isBoundedJson(value)) return false;
  const item = (kind: StoreKind) => (v: unknown): boolean => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    return strictObject(v, { status: s => statuses.includes(s as string) }, { phase: p => isRecordedQqLifecyclePhase(kind, p) })
      && (r.status === "recorded" ? r.phase !== undefined : r.phase === undefined);
  };
  if (!strictObject(value, { schemaVersion: v => v === 1, startupMode: v => v === "legacy" || v === "blocked", manualReviewRequired: v => typeof v === "boolean",
    stores: v => strictObject(v, { migration: item("migration"), firstSetup: item("firstSetup"), recovery: item("recovery"), driverOwnership: item("driverOwnership"), adoption: item("adoption") }) })) return false;
  const v = value as QqLifecycleDiagnostics;
  const blocked = Object.values(v.stores).some(s => s.status !== "absent");
  return v.startupMode === (blocked ? "blocked" : "legacy") && v.manualReviewRequired === Object.values(v.stores).some(s => ["dirty", "locked", "incomplete", "corrupt", "unavailable"].includes(s.status));
}
