import { lstatSync } from "node:fs";
import { join } from "node:path";
import { QqMigrationStore } from "./migration-store";
import { QqFirstSetupStore } from "./first-setup-store";

/** Fixed host-owned locations, never renderer input. Reading never creates a store. */
export function qqLifecyclePaths(userDataPath: string): { migration: string; firstSetup: string } {
  return { migration: join(userDataPath, "qq-module-migration"), firstSetup: join(userDataPath, "qq-module-first-setup") };
}

/** A durable choice is not proof that the previous process stopped or that either
 * driver is safe to restart. Even rolled-back means "not restarted", not permission
 * to resume legacy. Recovery requires a separate explicit host action and live proof.
 * Corrupt/inaccessible stores fail closed; never delete locks or guess an identity. */
export function getQqStartupMode(userDataPath: string): "legacy" | "blocked" {
  try {
    const paths = qqLifecyclePaths(userDataPath);
    for (const [root, lock] of [[paths.migration, "migration-lock"], [paths.firstSetup, "setup-lock"]]) {
      try {
        const stat = lstatSync(root);
        if (stat.isSymbolicLink() || !stat.isDirectory()) return "blocked";
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "blocked"; }
      try { lstatSync(join(root, lock)); return "blocked"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "blocked"; }
    }
    if (new QqMigrationStore(paths.migration).read() || new QqFirstSetupStore(paths.firstSetup).read()) return "blocked";
    return "legacy";
  } catch { return "blocked"; }
}
