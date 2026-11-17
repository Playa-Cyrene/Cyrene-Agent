import { lstatSync } from "node:fs";
import { join } from "node:path";

/** Fixed host-owned locations, never renderer input. Reading never creates a store. */
export function qqLifecyclePaths(userDataPath: string): { migration: string; firstSetup: string; recovery: string; driverOwnership: string } {
  return { driverOwnership: join(userDataPath, "qq-module-driver-ownership"), recovery: join(userDataPath, "qq-module-recovery"), migration: join(userDataPath, "qq-module-migration"), firstSetup: join(userDataPath, "qq-module-first-setup") };
}

/** A durable choice is not proof that the previous process stopped or that either
 * driver is safe to restart. Even rolled-back means "not restarted", not permission
 * to resume legacy. Recovery requires a separate explicit host action and live proof.
 * Corrupt/inaccessible stores fail closed; never delete locks or guess an identity. */
export function getQqStartupMode(userDataPath: string): "legacy" | "blocked" {
  try {
    const paths = qqLifecyclePaths(userDataPath);
    for (const root of Object.values(paths)) {
      // Even an empty/valid-marked directory is an ambiguous durable artifact:
      // a selected state may have been lost. Never infer "never configured" from
      // a missing state file and restart legacy. Read-only; do not repair/delete.
      try { lstatSync(root); return "blocked"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "blocked"; }
    }
    return "legacy";
  } catch { return "blocked"; }
}
