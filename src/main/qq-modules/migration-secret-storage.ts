import { app, safeStorage } from "electron";
import type { QqMigrationSecretStorage } from "./migration-plan";

/** Unlike the legacy settings store, migration must not fall back to obfuscation or
 * Linux basic_text. This host-only adapter performs no writes or credential export. */
export const qqMigrationSecretStorage: QqMigrationSecretStorage = {
  isSecureAvailable() {
    try {
      if (!app.isReady() || !safeStorage.isEncryptionAvailable()) return false;
      if (process.platform === "linux") {
        const backend = safeStorage.getSelectedStorageBackend();
        return ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(backend);
      }
      return true;
    } catch { return false; }
  },
  decryptString(bytes) {
    if (!this.isSecureAvailable()) throw new Error("QQ_MIGRATION_secure-storage-unavailable");
    return safeStorage.decryptString(bytes);
  },
};
