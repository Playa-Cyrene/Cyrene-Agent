import type { QqApiSupport, QqApiVersion } from "./types";
import { isBoundedJson, strictObject } from "./validation";

/** 仅本 checkout 中实现的候选协议，不是已发布 SDK 或主程序兼容声明。 */
export const QQ_API_SUPPORT: Readonly<QqApiSupport> = Object.freeze({ major: 1, minMinor: 0, maxMinor: 0 });
export function validateApiSupport(value: unknown): value is QqApiSupport {
  const versionNumber = (v: unknown): boolean => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 65535;
  if (!isBoundedJson(value) || !strictObject(value, { major: versionNumber, minMinor: versionNumber, maxMinor: versionNumber })) return false;
  const support = value as QqApiSupport;
  return support.major > 0 && support.minMinor <= support.maxMinor;
}
export type QqApiNegotiation = { ok: true; version: QqApiVersion } | { ok: false; reason: "malformed" | "major-mismatch" | "minor-mismatch" };
/** Pick highest mutually supported minor; never coerce strings or default a missing version. */
export function negotiateQqApi(host: unknown, module: unknown): QqApiNegotiation {
  if (!validateApiSupport(host) || !validateApiSupport(module)) return { ok: false, reason: "malformed" };
  if (host.major !== module.major) return { ok: false, reason: "major-mismatch" };
  const minor = Math.min(host.maxMinor, module.maxMinor);
  if (minor < Math.max(host.minMinor, module.minMinor)) return { ok: false, reason: "minor-mismatch" };
  return { ok: true, version: { major: host.major, minor } };
}
