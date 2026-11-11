import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildQqMigrationPlan, readQqMigrationToken } from "./migration-plan";
import { QqMigrationStore } from "./migration-store";
import { QqMigrationCoordinator, type QqMigrationOptions } from "./migration";
import { QqModuleManager } from "./manager";
import { FakeTransport, inbound } from "../../../scripts/verify/qq-module/fixtures";

const packageId = `pkg-${"a".repeat(64)}`;
const identity = { selfId: "10000", connectionEpoch: 7 };
const legacyMachine = { userDataPath: "/legacy/original", appName: "Cyrene" };
const settings = (qq: object = {}) => Buffer.from(JSON.stringify({ qq: { enabled: true, listenMode: "loopback", port: 6200,
  allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true, groupReplyStyle: "reply-and-mention",
  groupToolPolicy: "off", groupMemoryPolicy: "shared-personal", ...qq }, qqbot: { enabled: true, appId: "official-unchanged" }, mirrorToDesktop: true }));
const secureStorage = () => ({ isSecureAvailable: vi.fn(() => true), decryptString: vi.fn(() => "test-only-secret") });
const directories: string[] = [];
const peers: FakeTransport[] = [];
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(extra: Partial<QqMigrationOptions> = {}, fault?: ConstructorParameters<typeof QqMigrationStore>[1]) {
  const root = mkdtempSync(join(tmpdir(), "qq-migration-")); directories.push(root);
  const path = join(root, "channels-settings.json"); writeFileSync(path, settings());
  const history = join(root, "channels-history.json"); writeFileSync(history, '{"qq:private:30000":["existing-message"]}');
  const binding = join(root, "channel-conversation-bindings.json"); writeFileSync(binding, '{"qq:private:30000":"desktop-original"}');
  const before = [path, history, binding].map((file) => readFileSync(file));
  const peer = new FakeTransport(); peers.push(peer);
  const store = new QqMigrationStore(join(root, "migration"), fault);
  const legacy = { getMigrationIdentity: vi.fn(() => ({ accountId: "10000", connectionEpoch: 7 })),
    prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const handler = vi.fn(async () => null);
  let manager: QqModuleManager | undefined;
  const options: QqMigrationOptions = { store, readLegacySettings: () => readFileSync(path), legacy, secureStorage: secureStorage(), legacyMachine,
    verifyCandidate: vi.fn(), createModule: vi.fn((input) => {
      manager = new QqModuleManager({ getConfiguration: () => input, createTransport: () => peer, requestTimeoutMs: 30, drainTimeoutMs: 30 });
      manager.onMessage = handler;
      return manager;
    }), interfaces: {}, backendReconnectTimeoutMs: 100, ...extra };
  const coordinator = new QqMigrationCoordinator(options);
  const preview = () => coordinator.previewMigration(packageId);
  const confirm = (p = preview()) => coordinator.confirmMigration({ previewId: p.previewId, accountId: p.accountId, userConfirmed: true });
  return { root, path, history, binding, before, store, legacy, peer, options, coordinator, preview, confirm, handler, getManager: () => manager };
}
afterEach(() => { for (const peer of peers.splice(0)) peer.crash(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("QQ legacy configuration migration plan", () => {
  it("preserves existing qq identity, whitelist, policy and explicit port", () => {
    const plan = buildQqMigrationPlan(settings(), identity, {});
    expect(plan).toMatchObject({ channelId: "qq", schemaVersion: 1, identity, credentialKind: "none",
      config: { expectedSelfId: "10000", configRevision: 1, listen: { host: "127.0.0.1", port: 6200 }, allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true } });
  });
  it.each(["127.0.0.2", "127.255.1.3", "::1", "::ffff:127.0.0.2"])("preserves numeric loopback %s", (host) => {
    expect(buildQqMigrationPlan(settings({ listenMode: "custom", customHost: host }), identity, {}).config.listen.host).toBe(host);
  });
  it.each(["localhost", "[::1]", "0.0.0.0", "::", "192.168.1.2", "::1%lo", "127.0.0.1.invalid"])("blocks unsupported legacy %s without silently rewriting", (host) => {
    expect(() => buildQqMigrationPlan(settings({ listenMode: "custom", customHost: host, accessToken: "plain:token" }), identity, {})).toThrow("unsupported-listen-address");
  });
  it("resolves auto only against host interfaces and blocks WSL rather than converting it", () => {
    expect(buildQqMigrationPlan(settings({ listenMode: "auto" }), identity, {}).config.listen.host).toBe("127.0.0.1");
    const interfaces = { "vEthernet (WSL)": [{ address: "172.20.0.1", netmask: "255.255.255.0", family: "IPv4" as const, mac: "00:00:00:00:00:00", internal: false, cidr: "172.20.0.1/24" }] };
    expect(() => buildQqMigrationPlan(settings({ listenMode: "auto" }), identity, interfaces)).toThrow("unsupported-listen-address");
    expect(() => buildQqMigrationPlan(settings({ listenMode: "wsl" }), identity, {})).toThrow("unsupported-listen-address");
  });
  it.each([{ port: 0 }, { allowedPrivateUserIds: [123] }, { allowedGroupIds: ["2", "2"] }, { groupRequireMention: false }, { groupToolPolicy: "all" }, { customOption: "unknown" }])("rejects lossy normalization of %j", (qq) => {
    expect(() => buildQqMigrationPlan(settings(qq), identity, {})).toThrow("unsupported-legacy-settings");
  });
  it("rejects disabled/missing config, invalid JSON and invalid accounts", () => {
    expect(() => buildQqMigrationPlan(settings({ enabled: false }), identity, {})).toThrow("legacy-not-enabled");
    expect(() => buildQqMigrationPlan(Buffer.from("{}"), identity, {})).toThrow("unsupported-legacy-settings");
    expect(() => buildQqMigrationPlan(Buffer.from("bad"), identity, {})).toThrow("invalid-settings");
    expect(() => buildQqMigrationPlan(settings(), { selfId: "", connectionEpoch: 0 }, {})).toThrow("confirmed-live-account-required");
  });
});

describe("QQ legacy credential boundary", () => {
  it.each(["old-secret", "plain:old-secret"])("reads plaintext fixture in memory, with secure storage available", (accessToken) => {
    expect(readQqMigrationToken(settings({ accessToken }), secureStorage(), legacyMachine)).toBe("old-secret");
  });
  it("decrypts enc once using host storage, never passes the ciphertext as a token", () => {
    const storage = secureStorage();
    expect(readQqMigrationToken(settings({ accessToken: "enc:YWJj" }), storage, legacyMachine)).toBe("test-only-secret");
    expect(storage.decryptString).toHaveBeenCalledWith(Buffer.from("abc"));
  });
  it("reads old obf data using original app/path rather than migration directory", () => {
    const key = createHash("sha256").update(`${legacyMachine.userDataPath}::${legacyMachine.appName}::cyrene-bot-secret`).digest();
    const bytes = Buffer.from("test-only-secret");
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % 16];
    expect(readQqMigrationToken(settings({ accessToken: `obf:${bytes.toString("base64")}` }), secureStorage(), legacyMachine)).toBe("test-only-secret");
  });
  it.each(["enc:YWJj", "obf:YWJj", "plain:test", "test"])("blocks %s if no secure keychain is available", (accessToken) => {
    expect(() => readQqMigrationToken(settings({ accessToken }), { ...secureStorage(), isSecureAvailable: () => false }, legacyMachine)).toThrow("secure-storage-unavailable");
  });
  it("does not turn decryption failure, malformed base64 or an empty decrypted token into unauthenticated access", () => {
    const storage = secureStorage(); storage.decryptString.mockImplementation(() => { throw new Error("SECRET SHOULD NOT LEAK"); });
    expect(() => readQqMigrationToken(settings({ accessToken: "enc:YWJj" }), storage, legacyMachine)).toThrow("QQ_MIGRATION_credential-unreadable");
    expect(() => readQqMigrationToken(settings({ accessToken: "enc:!!" }), secureStorage(), legacyMachine)).toThrow("credential-unreadable");
    storage.decryptString.mockReturnValue("");
    expect(() => readQqMigrationToken(settings({ accessToken: "enc:YWJj" }), storage, legacyMachine)).toThrow("credential-unreadable");
    expect(readQqMigrationToken(settings(), { ...secureStorage(), isSecureAvailable: () => false }, legacyMachine)).toBe("");
  });
});

describe("QQ migration coordinator and recovery", () => {
  it("preview is read-only and redacts credentials; cancellation makes no changes", () => {
    const s = setup(); writeFileSync(s.path, settings({ accessToken: "plain:test-only-secret" }));
    const before = readFileSync(s.path); const preview = s.preview();
    expect(JSON.stringify(preview)).not.toContain("test-only-secret");
    expect(preview).toMatchObject({ channelId: "qq", accountId: "10000", credentialAction: "host-decrypt-in-memory", legacyCredentialProtection: "plaintext" });
    preview.config.allowedGroupIds.length = 0;
    expect(s.store.read()).toBeNull(); expect(readdirSync(s.root)).toHaveLength(3);
    expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled(); expect(s.options.createModule).not.toHaveBeenCalled(); expect(readFileSync(s.path)).toEqual(before);
  });
  it("requires exact current preview and matching explicit account confirmation", async () => {
    const s = setup(); const old = s.preview(); const next = s.preview();
    await expect(s.confirm(old)).rejects.toThrow("stale-or-mismatched-confirmation");
    await expect(s.coordinator.confirmMigration({ previewId: next.previewId, accountId: "other", userConfirmed: true })).rejects.toThrow("stale-or-mismatched-confirmation");
    await expect(s.coordinator.confirmMigration({ ...next, userConfirmed: true } as never)).rejects.toThrow("explicit-account-confirmation-required");
    expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  });
  it("switches once, keeps all legacy files byte-for-byte and persists no credentials", async () => {
    const s = setup(); writeFileSync(s.path, settings({ accessToken: "enc:YWJj" })); const original = readFileSync(s.path);
    const preview = s.preview();
    expect(await s.confirm(preview)).toEqual({ outcome: "committed", legacyData: "unchanged", legacyRuntime: "not-restarted" });
    expect(await s.confirm(preview)).toMatchObject({ outcome: "committed" });
    expect(s.legacy.prepareMigrationStop).toHaveBeenCalledOnce(); expect(s.options.createModule).toHaveBeenCalledOnce();
    expect(s.peer.messages.find((m) => m.method === "initialize")?.payload).toMatchObject({ credentials: { accessToken: "test-only-secret" } });
    expect(readFileSync(s.path)).toEqual(original); expect(readFileSync(s.history)).toEqual(s.before[1]); expect(readFileSync(s.binding)).toEqual(s.before[2]);
    const state = readFileSync(join(s.root, "migration/state.json"), "utf8");
    expect(state).not.toContain("test-only-secret"); expect(state).not.toContain("YWJj"); expect(state).not.toContain("accessToken");
    expect(new QqMigrationStore(s.store.root).read()).toMatchObject({ phase: "committed", plan: { config: { expectedSelfId: "10000" } } });
  });
  it("holds module inbound and outbound until the durable commit point", async () => {
    let s: ReturnType<typeof setup>;
    s = setup({}, (record) => {
      if (record.phase === "module-staged") s.peer.event("inbound", inbound("before-commit"));
    });
    expect(await s.confirm()).toMatchObject({ outcome: "committed" }); await tick();
    expect(s.handler).not.toHaveBeenCalled();
    expect(s.peer.messages.filter((m) => m.method === "ackInbound").at(-1)?.payload).toMatchObject({ outcome: "stale-instance" });
    s.peer.event("inbound", inbound("after-commit")); await tick(); expect(s.handler).toHaveBeenCalledOnce();
  });
  it.each(["settings", "account", "connection", "secure-storage"])("rejects changed %s before old stop", async (change) => {
    const s = setup(); writeFileSync(s.path, settings({ accessToken: "plain:secret" })); const preview = s.preview();
    if (change === "settings") writeFileSync(s.path, settings({ port: 6201 }));
    if (change === "account") s.legacy.getMigrationIdentity.mockReturnValue({ accountId: "999", connectionEpoch: 7 });
    if (change === "connection") s.legacy.getMigrationIdentity.mockReturnValue({ accountId: "10000", connectionEpoch: 8 });
    if (change === "secure-storage") s.options.secureStorage.isSecureAvailable = () => false;
    await expect(s.confirm(preview)).rejects.toThrow(); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
  });
  it("does not start a module or advertise rollback success when old draining is incomplete", async () => {
    const s = setup(); s.legacy.prepareMigrationStop.mockResolvedValue({ safeToSwitch: false, drained: false, stopped: true });
    expect(await s.confirm()).toMatchObject({ outcome: "recovery-required", errorCode: "legacy-not-drained-and-stopped" });
    expect(s.options.createModule).not.toHaveBeenCalled(); expect(s.store.read()?.phase).toBe("prepared");
    expect(() => new QqMigrationCoordinator(s.options).previewMigration(packageId)).toThrow("existing-migration-requires-review");
  });
  it.each(["legacy-stopped", "module-staged", "committed"])("rolls back local selection after a %s write failure, but never restarts old code", async (phase) => {
    const s = setup({}, (record) => { if (record.phase === phase) throw new Error("injected"); });
    expect(await s.confirm()).toMatchObject({ outcome: "rolled-back", legacyRuntime: "not-restarted" });
    expect(s.store.read()?.phase).toBe("rolled-back");
    if (phase !== "legacy-stopped") expect(s.peer.killed).toBe(true);
  });
  it("fails before stopping old driver if intent cannot be persisted", async () => {
    const s = setup({}, () => { throw new Error("disk failure"); });
    await expect(s.confirm()).rejects.toThrow("disk failure"); expect(s.legacy.prepareMigrationStop).not.toHaveBeenCalled();
    expect(s.store.read()).toBeNull();
  });
  it("rolls back mismatched/absent module accounts before any inbound is dispatched", async () => {
    const s = setup(); const original = s.peer.behavior;
    s.peer.behavior = (request) => request.method === "start" ? s.peer.reply(request, { phase: "running", selfId: "999", connectionEpoch: 1 }) : original(request);
    expect(await s.confirm()).toMatchObject({ outcome: "rolled-back", errorCode: "module-account-unverified" }); expect(s.handler).not.toHaveBeenCalled();
  });
  it("waits for asynchronous backend reconnection while keeping inbound quarantined", async () => {
    const s = setup(); const original = s.peer.behavior;
    s.peer.behavior = (request) => {
      if (request.method !== "start") { original(request); return; }
      s.peer.reply(request, { phase: "waiting-backend" });
      setTimeout(() => {
        s.peer.event("status", { phase: "running", selfId: "10000", connectionEpoch: 1 });
        s.peer.event("inbound", inbound("before-confirmed"));
      }, 30);
    };
    expect(await s.confirm()).toMatchObject({ outcome: "committed" }); expect(s.handler).not.toHaveBeenCalled();
    expect(s.peer.killed).toBe(false);
  });
  it("bounds backend reconnection wait and keeps repeat failed confirmation idempotent", async () => {
    const s = setup({ backendReconnectTimeoutMs: 10 }); const original = s.peer.behavior;
    s.peer.behavior = (request) => request.method === "start" ? s.peer.reply(request, { phase: "waiting-backend" }) : original(request);
    const preview = s.preview();
    expect(await s.confirm(preview)).toMatchObject({ outcome: "rolled-back", errorCode: "module-account-unverified" });
    expect(await s.confirm(preview)).toMatchObject({ outcome: "rolled-back" });
    expect(s.options.createModule).toHaveBeenCalledOnce(); expect(s.peer.killed).toBe(true);
  });
  it("keeps recovery-required when module exit cannot be confirmed", async () => {
    const s = setup({}, (record) => { if (record.phase === "module-staged") throw new Error("injected"); });
    s.peer.terminate = async () => { throw new Error("still running"); };
    expect(await s.confirm()).toMatchObject({ outcome: "recovery-required" }); expect(s.store.read()?.phase).toBe("legacy-stopped");
    expect(() => s.preview()).toThrow("existing-migration-requires-review");
  });
  it("handles disconnect at commit without claiming success", async () => {
    let s: ReturnType<typeof setup>;
    s = setup({}, (record) => { if (record.phase === "committed") s.peer.event("status", { phase: "waiting-backend" }); });
    expect(await s.confirm()).toMatchObject({ outcome: "rolled-back", errorCode: "module-disconnected-before-activation" });
  });
  it("requires explicit current process-stop proof for restart rollback, separate from original data preservation", async () => {
    const s = setup(); await s.confirm();
    const restarted = new QqMigrationCoordinator(s.options);
    expect(await restarted.rollbackStoppedMigration(async () => false)).toMatchObject({ outcome: "recovery-required" });
    expect(s.store.read()?.phase).toBe("committed");
    await s.getManager()!.stop();
    expect(await restarted.rollbackStoppedMigration(async () => true)).toEqual({ outcome: "rolled-back", legacyData: "unchanged", legacyRuntime: "not-restarted" });
    expect(s.store.read()?.phase).toBe("rolled-back");
  });
  it("rejects concurrent confirmations and stale locks rather than stealing ownership", async () => {
    const s = setup(); const preview = s.preview(); let release!: () => void;
    s.legacy.prepareMigrationStop.mockImplementation(() => new Promise((r) => { release = () => r({ safeToSwitch: true, drained: true, stopped: true }); }));
    const first = s.confirm(preview); await tick();
    await expect(s.confirm(preview)).rejects.toThrow("busy-or-recovery-required"); release(); await first;
    writeFileSync(join(s.store.root, "migration-lock"), "stale");
    await expect(s.confirm(preview)).rejects.toThrow("busy-or-recovery-required");
  });
  it("refuses corrupt or unknown schema on restart", async () => {
    const s = setup(); await s.confirm();
    writeFileSync(join(s.store.root, "state.json"), '{"schemaVersion":2}');
    expect(() => s.store.read()).toThrow("invalid-state");
  });
});
