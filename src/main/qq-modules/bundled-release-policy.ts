import { createPublicKey } from "node:crypto";
import { strictObject } from "../../shared/qq-module/validation";
import { QqPackageError, qqPackageDigest, verifyQqPackage, type QqPackageVerificationContext, type QqSignedPackage } from "./package-verifier";

/** Installer-owned pairing, not a renderer/environment/package-supplied trust statement. */
export interface QqBundledReleasePairing {
  hostVersion: string;
  platform: "win32";
  arch: "x64" | "arm64";
  packageId: string;
  moduleVersion: string;
  releaseSequence: number;
  keyId: string;
}
export interface QqBundledReleaseOptions {
  pairing: QqBundledReleasePairing;
  /** Explicit reviewed SPKI Ed25519 public key. No embedded default or discovery. */
  trustedPublicKey: string;
  host: { version: string; platform: string; arch: string };
  /** Host-owned local installer reader. This module never fetches or executes anything. */
  readBundledCandidate(): QqSignedPackage;
  now(): number;
}
const version = (v: unknown): boolean => typeof v === "string" && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(v);
function fail(code: string): never { throw new QqPackageError(`bundled-${code}`); }

/** Pure policy construction plus synchronous local candidate validation. Does NOT prove
 * fresh-install/upgrade ownership, enable production, select a signer or clear crash state.
 * The returned context carries the exact manifest pin through installed-package readback. */
export function createQqBundledReleasePolicy(options: QqBundledReleaseOptions) {
  if (!strictObject(options.pairing, {
    hostVersion: version, platform: v => v === "win32", arch: v => v === "x64" || v === "arm64",
    packageId: v => typeof v === "string" && /^pkg-[a-f0-9]{64}$/.test(v), moduleVersion: version,
    releaseSequence: v => Number.isSafeInteger(v) && (v as number) > 0,
    keyId: v => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v),
  })) fail("invalid-pairing");
  const pairing = Object.freeze({ ...options.pairing });
  if (!strictObject(options.host, { version, platform: v => v === "win32", arch: v => v === "x64" || v === "arm64" })
    || options.host.version !== pairing.hostVersion || options.host.platform !== pairing.platform || options.host.arch !== pairing.arch) fail("host-mismatch");
  if (typeof options.trustedPublicKey !== "string" || options.trustedPublicKey.length > 4096 || !options.trustedPublicKey.startsWith("-----BEGIN PUBLIC KEY-----")) fail("invalid-key");
  let publicKey: string;
  try {
    const key = createPublicKey(options.trustedPublicKey);
    if (key.asymmetricKeyType !== "ed25519") fail("invalid-key");
    publicKey = key.export({ type: "spki", format: "pem" }).toString();
  } catch { return fail("invalid-key"); }
  const read = options.readBundledCandidate, clock = options.now;
  if (typeof read !== "function" || typeof clock !== "function") fail("invalid-source");
  function verificationContext(): QqPackageVerificationContext {
    return { trustedKeys: new Map([[pairing.keyId, publicKey]]), hostVersion: pairing.hostVersion,
      platform: pairing.platform, arch: pairing.arch, now: clock(), expectedManifestDigest: pairing.packageId.slice(4) };
  }
  function assertCandidate(input: QqSignedPackage): void {
    const manifest = verifyQqPackage(input, verificationContext());
    if (`pkg-${qqPackageDigest(input.manifest)}` !== pairing.packageId || manifest.version !== pairing.moduleVersion
      || manifest.releaseSequence !== pairing.releaseSequence || manifest.keyId !== pairing.keyId) fail("candidate-mismatch");
  }
  function candidate(): QqSignedPackage {
    const input = read();
    assertCandidate(input);
    // Return owned bytes, not mutable aliases into installer data or previous callers.
    return { manifest: Buffer.from(input.manifest), signature: Buffer.from(input.signature),
      files: new Map([...input.files].map(([path, bytes]) => [path, Buffer.from(bytes)])) };
  }
  candidate(); // Missing, corrupt, incompatible or expired bundle never yields a policy.
  return Object.freeze({ pairing, verificationContext, candidate, assertCandidate });
}
