import { EventEmitter } from "node:events";
import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QqPackageStore } from "./package-store";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest, type QqPackageVerificationContext } from "./package-verifier";
import { capabilities, configuration } from "../../../scripts/verify/qq-module/fixtures";
import type { QqRequest } from "../../shared/qq-module";
const mocks = vi.hoisted(() => ({ ready: vi.fn(() => true), fork: vi.fn() }));
vi.mock("electron", () => ({ app: { isReady: mocks.ready }, utilityProcess: { fork: mocks.fork } }));
import { createQqTrustedRuntimeFactory } from "./trusted-runtime-factory";
const roots: string[] = [];
const managers: Array<ReturnType<ReturnType<typeof createQqTrustedRuntimeFactory>["createModule"]>> = [];
beforeEach(() => { mocks.fork.mockReset(); mocks.ready.mockReturnValue(true); });
afterEach(async () => { for (const manager of managers.splice(0)) await manager.stop(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "qq-trusted-factory-")); roots.push(root);
  const key = generateKeyPairSync("ed25519");
  const context: QqPackageVerificationContext = { trustedKeys: new Map([["fixture", key.publicKey.export({ type: "spki", format: "pem" }).toString()]]), hostVersion: "1.3.7", platform: process.platform, arch: process.arch, now: 1000 };
  const storeRoot = join(root, "packages"), packages = new QqPackageStore(storeRoot, () => context);
  const candidate = (sequence = 1) => {
    const files = new Map([["dist/runtime/entry.cjs", Buffer.from(`// inert fixture ${sequence}`)]]);
    const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: `0.1.${sequence}`, releaseSequence: sequence, keyId: "fixture", issuedAt: 900, expiresAt: 2000,
      hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" }, apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: process.platform, arch: process.arch }], entry: "dist/runtime/entry.cjs",
      files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: qqPackageDigest(bytes) })) };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    return { manifest: manifestBytes, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), manifestBytes]), key.privateKey), files };
  };
  const requests: QqRequest[] = [];
  mocks.fork.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & { postMessage: (message: QqRequest) => void; kill: () => boolean };
    child.postMessage = (request) => {
      requests.push(request);
      const payload = request.method === "hello" ? { moduleId: "qfca", moduleVersion: "0.1.0", apiSupport: { major: 1, minMinor: 0, maxMinor: 0 } }
        : request.method === "initialize" ? { capabilities }
          : request.method === "start" ? { phase: "running", selfId: "10000", connectionEpoch: 1 }
            : request.method === "send" ? { operationId: request.payload.operationId, outcome: "sent", parts: request.payload.parts.map((_, partIndex) => ({ partIndex, outcome: "sent", messageId: "1" })) } : {};
      queueMicrotask(() => child.emit("message", { apiVersion: request.apiVersion, instanceId: request.instanceId, runtimeEpoch: request.runtimeEpoch,
        kind: "response", responseTo: request.requestId, ok: true, payload }));
    };
    child.kill = () => { queueMicrotask(() => child.emit("exit", 0)); return true; };
    return child;
  });
  const install = (sequence = 1) => packages.install(candidate(sequence), { userConfirmed: true });
  return { root, storeRoot, packages, context, install, requests };
}
it("resolves only an exact selected candidate, derives nested entry from the verified manifest, and performs no writes", () => {
  const s = setup(); const absent = `pkg-${"a".repeat(64)}`;
  expect(() => s.packages.resolveSelectedRuntime(absent)).toThrow("runtime-candidate-unavailable");
  expect(existsSync(s.storeRoot)).toBe(false);
  const first = s.install(); const selected = s.packages.resolveSelectedRuntime(first.packageId);
  expect(selected.packageDirectory).toBe(join(s.storeRoot, first.packageId, "payload"));
  expect(selected.entryPath).toBe(join(selected.packageDirectory, "dist/runtime/entry.cjs"));
  expect(readFileSync(selected.entryPath).toString()).toBe("// inert fixture 1");
  s.install(2);
  expect(() => s.packages.resolveSelectedRuntime(first.packageId)).toThrow("runtime-candidate-changed");
  expect(() => s.packages.resolveSelectedRuntime("../entry.cjs")).toThrow("invalid-runtime-candidate");
});
it.each(["revoked", "expired", "incompatible", "tampered", "locked"] as const)("revalidates %s state before exposing executable paths", (change) => {
  const s = setup(); const first = s.install();
  if (change === "revoked") s.context.trustedKeys = new Map();
  if (change === "expired") s.context.now = 2000;
  if (change === "incompatible") s.context.hostVersion = "2.0.0";
  if (change === "tampered") writeFileSync(join(s.storeRoot, first.packageId, "payload/dist/runtime/entry.cjs"), "malicious");
  if (change === "locked") writeFileSync(join(s.storeRoot, "install-lock"), "recovery required");
  expect(() => s.packages.resolveSelectedRuntime(first.packageId)).toThrow();
  expect(mocks.fork).not.toHaveBeenCalled();
});
it("builds a side-effect-free manager then starts through the real resolver and utilityProcess adapter", async () => {
  const s = setup(); const selected = s.install(); const cache = join(s.root, "media");
  const resolve = vi.spyOn(s.packages, "resolveSelectedRuntime");
  const handler = vi.fn(async () => null);
  const factory = createQqTrustedRuntimeFactory({ packages: s.packages, mediaCacheDirectory: cache, onMessage: handler });
  const input = configuration(); const manager = factory.createModule(input, selected.packageId); managers.push(manager);
  input.credentials.accessToken = "mutated-after-confirmation";
  expect(resolve).not.toHaveBeenCalled(); expect(mocks.fork).not.toHaveBeenCalled(); expect(existsSync(cache)).toBe(false);
  factory.verifyCandidate(selected.packageId); expect(resolve).toHaveBeenCalledOnce();
  await manager.start(); expect(manager.getState().phase).toBe("running");
  expect(resolve).toHaveBeenCalledTimes(2);
  expect(mocks.fork.mock.calls[0]?.[0]).toBe(join(s.storeRoot, selected.packageId, "payload/dist/runtime/entry.cjs"));
  expect(mocks.fork.mock.calls[0]?.[2].cwd).toBe(join(s.storeRoot, selected.packageId, "payload"));
  expect(manager.onMessage).toBe(handler);
  const init = s.requests.find((request) => request.method === "initialize");
  expect(init?.payload).toMatchObject({ mediaTransfer: "chunked-v1", credentials: { accessToken: "test-only-token" } });
  expect(JSON.stringify(mocks.fork.mock.calls)).not.toContain("test-only-token");
  expect(existsSync(cache)).toBe(false); // Broker is lazy until actual transfer.
});
it.each(["replaced", "revoked", "tampered"] as const)("rechecks a pinned candidate on restart after it is %s", async (change) => {
  const s = setup(); const selected = s.install();
  const factory = createQqTrustedRuntimeFactory({ packages: s.packages });
  const manager = factory.createModule(configuration(), selected.packageId); managers.push(manager);
  await manager.start(); expect(manager.getState().phase).toBe("running");
  if (change === "replaced") s.install(2);
  if (change === "revoked") s.context.trustedKeys = new Map();
  if (change === "tampered") writeFileSync(join(s.storeRoot, selected.packageId, "payload/dist/runtime/entry.cjs"), "bad");
  await manager.restart(); expect(manager.getState().phase).toBe("failed"); expect(mocks.fork).toHaveBeenCalledOnce();
});
it("cannot use an uninstalled directory or relative/root media cache as authority", async () => {
  const s = setup();
  expect(() => createQqTrustedRuntimeFactory({ packages: s.packages, mediaCacheDirectory: "relative" })).toThrow("INVALID_CACHE_PATH");
  const factory = createQqTrustedRuntimeFactory({ packages: s.packages });
  const manager = factory.createModule(configuration(), join(s.root, "arbitrary.cjs")); managers.push(manager);
  await manager.start(); expect(manager.getState().phase).toBe("failed"); expect(mocks.fork).not.toHaveBeenCalled();
});
it("detects a selection changed during verification rather than returning the old executable", () => {
  const s = setup(); const first = s.install();
  let replace = true;
  const resolver = new QqPackageStore(s.storeRoot, () => {
    if (replace) { replace = false; s.install(2); }
    return s.context;
  });
  expect(() => resolver.resolveSelectedRuntime(first.packageId)).toThrow("runtime-candidate-changed");
  expect(mocks.fork).not.toHaveBeenCalled();
});
it("does not start an unready Electron runtime or opt into media when no broker was requested", async () => {
  const s = setup(); const selected = s.install();
  const factory = createQqTrustedRuntimeFactory({ packages: s.packages });
  const manager = factory.createModule(configuration(), selected.packageId); managers.push(manager);
  mocks.ready.mockReturnValue(false);
  await manager.start(); expect(manager.getState().phase).toBe("failed"); expect(mocks.fork).not.toHaveBeenCalled();
  mocks.ready.mockReturnValue(true);
  await manager.restart(); expect(manager.getState().phase).toBe("running");
  const init = s.requests.find((request) => request.method === "initialize");
  expect(init?.payload).not.toHaveProperty("mediaTransfer");
});
