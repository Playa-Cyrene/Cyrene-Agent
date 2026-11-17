import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { QqRecoveryCoordinator, readQqRecoveryOrigin } from "./recovery";
import { QqRecoveryStore, type QqRecoveryRecord, type QqRecoveryDesired } from "./recovery-store";
import { QqFirstSetupStore } from "./first-setup-store";
import { QqMigrationStore } from "./migration-store";
import { QqModuleManager } from "./manager";
import { FakeTransport, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
const roots: string[] = [];
const managers: QqModuleManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map((m) => m.stop())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const packageId = `pkg-${"a".repeat(64)}`;
async function setup(checkpoint: (record: QqRecoveryRecord) => void = () => {}, kind: "first-setup" | "migration" = "first-setup") {
  const root = mkdtempSync(join(tmpdir(), "qq-recovery-")); roots.push(root);
  const first = new QqFirstSetupStore(join(root, "first")), migration = new QqMigrationStore(join(root, "migration"));
  const config = configuration().config, transactionId = randomUUID();
  if (kind === "first-setup") await first.locked(async (save) => save({ schemaVersion: 1, transactionId, packageId, config, phase: "selected" }));
  else await migration.locked(async (save) => save({ schemaVersion: 1, transactionId, packageId, phase: "selected",
    plan: { schemaVersion: 1, channelId: "qq", config, sourceDigest: "b".repeat(64), identity: { selfId: "10000", connectionEpoch: 1 }, credentialKind: "encrypted" } }));
  const directory = join(root, "recovery"), store = new QqRecoveryStore(directory, checkpoint);
  let proposed: QqRecoveryDesired | undefined;
  let latest: QqModuleManager | undefined;
  let peer: FakeTransport | undefined;
  const secureStorage = { isSecureAvailable: vi.fn(() => true) };
  const readCredential = vi.fn(() => "synthetic-secret-no-persistence");
  const prepareAllDriversStopped = vi.fn(async () => { await latest?.stop(); return true; });
  const verifyNoOtherDrivers = vi.fn(async () => true);
  const verifyCandidate = vi.fn();
  const handler = vi.fn(async () => null);
  const createModule = vi.fn((input) => {
    const snapshot = structuredClone(input); peer = new FakeTransport();
    const original = peer.behavior;
    peer.behavior = (r) => { original(r); if (r.method === "start") peer!.event("inbound", inbound("during-staging")); };
    latest = new QqModuleManager({ getConfiguration: () => snapshot, createTransport: () => peer!, requestTimeoutMs: 50, drainTimeoutMs: 50 });
    latest.onMessage = handler; managers.push(latest); return latest;
  });
  const options = { store, readSource: () => readQqRecoveryOrigin(first, migration),
    readConfiguration: (baseline: any): QqRecoveryDesired => proposed ?? { ...structuredClone(baseline), credentialRevision: baseline.credentialRevision ?? "credential-generation-1" },
    secureStorage, readCredential, prepareAllDriversStopped, verifyNoOtherDrivers, verifyCandidate, createModule, backendReconnectTimeoutMs: 50 };
  const coordinator = new QqRecoveryCoordinator(options);
  const preview = (action: "recover" | "reconfigure" = "recover") => coordinator.previewRecovery(action);
  const confirm = (p: ReturnType<typeof preview>) => coordinator.confirmRecovery({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true });
  return { root, directory, store, first, migration, config, options, coordinator, preview, confirm, secureStorage, readCredential, prepareAllDriversStopped,
    verifyNoOtherDrivers, verifyCandidate, createModule, handler, get manager() { return latest!; }, get peer() { return peer!; },
    propose: (desired: QqRecoveryDesired) => { proposed = structuredClone(desired); }, resetProposal: () => { proposed = undefined; } };
}
it.each(["first-setup", "migration"] as const)("recovers a completed %s without altering source records or persisting credentials", async (kind) => {
  const s = await setup(() => {}, kind);
  const source = kind === "first-setup" ? s.first : s.migration;
  const original = readFileSync(join(source.root, "state.json"));
  const p = s.preview(); expect(existsSync(s.directory)).toBe(false);
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled(); expect(s.readCredential).not.toHaveBeenCalled();
  expect(await s.confirm(p)).toEqual({ outcome: "committed" });
  expect(s.handler).not.toHaveBeenCalled(); expect(s.manager.getActiveMigrationIdentity()).toMatchObject({ selfId: "10000" });
  expect(s.store.read()).toMatchObject({ phase: "selected", desired: { credentialRevision: "credential-generation-1" } });
  const saved = readFileSync(join(s.directory, "state.json"), "utf8");
  expect(saved).not.toContain("synthetic-secret"); expect(saved).not.toContain("accessToken");
  expect(readFileSync(join(source.root, "state.json"))).toEqual(original);
});
it("binds cancellation/account consent and does not replay confirmed recovery", async () => {
  const s = await setup(); const p = s.preview(); s.coordinator.cancel({ previewId: p.previewId });
  await expect(s.confirm(p)).rejects.toThrow("stale-confirmation"); expect(s.prepareAllDriversStopped).not.toHaveBeenCalled();
  const next = s.preview();
  await expect(s.coordinator.confirmRecovery({ previewId: next.previewId, accountId: "999", userConfirmed: true })).rejects.toThrow("stale-confirmation");
  expect(await s.confirm(next)).toEqual({ outcome: "committed" });
  await expect(s.confirm(next)).rejects.toThrow("stale-confirmation");
  expect(s.createModule).toHaveBeenCalledOnce();
});
it("saves prepared before any stop/proof and reads secrets only after ALL-stopped proof", async () => {
  const s = await setup(); let release!: (value: boolean) => void;
  s.prepareAllDriversStopped.mockImplementationOnce(async () => {
    expect(s.store.read()?.phase).toBe("prepared"); expect(s.readCredential).not.toHaveBeenCalled();
    return new Promise((resolve) => { release = resolve; });
  });
  const result = s.confirm(s.preview()); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(() => new QqRecoveryCoordinator(s.options).previewRecovery("recover")).toThrow(/source-locked|incomplete-recovery/);
  expect(() => s.coordinator.cancel({ previewId: "anything" })).toThrow("operation-busy");
  release(false);
  expect(await result).toMatchObject({ outcome: "recovery-required", errorCode: "all-drivers-stop-unconfirmed" });
  expect(s.store.read()?.phase).toBe("rolled-back"); expect(s.readCredential).not.toHaveBeenCalled(); expect(s.createModule).not.toHaveBeenCalled();
});
it("preserves the previous canonical selection after failed changed configuration", async () => {
  const s = await setup(); await s.confirm(s.preview());
  s.propose({ config: { ...s.config, configRevision: 2, allowedGroupIds: [] }, enabled: true, credentialRevision: "credential-generation-2" });
  s.verifyNoOtherDrivers.mockResolvedValueOnce(false);
  expect(await s.confirm(s.preview("reconfigure"))).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()?.previous).toMatchObject({ config: { configRevision: 1 }, credentialRevision: "credential-generation-1" });
  s.resetProposal();
  expect(s.preview("recover").config.configRevision).toBe(1);
});
it("disables without credentials or new process, and requires reconfigure to enable again", async () => {
  const s = await setup(); await s.confirm(s.preview());
  s.propose({ config: s.config, enabled: false, credentialRevision: "credential-generation-1" });
  s.secureStorage.isSecureAvailable.mockReturnValue(false);
  const p = s.preview("reconfigure"); expect(p.changes).toEqual(["enabled"]);
  expect(await s.confirm(p)).toEqual({ outcome: "disabled" });
  expect(s.createModule).toHaveBeenCalledOnce(); expect(s.readCredential).toHaveBeenCalledOnce();
  expect(s.store.read()?.phase).toBe("disabled");
  expect(() => s.preview("recover")).toThrow("reconfiguration-required");
  s.secureStorage.isSecureAvailable.mockReturnValue(true);
  s.propose({ config: s.config, enabled: true, credentialRevision: "credential-generation-1" });
  expect(await s.confirm(s.preview("reconfigure"))).toEqual({ outcome: "committed" });
  expect(s.createModule).toHaveBeenCalledTimes(2);
});
it("requires explicit reconfiguration for credential generation changes and config revision advancement", async () => {
  const s = await setup(); await s.confirm(s.preview());
  s.propose({ config: s.config, enabled: true, credentialRevision: "credential-generation-2" });
  expect(() => s.preview("recover")).toThrow("reconfiguration-required");
  expect(s.preview("reconfigure").changes).toEqual(["credential"]);
  s.propose({ config: { ...s.config, allowedPrivateUserIds: [] }, enabled: true, credentialRevision: "credential-generation-1" });
  expect(() => s.preview("reconfigure")).toThrow("configuration-revision-required");
});
it("revalidates exact source, desired account/revision, trust and secure storage before stopping", async () => {
  const s = await setup(); const p = s.preview();
  s.propose({ config: { ...s.config, configRevision: 2, expectedSelfId: "999" }, enabled: true, credentialRevision: "credential-generation-2" });
  await expect(s.confirm(p)).rejects.toThrow("reconfiguration-required");
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled(); expect(s.createModule).not.toHaveBeenCalled();
});
it("checks desired credential generation again after asynchronous stop proof", async () => {
  const s = await setup(); const p = s.preview();
  s.prepareAllDriversStopped.mockImplementationOnce(async () => {
    s.propose({ config: s.config, enabled: true, credentialRevision: "credential-generation-2" }); return true;
  });
  expect(await s.confirm(p)).toMatchObject({ outcome: "rolled-back", errorCode: "configuration-or-credential-changed" });
  expect(s.readCredential).not.toHaveBeenCalled();
});
it("does not activate an unverified identity", async () => {
  const s = await setup();
  s.createModule.mockImplementationOnce((input) => {
    const snapshot = structuredClone(input); const peer = new FakeTransport(); const normal = peer.behavior;
    peer.behavior = (request) => request.method === "start" ? peer.reply(request, { phase: "running", selfId: "999", connectionEpoch: 1 }) : normal(request);
    const manager = new QqModuleManager({ getConfiguration: () => snapshot, createTransport: () => peer, requestTimeoutMs: 50 });
    managers.push(manager); return manager;
  });
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "rolled-back", errorCode: "module-account-unverified" });
});
it.each(["prepared", "module-staged", "selected", "disabled"] as const)("contains %s persistence failure, preserving canonical previous selection", async (phase) => {
  const s = await setup((r) => { if (r.phase === phase) throw Error("disk fault"); });
  const action = phase === "disabled" ? "reconfigure" : "recover";
  if (phase === "disabled") s.propose({ config: s.config, enabled: false, credentialRevision: "credential-generation-1" });
  expect(await s.confirm(s.preview(action))).toMatchObject({ outcome: "rolled-back", errorCode: "operation-failed" });
  expect(s.store.read()?.phase).toBe("rolled-back");
  if (s.createModule.mock.calls.length) expect(s.manager.getActiveMigrationIdentity()).toBeNull();
});
it("retains incomplete intent when rollback cannot be persisted", async () => {
  const s = await setup((r) => { if (r.phase !== "prepared") throw Error("disk fault"); });
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "recovery-required" });
  expect(s.store.read()?.phase).toBe("prepared");
  expect(() => new QqRecoveryCoordinator(s.options).previewRecovery("recover")).toThrow("incomplete-recovery");
});
it("rejects two origins, incomplete/corrupt origins and stale source locks", async () => {
  const s = await setup(); const record = s.first.read()!;
  await s.migration.locked(async (save) => save({ schemaVersion: 1, transactionId: randomUUID(), packageId, phase: "selected",
    plan: { schemaVersion: 1, channelId: "qq", config: s.config, sourceDigest: "b".repeat(64), identity: { selfId: "10000", connectionEpoch: 1 }, credentialKind: "encrypted" } }));
  expect(() => s.preview()).toThrow("ambiguous-or-missing-source");
  const next = await setup(); await next.first.locked(async (save) => save({ ...record, phase: "prepared" }));
  expect(() => next.preview()).toThrow("incomplete-source");
  writeFileSync(join(next.first.root, "state.json"), "broken"); expect(() => next.preview()).toThrow("invalid-state");
  const locked = await setup(); writeFileSync(join(locked.first.root, "setup-lock"), "");
  expect(() => locked.preview()).toThrow("source-locked");
});
it("never overwrites unknown recovery state or ignores a stale recovery lock", async () => {
  const s = await setup(); await s.confirm(s.preview()); await s.manager.stop();
  writeFileSync(join(s.directory, "recovery-lock"), "");
  expect(() => new QqRecoveryCoordinator(s.options).previewRecovery("recover")).toThrow("source-locked");
  rmSync(join(s.directory, "recovery-lock")); writeFileSync(join(s.directory, "state.json"), "{bad");
  expect(() => s.preview()).toThrow("invalid-state");
});
it.skipIf(process.platform === "win32")("rejects dangling state and lock symlinks instead of treating them as absent", async () => {
  const s = await setup(); await s.confirm(s.preview()); await s.manager.stop();
  rmSync(join(s.directory, "state.json")); symlinkSync(join(s.root, "missing"), join(s.directory, "state.json"));
  expect(() => s.preview()).toThrow("unsafe-source");
  rmSync(join(s.directory, "state.json")); symlinkSync(join(s.root, "missing-lock"), join(s.directory, "recovery-lock"));
  expect(() => s.preview()).toThrow("source-locked");
});

