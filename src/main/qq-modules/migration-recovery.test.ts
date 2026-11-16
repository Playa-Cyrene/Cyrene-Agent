import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { QqInitialize } from "../../shared/qq-module";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { QqModuleManager } from "./manager";
import { QqMigrationCoordinator } from "./migration";
import { QqMigrationStore } from "./migration-store";

const packageId = `pkg-${"a".repeat(64)}`;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function setup() {
  const root = mkdtempSync(join(tmpdir(), "qq-recovery-"));
  const originals = [join(root, "settings.json"), join(root, "history.json"), join(root, "bindings.json")];
  const settings = Buffer.from(JSON.stringify({ qq: { enabled: true, listenMode: "loopback", port: 6200,
    accessToken: "plain:synthetic-only", allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"],
    groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal" } }));
  [settings, Buffer.from("synthetic history"), Buffer.from("synthetic bindings")].forEach((bytes, i) => writeFileSync(originals[i], bytes));
  const before = originals.map((p) => readFileSync(p));
  const fault = { rollbackWrite: false, selectedWrite: false, activation: "ok" as "ok" | "false" | "throw" | "after" | "unconfirmed", stop: "ok" as "ok" | "throw" | "unknown" };
  const modules: QqModuleManager[] = []; const peers: FakeTransport[] = [];
  let current: QqModuleManager | undefined; let legacyRunning = true; let legacyEpoch = 7;
  const store = new QqMigrationStore(join(root, "migration"), (record) => {
    if (record.phase === "rolled-back" && fault.rollbackWrite || record.phase === "selected" && fault.selectedWrite) throw new Error("synthetic persistence failure");
  });
  const legacy = { getMigrationIdentity: vi.fn(() => legacyRunning ? { accountId: "10000", connectionEpoch: legacyEpoch } : null),
    prepareMigrationStop: vi.fn(async () => { legacyRunning = false; return { safeToSwitch: true, drained: true, stopped: true }; }) };
  const activate = vi.fn(); const stop = vi.fn();
  const options = { store, readLegacySettings: () => readFileSync(originals[0]), legacy,
    secureStorage: { isSecureAvailable: () => true, decryptString: () => "unused" }, legacyMachine: { userDataPath: root, appName: "Synthetic" }, interfaces: {},
    verifyCandidate: vi.fn(), createModule: vi.fn((input: QqInitialize) => {
      const manager = new QqModuleManager({ getConfiguration: () => input, requestTimeoutMs: 100, drainTimeoutMs: 100,
        createTransport: () => { const peer = new FakeTransport(); peers.push(peer); return peer; } });
      const realActivate = manager.activateMigration.bind(manager); const realStop = manager.stop.bind(manager);
      vi.spyOn(manager, "activateMigration").mockImplementation(() => {
        activate();
        if (fault.activation === "false") return false;
        if (fault.activation === "unconfirmed") return true;
        if (fault.activation === "throw") throw new Error("synthetic activation failure");
        const result = realActivate();
        if (fault.activation === "after") throw new Error("synthetic failure after activation");
        return result;
      });
      vi.spyOn(manager, "stop").mockImplementation(async () => {
        stop();
        if (fault.stop === "throw") throw new Error("synthetic stop failure");
        if (fault.stop === "unknown") return;
        await realStop();
      });
      modules.push(manager); current = manager; return manager;
    }) };
  const coordinator = new QqMigrationCoordinator(options);
  const preview = coordinator.previewMigration(packageId);
  const consent = { previewId: preview.previewId, accountId: preview.accountId, userConfirmed: true as const };
  const confirm = () => coordinator.confirmMigration(consent);
  const bytes = () => readFileSync(join(store.root, "state.json"));
  cleanups.push(async () => {
    for (const peer of peers) peer.crash();
    await Promise.all(modules.map((m) => m.stop()));
    originals.forEach((p, i) => expect(readFileSync(p)).toEqual(before[i]));
    if (store.read()) expect(bytes().toString()).not.toContain("synthetic-only");
    rmSync(root, { recursive: true, force: true });
  });
  return { root, fault, store, options, coordinator, consent, confirm, bytes, legacy, activate, stop,
    get manager() { return current!; }, get peer() { return peers.at(-1)!; }, restartLegacy() { legacyRunning = true; legacyEpoch++; } };
}

it.each(["false", "throw", "unconfirmed"] as const)("keeps failed activation (%s) and failed rollback writes recoverable across retries and restart", async (activation) => {
  const s = await setup(); s.fault.activation = activation; s.fault.rollbackWrite = true;
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  for (let i = 0; i < 3; i++) expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()).toMatchObject({ phase: "selected", transactionId: s.consent.previewId, packageId });
  const evidence = s.bytes();
  expect(s.options.createModule).toHaveBeenCalledOnce(); expect(s.legacy.prepareMigrationStop).toHaveBeenCalledOnce(); expect(s.activate).toHaveBeenCalledOnce();
  const restarted = new QqMigrationCoordinator({ ...s.options, store: new QqMigrationStore(s.store.root) });
  expect(() => restarted.previewMigration(packageId)).toThrow("existing-migration-requires-review");
  await expect(restarted.confirmMigration(s.consent)).rejects.toThrow("stale-or-mismatched-confirmation");
  expect(await restarted.rollbackStoppedMigration(async () => false)).toMatchObject({ outcome: "recovery-required" });
  expect(s.bytes()).toEqual(evidence);
  s.fault.rollbackWrite = false;
  expect(await restarted.rollbackStoppedMigration(async () => s.manager.isStoppedForMigration())).toMatchObject({ outcome: "rolled-back" });
  expect(s.store.read()).toMatchObject({ phase: "rolled-back", transactionId: s.consent.previewId, packageId });
});

it.each(["throw", "unknown"] as const)("does not clear recovery evidence or spawn another driver when stop is %s", async (stop) => {
  const s = await setup(); s.fault.activation = "false"; s.fault.stop = stop;
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  const evidence = s.bytes();
  expect(s.manager.isStoppedForMigration()).toBe(false);
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  const proof = vi.fn(async () => true);
  expect(await s.coordinator.rollbackStoppedMigration(proof)).toMatchObject({ outcome: "recovery-required", errorCode: "module-stop-unconfirmed" });
  expect(proof).not.toHaveBeenCalled(); expect(s.bytes()).toEqual(evidence);
  expect(s.options.createModule).toHaveBeenCalledOnce(); expect(() => s.coordinator.previewMigration(packageId)).toThrow("existing-migration-requires-review");
});

it("never treats an uncertain partial activation as success even while its process is still active", async () => {
  const s = await setup(); s.fault.activation = "after"; s.fault.stop = "throw";
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  expect(s.manager.getActiveMigrationIdentity()).not.toBeNull();
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  expect(s.options.createModule).toHaveBeenCalledOnce(); expect(s.activate).toHaveBeenCalledOnce();
});

it("requires successful durable selection before any activation and preserves normal rollback", async () => {
  const s = await setup(); s.fault.selectedWrite = true;
  expect(await s.confirm()).toMatchObject({ outcome: "rolled-back" });
  expect(s.activate).not.toHaveBeenCalled(); expect(s.manager.getActiveMigrationIdentity()).toBeNull();
  expect(s.store.read()?.phase).toBe("rolled-back");
  expect(await s.confirm()).toMatchObject({ outcome: "rolled-back" });
  expect(s.options.createModule).toHaveBeenCalledOnce();
});

it("only repeats successful confirmation for the same live generation, not the disk marker after restart", async () => {
  const s = await setup(); expect(await s.confirm()).toMatchObject({ outcome: "committed" });
  expect(s.store.read()?.phase).toBe("selected");
  expect(s.manager.getActiveMigrationIdentity()).toMatchObject({ selfId: "10000", connectionEpoch: 1, runtimeEpoch: 1 });
  expect(await s.confirm()).toMatchObject({ outcome: "committed" }); expect(s.activate).toHaveBeenCalledOnce();
  const restarted = new QqMigrationCoordinator({ ...s.options, store: new QqMigrationStore(s.store.root) });
  expect(() => restarted.previewMigration(packageId)).toThrow("existing-migration-requires-review");
  await expect(restarted.confirmMigration(s.consent)).rejects.toThrow("stale-or-mismatched-confirmation");
  expect(await restarted.rollbackStoppedMigration(async () => false)).toMatchObject({ outcome: "recovery-required" });
  expect(s.options.createModule).toHaveBeenCalledOnce();
});

it.each(["disconnect", "reconnect", "generation"] as const)("rejects a stale success receipt after %s", async (change) => {
  const s = await setup(); expect(await s.confirm()).toMatchObject({ outcome: "committed" });
  if (change === "generation") await s.manager.restart();
  else {
    s.peer.event("status", { phase: "waiting-backend" });
    if (change === "reconnect") s.peer.event("status", { phase: "running", selfId: "10000", connectionEpoch: 2 });
  }
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()?.phase).toBe("selected"); expect(s.options.createModule).toHaveBeenCalledOnce();
});

it("accepts legacy committed records for recovery but never as live success proof", async () => {
  const s = await setup(); expect(await s.confirm()).toMatchObject({ outcome: "committed" });
  await s.store.locked(async (save) => save({ ...s.store.read()!, phase: "committed" }));
  expect(new QqMigrationStore(s.store.root).read()?.phase).toBe("committed");
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  const restarted = new QqMigrationCoordinator({ ...s.options, store: new QqMigrationStore(s.store.root) });
  expect(() => restarted.previewMigration(packageId)).toThrow("existing-migration-requires-review");
  expect(await restarted.rollbackStoppedMigration(async () => false)).toMatchObject({ outcome: "recovery-required" });
});

it("keeps selected evidence if explicit rollback persistence fails after a successful activation", async () => {
  const s = await setup(); expect(await s.confirm()).toMatchObject({ outcome: "committed" }); const evidence = s.bytes();
  s.fault.rollbackWrite = true;
  expect(await s.coordinator.rollbackStoppedMigration(async () => true)).toMatchObject({ outcome: "recovery-required", errorCode: "rollback-persist-failed" });
  expect(s.manager.isStoppedForMigration()).toBe(true); expect(s.bytes()).toEqual(evidence);
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  s.fault.rollbackWrite = false;
  expect(await s.coordinator.rollbackStoppedMigration(async () => true)).toMatchObject({ outcome: "rolled-back" });
  await expect(s.confirm()).rejects.toThrow("stale-or-mismatched-confirmation");
});

it("does not erase evidence when external stop verification throws", async () => {
  const s = await setup(); expect(await s.confirm()).toMatchObject({ outcome: "committed" }); const evidence = s.bytes();
  expect(await s.coordinator.rollbackStoppedMigration(async () => { throw new Error("unknown processes"); })).toMatchObject({ outcome: "recovery-required", errorCode: "driver-stop-unconfirmed" });
  expect(s.bytes()).toEqual(evidence); expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
});

it("permits a fresh migration only after verified recovery, a new preview and a new live legacy identity", async () => {
  const s = await setup(); s.fault.activation = "false"; s.fault.rollbackWrite = true;
  expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" });
  s.fault.rollbackWrite = false;
  expect(await s.coordinator.rollbackStoppedMigration(async () => s.manager.isStoppedForMigration())).toMatchObject({ outcome: "rolled-back" });
  expect(() => s.coordinator.previewMigration(packageId)).toThrow("confirmed-live-account-required");
  s.fault.activation = "ok"; s.restartLegacy();
  const next = s.coordinator.previewMigration(packageId); expect(next.previewId).not.toBe(s.consent.previewId);
  expect(await s.coordinator.confirmMigration({ previewId: next.previewId, accountId: next.accountId, userConfirmed: true })).toMatchObject({ outcome: "committed" });
  expect(s.options.createModule).toHaveBeenCalledTimes(2); expect(s.legacy.prepareMigrationStop).toHaveBeenCalledTimes(2);
});
