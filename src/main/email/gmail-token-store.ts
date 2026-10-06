import { app, safeStorage } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { hasGmailSafeStorage, type GmailSafeStoragePort } from "./gmail-safe-storage";

const TOKEN_FILE = "gmail-tokens.enc";

export interface GmailTokens {
  access_token: string;
  refresh_token: string;
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

function isGmailTokens(value: unknown): value is GmailTokens {
  if (!value || typeof value !== "object") return false;
  const tokens = value as Partial<GmailTokens>;
  return typeof tokens.access_token === "string"
    && tokens.access_token.length > 0
    && typeof tokens.refresh_token === "string"
    && tokens.refresh_token.length > 0
    && (tokens.expiry_date === undefined || Number.isFinite(tokens.expiry_date))
    && (tokens.scope === undefined || typeof tokens.scope === "string")
    && (tokens.token_type === undefined || typeof tokens.token_type === "string");
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export class GmailTokenStore {
  constructor(
    private readonly storage: GmailSafeStoragePort = safeStorage,
    private readonly getUserDataPath: () => string = () => app.getPath("userData"),
  ) {}

  get isSecureStorageAvailable(): boolean {
    return hasGmailSafeStorage(this.storage);
  }

  private get filePath(): string {
    return path.join(this.getUserDataPath(), TOKEN_FILE);
  }

  async load(): Promise<GmailTokens | null> {
    if (!this.isSecureStorageAvailable) {
      throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");
    }

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
      if (!isGmailTokens(value)) throw new Error("invalid token shape");
      return value;
    } catch {
      throw new Error("GMAIL_TOKEN_STORE_CORRUPT");
    }
  }

  async save(tokens: GmailTokens): Promise<void> {
    if (!this.isSecureStorageAvailable) {
      throw new Error("GMAIL_SAFE_STORAGE_UNAVAILABLE");
    }
    if (!isGmailTokens(tokens)) throw new Error("GMAIL_TOKEN_INVALID");

    const filePath = this.filePath;
    const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await mkdir(path.dirname(filePath), { recursive: true });
    try {
      const encrypted = await this.storage.encryptStringAsync(JSON.stringify(tokens));
      await writeFile(temporaryPath, encrypted, { mode: 0o600 });
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}