it.skipIf(process.platform === "win32")("rejects dangling original-state symlinks before reading a legacy selected source", async () => {
  const s = await setup(); const path = join(s.first.root, "state.json");
  rmSync(path); symlinkSync(join(s.root, "absent-original"), path);
  expect(() => s.preview()).toThrow("unsafe-source");
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled();
});
it("reports recovery required if ALL-stop proof throws, even after persisting previous selection", async () => {
  const s = await setup(); s.prepareAllDriversStopped.mockRejectedValueOnce(Error("unknown old process"));
  expect(await s.confirm(s.preview())).toMatchObject({ outcome: "recovery-required", errorCode: "operation-failed" });
  expect(s.store.read()?.phase).toBe("rolled-back"); expect(s.readCredential).not.toHaveBeenCalled();
});

it("allows explicit disable when candidate execution trust is revoked, but never re-enables it", async () => {
  const s = await setup(); await s.confirm(s.preview());
  s.verifyCandidate.mockImplementation(() => { throw Error("publisher revoked or package expired/corrupt"); });
  s.propose({ config: s.config, enabled: false, credentialRevision: "credential-generation-1" });
  expect(await s.confirm(s.preview("reconfigure"))).toEqual({ outcome: "disabled" });
  expect(s.readCredential).toHaveBeenCalledOnce(); expect(s.createModule).toHaveBeenCalledOnce();
  s.propose({ config: s.config, enabled: true, credentialRevision: "credential-generation-1" });
  expect(() => s.preview("reconfigure")).toThrow("revoked");
  expect(s.createModule).toHaveBeenCalledOnce();
});

