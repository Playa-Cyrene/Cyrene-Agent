import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { QqPackageStore } from "./package-store";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, isQqPackagePath, qqPackageDigest, verifyQqPackage,
  type QqPackageManifest, type QqSignedPackage, type QqPackageVerificationContext } from "./package-verifier";
import { getQqModuleInstallationStatus } from "./installation-status";

// Fresh ephemeral fixture keys, never published or configured as production roots.
const keys = generateKeyPairSync("ed25519");
const context: QqPackageVerificationContext = { trustedKeys: new Map([["fixture", keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
  hostVersion: "1.3.7", platform: "win32", arch: "x64", now: 1000 };
function candidate(sequence = 1, patch: Partial<QqPackageManifest> = {}): QqSignedPackage {
  const files = new Map([["index.cjs", Buffer.from(`// inert fixture ${sequence}`)], ["LICENSE", Buffer.from("test fixture only")]]);
  const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: `0.1.${sequence}`, releaseSequence: sequence,
    keyId: "fixture", issuedAt: 900, expiresAt: 2000, hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" },
    apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "win32", arch: "x64" }], entry: "index.cjs",
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: qqPackageDigest(bytes) })), ...patch };
  return signed(manifest, files);
}
function signed(manifest: QqPackageManifest, files: ReadonlyMap<string, Uint8Array>): QqSignedPackage {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return { manifest: bytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), keys.privateKey), files };
}
const temp: string[] = [];
function store(checkpoint?: ConstructorParameters<typeof QqPackageStore>[2]) {
  const parent = mkdtempSync(join(tmpdir(), "cyrene-package-test-")); temp.push(parent);
  const root = join(parent, "packages");
  return { parent, root, instance: new QqPackageStore(root, () => context, checkpoint) };
}
afterEach(() => { for (const path of temp.splice(0)) rmSync(path, { recursive: true, force: true }); });
const consent = { userConfirmed: true } as const;

describe("QQ signed package gate", () => {
  it("accepts a correctly pinned, compatible complete package", () => {
    expect(verifyQqPackage(candidate(), context).version).toBe("0.1.1");
  });
  it("never trusts a package key or digest by itself", () => {
    expect(() => verifyQqPackage(candidate(), { ...context, trustedKeys: new Map() })).toThrow("untrusted-publisher");
    const other = generateKeyPairSync("ed25519");
    expect(() => verifyQqPackage(candidate(), { ...context, trustedKeys: new Map([["fixture", other.publicKey.export({ type: "spki", format: "pem" }).toString()]]) })).toThrow("invalid-signature");
  });
  it("rejects manifest, signature and file tampering separately", () => {
    const input = candidate();
    expect(() => verifyQqPackage({ ...input, manifest: Buffer.from(Buffer.from(input.manifest).toString().replace('"0.1.1"', '"0.1.2"')) }, context)).toThrow("invalid-signature");
    expect(() => verifyQqPackage({ ...input, signature: new Uint8Array(64) }, context)).toThrow("invalid-signature");
    expect(() => verifyQqPackage({ ...input, files: new Map([...input.files].map(([p, b]) => [p, p === "LICENSE" ? Buffer.alloc(b.length) : b])) }, context)).toThrow("file-integrity-failed");
  });
  it.each(["1.2.9", "1.4.0", "1.3.7-beta.1", "01.3.7"])("rejects host version %s", (hostVersion) => {
    expect(() => verifyQqPackage(candidate(), { ...context, hostVersion })).toThrow("incompatible-package");
  });
  it("rejects wrong API, platform, architecture and time", () => {
    expect(() => verifyQqPackage(candidate(1, { apiSupport: { major: 2, minMinor: 0, maxMinor: 0 } }), context)).toThrow("incompatible-package");
    expect(() => verifyQqPackage(candidate(1, { apiSupport: { major: 1, minMinor: 1, maxMinor: 2 } }), context)).toThrow("incompatible-package");
    expect(() => verifyQqPackage(candidate(), { ...context, platform: "linux" })).toThrow("incompatible-package");
    expect(() => verifyQqPackage(candidate(), { ...context, arch: "arm64" })).toThrow("incompatible-package");
    expect(() => verifyQqPackage(candidate(), { ...context, now: 2000 })).toThrow("expired-manifest");
    expect(() => verifyQqPackage(candidate(), { ...context, now: 899 })).toThrow("expired-manifest");
  });
  it.each(["../x", "/x", "C:/x", "C:x", "a\\b", "a//b", "a/./b", "a/../b", "a:stream", "CON", "nul.js", "COM1.txt", "aux ", "dir/file.", "dir/é.js", ""])("rejects unsafe portable path %s", (path) => {
    expect(isQqPackagePath(path)).toBe(false);
    expect(() => verifyQqPackage(candidate(1, { entry: path }), context)).toThrow();
  });
  it("rejects extra files, missing files, duplicate paths and file-directory aliases", () => {
    const input = candidate(), manifest: QqPackageManifest = JSON.parse(Buffer.from(input.manifest).toString());
    expect(() => verifyQqPackage({ ...input, files: new Map([...input.files, ["extra.js", Buffer.from("")]]) }, context)).toThrow("invalid-file-inventory");
    expect(() => verifyQqPackage({ ...input, files: new Map() }, context)).toThrow("invalid-file-inventory");
    expect(() => verifyQqPackage(signed({ ...manifest, files: [manifest.files[0], { ...manifest.files[0], path: "INDEX.cjs" }] }, input.files), context)).toThrow("invalid-file-inventory");
    expect(() => verifyQqPackage(signed({ ...manifest, files: [manifest.files[0], { ...manifest.files[1], path: "index.cjs/child" }] }, input.files), context)).toThrow("invalid-file-inventory");
  });
  it("rejects oversized, noncanonical and unknown-field manifests", () => {
    const input = candidate();
    expect(() => verifyQqPackage({ ...input, manifest: Buffer.alloc(256 * 1024 + 1) }, context)).toThrow("invalid-manifest");
    expect(() => verifyQqPackage({ ...input, manifest: Buffer.from(` ${Buffer.from(input.manifest)}`) }, context)).toThrow("invalid-manifest");
    const raw = Buffer.from(input.manifest).toString();
    expect(() => verifyQqPackage({ ...input, manifest: Buffer.from(raw.replace('"moduleId":"qfca"', '"moduleId":"bad","moduleId":"qfca"')) }, context)).toThrow("invalid-manifest");
    expect(() => verifyQqPackage(candidate(1, { publicKey: "attacker" } as Partial<QqPackageManifest>), context)).toThrow("invalid-manifest");
  });
});

