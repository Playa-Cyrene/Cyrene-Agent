import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { QqModuleHostService } from "./host-service";
import { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import type { MessageHandler } from "../channels/types";
import { QqPackageStore } from "./package-store";
import { QqFirstSetupStore } from "./first-setup-store";
import { QqMigrationStore } from "./migration-store";
import { getQqStartupMode, qqLifecyclePaths } from "./startup-recovery";
import { capabilities, configuration, inbound } from "../../../scripts/verify/qq-module/fixtures";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest, type QqPackageVerificationContext } from "./package-verifier";
import type { QqModuleActionResult } from "../../shared/qq-module-actions";

const transportState = vi.hoisted(() => ({ peers: [] as any[], creates: 0 }));
// Everything above the process boundary is real, including signed package verification,
// package store/factory, coordinator, manager, single route and durable setup/migration.
vi.mock("./utility-process", async () => {
  const { FakeTransport } = await import("../../../scripts/verify/qq-module/fixtures");
  return { createQqUtilityProcess: () => {
    transportState.creates++;
    const peer = new FakeTransport(); transportState.peers.push(peer); return peer;
  } };
});
const roots: string[] = [];
const services: QqModuleHostService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => {});
  for (const peer of transportState.peers.splice(0)) peer.crash();
  transportState.creates = 0;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(enabled = false) {
  const root = mkdtempSync(join(tmpdir(), "qq-host-service-")); roots.push(root);
  const key = generateKeyPairSync("ed25519");
  const context: QqPackageVerificationContext = { trustedKeys: new Map([["fixture", key.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    hostVersion: "1.3.7", platform: "linux", arch: "x64", now: 1000 };
  const candidate = (sequence = 1) => {
    const files = new Map([["entry.cjs", Buffer.from("// inert host test peer")]]);
    const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: `0.1.${sequence}`, releaseSequence: sequence, keyId: "fixture", issuedAt: 900, expiresAt: 2000,
      hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" }, apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "linux", arch: "x64" }], entry: "entry.cjs",
      files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: qqPackageDigest(bytes) })) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    return { manifest: bytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), key.privateKey), files };
  };
  const legacy = { id: "qq" as const, displayName: "fixture", capability: capabilities.messages, onMessage: null as MessageHandler | null,
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: true })),
    getStatus: () => ({ enabled, phase: enabled ? "running" as const : "offline" as const }),
    getMigrationIdentity: vi.fn(() => enabled ? { accountId: "10000", connectionEpoch: 1 } : null),
    prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const router = new QqRoutingAdapter(legacy, getQqStartupMode(root));
  let config = configuration().config;
  const original = Buffer.from(JSON.stringify({ qq: { enabled, listenMode: "loopback", accessToken: "enc:" + Buffer.from("synthetic envelope").toString("base64"), allowedPrivateUserIds: ["30000"] }, unrelated: { retained: true } }));
  const settings = join(root, "settings.json"); writeFileSync(settings, original);
  const options = { userDataPath: root, router, verificationContext: () => context, candidate: () => candidate(),
    readLegacySettings: () => readFileSync(settings), secureStorage: { isSecureAvailable: vi.fn(() => true), decryptString: vi.fn(() => "synthetic-secure-token") },
    appName: "test", readFirstConfiguration: (accountId: string) => ({ ...config, expectedSelfId: accountId }),
    readFirstCredential: vi.fn(() => "synthetic-secure-token"), verifyNoLegacyDriver: vi.fn(async () => !enabled), backendReconnectTimeoutMs: 50 };
  const service = new QqModuleHostService(options); services.push(service);
  const extract = (result: QqModuleActionResult) => { if (!result.ok || !("preview" in result)) throw Error("expected preview"); return result.preview; };
  const install = async () => {
    const preview = extract(await service.execute({ action: "preview-install" }));
    expect(await service.execute({ action: "confirm-install", operationId: preview.operationId, userConfirmed: true })).toEqual({ ok: true, state: "installed" });
    return preview;
  };
  const first = async () => extract(await service.execute({ action: "preview-setup", accountId: "10000" }));
  const confirmFirst = (preview: Awaited<ReturnType<typeof first>>) => service.execute({ action: "confirm-setup", operationId: preview.operationId, accountId: preview.accountId!, userConfirmed: true });
  return { root, router, legacy, options, service, context, candidate, settings, original, extract, install, first, confirmFirst,
    changeConfig: () => { config = { ...config, configRevision: 2 }; } };
}
it("constructs without store creation; installation is verified but never starts QQ", async () => {
  const s = setup();
  expect(existsSync(join(s.root, "qq-module-packages"))).toBe(false);
  const p = s.extract(await s.service.execute({ action: "preview-install" }));
  expect(existsSync(join(s.root, "qq-module-packages"))).toBe(false);
  expect(await s.service.execute({ action: "cancel", operationId: p.operationId })).toEqual({ ok: true, state: "cancelled" });
  expect(await s.service.execute({ action: "confirm-install", operationId: p.operationId, userConfirmed: true })).toEqual({ ok: false, error: "stale" });
  await s.install();
  expect(transportState.creates).toBe(0); expect(s.legacy.start).not.toHaveBeenCalled(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  expect(s.options.readFirstCredential).not.toHaveBeenCalled();
  expect(await s.service.execute({ action: "status" })).toEqual({ ok: true, state: "ready" });
});
it("composes first setup without old QQ data, dispatches only the module and persists no secret", async () => {
  const s = setup(); await s.install();
  const onMessage = vi.fn(async () => null); s.router.onMessage = onMessage;
  const p = await s.first(); expect(s.options.readFirstCredential).not.toHaveBeenCalled();
  expect(s.router.getDriver()).toBe("legacy");
  expect(await s.confirmFirst(p)).toEqual({ ok: true, state: "committed" });
  expect(s.router.getDriver()).toBe("module"); expect(transportState.creates).toBe(1);
  transportState.peers[0].event("inbound", inbound()); await new Promise((r) => setImmediate(r));
  expect(onMessage).toHaveBeenCalledOnce();
  expect(s.legacy.start).not.toHaveBeenCalled(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  expect(readFileSync(s.settings)).toEqual(s.original);
  const paths = qqLifecyclePaths(s.root); expect(new QqFirstSetupStore(paths.firstSetup).read()?.phase).toBe("selected");
  expect(readFileSync(join(paths.firstSetup, "state.json"), "utf8")).not.toContain("synthetic-secure-token");
  expect(await s.service.execute({ action: "status" })).toEqual({ ok: true, state: "committed" });
});
it("composes legacy migration through one route without changing source settings", async () => {
  const s = setup(true); await s.install();
  const p = s.extract(await s.service.execute({ action: "preview-migration" }));
  expect(await s.service.execute({ action: "confirm-migration", operationId: p.operationId, accountId: p.accountId!, userConfirmed: true })).toEqual({ ok: true, state: "committed" });
  expect(s.legacy.prepareMigrationStop).toHaveBeenCalledOnce(); expect(s.router.getDriver()).toBe("module");
  expect(s.options.readFirstCredential).not.toHaveBeenCalled(); expect(s.options.secureStorage.decryptString).toHaveBeenCalledOnce();
  expect(readFileSync(s.settings)).toEqual(s.original);
  expect(new QqMigrationStore(qqLifecyclePaths(s.root).migration).read()?.phase).toBe("selected");
});
it("refuses wrong first-setup account before revoking legacy route or checking process absence", async () => {
  const s = setup(); await s.install(); const p = await s.first();
  expect(await s.service.execute({ action: "confirm-setup", operationId: p.operationId, accountId: "999", userConfirmed: true })).toEqual({ ok: false, error: "stale" });
  expect(s.router.getDriver()).toBe("legacy"); expect(s.options.verifyNoLegacyDriver).not.toHaveBeenCalled();
  expect(transportState.creates).toBe(0); expect(s.options.readFirstCredential).not.toHaveBeenCalled();
  expect(await s.confirmFirst(p)).toEqual({ ok: true, state: "committed" });
});
it("rejects configuration changes and package replacement before starting a module", async () => {
  const config = setup(); await config.install(); const p = await config.first(); config.changeConfig();
  await expect(config.confirmFirst(p)).rejects.toThrow("configuration-changed"); expect(transportState.creates).toBe(0);
  const packages = setup(); await packages.install(); const q = await packages.first();
  new QqPackageStore(join(packages.root, "qq-module-packages"), () => packages.context).install(packages.candidate(2), { userConfirmed: true });
  await expect(packages.confirmFirst(q)).rejects.toThrow();
  expect(transportState.creates).toBe(0);
});
it("replaces/cancels previews so old consent cannot execute", async () => {
  const s = setup(); await s.install(); const first = await s.first(); const second = await s.first();
  expect(await s.confirmFirst(first)).toEqual({ ok: false, error: "stale" });
  expect(await s.service.execute({ action: "cancel", operationId: second.operationId })).toEqual({ ok: true, state: "cancelled" });
  expect(await s.confirmFirst(second)).toEqual({ ok: false, error: "stale" });
  expect(s.options.verifyNoLegacyDriver).not.toHaveBeenCalled();
});
it("serializes a confirmed operation, then shutdown prevents any late module creation", async () => {
  const s = setup(); await s.install(); const p = await s.first();
  let release!: (value: boolean) => void;
  s.options.verifyNoLegacyDriver.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const confirming = s.confirmFirst(p); await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(await s.service.execute({ action: "cancel", operationId: p.operationId })).toEqual({ ok: false, error: "busy" });
  const shutting = s.service.shutdown();
  expect(await s.service.execute({ action: "status" })).toEqual({ ok: false, error: "recovery-required" });
  release(true); await confirming; await shutting;
  expect(transportState.creates).toBe(0); expect(s.router.getDriver()).toBe("blocked");
});
it("requires recovery after shutdown/reconstruction; durable selected never restarts a driver", async () => {
  const s = setup(); await s.install(); await s.confirmFirst(await s.first()); await s.service.shutdown();
  expect(getQqStartupMode(s.root)).toBe("blocked");
  const router = new QqRoutingAdapter(s.legacy, getQqStartupMode(s.root));
  const restarted = new QqModuleHostService({ ...s.options, router }); services.push(restarted);
  expect(await restarted.execute({ action: "status" })).toEqual({ ok: true, state: "recovery-required" });
  expect(await restarted.execute({ action: "preview-setup", accountId: "10000" })).toEqual({ ok: false, error: "recovery-required" });
  await expect(router.start()).rejects.toThrow("EXPLICIT_ACTIVATION_REQUIRED");
  expect(transportState.creates).toBe(1); expect(s.legacy.start).not.toHaveBeenCalled();
});
it("keeps startup and service status fail-closed for a lock left before the first state write", async () => {
  const s = setup(); const path = qqLifecyclePaths(s.root).firstSetup;
  mkdirSync(path); writeFileSync(join(path, "marker"), "Cyrene QQ first setup v1\n"); writeFileSync(join(path, "setup-lock"), "");
  expect(getQqStartupMode(s.root)).toBe("blocked");
  expect(await s.service.execute({ action: "status" })).toEqual({ ok: true, state: "recovery-required" });
});
it("first setup works when no legacy settings/history file exists", async () => {
  const s = setup(); rmSync(s.settings); await s.install();
  expect(await s.confirmFirst(await s.first())).toEqual({ ok: true, state: "committed" });
  expect(existsSync(s.settings)).toBe(false); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
});
it("rejects mismatched legacy migration consent before quiescing its route", async () => {
  const s = setup(true); await s.install();
  const p = s.extract(await s.service.execute({ action: "preview-migration" }));
  await expect(s.service.execute({ action: "confirm-migration", operationId: p.operationId, accountId: "999", userConfirmed: true })).rejects.toThrow("stale");
  expect(s.router.getDriver()).toBe("legacy"); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(transportState.creates).toBe(0);
});
