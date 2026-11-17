import { isAbsolute, parse, resolve } from "node:path";
import type { MessageHandler } from "../channels/types";
import { QqModuleManager, type QqModuleManagerOptions } from "./manager";
import { QqMediaBroker } from "./media-broker";
import type { QqMigrationOptions } from "./migration";
import type { QqPackageStore } from "./package-store";
import { createQqUtilityProcess } from "./utility-process";

export interface QqTrustedRuntimeFactoryOptions {
  packages: QqPackageStore;
  /** Dedicated host-owned absolute cache. Omit to disable media. Never renderer input. */
  mediaCacheDirectory?: string;
  onMessage?: MessageHandler;
  timeouts?: Pick<QqModuleManagerOptions, "requestTimeoutMs" | "sendTimeoutMs" | "drainTimeoutMs">;
}
/** Composes real store verification, Electron utilityProcess, manager and optional media
 * broker. Not registered in production startup/IPC and does not supply release trust.
 * Constructing this factory or a manager performs no store reads, writes or process starts.
 * The host must serialize driver ownership and installation; path checks are NOT a sandbox.
 * Use both returned ports on the SAME migration coordinator, with the SAME package store
 * as the installation controller. A selected package is not proof of a live activation. */
export function createQqTrustedRuntimeFactory(options: QqTrustedRuntimeFactoryOptions): Pick<QqMigrationOptions, "verifyCandidate" | "createModule"> {
  const packages = options.packages;
  const cache = options.mediaCacheDirectory;
  if (cache !== undefined && (!isAbsolute(cache) || resolve(cache) === parse(resolve(cache)).root)) throw new Error("QQ_MODULE_INVALID_CACHE_PATH");
  const onMessage = options.onMessage;
  const timeouts = { ...options.timeouts };
  return {
    verifyCandidate(packageId) { packages.resolveSelectedRuntime(packageId); },
    createModule(input, packageId) {
      // Do not retain caller-mutable settings/credentials or allow a subsequent caller
      // mutation to change which account was confirmed. Manager validates on start.
      const configuration = structuredClone(input);
      const manager = new QqModuleManager({ ...timeouts, getConfiguration: () => structuredClone(configuration),
        ...(cache === undefined ? {} : { mediaBroker: new QqMediaBroker(cache) }),
        createTransport: () => {
          const candidate = packages.resolveSelectedRuntime(packageId);
          return createQqUtilityProcess(candidate.packageDirectory, candidate.entryPath);
        },
      });
      manager.onMessage = onMessage ?? null;
      return manager;
    },
  };
}
