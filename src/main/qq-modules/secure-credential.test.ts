import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { QqSecureCredentialStore, qqSecureCredentialDirectory } from "./secure-credential-store";
import { createQqElectronSecureStoragePort } from "./secure-credential-electron";
vi.mock("electron", () => ({ app: {}, safeStorage: {} }));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(checkpoint: (stage: "before-commit" | "after-commit") => void = () => {}) {
  const parent = mkdtempSync(join(tmpdir(), "qq-secure-credential-")); roots.push(parent);
  const root = qqSecureCredentialDirectory(parent), key = randomBytes(32);
  const storage = {
    isSecureAvailable: vi.fn(() => true),
    encryptString: vi.fn((plain: string) => {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      return Buffer.concat([nonce, cipher.update(plain, "utf8"), cipher.final(), cipher.getAuthTag()]);
    }),
    decryptString: vi.fn((bytes: Buffer) => {
      const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(bytes.length - 16));
      return Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]).toString("utf8");
    }),
  };
  const store = new QqSecureCredentialStore(root, storage, checkpoint);
  const put = (secret = "synthetic-token-A", expectedGeneration: string | null = null, accountId = "10000") =>
    store.write({ accountId, token: secret, expectedGeneration, userConfirmed: true });
  const path = join(root, "credential.json");
  return { parent, root, store, storage, put, path };
}
it("constructor and metadata reads do not create a directory or touch the keychain", () => {
  const s = setup(); expect(s.store.getMetadata()).toBeNull(); expect(existsSync(s.root)).toBe(false);
  expect(s.storage.isSecureAvailable).not.toHaveBeenCalled(); expect(s.storage.decryptString).not.toHaveBeenCalled();
});
it("persists only encrypted account-bound payload and reads metadata without decrypting", () => {
  const s = setup(); const metadata = s.put();
  expect(metadata).toMatchObject({ accountId: "10000", status: "active" }); expect(metadata.generation).toMatch(/^[a-f0-9-]{36}$/);
  expect(s.store.getMetadata()).toEqual(metadata); expect(s.storage.decryptString).not.toHaveBeenCalled();
  const disk = readFileSync(s.path, "utf8"); expect(disk).not.toContain("synthetic-token"); expect(disk).not.toContain('"token"');
  expect(s.store.read({ accountId: metadata.accountId, generation: metadata.generation })).toBe("synthetic-token-A");
  expect(readdirSync(s.root).sort()).toEqual(["credential.json", "marker"]);
});
it("replacement rotates random generation and old preview cannot read the new credential", () => {
  const s = setup(); const first = s.put(), second = s.put("synthetic-token-B", first.generation);
  expect(second.generation).not.toBe(first.generation);
  const count = s.storage.decryptString.mock.calls.length;
  expect(() => s.store.read({ accountId: first.accountId, generation: first.generation })).toThrow("stale-or-revoked");
  expect(s.storage.decryptString).toHaveBeenCalledTimes(count);
  expect(s.store.read({ accountId: second.accountId, generation: second.generation })).toBe("synthetic-token-B");
  expect(() => s.put("synthetic-token-C", first.generation)).toThrow("stale-generation");
  expect(s.store.getMetadata()).toEqual(second);
});
it("matches account as well as generation before decryption", () => {
  const s = setup(); const first = s.put();
  expect(() => s.store.read({ accountId: "999", generation: first.generation })).toThrow("stale-or-revoked");
  expect(s.storage.decryptString).not.toHaveBeenCalled();
});
it("revoke needs no available keychain and explicit restore reencrypts with a fresh generation", () => {
  const s = setup(); const first = s.put(); const original = JSON.parse(readFileSync(s.path, "utf8"));
  s.storage.isSecureAvailable.mockReturnValue(false);
  const revoked = s.store.revoke({ accountId: first.accountId, generation: first.generation, userConfirmed: true });
  expect(revoked.status).toBe("revoked"); expect(s.store.getMetadata()).toEqual(revoked);
  expect(JSON.parse(readFileSync(s.path, "utf8")).ciphertext).toBe(original.ciphertext);
  expect(s.storage.decryptString).not.toHaveBeenCalled();
  expect(() => s.store.read({ accountId: first.accountId, generation: first.generation })).toThrow("stale-or-revoked");
  expect(() => s.store.restore({ accountId: revoked.accountId, generation: revoked.generation, userConfirmed: true })).toThrow("secure-storage-unavailable");
  s.storage.isSecureAvailable.mockReturnValue(true);
  const restored = s.store.restore({ accountId: revoked.accountId, generation: revoked.generation, userConfirmed: true });
  expect(restored.generation).not.toBe(first.generation); expect(restored.status).toBe("active");
  expect(s.store.read({ accountId: restored.accountId, generation: restored.generation })).toBe("synthetic-token-A");
  expect(() => s.store.read({ accountId: first.accountId, generation: first.generation })).toThrow("stale-or-revoked");
});
it.each(["account", "generation"] as const)("detects relabelled %s metadata against the encrypted payload", (field) => {
  const s = setup(); s.put(); const envelope = JSON.parse(readFileSync(s.path, "utf8"));
  if (field === "account") envelope.accountId = "999"; else envelope.generation = randomUUID();
  writeFileSync(s.path, JSON.stringify(envelope));
  expect(() => s.store.read({ accountId: envelope.accountId, generation: envelope.generation })).toThrow("identity-mismatch");
});
it("requires strict explicit host consent and never accepts token/path extras in reads", () => {
  const s = setup();
  expect(() => s.store.write({ accountId: "10000", token: "synthetic-token", expectedGeneration: null, userConfirmed: false } as any)).toThrow("invalid-confirmation");
  expect(() => s.store.write({ accountId: "10000", token: "synthetic-token", expectedGeneration: null, userConfirmed: true, path: "/tmp/other" } as any)).toThrow("invalid-confirmation");
  const first = s.put();
  expect(() => s.store.read({ accountId: first.accountId, generation: first.generation, token: "secret" } as any)).toThrow("invalid-request");
  expect(() => s.store.revoke({ accountId: first.accountId, generation: first.generation, userConfirmed: false } as any)).toThrow("invalid-confirmation");
});
it.each(["", " ", "\n", "abc\0", "x".repeat(4097)])("rejects blank/control/oversized tokens before writes", (secret) => {
  const s = setup(); expect(() => s.put(secret)).toThrow("invalid-confirmation"); expect(existsSync(s.root)).toBe(false);
});
it("unavailable or failing encryption is zero-write and does not expose underlying messages", () => {
  const s = setup(); s.storage.isSecureAvailable.mockReturnValue(false);
  expect(() => s.put()).toThrow("secure-storage-unavailable"); expect(existsSync(s.root)).toBe(false);
  s.storage.isSecureAvailable.mockReturnValue(true);
  s.storage.encryptString.mockImplementationOnce(() => { throw Error("PRIVATE token and path"); });
  expect(() => s.put()).toThrow(/^QQ_SECURE_CREDENTIAL_encryption-failed$/); expect(existsSync(s.root)).toBe(false);
  s.put(); s.storage.decryptString.mockImplementationOnce(() => { throw Error("PRIVATE decrypt detail"); });
  const meta = s.store.getMetadata()!;
  expect(() => s.store.read({ accountId: meta.accountId, generation: meta.generation })).toThrow(/^QQ_SECURE_CREDENTIAL_decryption-failed$/);
});
it("a failed replacement leaves the old envelope and generation readable", () => {
  let shouldFail = false; const s = setup((stage) => { if (shouldFail && stage === "before-commit") throw Error("disk full"); });
  const first = s.put(); shouldFail = true;
  expect(() => s.put("synthetic-token-B", first.generation)).toThrow("write-failed");
  expect(s.store.getMetadata()).toEqual(first); expect(s.store.read({ accountId: first.accountId, generation: first.generation })).toBe("synthetic-token-A");
  expect(readdirSync(s.root).sort()).toEqual(["credential.json", "marker"]);
});
it("reports uncertainty after the commit point rather than claiming the write never happened", () => {
  const s = setup((stage) => { if (stage === "after-commit") throw Error("later failure"); });
  expect(() => s.put()).toThrow("commit-uncertain");
  expect(s.store.getMetadata()?.status).toBe("active");
});
it("does not treat interrupted first write or deleted state as an absent credential", () => {
  const interrupted = setup(() => { throw Error("disk full"); }); expect(() => interrupted.put()).toThrow("write-failed");
  expect(() => interrupted.store.getMetadata()).toThrow("incomplete-store");
  const deleted = setup(); deleted.put(); rmSync(deleted.path);
  expect(() => deleted.store.getMetadata()).toThrow("incomplete-store");
  expect(() => deleted.put()).toThrow("incomplete-store");
});
it.each(["schema", "extra", "base64", "oversized"] as const)("rejects malformed %s envelopes without decryption", (kind) => {
  const s = setup(); s.put(); const value = JSON.parse(readFileSync(s.path, "utf8"));
  if (kind === "schema") value.schemaVersion = 2;
  if (kind === "extra") value.token = "not allowed";
  if (kind === "base64") value.ciphertext += "\n";
  if (kind === "oversized") value.ciphertext = "a".repeat(50000);
  writeFileSync(s.path, JSON.stringify(value));
  expect(() => s.store.getMetadata()).toThrow(); expect(s.storage.decryptString).not.toHaveBeenCalled();
});
it("stale locks fail closed for metadata, read and mutation without auto-removal", () => {
  const s = setup(); const first = s.put(); writeFileSync(join(s.root, "credential-lock"), "");
  expect(() => s.store.getMetadata()).toThrow("busy-or-recovery-required");
  expect(() => s.store.read({ accountId: first.accountId, generation: first.generation })).toThrow("busy-or-recovery-required");
  expect(() => s.put("new", first.generation)).toThrow("busy-or-recovery-required");
  expect(existsSync(join(s.root, "credential-lock"))).toBe(true);
});
it("hard-linked state files are rejected", () => {
  const s = setup(); s.put(); linkSync(s.path, join(s.parent, "copy"));
  expect(() => s.store.getMetadata()).toThrow("unsafe-store-file");
});
it.skipIf(process.platform === "win32")("rejects dangling state/lock/root links and symlink ancestors", () => {
  const state = setup(); state.put(); rmSync(state.path); symlinkSync(join(state.parent, "missing"), state.path);
  expect(() => state.store.getMetadata()).toThrow("unsafe-store-file");
  const lock = setup(); lock.put(); symlinkSync(join(lock.parent, "missing"), join(lock.root, "credential-lock"));
  expect(() => lock.store.getMetadata()).toThrow("busy-or-recovery-required");
  const root = setup(); symlinkSync(join(root.parent, "missing"), root.root);
  expect(() => root.store.getMetadata()).toThrow("unsafe-store-path");
  const ancestor = setup(); const alias = join(ancestor.parent, "alias"); symlinkSync(ancestor.parent, alias, "dir");
  expect(() => new QqSecureCredentialStore(join(alias, "creds"), ancestor.storage).getMetadata()).toThrow("unsafe-store-path");
});
function adapter(platform: NodeJS.Platform = "linux", backend = "gnome_libsecret") {
  const deps = { platform, app: { isReady: vi.fn(() => false) }, safeStorage: { isEncryptionAvailable: vi.fn(() => true), getSelectedStorageBackend: vi.fn(() => backend),
    encryptString: vi.fn((value: string) => Buffer.from(value)), decryptString: vi.fn((value: Buffer) => value.toString()) } };
  return { deps, port: createQqElectronSecureStoragePort(deps) };
}
it("Electron availability is checked afresh across ready and keychain changes", () => {
  const s = adapter(); expect(s.port.isSecureAvailable()).toBe(false);
  s.deps.app.isReady.mockReturnValue(true); expect(s.port.isSecureAvailable()).toBe(true);
  s.deps.safeStorage.isEncryptionAvailable.mockReturnValue(false);
  expect(() => s.port.encryptString("synthetic")).toThrow("secure-storage-unavailable");
  s.deps.safeStorage.isEncryptionAvailable.mockReturnValue(true); expect(s.port.encryptString("synthetic").toString()).toBe("synthetic");
});
it.each(["basic_text", "unknown", "future_unknown_backend"])("Electron rejects Linux %s backend with no fallback", (backend) => {
  const s = adapter("linux", backend); s.deps.app.isReady.mockReturnValue(true);
  expect(s.port.isSecureAvailable()).toBe(false);
  expect(() => s.port.decryptString(Buffer.from("anything"))).toThrow("secure-storage-unavailable");
  expect(s.deps.safeStorage.decryptString).not.toHaveBeenCalled();
});
it.each(["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"])("Electron supports explicit Linux secure backend %s", (backend) => {
  const s = adapter("linux", backend); s.deps.app.isReady.mockReturnValue(true); expect(s.port.isSecureAvailable()).toBe(true);
});
it.each(["win32", "darwin"] as const)("Electron uses the native %s encryption service without Linux fallback checks", (platform) => {
  const s = adapter(platform); s.deps.app.isReady.mockReturnValue(true);
  expect(s.port.isSecureAvailable()).toBe(true); expect(s.deps.safeStorage.getSelectedStorageBackend).not.toHaveBeenCalled();
});
