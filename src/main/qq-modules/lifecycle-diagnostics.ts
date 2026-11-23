import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { QqAdoptionIntentStore } from "./adoption-intent";
import { qqFirstSetupLockPath, qqLifecyclePaths } from "./startup-recovery";
import { validateQqMigrationRecord } from "./migration-store";
import { validateQqFirstSetupRecord } from "./first-setup-store";
import { validateQqRecoveryRecord } from "./recovery-store";

import type { QqLifecycleDiagnostics, QqLifecycleStoreDiagnostic } from "../../shared/qq-module-diagnostics";
export type { QqLifecycleDiagnostics } from "../../shared/qq-module-diagnostics";

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
function safeParents(path: string): void {
  for (let p = path;; p = dirname(p)) {
    const s = lstatSync(p);
    if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("unsafe");
    if (dirname(p) === p) break;
  }
}
function file(path: string, limit: number): string {
  const s = lstatSync(path);
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > limit) throw new Error("unsafe");
  const b = readFileSync(path);
  if (b.length > limit) throw new Error("unsafe");
  return b.toString("utf8");
}
function inspect(root: string, kind: keyof QqLifecycleDiagnostics["stores"]): QqLifecycleStoreDiagnostic {
  try {
    if (kind === "firstSetup") {
      try { lstatSync(qqFirstSetupLockPath(root)); return { status: "locked" }; }
      catch (e) { if (!missing(e)) throw e; }
    }
    try { const s = lstatSync(root); if (!s.isDirectory() || s.isSymbolicLink()) return { status: "corrupt" }; }
    catch (e) { if (missing(e)) return { status: "absent" }; throw e; }
    if (kind === "adoption") {
      const names = readdirSync(root);
      if (!names.includes("state.json") || !names.includes("intent-lock") || names.includes("state.tmp")) return { status: "incomplete" };
      const intent = new QqAdoptionIntentStore(dirname(root)).read();
      return intent ? { status: "recorded", phase: "prepared" } : { status: "incomplete" };
    }
    const owner = kind === "driverOwnership";
    const lock = owner ? "owner.lock" : kind === "migration" ? "migration-lock" : kind === "firstSetup" ? "setup-lock" : "recovery-lock";
    const names = readdirSync(root);
    // A lock is evidence only: no PID probes, expiration assumptions or cleanup.
    if (names.includes(lock)) return { status: "locked" };
    const state = owner ? "ownership.json" : "state.json";
    if (names.some(n => n.startsWith(".state-") || /^ownership-.*\.tmp$/.test(n))) return { status: "incomplete" };
    if (names.some(n => ![state, ...(owner ? [] : ["marker"])].includes(n))) return { status: "corrupt" };
    if (!names.includes(state) || (!owner && !names.includes("marker"))) return { status: "incomplete" };
    if (!owner) {
      const marker = kind === "migration" ? "Cyrene QQ migration rehearsal v1\n" : kind === "firstSetup" ? "Cyrene QQ first setup v1\n" : "Cyrene QQ recovery v1\n";
      if (file(join(root, "marker"), 128) !== marker) return { status: "corrupt" };
    }
    const value: unknown = JSON.parse(file(join(root, state), owner ? 4096 : 256 * 1024));
    if (owner) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "corrupt" };
      const v = value as Record<string, unknown>;
      if (Object.keys(v).sort().join(",") !== "epoch,phase,schema,scopeId" || v.schema !== 1
        || typeof v.scopeId !== "string" || !v.scopeId || v.scopeId.length > 200
        || typeof v.epoch !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v.epoch)
        || !["dirty", "clean-retired"].includes(v.phase as string)) return { status: "corrupt" };
      return { status: v.phase as "dirty" | "clean-retired" };
    }
    const valid = kind === "migration" ? validateQqMigrationRecord(value) : kind === "firstSetup" ? validateQqFirstSetupRecord(value) : validateQqRecoveryRecord(value);
    if (!valid) return { status: "corrupt" };
    return { status: "recorded", phase: (value as { phase: QqLifecycleStoreDiagnostic["phase"] }).phase };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { status: code === "EACCES" || code === "EPERM" ? "unavailable" : "corrupt" };
  }
}
/** Host-only fixed profile input. Observational snapshot, NEVER an ownership or startup grant.
 * No returned filesystem paths, identities, credential revisions or raw error strings. */
export function readQqLifecycleDiagnostics(userDataPath: string): QqLifecycleDiagnostics {
  const stores = {} as QqLifecycleDiagnostics["stores"];
  let safe = false;
  try {
    if (!isAbsolute(userDataPath) || resolve(userDataPath) === parse(resolve(userDataPath)).root) throw new Error("unsafe");
    safeParents(userDataPath); safe = true;
  } catch { /* fail closed without disclosing filesystem errors */ }
  const paths = qqLifecyclePaths(userDataPath);
  for (const kind of Object.keys(paths) as (keyof typeof paths)[]) stores[kind] = safe ? inspect(paths[kind], kind) : { status: "unavailable" };
  const blocked = Object.values(stores).some(s => s.status !== "absent");
  return { schemaVersion: 1, startupMode: blocked ? "blocked" : "legacy", manualReviewRequired: Object.values(stores).some(s => ["dirty", "locked", "incomplete", "corrupt", "unavailable"].includes(s.status)), stores };
}
