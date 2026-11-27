// Isolated integration ONLY: real legacy listener + real QFCA utilityProcess.
// Never load the main application or a user's profile. No production release trust.
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { join, resolve, isAbsolute } = require("node:path");
const { tmpdir } = require("node:os");
const { createServer } = require("node:net");
const { createHash, generateKeyPairSync, sign, randomBytes, createCipheriv, createDecipheriv } = require("node:crypto");
const { app } = require("electron");
const hostRoot = resolve(__dirname, "../../..");
const unsignedPath = process.env.QFCA_UNSIGNED_CANDIDATE;
const scenario = process.env.QQ_UPGRADE_SCENARIO || "success";
if (!unsignedPath || !isAbsolute(unsignedPath)) throw Error("QFCA_UNSIGNED_CANDIDATE must identify an absolute reviewed offline candidate");
if (!["success", "wrong-account", "lost-proof", "shutdown-drain", "shutdown-stage"].includes(scenario)) throw Error("Unsupported isolated scenario");
const root = fs.mkdtempSync(join(tmpdir(), "qq-upgrade-electron-"));
app.disableHardwareAcceleration();
app.setName("Cyrene");
app.setPath("userData", root);
const { WebSocket } = require(join(hostRoot, "node_modules/ws"));
const fromMain = path => require(join(hostRoot, "dist/main/main", path));
const { NapCatAdapter } = fromMain("channels/adapters/qq/napcat-adapter.js");
const { QqRoutingAdapter } = fromMain("channels/adapters/qq-routing-adapter.js");
const { createQqProductionHost } = fromMain("qq-modules/production-host.js");
const { createQqUtilityProcess } = fromMain("qq-modules/utility-process.js");
const { QqModuleActionGateway } = fromMain("qq-modules/action-gateway.js");
const { QQ_PACKAGE_SIGNATURE_DOMAIN } = fromMain("qq-modules/package-verifier.js");
const { getQqStartupMode } = fromMain("qq-modules/startup-recovery.js");
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const wait = async (predicate, label, ms = 12000) => {
  const end = Date.now() + ms;
  while (!predicate()) { if (Date.now() > end) throw Error(`Timeout: ${label}`); await new Promise(r => setTimeout(r, 10)); }
};
const pause = ms => new Promise(r => setTimeout(r, ms));
const token = "synthetic-upgrade-fixture-not-a-real-secret";
const sockets = [], services = [], transports = [], timeline = [], received = [];
let legacy, releaseTurn = () => {}, manager, route, service, gateway, scopeHeld = true;
const owner = { key: {}, isAuthorized: () => true };
const actions = [];
const watchdog = setTimeout(() => { console.error("UPGRADE_HARNESS_TIMEOUT"); app.exit(2); }, 60000);
async function cleanup() {
  releaseTurn();
  for (const socket of sockets) socket.terminate();
  const errors = [];
  for (const host of services.reverse()) { try { await host.shutdown(); } catch (error) { if (!["lost-proof", "shutdown-drain"].includes(scenario) || !String(error).includes("QQ_PRODUCTION_ADOPTION_LOST")) errors.push("host shutdown failed"); } }
  for (const transport of transports) { try { await transport.terminate(); } catch { errors.push("child exit unconfirmed"); } }
  try { await legacy?.stop(); } catch { errors.push("legacy stop failed"); }
  if (errors.length) { console.error("CLEANUP_INCOMPLETE", errors.join("; ")); clearTimeout(watchdog); return false; }
  fs.rmSync(root, { recursive: true, force: true });
  clearTimeout(watchdog);
  return true;
}
async function vacantPort() {
  const listener = createServer(); await new Promise(r => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port; await new Promise(r => listener.close(r)); return port;
}
function attachObservation(router) {
  const attach = router.attachModule.bind(router);
  router.attachModule = value => { manager = value; attach(value); };
  router.onMessage = async message => { received.push(message); return null; };
}
async function connect(port, label, options = {}) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: `Bearer ${token}`, "X-Self-ID": "10000" } });
  sockets.push(socket);
  let releaseLogin, loginRequested = false;
  socket.on("message", raw => {
    const request = JSON.parse(raw.toString()); actions.push({ label, action: request.action, params: request.params });
    const respond = data => { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: request.echo, data })); };
    if (request.action === "get_login_info") {
      loginRequested = true;
      releaseLogin = () => respond({ user_id: options.account || "10000" });
      if (!options.holdLogin) releaseLogin();
      return;
    }
    if (request.action === "get_version_info") return respond({ app_name: "NapCat.Onebot", app_version: "4.8.115" });
    if (["can_send_image", "can_send_record"].includes(request.action)) return respond({ yes: true });
    if (request.action === "test_download_stream") {
      for (let i = 1; i <= 10; i++) respond({ type: "stream", data_type: "data_chunk", data: `Index-> ${i}` });
      return respond({ type: "response", data_type: "data_complete", data: "Stream transmission complete" });
    }
    return respond({ message_id: actions.length });
  });
  await new Promise((r, reject) => { socket.once("open", r); socket.once("error", reject); });
  return { socket, get loginRequested() { return loginRequested; }, releaseLogin: () => releaseLogin?.(),
    incoming: (id, text) => socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "private", message_id: id, user_id: 30000,
      time: 1700000000, sender: { nickname: "Synthetic fixture" }, message: [{ type: "text", data: { text } }] })) };
}
function preview(result, state) { assert.equal(result.state, state, JSON.stringify(result)); return result.preview; }
const outgoing = text => ({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text }] });
(async () => {
  await app.whenReady();
  console.log(`ENV actualOS=${process.platform}/${process.arch}; adoptionContext=SIMULATED-win32; secureStorage=synthetic-AES; scenario=${scenario}`);
  const port = await vacantPort();
  const settingsPath = join(root, "channels-settings.json");
  // Deliberately synthetic plain legacy fixture: exercise the REAL settings loader,
  // not a mock. New credential storage below uses AES, not a claimed OS keychain.
  const settings = Buffer.from(JSON.stringify({ qq: { enabled: true, listenMode: "loopback", port,
    allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true,
    groupReplyStyle: "reply-and-mention", groupToolPolicy: "off", groupMemoryPolicy: "shared-personal", accessToken: `plain:${token}` } }));
  fs.writeFileSync(settingsPath, settings, { mode: 0o600 });
  const preserved = [[settingsPath, settings], [join(root, "channels-history.json"), Buffer.from('{"fixture":"unchanged"}')],
    [join(root, "channel-conversation-bindings.json"), Buffer.from('{"fixture":"unchanged"}')]];
  for (const [path, bytes] of preserved) fs.writeFileSync(path, bytes, { mode: 0o600 });
  legacy = new NapCatAdapter(); route = new QqRoutingAdapter(legacy);
  await route.start();
  const listener = legacy.server?.httpServer; assert.ok(listener, "must observe actual legacy HTTP listener");
  listener.once("close", () => timeline.push("legacy-listener-close"));
  const oldPeer = await connect(port, "legacy");
  await wait(() => route.getMigrationIdentity()?.accountId === "10000", "legacy account validation");
  const initialIdentity = route.getMigrationIdentity(); assert.ok(initialIdentity);
  let turnEntered = false;
  const turnGate = new Promise(r => { releaseTurn = r; });
  route.onMessage = async message => {
    received.push(message);
    if (message.text === "legacy-held") { turnEntered = true; await turnGate; assert.equal((await route.send(outgoing("legacy-drained-reply"))).ok, true); timeline.push("legacy-turn-finished"); }
    return null;
  };
  oldPeer.incoming("old-1", "legacy-held"); await wait(() => turnEntered, "accepted legacy turn");
  const unsigned = JSON.parse(fs.readFileSync(unsignedPath, "utf8")), manifest = Buffer.from(unsigned.manifest, "base64"), parsed = JSON.parse(manifest);
  assert.ok(parsed.targets.some(t => t.platform === process.platform && t.arch === process.arch), "candidate must match actual OS");
  const keys = generateKeyPairSync("ed25519");
  const candidate = { manifest, signature: sign(null, Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN), manifest]), keys.privateKey), files: new Map(unsigned.files.map(f => [f.path, Buffer.from(f.data, "base64")])) };
  const verification = { trustedKeys: new Map([[parsed.keyId, keys.publicKey.export({ type: "spki", format: "pem" }).toString()]]), hostVersion: "1.3.7", platform: process.platform, arch: process.arch, now: 1500 };
  const key = randomBytes(32);
  const secure = { isSecureAvailable: () => true, encryptString: value => { const iv = randomBytes(12), c = createCipheriv("aes-256-gcm", key, iv); const bytes = Buffer.concat([c.update(value, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), bytes]); },
    decryptString: bytes => { const c = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12)); c.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([c.update(bytes.subarray(28)), c.final()]).toString(); } };
  const adoptionContext = { platform: "win32", scopeId: "isolated-process-owned-fixture", sessionEpoch: randomBytes(16).toString("hex"), mode: "validated-upgrade",
    previousHostSha256: digest(fs.readFileSync(join(hostRoot, "dist/main/main/channels/adapters/qq/napcat-adapter.js"))),
    hostSha256: digest(fs.readFileSync(join(hostRoot, "dist/main/main/qq-modules/production-host.js"))), moduleSha256: digest(manifest) };
  const options = { userDataPath: root, router: route, secureStorage: secure,
    releasePolicy: { candidate: () => candidate, verificationContext: () => verification }, ownership: { scopeId: adoptionContext.scopeId },
    legacyUpgrade: { readLegacySettings: () => fs.readFileSync(settingsPath), adoption: {
      readContext: () => ({ ...adoptionContext }), reviewedPolicy: { approve: value => JSON.stringify(value) === JSON.stringify(adoptionContext) },
      // Only this fresh fixture's processes are owned by this script. This is NOT
      // the missing production installer/history-proof implementation.
      exclusiveScope: { freezeAndProve: async () => ({ isHeld: () => scopeHeld, release: () => { scopeHeld = false; } }) },
    } }, backendReconnectTimeoutMs: 4000,
    createTransport: (directory, entry) => {
      assert.ok(timeline.includes("legacy-listener-close"), "real listener close must precede fork");
      assert.ok(timeline.includes("legacy-turn-finished"), "accepted turn drain must precede fork");
      const transport = createQqUtilityProcess(directory, entry); const n = transports.push(transport);
      timeline.push(`child-${n}-created`); transport.onExit(() => timeline.push(`child-${n}-exit`)); return transport;
    } };
  const attach = route.attachModule.bind(route); route.attachModule = value => { manager = value; attach(value); };
  service = createQqProductionHost(options); services.push(service); gateway = new QqModuleActionGateway(service);
  const install = preview(await gateway.execute({ action: "preview-install" }, owner), "preview-install");
  assert.equal((await gateway.execute({ action: "confirm-install", operationId: install.operationId, userConfirmed: true }, owner)).state, "installed");
  const migration = preview(await gateway.execute({ action: "preview-migration" }, owner), "preview-migration");
  assert.equal(transports.length, 0); assert.equal(fs.existsSync(join(root, "qq-module-adoption")), false);
  const confirmation = gateway.execute({ action: "confirm-migration", operationId: migration.operationId, accountId: "10000", userConfirmed: true }, owner);
  await wait(() => legacy.quiescing === true, "real legacy quiesce");
  assert.equal((await gateway.execute({ action: "cancel", operationId: migration.operationId }, owner)).error, "busy");
  let rejectedFrameObserved = false;
  const oldServerSocket = legacy.server?.socket; assert.ok(oldServerSocket);
  const observeRejected = raw => { if (JSON.parse(raw.toString()).message_id === "old-2") rejectedFrameObserved = true; };
  oldServerSocket.on("message", observeRejected);
  oldPeer.incoming("old-2", "must-not-enter-during-drain");
  await wait(() => rejectedFrameObserved, "actual old server received rejected frame");
  await new Promise(r => setImmediate(r)); oldServerSocket.off("message", observeRejected);
  assert.equal(received.length, 1); assert.equal(transports.length, 0);
  assert.equal(getQqStartupMode(root), "blocked");
  if (scenario === "shutdown-drain") {
    let shutdownSettled = false;
    const closing = service.shutdown().then(() => ({ ok: true }), error => ({ ok: false, error })).finally(() => { shutdownSettled = true; });
    assert.ok(["busy", "recovery-required"].includes((await gateway.execute({ action: "status" }, owner)).error));
    await pause(75); assert.equal(shutdownSettled, false); assert.equal(transports.length, 0);
    releaseTurn(); const result = await confirmation; assert.notEqual(result.state, "committed");
    const shutdownResult = await closing;
    if (!shutdownResult.ok) assert.match(String(shutdownResult.error), /ADOPTION_LOST/);
    await pause(100); assert.equal(listener.listening, false); assert.equal(transports.length, 0);
    await assert.rejects(route.start());
    assert.equal((await route.send(outgoing("must-not-send-after-shutdown"))).ok, false);
    console.log("PASS shutdown during actual legacy drain waits for admitted work, no late child spawn, listener closes; abandoned adoption proof stays untrusted");
    return;
  }
  releaseTurn();
  await wait(() => manager?.getState().phase === "waiting-backend", "new actual utility process listener");
  assert.equal(listener.listening, false); assert.ok(timeline.indexOf("legacy-listener-close") < timeline.indexOf("child-1-created"));
  const modulePeer = await connect(port, "module-1", { account: scenario === "wrong-account" ? "20000" : "10000", holdLogin: scenario === "lost-proof" || scenario === "shutdown-stage" });
  if (scenario === "lost-proof") { await wait(() => modulePeer.loginRequested, "held module identity request"); scopeHeld = false; modulePeer.releaseLogin(); }
  if (scenario === "shutdown-stage") {
    await wait(() => modulePeer.loginRequested, "held stage identity request");
    let shutdownSettled = false;
    const closing = service.shutdown().finally(() => { shutdownSettled = true; });
    assert.ok(["busy", "recovery-required"].includes((await gateway.execute({ action: "status" }, owner)).error));
    await pause(75); assert.equal(shutdownSettled, false);
    modulePeer.releaseLogin(); await confirmation; await closing;
    await wait(() => timeline.includes("child-1-exit"), "shutdown child exit");
    await pause(100); assert.equal(transports.length, 1); assert.equal(listener.listening, false);
    assert.equal(manager.getActiveMigrationIdentity(), null); await assert.rejects(route.start());
    assert.equal((await route.send(outgoing("must-not-send-after-shutdown"))).ok, false);
    console.log("PASS shutdown during actual child identity staging drains admitted operation then observes child exit; no post-shutdown spawn");
    return;
  }
  const outcome = await confirmation;
  if (scenario !== "success") {
    assert.notEqual(outcome.state, "committed"); assert.ok(["rolled-back", "recovery-required"].includes(outcome.state), JSON.stringify(outcome));
    await wait(() => timeline.includes("child-1-exit"), "failed candidate real exit");
    assert.equal(route.isLegacyBlocked(), true); assert.equal(manager.getState().phase, "stopped");
    assert.equal(manager.getActiveMigrationIdentity(), null); await assert.rejects(route.start());
    assert.equal((await route.send(outgoing("must-not-send-after-failure"))).ok, false);
    await pause(100); assert.equal(transports.length, 1); assert.equal(listener.listening, false);
    assert.equal(actions.filter(a => a.label !== "legacy" && a.action.startsWith("send_")).length, 0);
    if (scenario === "lost-proof") { await assert.rejects(service.shutdown(), /ADOPTION_LOST/); assert.ok(fs.existsSync(join(root, "qq-module-driver-ownership/owner.lock"))); }
    for (const [path, bytes] of preserved) assert.deepEqual(fs.readFileSync(path), bytes);
    console.log(`PASS ${scenario}: real candidate exited, no activation/send, old route remains blocked, legacy data unchanged`);
    return;
  }
  assert.equal(outcome.state, "committed", JSON.stringify(outcome));
  modulePeer.incoming("new-1", "new-module-inbound"); await wait(() => received.some(m => m.text === "new-module-inbound"), "module routed inbound");
  assert.equal((await route.send(outgoing("new-module-outbound"))).ok, true);
  assert.equal(actions.filter(a => a.label === "legacy" && JSON.stringify(a.params).includes("legacy-drained-reply")).length, 1);
  assert.equal(actions.filter(a => a.label === "module-1" && JSON.stringify(a.params).includes("new-module-outbound")).length, 1);
  for (const [path, bytes] of preserved) assert.deepEqual(fs.readFileSync(path), bytes);
  console.log("PASS real legacy drain/listener close BEFORE actual signed QFCA fork; same-port identity-verified reconnect; route inbound/outbound; original files unchanged");
  await transports[0].terminate(); await wait(() => timeline.includes("child-1-exit"), "actual first child exit");
  await pause(100); assert.equal(transports.length, 1, "child crash must not trigger automatic restart");
  const previous = manager;
  const recovery = preview(await gateway.execute({ action: "preview-recovery" }, owner), "preview-recovery");
  const recovering = gateway.execute({ action: "confirm-recovery", operationId: recovery.operationId, accountId: "10000", userConfirmed: true }, owner);
  await wait(() => manager !== previous && manager.getState().phase === "waiting-backend", "explicit recovery new child");
  await connect(port, "module-2"); assert.equal((await recovering).state, "committed");
  assert.equal((await route.send(outgoing("after-explicit-recovery"))).ok, true);
  await service.shutdown(); assert.ok(timeline.includes("child-2-exit"));
  assert.equal(JSON.parse(fs.readFileSync(join(root, "qq-module-driver-ownership/ownership.json"), "utf8")).phase, "clean-retired");
  route = new QqRoutingAdapter(legacy, "blocked"); attachObservation(route);
  service = createQqProductionHost({ ...options, router: route }); services.push(service); gateway = new QqModuleActionGateway(service);
  assert.equal(transports.length, 2, "reopening host must not auto-start");
  const next = preview(await gateway.execute({ action: "preview-recovery" }, owner), "preview-recovery");
  const reopening = gateway.execute({ action: "confirm-recovery", operationId: next.operationId, accountId: "10000", userConfirmed: true }, owner);
  await wait(() => transports.length === 3 && manager.getState().phase === "waiting-backend", "new host explicit child");
  const last = await connect(port, "module-3"); assert.equal((await reopening).state, "committed");
  last.incoming("new-3", "after-clean-host-recovery"); await wait(() => received.some(m => m.text === "after-clean-host-recovery"), "new host route");
  await service.shutdown(); assert.ok(timeline.includes("child-3-exit"));
  for (const [path, bytes] of preserved) assert.deepEqual(fs.readFileSync(path), bytes);
  console.log("PASS actual child termination, explicit same-host recovery, clean-retired cross-host inheritance without automatic start, actual final child exit");
  console.log("TIMELINE", JSON.stringify(timeline));
})().then(async () => { if (!await cleanup()) { app.exit(1); return; } console.log(`ALL_REAL_UPGRADE_ELECTRON_PASS scenario=${scenario}`); app.exit(0); })
  .catch(async error => { console.error(error); await cleanup(); app.exit(1); });
