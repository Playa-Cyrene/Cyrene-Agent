import { isQqModuleLoopbackHost } from "./listen-policy";
import { resolveQqListenAuthRequirement } from "../channels/qq-listen-policy";
import { strictObject } from "../../shared/qq-module/validation";
import type { QqModuleInstallationStatus, QqModuleListenInput } from "../../shared/qq-module-installation";

/** No published trust root/format/support matrix is approved yet. This read-only
 * endpoint must never fetch releases, create directories, migrate or start a module.
 * The offline verifier/store are intentionally not imported by production wiring. */
export function getQqModuleInstallationStatus(input: unknown, interfaces?: Parameters<typeof resolveQqListenAuthRequirement>[1]): QqModuleInstallationStatus {
  const valid = strictObject(input, { listenMode: (v) => ["auto", "loopback", "wsl", "custom"].includes(v as string) },
    { customHost: (v) => typeof v === "string" && v.length <= 253 });
  const resolved = valid ? resolveQqListenAuthRequirement(input as QqModuleListenInput, interfaces) : null;
  // QFCA's first supported policy is loopback-only. A token cannot enable remote
  // listening. Do not silently rewrite auto/WSL/custom settings to loopback.
  const listenCompatibility = !resolved?.ok ? "unresolved" : isQqModuleLoopbackHost(resolved.resolvedHost) ? "loopback" : "unsupported-host";
  return { availability: "release-unconfigured", canInstall: false, moduleInstalled: false, currentDriver: "legacy-builtin", listenCompatibility };
}
