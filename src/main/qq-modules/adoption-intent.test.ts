import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { QqAdoptionIntentStore } from "./adoption-intent";
import { getQqStartupMode } from "./startup-recovery";
import { QqDriverOwnershipSupervisor } from "./driver-ownership";
import { QqAdoptionProofCoordinator, type QqAdoptionContext } from "./adoption-proof";
const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "qq-adoption-test-")); roots.push(path); return path; };
const context: QqAdoptionContext = { platform: "win32", scopeId: "test", sessionEpoch: "session", mode: "new-install", previousHostSha256: null, hostSha256: "a".repeat(64), moduleSha256: "b".repeat(64) };
afterEach(() => { roots.splice(0).forEach(p => rmSync(p, { force: true, recursive: true })); });
it("persists strict prepared evidence and gates legacy startup without granting absence", () => {
  const path = root(), store = new QqAdoptionIntentStore(path);
  expect(store.read()).toBeNull(); expect(getQqStartupMode(path)).toBe("legacy");
  store.persistIntent(context); expect(store.read()).toMatchObject({ phase: "prepared", context });
  expect(getQqStartupMode(path)).toBe("blocked"); expect(() => store.persistIntent(context)).toThrow();
});
it("preserves empty/partial roots for manual review", () => {
  const path = root(), store = new QqAdoptionIntentStore(path); mkdirSync(store.root);
  expect(getQqStartupMode(path)).toBe("blocked"); expect(() => store.read()).toThrow(); expect(() => store.persistIntent(context)).toThrow();
});
it("rejects extra state fields", () => {
  const store = new QqAdoptionIntentStore(root()); store.persistIntent(context);
  writeFileSync(join(store.root, "state.json"), JSON.stringify({ ...store.read(), unexpected: true }));
  expect(() => store.read()).toThrow();
});
it("adoption evidence does not override an existing dirty ownership scope", async () => {
  const path = root(), directory = join(path, "ownership"), store = new QqAdoptionIntentStore(path);
  QqDriverOwnershipSupervisor.open({ directory, scopeId: context.scopeId, bootstrap: { verifyInitialScope: () => true } });
  const coordinator = new QqAdoptionProofCoordinator({ readContext: () => context, persistIntent: c => store.persistIntent(c),
    reviewedPolicy: { approve: () => true }, exclusiveScope: { freezeAndProve: async () => ({ isHeld: () => true, release() {} }) } });
  const proof = await coordinator.prepare();
  expect(() => QqDriverOwnershipSupervisor.open({ directory, scopeId: proof.scopeId, bootstrap: proof.bootstrap })).toThrow();
  proof.cancel();
});
