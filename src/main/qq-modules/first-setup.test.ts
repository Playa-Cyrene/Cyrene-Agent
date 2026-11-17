import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { QqFirstSetupCoordinator } from "./first-setup";
import { QqFirstSetupStore, type QqFirstSetupRecord } from "./first-setup-store";
import { QqModuleManager } from "./manager";
import { FakeTransport, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
const roots: string[] = [];
const managers: QqModuleManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.stop())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const packageId = `pkg-${"a".repeat(64)}`;
function setup(checkpoint: (record: QqFirstSetupRecord) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "qq-first-setup-")); roots.push(root);
  const directory = join(root, "setup"), store = new QqFirstSetupStore(directory, checkpoint);
  let config = configuration().config;
  const secureStorage = { isSecureAvailable: vi.fn(() => true) };
  const readCredential = vi.fn(() => "synthetic-secret-DO-NOT-PERSIST");
  const verifyNoLegacyDriver = vi.fn(async () => true);
  const verifyCandidate = vi.fn();
  let peer: FakeTransport | undefined; let manager: QqModuleManager | undefined;
  const handler = vi.fn(async () => null);
  const createModule = vi.fn((input) => {
    const snapshot = structuredClone(input);
    peer = new FakeTransport();
    const original = peer.behavior;
    peer.behavior = (request) => { original(request); if (request.method === "start") peer!.event("inbound", inbound("quarantined")); };
    manager = new QqModuleManager({ getConfiguration: () => snapshot, createTransport: () => peer!, requestTimeoutMs: 50, drainTimeoutMs: 50 });
    manager.onMessage = handler; managers.push(manager); return manager;
  });
  const options = { store, secureStorage, readConfiguration: () => config, readCredential, verifyNoLegacyDriver, verifyCandidate, createModule, backendReconnectTimeoutMs: 50 };
  const coordinator = new QqFirstSetupCoordinator(options);
  const preview = () => coordinator.previewSetup(packageId);
  const confirm = (p: ReturnType<typeof preview>) => coordinator.confirmSetup({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true });
  return { root, directory, store, options, coordinator, preview, confirm, secureStorage, readCredential, verifyNoLegacyDriver,
    verifyCandidate, createModule, handler, get peer() { return peer!; }, get manager() { return manager!; }, changeConfig: () => { config = { ...config, configRevision: 2 }; } };
}
it("previews and cancels without old data, secret reads, writes or process creation", async () => {
  const s = setup(); const p = s.preview();
  expect(p.accountId).toBe("10000"); expect(existsSync(s.directory)).toBe(false);
  s.coordinator.cancel({ previewId: p.previewId });
  await expect(s.confirm(p)).rejects.toThrow("stale-confirmation");
  expect(s.readCredential).not.toHaveBeenCalled(); expect(s.createModule).not.toHaveBeenCalled();
  expect(s.verifyNoLegacyDriver).not.toHaveBeenCalled();
});
it("requires secure storage, exact account consent and unchanged configuration", async () => {
  const s = setup(); s.secureStorage.isSecureAvailable.mockReturnValue(false);
  expect(() => s.preview()).toThrow("secure-storage-unavailable");
  s.secureStorage.isSecureAvailable.mockReturnValue(true); const p = s.preview();
  await expect(s.coordinator.confirmSetup({ previewId: p.previewId, accountId: "999", userConfirmed: true })).rejects.toThrow("stale-confirmation");
  await expect(s.coordinator.confirmSetup({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true, path: "/untrusted" })).rejects.toThrow("explicit-account-confirmation");
  s.changeConfig(); await expect(s.confirm(p)).rejects.toThrow("configuration-changed");
  expect(s.readCredential).not.toHaveBeenCalled(); expect(s.createModule).not.toHaveBeenCalled();
});
it("persists recovery intent before checking unknown legacy and never reads credentials on failed proof", async () => {
  const s = setup(); s.verifyNoLegacyDriver.mockResolvedValue(false); const p = s.preview();
  expect(await s.confirm(p)).toMatchObject({ outcome: "rolled-back", errorCode: "legacy-driver-not-confirmed-absent" });
  expect(s.store.read()?.phase).toBe("rolled-back"); expect(s.readCredential).not.toHaveBeenCalled(); expect(s.createModule).not.toHaveBeenCalled();
});
it("uses real manager quarantine, saves only nonsecret selection, and never replays consent", async () => {
  const s = setup(); const p = s.preview(); expect(await s.confirm(p)).toEqual({ outcome: "committed" });
  expect(s.handler).not.toHaveBeenCalled();
  expect(s.manager.getActiveMigrationIdentity()).toMatchObject({ selfId: "10000" });
  s.peer.event("inbound", inbound("active")); await new Promise((resolve) => setImmediate(resolve));
  expect(s.handler).toHaveBeenCalledOnce();
  const record = s.store.read(); expect(record).toMatchObject({ phase: "selected", config: { expectedSelfId: "10000" } });
  const saved = readFileSync(join(s.directory, "state.json"), "utf8");
  expect(saved).not.toContain("synthetic-secret"); expect(saved).not.toContain("accessToken"); expect(saved).not.toContain("credential");
  await expect(s.confirm(p)).rejects.toThrow("stale-confirmation");
  expect(s.createModule).toHaveBeenCalledOnce();
  const restart = new QqFirstSetupCoordinator(s.options);
  expect(() => restart.previewSetup(packageId)).toThrow("existing-setup-requires-review");
  expect(s.readCredential).toHaveBeenCalledOnce();
});
it("does not cancel or reconfirm once absence verification is in progress", async () => {
  const s = setup(); let release!: (value: boolean) => void;
  s.verifyNoLegacyDriver.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const p = s.preview(); const result = s.confirm(p);
  expect(() => s.coordinator.cancel({ previewId: p.previewId })).toThrow("operation-busy");
  await expect(s.confirm(p)).rejects.toThrow("operation-busy");
  release(true); expect(await result).toMatchObject({ outcome: "committed" });
});
it("rechecks legacy absence after durable preparation before starting a module", async () => {
  const s = setup(); s.verifyNoLegacyDriver.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "rolled-back", errorCode: "legacy-driver-not-confirmed-absent" });
  expect(s.createModule).not.toHaveBeenCalled(); expect(s.store.read()?.phase).toBe("rolled-back");
});
it("rolls back and stops an unverified backend account without activation", async () => {
  const s = setup();
  s.createModule.mockImplementationOnce((input) => {
    const snapshot = structuredClone(input); const peer = new FakeTransport(); const original = peer.behavior;
    peer.behavior = (req) => { if (req.method === "start") peer.reply(req, { phase: "running", selfId: "999", connectionEpoch: 1 }); else original(req); };
    const manager = new QqModuleManager({ getConfiguration: () => snapshot, createTransport: () => peer, requestTimeoutMs: 50 });
    managers.push(manager); return manager;
  });
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "rolled-back", errorCode: "module-account-unverified" });
  expect(s.store.read()?.phase).toBe("rolled-back");
});
it.each(["prepared", "module-staged", "selected"] as const)("contains %s persistence failure without activating a runtime", async (phase) => {
  const s = setup((record) => { if (record.phase === phase) throw Error("disk failure"); });
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "rolled-back", errorCode: "operation-failed" });
  expect(s.store.read()?.phase).toBe("rolled-back");
  if (s.createModule.mock.calls.length) expect(s.manager.getActiveMigrationIdentity()).toBeNull();
});
it("keeps a recovery marker when rollback persistence also fails", async () => {
  const s = setup((record) => { if (record.phase !== "prepared") throw Error("disk failure"); });
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()?.phase).toBe("prepared");
  expect(() => new QqFirstSetupCoordinator(s.options).previewSetup(packageId)).toThrow("existing-setup-requires-review");
});
it("recovery needs live all-driver stop proof and never restarts either driver", async () => {
  const s = setup(); await s.confirm(s.preview());
  expect(await s.coordinator.rollbackStoppedSetup(async () => false)).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()?.phase).toBe("selected");
  expect(await s.coordinator.rollbackStoppedSetup(async () => true)).toEqual({ outcome: "rolled-back" });
  expect(s.store.read()?.phase).toBe("rolled-back"); expect(s.createModule).toHaveBeenCalledOnce();
});
it("rejects stale on-disk locks and malformed states without guessing recovery", async () => {
  const s = setup(); await s.confirm(s.preview()); await s.manager.stop();
  writeFileSync(join(s.directory, "setup-lock"), "");
  await expect(s.coordinator.rollbackStoppedSetup(async () => true)).rejects.toThrow("busy-or-recovery-required");
  expect(readdirSync(s.directory)).toContain("setup-lock");
  writeFileSync(join(s.directory, "state.json"), JSON.stringify({ token: "not a valid record" }));
  expect(() => s.store.read()).toThrow("invalid-state");
});
it.skipIf(process.platform === "win32")("rejects symlinked persistence directories", () => {
  const s = setup(); const target = join(s.root, "target");
  symlinkSync(s.root, target, "dir");
  expect(() => new QqFirstSetupStore(join(target, "setup")).read()).toThrow("unsafe-store-path");
});
it.each(["trust", "secure", "credential"] as const)("rejects changed %s authority before process creation", async (kind) => {
  const s = setup(); const p = s.preview();
  if (kind === "trust") s.verifyCandidate.mockImplementation(() => { throw Error("revoked trust"); });
  if (kind === "secure") s.secureStorage.isSecureAvailable.mockReturnValue(false);
  if (kind === "credential") s.readCredential.mockReturnValue(" ");
  if (kind === "credential") {
    expect(await s.confirm(p)).toMatchObject({ outcome: "rolled-back", errorCode: "credential-unreadable" });
    expect(s.store.read()?.phase).toBe("rolled-back");
  } else {
    await expect(s.confirm(p)).rejects.toThrow(); expect(s.store.read()).toBeNull();
  }
  expect(s.createModule).not.toHaveBeenCalled();
});

it("writes prepared before the first asynchronous proof and leaves restart-visible intent while blocked", async () => {
  const s = setup(); let release!: (value: boolean) => void;
  s.verifyNoLegacyDriver.mockImplementationOnce(() => {
    expect(s.store.read()?.phase).toBe("prepared");
    expect(s.readCredential).not.toHaveBeenCalled();
    return new Promise((resolve) => { release = resolve; });
  });
  const result = s.confirm(s.preview());
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(() => new QqFirstSetupCoordinator(s.options).previewSetup(packageId)).toThrow("existing-setup-requires-review");
  release(false);
  expect(await result).toMatchObject({ outcome: "rolled-back", errorCode: "legacy-driver-not-confirmed-absent" });
  expect(s.store.read()?.phase).toBe("rolled-back");
});
