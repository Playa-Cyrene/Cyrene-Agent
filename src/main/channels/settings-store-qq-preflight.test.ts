import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const fixture = vi.hoisted(() => ({ root: "", decoded: "test-only-secret", fail: false }));
vi.mock("electron", () => ({ app: { getPath: () => fixture.root, getName: () => "Cyrene", isReady: () => true },
  safeStorage: { isEncryptionAvailable: () => true, decryptString: vi.fn(() => {
    if (fixture.fail) throw new Error("private decrypt diagnostic and token");
    return fixture.decoded;
  }) } }));
import { readQqModulePreflightToken } from "./settings-store";
import { getQqModuleInstallationStatus } from "../qq-modules/installation-status";
const query = () => getQqModuleInstallationStatus({ listenMode: "loopback" }, {}, readQqModulePreflightToken);
beforeEach(() => { fixture.root = mkdtempSync(join(tmpdir(), "qq-token-preflight-")); fixture.decoded = "test-only-secret"; fixture.fail = false; });
afterEach(() => { rmSync(fixture.root, { recursive: true, force: true }); vi.restoreAllMocks(); });
describe("saved QQ credential read-only module preflight", () => {
  it.each(["plain", "raw", "enc", "obf"])("reads %s values without rewriting or exposing them", (format) => {
    for (const decoded of ["", "  ", "\t\u00a0", " test-only-secret "]) {
      fixture.decoded = decoded;
      let stored = decoded;
      if (format === "plain") stored = `plain:${decoded}`;
      if (format === "enc") stored = "enc:YWJj";
      if (format === "obf") {
        const bytes = Buffer.from(decoded);
        const key = createHash("sha256").update(`${fixture.root}::Cyrene::cyrene-bot-secret`).digest();
        for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % 16];
        stored = `obf:${bytes.toString("base64")}`;
      }
      const file = join(fixture.root, "channels-settings.json");
      const bytes = JSON.stringify({ qq: { accessToken: stored }, feishu: { appSecret: "enc:!!" } });
      writeFileSync(file, bytes);
      const status = query();
      expect(status.tokenCompatibility).toBe(format === "obf" && !decoded ? "unresolved" : decoded.trim() ? "available" : "required");
      expect(status.canInstall).toBe(false);
      expect(JSON.stringify(status)).not.toContain("test-only-secret");
      expect(readFileSync(file, "utf8")).toBe(bytes);
    }
  });
  it("rejects malformed obfuscated UTF-8 rather than treating replacement text as a token", () => {
    const key = createHash("sha256").update(`${fixture.root}::Cyrene::cyrene-bot-secret`).digest();
    const stored = `obf:${Buffer.from([0xff ^ key[0]]).toString("base64")}`;
    writeFileSync(join(fixture.root, "channels-settings.json"), JSON.stringify({ qq: { accessToken: stored } }));
    expect(query().tokenCompatibility).toBe("unresolved");
  });
  it("distinguishes missing credentials from failed reads without logging diagnostics", () => {
    expect(query().tokenCompatibility).toBe("required");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const file = join(fixture.root, "channels-settings.json");
    for (const content of ['{"qq":{"accessToken":"enc:YWJj"}}', '{"qq":{"accessToken":"enc:!!"}}', '{"qq":{"accessToken":42}}', 'bad json']) {
      fixture.fail = true; writeFileSync(file, content);
      expect(query().tokenCompatibility).toBe("unresolved");
      expect(readFileSync(file, "utf8")).toBe(content);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
