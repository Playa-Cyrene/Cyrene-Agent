import { afterEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ ready: true, available: true, backend: "gnome_libsecret" }));
vi.mock("electron", () => ({ app: { isReady: () => state.ready }, safeStorage: {
  isEncryptionAvailable: () => state.available, getSelectedStorageBackend: () => state.backend,
  decryptString: () => "test-secret",
} }));
import { qqMigrationSecretStorage } from "./migration-secret-storage";
afterEach(() => { state.ready = true; state.available = true; state.backend = "gnome_libsecret"; vi.unstubAllGlobals(); });
describe("QQ migration OS storage gate", () => {
  it("requires a ready app and actual encryption availability", () => {
    state.ready = false; expect(qqMigrationSecretStorage.isSecureAvailable()).toBe(false);
    state.ready = true; state.available = false; expect(qqMigrationSecretStorage.isSecureAvailable()).toBe(false);
    expect(() => qqMigrationSecretStorage.decryptString(Buffer.alloc(0))).toThrow("secure-storage-unavailable");
  });
  it("rejects basic_text/unknown Linux backends and accepts supported keychains", () => {
    vi.stubGlobal("process", { ...process, platform: "linux" });
    for (const backend of ["basic_text", "unknown", "", "future-unknown-backend"]) {
      state.backend = backend; expect(qqMigrationSecretStorage.isSecureAvailable()).toBe(false);
    }
    for (const backend of ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"]) {
      state.backend = backend; expect(qqMigrationSecretStorage.isSecureAvailable()).toBe(true);
    }
  });
});
