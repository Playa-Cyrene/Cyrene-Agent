import { strictObject } from "../../shared/qq-module/validation";
import { createHash, createPublicKey, verify } from "node:crypto";
import { negotiateQqApi, QQ_API_SUPPORT, validateApiSupport, type QqApiSupport } from "../../shared/qq-module";

/** Offline candidate format, not a published QFCA release format. No archive extractor,
 * downloader, dependency installer, lifecycle script or module execution is involved. */
export const QQ_PACKAGE_LIMITS = Object.freeze({ manifestBytes: 256 * 1024, files: 2048, fileBytes: 32 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 });
export const QQ_PACKAGE_SIGNATURE_DOMAIN = "Cyrene/QFCA/package-manifest/v1\0";
export interface QqPackageManifest {
  schemaVersion: 1;
  moduleId: "qfca";
  version: string;
  releaseSequence: number;
  keyId: string;
  /** Unix milliseconds; freshness is checked using the host clock. */
  issuedAt: number;
  expiresAt: number;
  hostVersionRange: { minInclusive: string; maxExclusive: string };
  apiSupport: QqApiSupport;
  targets: { platform: string; arch: string }[];
  entry: string;
  files: { path: string; size: number; sha256: string }[];
}
export interface QqSignedPackage {
  manifest: Uint8Array;
  signature: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
}
export interface QqPackageVerificationContext {
  /** Host-owned pins only. Never accept a public key supplied by the package/renderer. */
  trustedKeys: ReadonlyMap<string, string>;
  hostVersion: string;
  platform: string;
  arch: string;
  now: number;
}
export class QqPackageError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new QqPackageError(code); };
const integer = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0;
const version = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.test(v);
const digest = (v: unknown): boolean => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const keyId = (v: unknown): boolean => typeof v === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
/** Conservative cross-platform paths: no ADS, traversal, drive, UNC, reserved device,
 * alternate separators, trailing spaces/dots or case-insensitive collisions. */
export function isQqPackagePath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 240 && v.split("/").every((part) =>
    /^[a-zA-Z0-9_@][a-zA-Z0-9_.@-]{0,63}$/.test(part) && !part.endsWith(".")
    && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
}
function compare(a: string, b: string): number {
  const left = a.split(".").map(Number), right = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
export const qqPackageDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

export function verifyQqPackage(input: QqSignedPackage, context: QqPackageVerificationContext): QqPackageManifest {
  if (!(input.manifest instanceof Uint8Array) || input.manifest.byteLength > QQ_PACKAGE_LIMITS.manifestBytes
    || !(input.signature instanceof Uint8Array) || input.signature.byteLength !== 64) fail("invalid-manifest");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(input.manifest).toString("utf8")); } catch { fail("invalid-manifest"); }
  // Reject duplicate keys, non-UTF8 bytes, whitespace variants and noncanonical numbers.
  if (!Buffer.from(JSON.stringify(value)).equals(Buffer.from(input.manifest))) fail("invalid-manifest");
  if (!strictObject(value, {
    schemaVersion: (v) => v === 1, moduleId: (v) => v === "qfca", version, releaseSequence: (v) => integer(v) && (v as number) > 0,
    keyId, issuedAt: integer, expiresAt: integer,
    hostVersionRange: (v) => strictObject(v, { minInclusive: version, maxExclusive: version }),
    apiSupport: validateApiSupport,
    targets: (v) => Array.isArray(v) && v.length > 0 && v.length <= 12 && v.every((t) => strictObject(t, {
      platform: (p) => ["win32", "darwin", "linux"].includes(p as string), arch: (a) => ["x64", "arm64"].includes(a as string),
    })),
    entry: isQqPackagePath,
    files: (v) => Array.isArray(v) && v.length > 0 && v.length <= QQ_PACKAGE_LIMITS.files && v.every((f) => strictObject(f, {
      path: isQqPackagePath, size: (n) => integer(n) && (n as number) <= QQ_PACKAGE_LIMITS.fileBytes, sha256: digest,
    })),
  })) fail("invalid-manifest");
  const manifest = value as QqPackageManifest;
  const pin = context.trustedKeys.get(manifest.keyId);
  if (!pin) throw new QqPackageError("untrusted-publisher");
  try {
    const key = createPublicKey(pin);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null,
      Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), input.manifest]), key, input.signature)) fail("invalid-signature");
  } catch { fail("invalid-signature"); }
  if (!integer(context.now) || manifest.issuedAt > context.now || manifest.expiresAt <= context.now || manifest.expiresAt <= manifest.issuedAt) fail("expired-manifest");
  const range = manifest.hostVersionRange;
  if (!version(context.hostVersion) || compare(range.minInclusive, range.maxExclusive) >= 0
    || compare(context.hostVersion, range.minInclusive) < 0 || compare(context.hostVersion, range.maxExclusive) >= 0
    || !negotiateQqApi(QQ_API_SUPPORT, manifest.apiSupport).ok
    || !manifest.targets.some((t) => t.platform === context.platform && t.arch === context.arch)) fail("incompatible-package");
  if (!manifest.entry.endsWith(".js") && !manifest.entry.endsWith(".cjs") && !manifest.entry.endsWith(".mjs")) fail("invalid-entry");
  const paths = new Set<string>();
  const directories = new Map<string, string>();
  let total = 0;
  for (const file of manifest.files) {
    const lower = file.path.toLowerCase();
    if (paths.has(lower)) fail("invalid-file-inventory");
    paths.add(lower);
    // Every shared directory must keep one spelling for exact-path readback on Windows.
    const parts = file.path.split("/");
    while (parts.length > 1) {
      parts.pop();
      const directory = parts.join("/"), key = directory.toLowerCase();
      if (directories.has(key) && directories.get(key) !== directory) fail("invalid-file-inventory");
      directories.set(key, directory);
    }
    total += file.size;
    if (total > QQ_PACKAGE_LIMITS.totalBytes) fail("package-too-large");
  }
  for (const path of paths) {
    const parts = path.split("/");
    while (parts.length > 1) { parts.pop(); if (paths.has(parts.join("/"))) fail("invalid-file-inventory"); }
  }
  if (!manifest.files.some((f) => f.path === manifest.entry)) fail("invalid-entry");
  if (!(input.files instanceof Map) || input.files.size !== manifest.files.length) fail("invalid-file-inventory");
  for (const file of manifest.files) {
    const bytes = input.files.get(file.path);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== file.size || qqPackageDigest(bytes) !== file.sha256) fail("file-integrity-failed");
  }
  return manifest;
}
