import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { QqInstallationController } from "./installation-controller";
import { QqPackageStore } from "./package-store";
import { QqMigrationCoordinator } from "./migration";
import { QqMigrationStore } from "./migration-store";
import { QqModuleManager } from "./manager";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest, type QqPackageVerificationContext } from "./package-verifier";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";

const roots: string[] = [];
const peers: FakeTransport[] = [];
afterEach(() => { for (const peer of peers.splice(0)) peer.crash(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "qq-controller-")); roots.push(root);
  const key = generateKeyPairSync("ed25519");
  const context: QqPackageVerificationContext = { trustedKeys: new Map([["fixture", key.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    hostVersion: "1.3.7", platform: "linux", arch: "x64", now: 1000 };
  const candidate = (sequence = 1) => {
    const files = new Map([["entry.cjs", Buffer.from(`// inert fixture ${sequence}`)]]);
    const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: `0.1.${sequence}`, releaseSequence: sequence, keyId: "fixture", issuedAt: 900, expiresAt: 2000,
      hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" }, apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "linux", arch: "x64" }], entry: "entry.cjs",
      files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: qqPackageDigest(bytes) })) };
    const bytes = Buffer.from(JSON.stringify(manifest));
    return { manifest: bytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), key.privateKey), files };
  };
  const packageRoot = join(root, "packages"), packages = new QqPackageStore(packageRoot, () => context);
  const settings = join(root, "settings.json");
  const original = Buffer.from(JSON.stringify({ qq: { enabled: true, listenMode: "loopback", accessToken: "plain:synthetic-only-token", allowedPrivateUserIds: ["30000"] } }));
  writeFileSync(settings, original);
  const legacy = { getMigrationIdentity: vi.fn(() => ({ accountId: "10000", connectionEpoch: 1 })),
    prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const migrationStore = new QqMigrationStore(join(root, "migration"));
  const createModule = vi.fn((input) => {
    const peer = new FakeTransport(); peers.push(peer);
    return new QqModuleManager({ getConfiguration: () => input, createTransport: () => peer, requestTimeoutMs: 100, drainTimeoutMs: 100 });
  });
  const migration = new QqMigrationCoordinator({ store: migrationStore, readLegacySettings: () => readFileSync(settings), legacy,
    secureStorage: { isSecureAvailable: () => true, decryptString: () => "synthetic-only-token" }, legacyMachine: { userDataPath: root, appName: "fixture" },
    verifyCandidate: (id) => { if (packages.getSelected()?.packageId !== id) throw new Error("candidate changed"); }, createModule, backendReconnectTimeoutMs: 100 });
  const controller = new QqInstallationController({ packages, verificationContext: () => context, migration });
  const install = () => { const p = controller.previewInstallation(candidate()); return controller.confirmInstallation({ operationId: p.operationId, userConfirmed: true }); };
  const confirm = (p: ReturnType<typeof controller.previewMigration>) => controller.confirmMigration({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true });
  return { root, packageRoot, packages, context, candidate, controller, install, confirm, legacy, createModule, migrationStore, settings, original };
}
it("defaults to unconfigured and rejects every mutating route without inspecting inputs", async () => {
  const controller = new QqInstallationController();
  const poison = { get manifest(): never { throw Error("must not inspect"); } };
  expect(controller.getState()).toEqual({ availability: "release-unconfigured", phase: "idle" });
  expect(() => controller.previewInstallation(poison as any)).toThrow("release-unconfigured");
  expect(() => controller.confirmInstallation(null)).toThrow("release-unconfigured");
  expect(() => controller.previewMigration()).toThrow("release-unconfigured");
  await expect(controller.confirmMigration(null)).rejects.toThrow("release-unconfigured");
  expect(() => controller.cancel(null)).toThrow("release-unconfigured");
});
it("previews without writes; cancellation and replacing previews invalidate old consent", () => {
  const s = setup(); const first = s.controller.previewInstallation(s.candidate());
  expect(existsSync(s.packageRoot)).toBe(false);
  s.controller.cancel({ operationId: first.operationId });
  expect(() => s.controller.confirmInstallation({ operationId: first.operationId, userConfirmed: true })).toThrow("stale-operation");
  const second = s.controller.previewInstallation(s.candidate());
  const third = s.controller.previewInstallation(s.candidate());
  expect(() => s.controller.confirmInstallation({ operationId: second.operationId, userConfirmed: true })).toThrow("stale-operation");
  s.controller.confirmInstallation({ operationId: third.operationId, userConfirmed: true });
  expect(s.createModule).not.toHaveBeenCalled(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  expect(() => s.controller.confirmInstallation({ operationId: third.operationId, userConfirmed: true })).toThrow("stale-operation");
});
it("snapshots candidate bytes, rechecks revoked trust, and consumes failed confirmations", () => {
  const s = setup(); const bytes = s.candidate(); const p = s.controller.previewInstallation(bytes);
  bytes.files.get("entry.cjs")!.fill(0);
  s.controller.confirmInstallation({ operationId: p.operationId, userConfirmed: true });
  expect(s.packages.getSelected()?.manifest.version).toBe("0.1.1");
  const next = s.controller.previewInstallation(s.candidate(2)); s.context.trustedKeys = new Map();
  expect(() => s.controller.confirmInstallation({ operationId: next.operationId, userConfirmed: true })).toThrow("untrusted-publisher");
  expect(() => s.controller.confirmInstallation({ operationId: next.operationId, userConfirmed: true })).toThrow("stale-operation");
});
it("cancels migration without decrypt/stop/write and refuses extra authority in confirmation", async () => {
  const s = setup(); s.install(); const p = s.controller.previewMigration();
  await expect(s.controller.confirmMigration({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true, path: "/untrusted" })).rejects.toThrow("invalid-confirmation");
  s.controller.cancel({ operationId: p.previewId });
  await expect(s.confirm(p)).rejects.toThrow("stale-operation");
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(s.migrationStore.read()).toBeNull();
});
it("binds migration to installed selection, refusing a package changed after preview", async () => {
  const s = setup(); s.install(); const p = s.controller.previewMigration();
  s.packages.install(s.candidate(2), { userConfirmed: true });
  await expect(s.confirm(p)).rejects.toThrow("candidate-changed");
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
});
it("composes real stores/coordinator, blocks concurrent cancellation, never caches live activation", async () => {
  const s = setup(); s.install(); const p = s.controller.previewMigration();
  let release!: () => void;
  s.legacy.prepareMigrationStop.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ safeToSwitch: true, drained: true, stopped: true }); }));
  const pending = s.confirm(p);
  expect(s.controller.getState().phase).toBe("busy");
  expect(() => s.controller.cancel({ operationId: p.previewId })).toThrow("operation-busy");
  expect(() => s.controller.previewInstallation(s.candidate(2))).toThrow("operation-busy");
  await expect(s.confirm(p)).rejects.toThrow("operation-busy");
  expect(s.createModule).not.toHaveBeenCalled(); release();
  await expect(pending).resolves.toMatchObject({ outcome: "committed", legacyData: "unchanged" });
  expect(s.createModule).toHaveBeenCalledOnce(); expect(readFileSync(s.settings)).toEqual(s.original);
  expect(s.controller.getState().phase).toBe("idle"); // Not a persisted/live-driver claim.
  peers.at(-1)!.crash(); await expect(s.confirm(p)).rejects.toThrow("stale-operation");
  expect(() => s.controller.previewMigration()).toThrow("existing-migration-requires-review");
});
it("invalidates an earlier preview even if its replacement fails verification", () => {
  const s = setup(); const first = s.controller.previewInstallation(s.candidate());
  const invalid = s.candidate(2); invalid.signature.fill(0);
  expect(() => s.controller.previewInstallation(invalid)).toThrow("invalid-signature");
  expect(() => s.controller.confirmInstallation({ operationId: first.operationId, userConfirmed: true })).toThrow("stale-operation");
  expect(existsSync(s.packageRoot)).toBe(false);
});
it("does not let mutation of returned migration preview change the confirmed account or package", async () => {
  const s = setup(); s.install(); const p = s.controller.previewMigration();
  p.accountId = "99999"; p.targetPackageId = `pkg-${"f".repeat(64)}`;
  await expect(s.confirm(p)).rejects.toThrow("stale-operation");
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  s.controller.cancel({ operationId: p.previewId });
});
it("returns durable recovery rather than success when the legacy driver cannot stop", async () => {
  const s = setup(); s.install(); const p = s.controller.previewMigration();
  s.legacy.prepareMigrationStop.mockResolvedValue({ safeToSwitch: false, drained: false, stopped: false });
  await expect(s.confirm(p)).resolves.toMatchObject({ outcome: "recovery-required", legacyRuntime: "not-restarted" });
  expect(s.createModule).not.toHaveBeenCalled(); expect(s.migrationStore.read()?.phase).toBe("prepared");
  expect(s.controller.getState().phase).toBe("idle");
  expect(() => s.controller.previewMigration()).toThrow("existing-migration-requires-review");
  expect(readFileSync(s.settings)).toEqual(s.original);
});