describe("QQ offline package transactions", () => {
  it("does not create a store on construction/read or bad consent/untrusted input", () => {
    const s = store(); expect(s.instance.getSelected()).toBeNull(); expect(existsSync(s.root)).toBe(false);
    expect(() => s.instance.install(candidate(), { userConfirmed: false } as never)).toThrow("explicit-consent-required");
    const untrusted = new QqPackageStore(s.root, () => ({ ...context, trustedKeys: new Map() }));
    expect(() => untrusted.install(candidate(), consent)).toThrow("untrusted-publisher");
    expect(existsSync(s.root)).toBe(false);
  });
  it("persists selection, keeps old packages/data, and permits explicit rollback without lowering replay floor", () => {
    const s = store(); writeFileSync(join(s.parent, "qq-settings.json"), "old-token-and-config");
    writeFileSync(join(s.parent, "history.sqlite"), "history-and-bindings");
    const first = s.instance.install(candidate(), consent), second = s.instance.install(candidate(2), consent);
    const restarted = new QqPackageStore(s.root, () => context);
    expect(restarted.getSelected()?.manifest.version).toBe("0.1.2");
    expect(restarted.rollback(consent).packageId).toBe(first.packageId);
    expect(restarted.getSelected()?.manifest.version).toBe("0.1.1");
    expect(() => restarted.install(candidate(2), consent)).toThrow("release-replay-blocked");
    expect(existsSync(join(s.root, second.packageId))).toBe(true);
    expect(readFileSync(join(s.parent, "qq-settings.json"), "utf8")).toBe("old-token-and-config");
    expect(readFileSync(join(s.parent, "history.sqlite"), "utf8")).toBe("history-and-bindings");
  });
  it.each(["expired", "revoked", "incompatible"])("allows a verified repair to replace an %s old package", (reason) => {
    const s = store();
    s.instance.install(candidate(), consent);
    const fresh = candidate(2, { issuedAt: 1900, expiresAt: 3000,
      ...(reason === "revoked" ? { keyId: "replacement" } : {}),
      ...(reason === "incompatible" ? { hostVersionRange: { minInclusive: "2.0.0", maxExclusive: "3.0.0" } } : {}),
    });
    const updated = { ...context, now: reason === "expired" ? 2100 : 1950,
      ...(reason === "revoked" ? { trustedKeys: new Map([["replacement", context.trustedKeys.get("fixture")!]]) } : {}),
      ...(reason === "incompatible" ? { hostVersion: "2.0.0" } : {}),
    };
    const repaired = new QqPackageStore(s.root, () => updated);
    expect(repaired.install(fresh, consent).manifest.version).toBe("0.1.2");
    expect(() => repaired.rollback(consent)).toThrow();
    expect(repaired.getSelected()?.manifest.version).toBe("0.1.2");
  });
  it.each(["staged", "published", "before-commit"] as const)("rolls back an injected %s failure, and retry succeeds", (point) => {
    const s = store(); const first = s.instance.install(candidate(), consent);
    const interrupted = new QqPackageStore(s.root, () => context, (phase) => { if (phase === point) throw new Error("injected"); });
    expect(() => interrupted.install(candidate(2), consent)).toThrow("injected");
    expect(s.instance.getSelected()?.packageId).toBe(first.packageId);
    expect(readdirSync(s.root).filter((f) => f.startsWith(".stage-") || f === "install-lock" || f.startsWith(".state-"))).toEqual([]);
    expect(s.instance.install(candidate(2), consent).manifest.version).toBe("0.1.2");
  });
  it("blocks repeated/concurrent installs while a transaction owns the lock", () => {
    const s = store();
    const other = new QqPackageStore(s.root, () => context);
    const concurrent = new QqPackageStore(s.root, () => context, (phase) => {
      if (phase === "staged") expect(() => other.install(candidate(2), consent)).toThrow("install-busy-or-recovery-required");
    });
    concurrent.install(candidate(), consent);
    expect(() => other.install(candidate(), consent)).toThrow("release-replay-blocked");
  });
  it("fails closed on a stale lock after interruption but keeps the last selection readable", () => {
    const s = store(); const first = s.instance.install(candidate(), consent);
    mkdirSync(join(s.root, ".stage-interrupted")); writeFileSync(join(s.root, "install-lock"), "");
    expect(() => s.instance.install(candidate(2), consent)).toThrow("install-busy-or-recovery-required");
    expect(s.instance.getSelected()?.packageId).toBe(first.packageId);
    expect(existsSync(join(s.root, ".stage-interrupted"))).toBe(true);
  });
  it("checks stored bytes and keys again on selection and rollback", () => {
    const s = store(); const first = s.instance.install(candidate(), consent); s.instance.install(candidate(2), consent);
    const revoked = new QqPackageStore(s.root, () => ({ ...context, trustedKeys: new Map() }));
    expect(() => revoked.getSelected()).toThrow("untrusted-publisher");
    writeFileSync(join(s.root, first.packageId, "payload", "index.cjs"), "tampered");
    expect(() => s.instance.rollback(consent)).toThrow("file-integrity-failed");
    expect(s.instance.getSelected()?.manifest.version).toBe("0.1.2");
  });
  it("refuses unknown directories, path traversal state and extra payload files", () => {
    const s = store(); mkdirSync(s.root); writeFileSync(join(s.root, "mine.txt"), "retain");
    expect(() => s.instance.install(candidate(), consent)).toThrow();
    expect(readFileSync(join(s.root, "mine.txt"), "utf8")).toBe("retain");
    const t = store(), first = t.instance.install(candidate(), consent);
    writeFileSync(join(t.root, first.packageId, "payload", "extra.js"), "unlisted");
    expect(() => t.instance.getSelected()).toThrow("invalid-file-inventory");
    writeFileSync(join(t.root, "state.json"), JSON.stringify({ schemaVersion: 1, active: "../../history", previous: null, highestSequence: 1 }));
    expect(() => t.instance.getSelected()).toThrow("invalid-store-state");
  });
  it.skipIf(process.platform === "win32")("rejects symlink roots/payloads without writing through to other data", () => {
    const s = store(), target = join(s.parent, "user-data"); mkdirSync(target);
    symlinkSync(target, s.root, "dir");
    expect(() => s.instance.install(candidate(), consent)).toThrow("unsafe-store-path"); expect(readdirSync(target)).toEqual([]);
    const t = store(), first = t.instance.install(candidate(), consent);
    const path = join(t.root, first.packageId, "payload", "index.cjs"); rmSync(path); symlinkSync(join(t.parent, "private.txt"), path);
    expect(() => t.instance.getSelected()).toThrow();
  });
  it("cannot turn a production status query into installation", () => {
    const first = getQqModuleInstallationStatus({ listenMode: "loopback" });
    expect(first).toEqual({ availability: "release-unconfigured", canInstall: false, moduleInstalled: false, currentDriver: "legacy-builtin", listenCompatibility: "loopback" });
    (first as any).canInstall = true;
    expect(getQqModuleInstallationStatus({ listenMode: "loopback" }).canInstall).toBe(false);
  });
});