it("rejects a missing canonical state in an existing recovery store rather than reverting to enabled origin", async () => {
  const s = await setup();
  s.propose({ config: s.config, enabled: false, credentialRevision: "credential-generation-1" });
  expect(await s.confirm(s.preview("reconfigure"))).toEqual({ outcome: "disabled" });
  rmSync(join(s.directory, "state.json"));
  expect(() => s.store.read()).toThrow("invalid-state");
  expect(() => new QqRecoveryCoordinator(s.options).previewRecovery("recover")).toThrow("invalid-state");
});
it("rejects original store artifacts with missing state rather than guessing the other origin", async () => {
  const s = await setup(); rmSync(join(s.first.root, "state.json"));
  expect(() => s.preview()).toThrow("incomplete-source");
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled();
});

it.each(["configuration", "credential", "candidate"] as const)("rejects stale %s before creating a sidecar and permits a fresh preview", async (kind) => {
  const s = await setup(); const p = s.preview("reconfigure");
  if (kind === "configuration") s.propose({ config: { ...s.config, configRevision: 2, allowedGroupIds: [] }, enabled: true, credentialRevision: "credential-generation-1" });
  if (kind === "credential") s.propose({ config: s.config, enabled: true, credentialRevision: "credential-generation-2" });
  if (kind === "candidate") s.verifyCandidate.mockImplementationOnce(() => { throw Error("candidate changed"); });
  await expect(s.confirm(p)).rejects.toThrow();
  expect(existsSync(s.directory)).toBe(false);
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled(); expect(s.readCredential).not.toHaveBeenCalled();
  const next = s.preview("reconfigure");
  expect(next.previewId).not.toBe(p.previewId);
  expect(await s.confirm(next)).toEqual({ outcome: "committed" });
});
it("rejects a changed source before creating recovery files and allows a newly confirmed source snapshot", async () => {
  const s = await setup(); const p = s.preview();
  const first = s.first.read()!;
  await s.first.locked(async (save) => save({ ...first, config: { ...first.config, configRevision: 2 } }));
  await expect(s.confirm(p)).rejects.toThrow("source-changed");
  expect(existsSync(s.directory)).toBe(false);
  expect(s.prepareAllDriversStopped).not.toHaveBeenCalled();
  expect(s.preview().config.configRevision).toBe(2);
});
