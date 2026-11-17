import { generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createQqProductionHost, type QqProductionHost } from "./production-host";
import { QqModuleActionGateway } from "./action-gateway";
import { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import { QqSecureCredentialStore, qqSecureCredentialDirectory } from "./secure-credential-store";
import { QqConfigurationProposalStore, qqConfigurationProposalDirectory } from "./configuration-proposal";
import { FakeTransport, configuration } from "../../../scripts/verify/qq-module/fixtures";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest } from "./package-verifier";
import type { QqModuleActionResult } from "../../shared/qq-module-actions";
const roots: string[] = [], services: QqProductionHost[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.shutdown().catch(() => {}); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "qq-production-host-")); roots.push(root);
  // Synthetic AES port exercises envelope persistence; it is NOT OS safeStorage.
  const aes = randomBytes(32);
  const secure = { isSecureAvailable: vi.fn(() => true), encryptString: vi.fn((value: string) => {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", aes, iv);
    const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]);
  }), decryptString: vi.fn((bytes: Buffer) => {
    const cipher = createDecipheriv("aes-256-gcm", aes, bytes.subarray(0, 12)); cipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString();
  }) };
  const keys = generateKeyPairSync("ed25519"), file = Buffer.from("// synthetic process factory");
  const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: "0.1.0", releaseSequence: 1, keyId: "fixture", issuedAt: 100, expiresAt: 2000,
    hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" }, apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "linux", arch: "x64" }], entry: "entry.cjs", files: [{ path: "entry.cjs", size: file.length, sha256: qqPackageDigest(file) }] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const releasePolicy = { verificationContext: () => ({ trustedKeys: new Map([["fixture", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]), hostVersion: "1.3.7", platform: "linux", arch: "x64", now: 1000 }),
    candidate: () => ({ manifest: bytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), keys.privateKey), files: new Map([["entry.cjs", file]]) }) };
  const legacy = { id: "qq" as const, displayName: "synthetic absent legacy", capability: { text: true }, onMessage: null, start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: false })), getStatus: () => ({ enabled: false, phase: "offline" as const }), getMigrationIdentity: () => null, prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, stopped: true, drained: true })) };
  const peers: FakeTransport[] = [];
  const createTransport = vi.fn(() => { const peer = new FakeTransport(); peer.terminate = async () => { peer.killed = true; peer.crash(); }; peers.push(peer); return peer; });
  const options = { userDataPath: root, router: new QqRoutingAdapter(legacy as any, "blocked"), secureStorage: secure, releasePolicy, ownership: { scopeId: "synthetic-owned-profile", bootstrap: { verifyInitialScope: vi.fn(() => true) } }, createTransport, backendReconnectTimeoutMs: 50 };
  const service = createQqProductionHost(options)!; services.push(service);
  const gateway = new QqModuleActionGateway(service), owner = { key: {}, isAuthorized: () => true };
  const credentials = new QqSecureCredentialStore(qqSecureCredentialDirectory(root), secure);
  const proposals = new QqConfigurationProposalStore(qqConfigurationProposalDirectory(root));
  const seed = () => credentials.write({ accountId: "10000", token: "synthetic-only", expectedGeneration: null, userConfirmed: true });
  const extract = (r: QqModuleActionResult) => { if (!r.ok || !("preview" in r)) throw Error(JSON.stringify(r)); return r.preview; };
  const activate = async () => {
    seed(); expect((await gateway.execute({ action: "propose-configuration", expectedRevision: null, config: configuration().config, enabled: true }, owner)).ok).toBe(true);
    const install = extract(await gateway.execute({ action: "preview-install" }, owner));
    expect(await gateway.execute({ action: "confirm-install", operationId: install.operationId, userConfirmed: true }, owner)).toEqual({ ok: true, state: "installed" });
    const first = extract(await gateway.execute({ action: "preview-setup", accountId: "10000" }, owner));
    expect(await gateway.execute({ action: "confirm-setup", operationId: first.operationId, accountId: "10000", userConfirmed: true }, owner)).toEqual({ ok: true, state: "committed" });
  };
  return { root, options, service, gateway, owner, credentials, proposals, secure, legacy, peers, createTransport, seed, extract, activate };
}
it("requires explicit release policy and blocked ownership scope without creating directories", () => {
  const s = fixture();
  expect(createQqProductionHost({ ...s.options, releasePolicy: undefined })).toBeUndefined();
  expect(existsSync(qqSecureCredentialDirectory(s.root))).toBe(false); expect(existsSync(join(s.root, "qq-module-driver-ownership"))).toBe(false);
  expect(s.secure.isSecureAvailable).not.toHaveBeenCalled();
  expect(() => createQqProductionHost({ ...s.options, router: new QqRoutingAdapter(s.legacy as any) })).toThrow("EXCLUSIVE_ROUTE");
});
it("saves only nonsecret proposals and requires a matching secure credential without decrypting", async () => {
  const s = fixture();
  expect(await s.gateway.execute({ action: "propose-configuration", expectedRevision: null, config: configuration().config, enabled: true }, s.owner)).toEqual({ ok: false, error: "unconfigured" });
  const metadata = s.seed();
  const r = await s.gateway.execute({ action: "propose-configuration", expectedRevision: null, config: configuration().config, enabled: true }, s.owner);
  expect(r.ok && r.state).toBe("configuration-saved"); expect(JSON.stringify(r)).not.toContain(metadata.generation);
  expect(s.secure.decryptString).not.toHaveBeenCalled(); expect(s.createTransport).not.toHaveBeenCalled();
  expect(readFileSync(join(qqConfigurationProposalDirectory(s.root), "state.json"), "utf8")).not.toContain("synthetic-only");
  expect(await s.gateway.execute({ action: "propose-configuration", expectedRevision: null, config: configuration().config, enabled: true }, s.owner)).toEqual({ ok: false, error: "stale" });
});
it("uses durable ownership and actual exit proof for setup/reconfigure/disable then clean host recovery", async () => {
  const s = fixture(); await s.activate(); expect(s.peers.length).toBe(1); expect(s.legacy.start).not.toHaveBeenCalled();
  const changed = { ...configuration().config, allowedPrivateUserIds: ["40000"] };
  await s.gateway.execute({ action: "propose-configuration", expectedRevision: 1, config: changed, enabled: true }, s.owner);
  const p = s.extract(await s.gateway.execute({ action: "preview-reconfigure" }, s.owner));
  expect(await s.gateway.execute({ action: "confirm-reconfigure", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "committed" });
  expect(s.peers[0].killed).toBe(true); expect(s.peers.length).toBe(2);
  await s.service.shutdown(); expect(JSON.parse(readFileSync(join(s.root, "qq-module-driver-ownership/ownership.json"), "utf8")).phase).toBe("clean-retired");
  const next = createQqProductionHost({ ...s.options, router: new QqRoutingAdapter(s.legacy as any, "blocked"), ownership: { scopeId: s.options.ownership.scopeId } })!; services.push(next);
  const gateway = new QqModuleActionGateway(next); const q = s.extract(await gateway.execute({ action: "preview-recovery" }, s.owner));
  expect(await gateway.execute({ action: "confirm-recovery", operationId: q.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "committed" });
  expect(s.peers.length).toBe(3);
  await gateway.execute({ action: "propose-configuration", expectedRevision: 2, config: changed, enabled: false }, s.owner);
  const d = s.extract(await gateway.execute({ action: "preview-reconfigure" }, s.owner)); const reads = s.secure.decryptString.mock.calls.length;
  expect(await gateway.execute({ action: "confirm-reconfigure", operationId: d.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "disabled" });
  expect(s.secure.decryptString).toHaveBeenCalledTimes(reads); expect(s.peers.length).toBe(3);
});
it("refuses restart when terminate resolves without an observed child exit", async () => {
  const s = fixture(); await s.activate(); s.peers[0].terminate = async () => { s.peers[0].killed = true; };
  const p = s.extract(await s.gateway.execute({ action: "preview-recovery" }, s.owner));
  const r = await s.gateway.execute({ action: "confirm-recovery", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner);
  expect(r.ok && r.state).toBe("recovery-required"); expect(s.peers.length).toBe(1);
  await expect(s.service.shutdown()).rejects.toThrow(); expect(existsSync(join(s.root, "qq-module-driver-ownership/owner.lock"))).toBe(true);
});
it("keeps dirty previous ownership blocked instead of using a bootstrap callback to override it", async () => {
  const s = fixture(); await s.activate();
  const next = createQqProductionHost({ ...s.options, router: new QqRoutingAdapter(s.legacy as any, "blocked") })!; services.push(next);
  const p = s.extract(await next.execute({ action: "preview-recovery" }));
  const r = await next.execute({ action: "confirm-recovery", operationId: p.operationId, accountId: "10000", userConfirmed: true });
  expect(r.ok && r.state).toBe("recovery-required"); expect(s.peers.length).toBe(1); expect(s.options.ownership.bootstrap.verifyInitialScope).toHaveBeenCalledOnce();
});
it("refuses changed proposal identity or credential generation after preview before spawning", async () => {
  const s = fixture(); await s.activate();
  const p = s.extract(await s.gateway.execute({ action: "preview-recovery" }, s.owner));
  const prior = s.proposals.read()!; s.proposals.propose({ config: { ...prior.config, configRevision: prior.config.configRevision + 1 }, enabled: true, credentialGeneration: prior.credentialGeneration }, prior.revision);
  expect((await s.gateway.execute({ action: "confirm-recovery", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner)).ok).toBe(false); expect(s.peers.length).toBe(1);
});
it("never exposes unsupervised legacy migration through this production composition", async () => {
  const s = fixture(); expect(await s.service.execute({ action: "preview-migration" })).toEqual({ ok: false, error: "unconfigured" }); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
});
it("credential rotation invalidates a preview and requires a new proposal before controlled replacement", async () => {
  const s = fixture(); await s.activate();
  const p = s.extract(await s.gateway.execute({ action: "preview-recovery" }, s.owner));
  const old = s.credentials.getMetadata()!; s.credentials.write({ accountId: old.accountId, token: "synthetic-rotated", expectedGeneration: old.generation, userConfirmed: true });
  expect((await s.gateway.execute({ action: "confirm-recovery", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner)).ok).toBe(false);
  expect(s.peers.length).toBe(1);
  expect((await s.gateway.execute({ action: "propose-configuration", expectedRevision: 1, config: configuration().config, enabled: true }, s.owner)).ok).toBe(true);
  const q = s.extract(await s.gateway.execute({ action: "preview-reconfigure" }, s.owner));
  expect(await s.gateway.execute({ action: "confirm-reconfigure", operationId: q.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "committed" });
  expect(s.peers.length).toBe(2);
});
it("allows stopping through a disabled proposal even when the encrypted credential file is corrupt", async () => {
  const s = fixture(); await s.activate();
  writeFileSync(join(qqSecureCredentialDirectory(s.root), "credential.json"), "invalid");
  const saved = await s.gateway.execute({ action: "propose-configuration", expectedRevision: 1, config: configuration().config, enabled: false }, s.owner);
  expect(saved.ok && saved.state).toBe("configuration-saved");
  const p = s.extract(await s.gateway.execute({ action: "preview-reconfigure" }, s.owner)); const reads = s.secure.decryptString.mock.calls.length;
  expect(await s.gateway.execute({ action: "confirm-reconfigure", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "disabled" });
  expect(s.secure.decryptString).toHaveBeenCalledTimes(reads); expect(s.peers.length).toBe(1);
});
it("shutdown waits for a confirmed staged operation then retires ownership without any post-shutdown fork", async () => {
  const s = fixture(); await s.activate(); const prior = s.createTransport.getMockImplementation()!;
  let release!: () => void;
  s.createTransport.mockImplementationOnce(() => {
    const peer = prior(); const normal = peer.behavior;
    peer.behavior = request => { if (request.method === "start") release = () => normal(request); else normal(request); };
    return peer;
  });
  const p = s.extract(await s.gateway.execute({ action: "preview-recovery" }, s.owner));
  const pending = s.gateway.execute({ action: "confirm-recovery", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner);
  await vi.waitFor(() => expect(release).toBeTypeOf("function")); const shutdown = s.service.shutdown(); release(); await pending; await shutdown;
  expect(s.peers.every(peer => peer.killed)).toBe(true);
  expect(JSON.parse(readFileSync(join(s.root, "qq-module-driver-ownership/ownership.json"), "utf8")).phase).toBe("clean-retired");
  expect(await s.service.execute({ action: "preview-recovery" })).toEqual({ ok: false, error: "recovery-required" });
});
