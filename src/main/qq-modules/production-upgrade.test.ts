import { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createQqProductionHost, type QqProductionHost } from "./production-host";
import { QqModuleActionGateway } from "./action-gateway";
import { getQqStartupMode } from "./startup-recovery";
import { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import { QqSecureCredentialStore, qqSecureCredentialDirectory } from "./secure-credential-store";
import { QqConfigurationProposalStore, qqConfigurationProposalDirectory } from "./configuration-proposal";
import { FakeTransport } from "../../../scripts/verify/qq-module/fixtures";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest } from "./package-verifier";
import type { QqAdoptionContext } from "./adoption-proof";
import type { QqModuleActionResult } from "../../shared/qq-module-actions";
const roots: string[] = [], services: QqProductionHost[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown().catch(() => {}); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qq-production-upgrade-")); roots.push(root);
  const aes = randomBytes(32);
  const secure = { isSecureAvailable: () => true, encryptString: vi.fn((value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", aes, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }), decryptString: vi.fn((bytes: Buffer) => {
    const cipher = createDecipheriv("aes-256-gcm", aes, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  }) };
  let settings = Buffer.from(JSON.stringify({ qq: { enabled: true, listenMode: "loopback", port: 6200,
    allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true, groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal",
    accessToken: `enc:${secure.encryptString("synthetic-upgrade-secret").toString("base64")}` }, unchanged: { fixture: true } }));
  secure.encryptString.mockClear(); secure.decryptString.mockClear();
  const original = Buffer.from(settings), keys = generateKeyPairSync("ed25519"), file = Buffer.from("// synthetic module");
  const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: "0.1.0", releaseSequence: 1, keyId: "fixture", issuedAt: 100, expiresAt: 2000,
    hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" }, apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "win32", arch: "x64" }], entry: "entry.cjs", files: [{ path: "entry.cjs", size: file.length, sha256: qqPackageDigest(file) }] };
  let bytes = Buffer.from(JSON.stringify(manifest));
  let verificationNow = 1000, expireAfterChecks = Infinity;
  const releasePolicy = { verificationContext: () => ({ trustedKeys: new Map([["fixture", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]), hostVersion: "1.3.7", platform: "win32", arch: "x64", now: expireAfterChecks-- <= 0 ? 3000 : verificationNow }),
    candidate: () => ({ manifest: bytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), keys.privateKey), files: new Map([["entry.cjs", file]]) }) };
  const legacy = { id: "qq" as const, displayName: "synthetic legacy", capability: { text: true }, onMessage: null,
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: true })), getStatus: () => ({ enabled: true, phase: "running" as const }),
    getMigrationIdentity: () => ({ accountId: "10000", connectionEpoch: 7 }), prepareMigrationStop: vi.fn(async () => {
      expect(existsSync(join(root, "qq-module-adoption/state.json"))).toBe(true);
      expect(existsSync(join(root, "qq-module-migration/state.json"))).toBe(true);
      return { safeToSwitch: true, stopped: true, drained: true };
    }) };
  let held = true, approved = true;
  const context: QqAdoptionContext = { platform: "win32", scopeId: "synthetic-profile", sessionEpoch: "test", mode: "validated-upgrade", previousHostSha256: "c".repeat(64), hostSha256: "a".repeat(64), moduleSha256: qqPackageDigest(bytes) };
  const freeze = vi.fn(async () => ({ isHeld: () => held, release: vi.fn() }));
  const peers: FakeTransport[] = [];
  const createTransport = vi.fn(() => { const peer = new FakeTransport(); peer.terminate = async () => { peer.killed = true; peer.crash(); }; peers.push(peer); return peer; });
  const options = { userDataPath: root, router: new QqRoutingAdapter(legacy as any), secureStorage: secure, releasePolicy, ownership: { scopeId: context.scopeId },
    legacyUpgrade: { readLegacySettings: () => Buffer.from(settings), adoption: { readContext: () => ({ ...context }), reviewedPolicy: { approve: () => approved }, exclusiveScope: { freezeAndProve: freeze } } }, createTransport, backendReconnectTimeoutMs: 100 };
  const service = createQqProductionHost(options)!; services.push(service);
  const gateway = new QqModuleActionGateway(service), owner = { key: {}, isAuthorized: () => true };
  const extract = (r: QqModuleActionResult) => { if (!r.ok || !("preview" in r)) throw Error(JSON.stringify(r)); return r.preview; };
  const install = async () => { const p = extract(await gateway.execute({ action: "preview-install" }, owner)); expect(await gateway.execute({ action: "confirm-install", operationId: p.operationId, userConfirmed: true }, owner)).toEqual({ ok: true, state: "installed" }); };
  const preview = async () => { await install(); return extract(await gateway.execute({ action: "preview-migration" }, owner)); };
  const confirm = (p: ReturnType<typeof extract>) => gateway.execute({ action: "confirm-migration", operationId: p.operationId, accountId: p.accountId!, userConfirmed: true }, owner);
  const publishFresh = () => {
    expireAfterChecks = Infinity; verificationNow = 3000;
    bytes = Buffer.from(JSON.stringify({ ...manifest, version: "0.1.1", releaseSequence: 2, issuedAt: 2500, expiresAt: 4000 }));
    context.moduleSha256 = qqPackageDigest(bytes);
  };
  return { root, service, options, gateway, owner, legacy, peers, secure, context, freeze, createTransport, extract, preview, confirm, publishFresh,
    expireAfter: (validChecks: number) => { expireAfterChecks = validChecks; },
    original, readSettings: () => settings, changeSettings: () => { settings = Buffer.from(settings.toString().replace("6200", "6201")); }, expire: () => { verificationNow = 3000; }, lose: () => { held = false; }, deny: () => { approved = false; } };
}
it("previews without touching secrets or stopping; confirms actual migration and preserves legacy source", async () => {
  const s = fixture(), p = await s.preview();
  expect(s.secure.decryptString).not.toHaveBeenCalled(); expect(s.freeze).not.toHaveBeenCalled(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  expect(existsSync(join(s.root, "qq-module-adoption"))).toBe(false);
  expect(await s.confirm(p)).toEqual({ ok: true, state: "committed" });
  expect(s.legacy.prepareMigrationStop).toHaveBeenCalledOnce(); expect(s.createTransport).toHaveBeenCalledOnce();
  expect(s.readSettings()).toEqual(s.original); expect(s.options.router.getDriver()).toBe("module");
  const credentials = new QqSecureCredentialStore(qqSecureCredentialDirectory(s.root), s.secure), metadata = credentials.getMetadata()!;
  expect(credentials.read({ accountId: "10000", generation: metadata.generation })).toBe("synthetic-upgrade-secret");
  const proposal = new QqConfigurationProposalStore(qqConfigurationProposalDirectory(s.root)).read()!;
  expect(proposal.config.allowedPrivateUserIds).toEqual(["30000"]);
  expect(JSON.parse(readFileSync(join(s.root, "qq-module-migration/state.json"), "utf8")).phase).toBe("selected");
  const changed = { ...proposal.config, allowedPrivateUserIds: ["40000"] };
  expect((await s.gateway.execute({ action: "propose-configuration", expectedRevision: proposal.revision, config: changed, enabled: true }, s.owner)).ok).toBe(true);
  const reconfigure = s.extract(await s.gateway.execute({ action: "preview-reconfigure" }, s.owner));
  expect(await s.gateway.execute({ action: "confirm-reconfigure", operationId: reconfigure.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "committed" });
  expect(s.peers[0].killed).toBe(true);
  await s.service.shutdown();
  const next = createQqProductionHost({ ...s.options, router: new QqRoutingAdapter(s.legacy as any, "blocked") })!; services.push(next);
  const gateway = new QqModuleActionGateway(next); const recovery = s.extract(await gateway.execute({ action: "preview-recovery" }, s.owner));
  expect(await gateway.execute({ action: "confirm-recovery", operationId: recovery.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "committed" });
});
it("rejects changed source or revoked review before import and stop", async () => {
  for (const kind of ["source", "policy"]) {
    const s = fixture(), p = await s.preview(); if (kind === "source") s.changeSettings(); else s.deny();
    expect((await s.confirm(p)).ok).toBe(false); expect(s.secure.encryptString).not.toHaveBeenCalled(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(s.createTransport).not.toHaveBeenCalled();
  }
});
it.each([0, 1])("keeps legacy available and permits a fresh confirmed upgrade after expiry on confirmation check %i", async validChecks => {
  const s = fixture(), stale = await s.preview();
  s.expireAfter(validChecks);
  expect((await s.confirm(stale)).ok).toBe(false);
  expect(s.secure.decryptString).not.toHaveBeenCalled();
  expect(s.secure.encryptString).not.toHaveBeenCalled();
  expect(s.freeze).not.toHaveBeenCalled();
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  expect(s.createTransport).not.toHaveBeenCalled();
  expect(s.options.router.getDriver()).toBe("legacy");
  expect(getQqStartupMode(s.root)).toBe("legacy");
  for (const sidecar of ["qq-module-adoption", "qq-module-migration", "qq-module-driver-ownership",
    "qq-module-credentials", "qq-module-configuration-proposals"]) expect(existsSync(join(s.root, sidecar))).toBe(false);
  expect(s.readSettings()).toEqual(s.original);
  s.publishFresh();
  const fresh = await s.preview();
  expect(fresh.packageId).not.toBe(stale.packageId);
  expect(await s.confirm(stale)).toEqual({ ok: false, error: "stale" });
  expect(await s.confirm(fresh)).toEqual({ ok: true, state: "committed" });
});
it("rejects a conflicting destination before making a migration marker", async () => {
  const s = fixture(), preview = await s.preview();
  const store = new QqSecureCredentialStore(qqSecureCredentialDirectory(s.root), s.secure);
  const existing = store.write({ accountId: "10000", token: "synthetic-existing-secret", expectedGeneration: null, userConfirmed: true });
  expect((await s.confirm(preview)).ok).toBe(false);
  expect(store.getMetadata()).toEqual(existing);
  expect(s.options.router.getDriver()).toBe("legacy");
  expect(getQqStartupMode(s.root)).toBe("legacy");
  expect(existsSync(join(s.root, "qq-module-adoption"))).toBe(false);
  expect(existsSync(join(s.root, "qq-module-migration"))).toBe(false);
  expect(existsSync(qqConfigurationProposalDirectory(s.root))).toBe(false);
  expect(s.freeze).not.toHaveBeenCalled();
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
});
it("keeps durable intent and imported sidecars on failed legacy stop without restarting or overwriting", async () => {
  const s = fixture(), p = await s.preview(); s.legacy.prepareMigrationStop.mockResolvedValue({ safeToSwitch: false, stopped: false, drained: false });
  expect(await s.confirm(p)).toMatchObject({ ok: true, state: "rolled-back" });
  expect(existsSync(join(s.root, "qq-module-adoption/state.json"))).toBe(true); expect(existsSync(qqSecureCredentialDirectory(s.root))).toBe(true);
  expect(s.createTransport).not.toHaveBeenCalled(); await expect(s.options.router.start()).rejects.toThrow();
  expect(await s.gateway.execute({ action: "preview-migration" }, s.owner)).toEqual({ ok: false, error: "recovery-required" });
});
it("blocks creation if proof is lost during module staging and retains dirty ownership", async () => {
  const s = fixture(), p = await s.preview();
  const create = s.options.createTransport.getMockImplementation()!;
  s.options.createTransport.mockImplementation(() => { const child = create(); s.lose(); return child; });
  expect(await s.confirm(p)).toMatchObject({ ok: true, state: "rolled-back" });
  expect(s.peers[0].killed).toBe(true); await expect(s.service.shutdown()).rejects.toThrow("ADOPTION_LOST");
  expect(existsSync(join(s.root, "qq-module-driver-ownership/owner.lock"))).toBe(true);
});
it("never stops or spawns after destination encryption failure; partial intent blocks another import", async () => {
  const s = fixture(), p = await s.preview();
  s.secure.encryptString.mockImplementation(() => { expect(existsSync(join(s.root, "qq-module-adoption/state.json"))).toBe(true); throw Error("synthetic encrypt failure"); });
  expect((await s.confirm(p)).ok).toBe(false);
  expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(s.createTransport).not.toHaveBeenCalled();
  expect(existsSync(join(s.root, "qq-module-adoption/state.json"))).toBe(true);
  expect(await s.gateway.execute({ action: "preview-migration" }, s.owner)).toEqual({ ok: false, error: "recovery-required" });
});
it("rejects replacement of imported policy during legacy drain", async () => {
  const s = fixture(), p = await s.preview(); const stop = s.legacy.prepareMigrationStop.getMockImplementation()!;
  s.legacy.prepareMigrationStop.mockImplementation(async () => {
    const store = new QqConfigurationProposalStore(qqConfigurationProposalDirectory(s.root)), prior = store.read()!;
    store.propose({ config: { ...prior.config, configRevision: 2, allowedPrivateUserIds: [] }, enabled: true, credentialGeneration: prior.credentialGeneration }, prior.revision);
    return stop();
  });
  expect(await s.confirm(p)).toMatchObject({ ok: true, state: "rolled-back" }); expect(s.createTransport).not.toHaveBeenCalled();
});
it("rechecks release expiry after asynchronous staging before committing", async () => {
  const s = fixture(), p = await s.preview(); const create = s.options.createTransport.getMockImplementation()!;
  s.options.createTransport.mockImplementation(() => { const peer = create(); s.expire(); return peer; });
  expect(await s.confirm(p)).toMatchObject({ ok: true, state: "rolled-back" }); expect(s.peers[0].killed).toBe(true);
});
