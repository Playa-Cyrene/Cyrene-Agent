import { generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, OutgoingMessage } from "../channels/types";
import type { QqInitialize, QqRequest, QqSendResultV1 } from "../../shared/qq-module";
import { capabilities, FakeTransport, inbound } from "../../../scripts/verify/qq-module/fixtures";
import { getQqModuleInstallationStatus } from "./installation-status";
import { QqModuleManager } from "./manager";
import { QqMediaBroker } from "./media-broker";
import { QqMigrationCoordinator } from "./migration";
import { QqMigrationStore, type QqMigrationRecord } from "./migration-store";
import { QqPackageStore } from "./package-store";
import { QQ_PACKAGE_SIGNATURE_DOMAIN, qqPackageDigest, type QqPackageManifest, type QqPackageVerificationContext } from "./package-verifier";

const roots: string[] = [], managers: QqModuleManager[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const attachment = { kind: "file" as const, mediaId: "incoming-fixture", filename: "history.txt", size: 5 };
function setup(checkpoint: (record: QqMigrationRecord) => void = () => {}) {
  const root = mkdtempSync(join(tmpdir(), "qq-integrated-rehearsal-")); roots.push(root);
  // Ephemeral test key and inert payload only. Never installed in production roots,
  // never used to execute the package or to authorize a real QFCA release.
  const key = generateKeyPairSync("ed25519");
  const context: QqPackageVerificationContext = { trustedKeys: new Map([["test-only", key.publicKey.export({ type: "spki", format: "pem" }).toString()]]),
    hostVersion: "1.3.7", platform: "linux", arch: "x64", now: 1000 };
  const files = new Map([["entry.cjs", Buffer.from("// inert integration fixture")]]);
  const manifest: QqPackageManifest = { schemaVersion: 1, moduleId: "qfca", version: "0.1.0", releaseSequence: 1, keyId: "test-only",
    issuedAt: 900, expiresAt: 2000, hostVersionRange: { minInclusive: "1.3.0", maxExclusive: "1.4.0" },
    apiSupport: { major: 1, minMinor: 0, maxMinor: 0 }, targets: [{ platform: "linux", arch: "x64" }], entry: "entry.cjs",
    files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: qqPackageDigest(bytes) })) };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const packages = new QqPackageStore(join(root, "packages"), () => context);
  const candidate = packages.install({ manifest: bytes, files,
    signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), bytes]), key.privateKey) }, { userConfirmed: true });
  const settings = join(root, "legacy-settings.json"), history = join(root, "legacy-history.jsonl"), binding = join(root, "legacy-bindings.json");
  writeFileSync(settings, JSON.stringify({ qq: { enabled: true, listenMode: "loopback", port: 6200, accessToken: "plain:test-only-secret",
    allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true,
    groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal" } }));
  writeFileSync(history, '{"text":"old history remains"}\n'); writeFileSync(binding, '{"session":"qq:20000"}\n');
  const originals = [settings, history, binding].map((path) => [path, readFileSync(path)] as const);
  const source = join(root, "host-selected.txt"); writeFileSync(source, "hello");
  const outgoing: OutgoingMessage = { channel: "qq", chatType: "group", targetId: "20000",
    parts: [{ kind: "text", text: "text plus file" }, { kind: "file", filePath: source, name: "reply.txt" }] };
  const peer = new FakeTransport(), original = peer.behavior;
  peer.behavior = (request) => request.method === "initialize" ? peer.reply(request, {
    capabilities: { ...capabilities, messages: { ...capabilities.messages, file: true, maxFileBytes: 100 * 1024 * 1024 } } })
    : request.method === "mediaBeginUpload" ? peer.reply(request, { mediaId: "upload-fixture" })
      : request.method === "mediaRead" ? peer.reply(request, { data: "aGVsbG8=", eof: true }) : original(request);
  const store = new QqMigrationStore(join(root, "migration"), checkpoint);
  const received: IncomingMessage[] = [];
  let manager: QqModuleManager | undefined;
  const legacy = { getMigrationIdentity: () => ({ accountId: "10000", connectionEpoch: 7 }),
    prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const createTransport = vi.fn(() => peer);
  const verifyCandidate = vi.fn((id: string) => { if (packages.getSelected()?.packageId !== id) throw new Error("candidate-changed"); });
  const createModule = vi.fn((input: QqInitialize) => {
    manager = new QqModuleManager({ getConfiguration: () => input, createTransport,
      mediaBroker: new QqMediaBroker(join(root, "cache")), requestTimeoutMs: 100, drainTimeoutMs: 200 });
    managers.push(manager); manager.onMessage = async (message) => { received.push(message); return null; };
    return manager;
  });
  const options = { store, legacy, verifyCandidate, createModule, readLegacySettings: () => readFileSync(settings), interfaces: {},
    secureStorage: { isSecureAvailable: () => true, decryptString: () => { throw new Error("fixture has no secret"); } },
    legacyMachine: { userDataPath: root, appName: "Cyrene" }, backendReconnectTimeoutMs: 100 };
  const coordinator = new QqMigrationCoordinator(options);
  const preview = () => coordinator.previewMigration(candidate.packageId);
  const confirm = (p = preview()) => coordinator.confirmMigration({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true });
  const unchanged = () => { for (const [path, bytes] of originals) expect(readFileSync(path)).toEqual(bytes); };
  return { root, context, packages, candidate, store, peer, received, legacy, options, createTransport, verifyCandidate,
    coordinator, confirm, preview, outgoing, unchanged, get manager() { return manager!; } };
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.stop()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("QQ installation, migration and media integration", () => {
  it("holds text/media before durable activation, then preserves host-owned history attachments", async () => {
    const attempts: Promise<QqSendResultV1>[] = [];
    const s = setup((record) => {
      if (record.phase === "module-staged" || record.phase === "committed") {
        s.peer.event("inbound", { ...inbound(`quarantine-${record.phase}`), attachments: [attachment] });
        attempts.push(s.manager.send(s.outgoing));
        expect(s.received).toEqual([]);
      }
    });
    expect((await s.confirm()).outcome).toBe("committed");
    for (const result of await Promise.all(attempts)) expect(result.parts.every((part) => part.outcome === "failed")).toBe(true);
    expect(s.peer.messages.some((request) => ["send", "mediaRead", "mediaBeginUpload"].includes(request.method))).toBe(false);
    expect(s.peer.messages.filter((request) => request.method === "ackInbound").map((request) => request.payload.outcome)).toEqual(["stale-instance", "stale-instance"]);
    s.peer.event("inbound", { ...inbound("after-activation"), attachments: [attachment] });
    await vi.waitFor(() => expect(s.received).toHaveLength(1));
    const cached = s.received[0].attachments![0].filePath!;
    expect(readFileSync(cached).toString()).toBe("hello");
    expect((await s.manager.send(s.outgoing)).outcome).toBe("sent");
    const wire = JSON.stringify(s.peer.messages);
    expect(wire).not.toContain(s.root); expect(wire).not.toContain("filePath");
    await s.manager.stop(); expect(readFileSync(cached).toString()).toBe("hello"); s.unchanged();
    expect(new QqMigrationStore(s.store.root).read()?.phase).toBe("committed");
    expect(new QqPackageStore(join(s.root, "packages"), () => s.context).getSelected()?.packageId).toBe(s.candidate.packageId);
    expect(getQqModuleInstallationStatus({ listenMode: "loopback" })).toMatchObject({ canInstall: false, moduleInstalled: false, currentDriver: "legacy-builtin" });
  });
  it("waits for old-driver drain proof before starting any media-capable process", async () => {
    const s = setup(); let release!: () => void;
    s.legacy.prepareMigrationStop.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ safeToSwitch: true, drained: true, stopped: true });
    }));
    const pending = s.confirm(); await tick();
    expect(s.store.read()?.phase).toBe("prepared"); expect(s.createTransport).not.toHaveBeenCalled();
    release(); expect((await pending).outcome).toBe("committed"); expect(s.createTransport).toHaveBeenCalledOnce(); s.unchanged();
  });
  it.each(["module-staged", "committed"] as const)("rolls back %s persistence failure without media leakage or restart replay", async (phase) => {
    const attempts: Promise<QqSendResultV1>[] = [];
    const s = setup((record) => {
      if (record.phase !== phase) return;
      s.peer.event("inbound", { ...inbound("failed-commit"), attachments: [attachment] });
      attempts.push(s.manager.send(s.outgoing)); throw new Error("injected storage failure");
    });
    expect((await s.confirm()).outcome).toBe("rolled-back");
    expect((await Promise.all(attempts)).every((result) => result.outcome === "failed")).toBe(true);
    expect(s.received).toEqual([]); expect(s.peer.killed).toBe(true);
    expect(s.peer.messages.some((request) => ["send", "mediaRead", "mediaBeginUpload"].includes(request.method))).toBe(false);
    expect(existsSync(join(s.root, "cache"))).toBe(false);
    expect(new QqMigrationStore(s.store.root).read()?.phase).toBe("rolled-back");
    new QqMigrationCoordinator(s.options); expect(s.createTransport).toHaveBeenCalledOnce(); s.unchanged();
  });
  it.each(["revoked", "tampered"] as const)("rechecks the installed %s candidate after old drain and before credential/process handoff", async (reason) => {
    const s = setup(); const preview = s.preview();
    s.legacy.prepareMigrationStop.mockImplementation(async () => {
      if (reason === "revoked") s.context.trustedKeys.clear();
      else writeFileSync(join(s.root, "packages", s.candidate.packageId, "payload", "entry.cjs"), "tampered");
      return { safeToSwitch: true, drained: true, stopped: true };
    });
    expect((await s.confirm(preview)).outcome).toBe("rolled-back");
    expect(s.verifyCandidate).toHaveBeenCalledTimes(3); expect(s.createTransport).not.toHaveBeenCalled(); s.unchanged();
  });
  it("rejects detached text and media after a migrated dispatcher lease expires", async () => {
    const s = setup(); await s.confirm(); let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let late: Promise<QqSendResultV1> | undefined;
    s.manager.onMessage = async () => { late = (async () => { await held; return s.manager.send(s.outgoing); })(); return null; };
    s.peer.event("inbound", inbound("detached-reply")); await tick(); release();
    expect((await late!).outcome).toBe("failed");
    expect(s.peer.messages.some((request) => ["send", "mediaBeginUpload"].includes(request.method))).toBe(false);
  });
  it("drains active text reply but cancels media when rolling back a migrated driver", async () => {
    const s = setup(); await s.confirm(); let release!: () => void, started = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const outcomes: QqSendResultV1[] = [];
    s.manager.onMessage = async () => {
      started = true; await held;
      outcomes.push(await s.manager.send(s.outgoing));
      outcomes.push(await s.manager.send({ ...s.outgoing, parts: [s.outgoing.parts[0]] }));
      return null;
    };
    s.peer.event("inbound", inbound("active-reply")); await vi.waitFor(() => expect(started).toBe(true));
    const rollback = s.coordinator.rollbackStoppedMigration(async () => true);
    await tick(); expect(s.manager.getState().phase).toBe("draining"); expect(s.peer.killed).toBe(false);
    release(); expect((await rollback).outcome).toBe("rolled-back");
    expect(outcomes.map((result) => result.outcome)).toEqual(["failed", "sent"]);
    expect(s.peer.messages.filter((request) => request.method === "send")).toHaveLength(1);
    expect(s.peer.messages.some((request) => request.method === "mediaBeginUpload")).toBe(false); s.unchanged();
  });
  it("revokes in-flight inbound media on rollback, removes partial cache and does not dispatch late bytes", async () => {
    const s = setup(); await s.confirm(); let read: QqRequest | undefined; const original = s.peer.behavior;
    s.peer.behavior = (request) => request.method === "mediaRead" ? read = request : original(request);
    s.peer.event("inbound", { ...inbound("held-download"), attachments: [attachment] });
    await vi.waitFor(() => expect(read).toBeDefined());
    expect((await s.coordinator.rollbackStoppedMigration(async () => true)).outcome).toBe("rolled-back");
    s.peer.reply(read!, { data: "aGVsbG8=", eof: true }); await tick();
    expect(s.received).toEqual([]); expect(readdirSync(join(s.root, "cache"))).toEqual([]); s.unchanged();
  });
  it("blocks pre-confirmation publisher revocation without stopping the original driver", async () => {
    const s = setup(); const preview = s.preview(); s.context.trustedKeys.clear();
    await expect(s.confirm(preview)).rejects.toThrow("untrusted-publisher");
    expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(s.createTransport).not.toHaveBeenCalled();
    expect(s.store.read()).toBeNull(); s.unchanged();
  });
});
