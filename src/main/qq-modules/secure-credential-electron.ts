import { app, safeStorage } from "electron";
import { QqSecureCredentialError, type QqSecureStoragePort } from "./secure-credential-store";

export interface QqElectronSafeStorageDependencies {
  app: { isReady(): boolean };
  safeStorage: { isEncryptionAvailable(): boolean; getSelectedStorageBackend(): string; encryptString(value: string): Buffer; decryptString(value: Buffer): string };
  platform: NodeJS.Platform;
}
/** Every operation rechecks live readiness and backend; no cached early false result,
 * no Linux basic_text/unknown backend and no fallback encryption or obfuscation. */
export function createQqElectronSecureStoragePort(deps: QqElectronSafeStorageDependencies = { app, safeStorage, platform: process.platform }): QqSecureStoragePort {
  const available = (): boolean => {
    try {
      if (!deps.app.isReady() || !deps.safeStorage.isEncryptionAvailable()) return false;
      if (deps.platform === "linux") return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(deps.safeStorage.getSelectedStorageBackend());
      return deps.platform === "win32" || deps.platform === "darwin";
    } catch { return false; }
  };
  return {
    isSecureAvailable: available,
    encryptString(value) {
      if (!available()) throw new QqSecureCredentialError("secure-storage-unavailable");
      try { return deps.safeStorage.encryptString(value); } catch { throw new QqSecureCredentialError("encryption-failed"); }
    },
    decryptString(value) {
      if (!available()) throw new QqSecureCredentialError("secure-storage-unavailable");
      try { return deps.safeStorage.decryptString(value); } catch { throw new QqSecureCredentialError("decryption-failed"); }
    },
  };
}
