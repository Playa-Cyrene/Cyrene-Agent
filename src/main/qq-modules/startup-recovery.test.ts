import { mkdtempSync, symlinkSync, existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { getQqStartupMode, qqLifecyclePaths } from "./startup-recovery";
import { QqFirstSetupStore } from "./first-setup-store";
import { configuration } from "../../../scripts/verify/qq-module/fixtures";
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "qq-startup-gate-")); roots.push(path); return path; };
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));
it("keeps untouched installations on legacy without creating sidecars", () => {
  const directory = root(); expect(getQqStartupMode(directory)).toBe("legacy");
  for (const path of Object.values(qqLifecyclePaths(directory))) expect(existsSync(path)).toBe(false);
});
it.each(["prepared", "module-staged", "selected", "rolled-back"] as const)("blocks automatic startup for first setup phase %s", async (phase) => {
  const directory = root(), paths = qqLifecyclePaths(directory);
  await new QqFirstSetupStore(paths.firstSetup).locked(async (save) => save({
    schemaVersion: 1, transactionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    packageId: `pkg-${"a".repeat(64)}`, config: configuration().config, phase,
  }));
  expect(getQqStartupMode(directory)).toBe("blocked");
});
it("blocks invalid/unrecognized migration and first-setup directories without repairing them", () => {
  for (const kind of ["migration", "firstSetup", "recovery"] as const) {
    const directory = root(), paths = qqLifecyclePaths(directory); mkdirSync(paths[kind]);
    writeFileSync(join(paths[kind], "state.json"), "invalid");
    expect(getQqStartupMode(directory)).toBe("blocked");
    expect(existsSync(join(paths[kind], "state.json"))).toBe(true);
  }
});

it("blocks an interrupted transaction lock even before its first state write", async () => {
  const directory = root(), path = qqLifecyclePaths(directory).firstSetup;
  // A valid empty store can be left between lock creation and first save.
  await new QqFirstSetupStore(path).locked(async () => {});
  writeFileSync(join(path, "setup-lock"), "");
  expect(getQqStartupMode(directory)).toBe("blocked");
  expect(existsSync(join(path, "setup-lock"))).toBe(true);
});

it.skipIf(process.platform === "win32")("blocks a dangling sidecar symlink instead of treating it as absent", () => {
  const directory = root(), path = qqLifecyclePaths(directory).recovery;
  symlinkSync(join(directory, "missing"), path);
  expect(getQqStartupMode(directory)).toBe("blocked");
});

it("blocks recovery locks before the first durable state and never deletes them", () => {
  const directory = root(), path = qqLifecyclePaths(directory).recovery;
  mkdirSync(path); writeFileSync(join(path, "recovery-lock"), "");
  expect(getQqStartupMode(directory)).toBe("blocked");
  expect(existsSync(join(path, "recovery-lock"))).toBe(true);
});

it.each(["migration", "firstSetup", "recovery"] as const)("blocks an existing %s directory even when its state was lost", (kind) => {
  const directory = root(), path = qqLifecyclePaths(directory)[kind];
  mkdirSync(path);
  expect(getQqStartupMode(directory)).toBe("blocked");
  expect(existsSync(path)).toBe(true);
});
