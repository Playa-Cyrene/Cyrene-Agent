import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QqPackageStore } from "./package-store";
import { describe, expect, it } from "vitest";
import { createQqBundledReleasePolicy } from "./bundled-release-policy";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, verifyQqPackage, type QqPackageManifest } from "./package-verifier";
function fixture() {
  const keys = generateKeyPairSync("ed25519");
  const file = Buffer.from("// synthetic only");
  const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: "0.1.0", releaseSequence: 1, keyId: "test-only",
    issuedAt: 100, expiresAt: 2000, hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" },
    apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "win32", arch: "x64" }], entry: "entry.cjs", files: [{ path: "entry.cjs", size: file.length, sha256: qqPackageDigest(file) }] };
  const signed = (value = manifest) => { const bytes = Buffer.from(JSON.stringify(value)); return { manifest: bytes,
    signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), keys.privateKey), files: new Map([["entry.cjs", file]]) }; };
  let candidate = signed(), now = 1000;
  const options = { pairing: { hostVersion: "1.3.7", platform: "win32" as const, arch: "x64" as const,
    packageId: `pkg-${qqPackageDigest(candidate.manifest)}`, moduleVersion: "0.1.0", releaseSequence: 1, keyId: "test-only" },
    trustedPublicKey: keys.publicKey.export({ type: "spki", format: "pem" }).toString(), host: { version: "1.3.7", platform: "win32", arch: "x64" },
    readBundledCandidate: () => candidate, now: () => now };
  return { options, manifest, signed, setCandidate: (c: typeof candidate) => { candidate = c; }, setNow: (n: number) => { now = n; } };
}
describe("host-owned Windows bundled pairing", () => {
  it("verifies exact signed candidate without executing code or providing a default signer", () => {
    const f = fixture(), p = createQqBundledReleasePolicy(f.options);
    expect(verifyQqPackage(p.candidate(), p.verificationContext()).version).toBe("0.1.0");
    expect(p.verificationContext().expectedManifestDigest).toBe(f.options.pairing.packageId.slice(4));
    expect(() => createQqBundledReleasePolicy({ ...f.options, trustedPublicKey: "" })).toThrow("invalid-key");
  });
  it.each([{ platform: "linux" }, { platform: "darwin" }, { arch: "arm64" }, { version: "1.3.8" }])("rejects other host pairings %j", change => {
    const f = fixture(); expect(() => createQqBundledReleasePolicy({ ...f.options, host: { ...f.options.host, ...change } })).toThrow("host-mismatch");
  });
  it.each([{ moduleVersion: "0.1.1" }, { releaseSequence: 2 }, { packageId: `pkg-${"0".repeat(64)}` }, { keyId: "other" }])("rejects wrong candidate identity %j", change => {
    const f = fixture(); expect(() => createQqBundledReleasePolicy({ ...f.options, pairing: { ...f.options.pairing, ...change } })).toThrow();
  });
  it("rejects unknown pairing fields and malformed digest pins", () => {
    const f = fixture(); expect(() => createQqBundledReleasePolicy({ ...f.options, pairing: { ...f.options.pairing, url: "https://invalid.test" } as any })).toThrow("invalid-pairing");
    const p = createQqBundledReleasePolicy(f.options);
    for (const pin of ["", "A".repeat(64), "0".repeat(63), "0".repeat(64)]) expect(() => verifyQqPackage(p.candidate(), { ...p.verificationContext(), expectedManifestDigest: pin })).toThrow("unexpected-manifest");
  });
  it("revalidates clock, contents and exact digest on later reads including installed verifier calls", () => {
    const f = fixture(), p = createQqBundledReleasePolicy(f.options), replacement = f.signed({ ...f.manifest, releaseSequence: 2 });
    // Even a valid alternate package signed by the SAME approved key cannot run.
    expect(() => verifyQqPackage(replacement, p.verificationContext())).toThrow("unexpected-manifest");
    f.setCandidate(replacement); expect(() => p.candidate()).toThrow("unexpected-manifest");
    f.setCandidate(f.signed()); f.setNow(2000); expect(() => p.candidate()).toThrow("expired-manifest");
    f.setNow(NaN); expect(() => p.candidate()).toThrow("expired-manifest");
  });
  it("rejects invalid signatures and tampered code", () => {
    const f = fixture(), p = createQqBundledReleasePolicy(f.options), changed = f.signed();
    changed.signature.fill(0); f.setCandidate(changed); expect(() => p.candidate()).toThrow("invalid-signature");
    const code = f.signed(); code.files.set("entry.cjs", Buffer.from("bad")); f.setCandidate(code); expect(() => p.candidate()).toThrow("file-integrity-failed");
  });
  it("snapshots host pins and returns isolated map and byte copies", () => {
    const f = fixture(), p = createQqBundledReleasePolicy(f.options);
    f.options.pairing.packageId = `pkg-${"0".repeat(64)}`; f.options.trustedPublicKey = "bad"; f.options.host.version = "9.0.0";
    (p.verificationContext().trustedKeys as Map<string, string>).clear();
    const c = p.candidate(); c.manifest.fill(0); c.signature.fill(0); c.files.get("entry.cjs")!.fill(0);
    expect(() => p.candidate()).not.toThrow();
  });
  it("keeps unpinned existing verifier callers compatible but never falls back on a supplied bad pin", () => {
    const f = fixture(), p = createQqBundledReleasePolicy(f.options), context = p.verificationContext(); delete context.expectedManifestDigest;
    expect(verifyQqPackage(f.signed({ ...f.manifest, releaseSequence: 2 }), context).releaseSequence).toBe(2);
    expect(() => verifyQqPackage(f.signed(), { ...context, expectedManifestDigest: null as any })).toThrow("unexpected-manifest");
  });
});

it("enforces bundle pin on existing selected package readback, not just install input", () => {
  const f = fixture(), p = createQqBundledReleasePolicy(f.options);
  const root = mkdtempSync(join(tmpdir(), "qq-bundle-policy-"));
  try {
    const directory = join(root, "packages");
    const unpinned = () => { const context = p.verificationContext(); delete context.expectedManifestDigest; return context; };
    const priorStore = new QqPackageStore(directory, unpinned);
    const other = priorStore.install(f.signed({ ...f.manifest, releaseSequence: 2 }), { userConfirmed: true });
    const pairedStore = new QqPackageStore(directory, p.verificationContext);
    expect(() => pairedStore.getSelected()).toThrow("unexpected-manifest");
    expect(() => pairedStore.resolveSelectedRuntime(other.packageId)).toThrow("unexpected-manifest");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
