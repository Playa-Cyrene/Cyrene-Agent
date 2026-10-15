import { safeStorage } from "electron";

export interface GmailSafeStoragePort {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; error?: string }>;
}

export function hasGmailSafeStorage(storage: GmailSafeStoragePort = safeStorage): boolean {
  if (!storage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  try {
    const backend = storage.getSelectedStorageBackend();
    return backend !== "basic_text" && backend !== "unknown";
  } catch {
    return false;
  }
}
