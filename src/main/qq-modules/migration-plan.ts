import { createHash } from "node:crypto";
import { resolveQqListenAuthRequirement } from "../channels/qq-listen-policy";
import { isQqModuleLoopbackHost } from "./listen-policy";
import { isBoundedJson, strictObject } from "../../shared/qq-module/validation";
import { validateRuntimeConfig, type QqRuntimeConfig } from "../../shared/qq-module";

export class QqMigrationError extends Error {
  constructor(readonly code: string) { super(`QQ_MIGRATION_${code}`); }
}
export function migrationFail(code: string): never { throw new QqMigrationError(code); }
export interface QqLegacyIdentity { selfId: string; connectionEpoch: number }
export interface QqMigrationPlan {
  schemaVersion: 1;
  channelId: "qq";
  config: QqRuntimeConfig;
  sourceDigest: string;
  identity: QqLegacyIdentity;
  credentialKind: "none" | "encrypted" | "obfuscated" | "plaintext";
}
/** Trusted host keychain port. Linux basic_text must report unavailable. No fallback. */
export interface QqMigrationSecretStorage {
  isSecureAvailable(): boolean;
  decryptString(bytes: Buffer): string;
}
interface LegacyConfig {
  enabled?: boolean; listenMode?: "auto" | "loopback" | "wsl" | "custom"; customHost?: string; port?: number;
  accessToken?: string; allowedPrivateUserIds?: string[]; allowedGroupIds?: string[];
  groupRequireMention?: true; groupReplyStyle?: "reply-and-mention"; groupToolPolicy?: "off"; groupMemoryPolicy?: "shared-personal";
}
const numericId = (v: unknown): v is string => typeof v === "string" && /^\d{1,128}$/.test(v);
const ids = (v: unknown): boolean => Array.isArray(v) && v.length <= 1024 && v.every(numericId) && new Set(v).size === v.length;
export function isQqLegacyIdentity(value: unknown): value is QqLegacyIdentity {
  return strictObject(value, { selfId: numericId, connectionEpoch: (n) => Number.isSafeInteger(n) && (n as number) >= 0 });
}
export function qqMigrationDigest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function readLegacyConfig(bytes: Uint8Array): LegacyConfig {
  if (bytes.byteLength > 256 * 1024) migrationFail("settings-too-large");
  let data: unknown;
  try { data = JSON.parse(Buffer.from(bytes).toString("utf8")); } catch { return migrationFail("invalid-settings"); }
  if (!isBoundedJson(data) || !data || typeof data !== "object" || Array.isArray(data)) migrationFail("invalid-settings");
  const qq = (data as Record<string, unknown>).qq;
  // No lossy normalization: malformed IDs, unknown fields and unsupported policies require review.
  if (!strictObject(qq, {}, {
    enabled: (v) => typeof v === "boolean", listenMode: (v) => ["auto", "loopback", "wsl", "custom"].includes(v as string),
    customHost: (v) => typeof v === "string" && v.length <= 253, port: (v) => Number.isSafeInteger(v) && (v as number) > 0 && (v as number) <= 65535,
    accessToken: (v) => typeof v === "string" && v.length <= 16 * 1024,
    allowedPrivateUserIds: ids, allowedGroupIds: ids, groupRequireMention: (v) => v === true,
    groupReplyStyle: (v) => v === "reply-and-mention", groupToolPolicy: (v) => v === "off", groupMemoryPolicy: (v) => v === "shared-personal",
  })) migrationFail("unsupported-legacy-settings");
  return qq as LegacyConfig;
}
export function buildQqMigrationPlan(bytes: Uint8Array, identity: QqLegacyIdentity, interfaces?: Parameters<typeof resolveQqListenAuthRequirement>[1]): QqMigrationPlan {
  if (!isQqLegacyIdentity(identity)) migrationFail("confirmed-live-account-required");
  const legacy = readLegacyConfig(bytes);
  if (legacy.enabled !== true) migrationFail("legacy-not-enabled");
  const listen = resolveQqListenAuthRequirement(legacy, interfaces);
  if (!listen.ok || !isQqModuleLoopbackHost(listen.resolvedHost)) migrationFail("unsupported-listen-address");
  const config: QqRuntimeConfig = { configRevision: 1, expectedSelfId: identity.selfId,
    listen: { host: listen.resolvedHost!, port: legacy.port ?? 6200 }, allowedPrivateUserIds: legacy.allowedPrivateUserIds ?? [],
    allowedGroupIds: legacy.allowedGroupIds ?? [], groupRequireMention: true };
  if (!validateRuntimeConfig(config)) migrationFail("unsupported-legacy-settings");
  const token = legacy.accessToken ?? "";
  return { schemaVersion: 1, channelId: "qq", config, sourceDigest: qqMigrationDigest(bytes), identity: { ...identity },
    credentialKind: !token ? "none" : token.startsWith("enc:") ? "encrypted" : token.startsWith("obf:") ? "obfuscated" : "plaintext" };
}
/** Reads the original credential only after confirmation. Never returns a stored enc:/obf:
 * envelope as a token, never uses the legacy loader's empty-string error fallback. */
export function readQqMigrationToken(bytes: Uint8Array, storage: QqMigrationSecretStorage,
  legacyMachine: { userDataPath: string; appName: string }): string {
  const stored = readLegacyConfig(bytes).accessToken ?? "";
  if (!stored) return "";
  if (!storage.isSecureAvailable()) migrationFail("secure-storage-unavailable");
  let token: string;
  try {
    if (stored.startsWith("enc:") || stored.startsWith("obf:")) {
      const encoded = stored.slice(4);
      const decoded = Buffer.from(encoded, "base64");
      if (!encoded || decoded.toString("base64") !== encoded) migrationFail("credential-unreadable");
      if (stored.startsWith("enc:")) token = storage.decryptString(decoded);
      else {
        // The exact legacy algorithm. Its key depends on the ORIGINAL path and app name.
        const key = createHash("sha256").update(`${legacyMachine.userDataPath}::${legacyMachine.appName}::cyrene-bot-secret`).digest().subarray(0, 16);
        for (let i = 0; i < decoded.length; i++) decoded[i] ^= key[i % key.length];
        token = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
      }
    } else token = stored.startsWith("plain:") ? stored.slice(6) : stored;
  } catch { return migrationFail("credential-unreadable"); }
  if (!token || token.length > 4096 || /[\x00-\x1f\x7f]/.test(token)) migrationFail("credential-unreadable");
  return token;
}
