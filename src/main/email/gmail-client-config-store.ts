import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasGmailSafeStorage, type GmailSafeStoragePort } from "./gmail-safe-storage";

const CONFIG_FILE = "gmail-client-config.enc";

export interface GmailClientCredentials {
  clientId: string;
  clientSecret?: string;
}

function isGmailClientCredentials(value: unknown): value is GmailClientCredentials {
  if (!value || typeof value !== "object") return false;
  const config = value as Partial<GmailClientCredentials>;
  return typeof config.clientId === "string"
    && config.clientId.trim().length > 0
    && (config.clientSecret === undefined || typeof config.clientSecret === "string");
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class GmailClientConfigStore {
  constructor(
    private readonly storage: GmailSafeStoragePort = safeStorage,
    private readonly getUserDataPath: () => string = () => app.getPath("userData"),
  ) {}

  get isSecureStorageAvailable(): boolean {
    return hasGmailSafeStorage(this.storage);
  }

  private get filePath(): string {
    return path.join(this.getUserDataPath(), CONFIG_FILE);
  }

  async load(): Promise<GmailClientCredentials | null> {
    if (!this.isSecureStorageAvailable) throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");

    let encrypted: Buffer;
    try {
      encrypted = await readFile(this.filePath);
    } catch (error) {
      if (isMissingFile(error)) return null;
      throw error;
    }

    try {
      const decrypted = await this.storage.decryptStringAsync(encrypted);
      const value: unknown = JSON.parse(decrypted.result);
      if (!isGmailClientCredentials(value)) throw new Error("invalid config shape");
      return {
        clientId: value.clientId.trim(),
        ...(value.clientSecret?.trim() ? { clientSecret: value.clientSecret.trim() } : {}),
      };
    } catch {
      throw new Error("GMAIL_CLIENT_CONFIG_CORRUPT");
    }
  }

  async save(config: GmailClientCredentials): Promise<void> {
    if (!this.isSecureStorageAvailable) throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");
    if (!isGmailClientCredentials(config)) throw new Error("GMAIL_CLIENT_CONFIG_INVALID");

    const filePath = this.filePath;
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const encrypted = await this.storage.encryptStringAsync(JSON.stringify({
        clientId: config.clientId.trim(),
        ...(config.clientSecret?.trim() ? { clientSecret: config.clientSecret.trim() } : {}),
      }));
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
