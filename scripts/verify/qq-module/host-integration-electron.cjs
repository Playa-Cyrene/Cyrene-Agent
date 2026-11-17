// Offline synthetic integration only. Run with Electron, never the main Cyrene app.
"use strict";
const assert = require("node:assert/strict");
const { createHash,generateKeyPairSync,sign } = require("node:crypto");
const { mkdtemp, readFile, readdir, rm, writeFile, mkdir } = require("node:fs/promises");
const { createServer } = require("node:net");
const { tmpdir } = require("node:os");
const { isAbsolute, join } = require("node:path");
const {mkdtempSync}=require("node:fs");
const root=mkdtempSync(join(tmpdir(),"qq-host-electron-"));
const hostRoot=require("node:path").resolve(__dirname,"../../..");
const unsignedPath=process.env.QFCA_UNSIGNED_CANDIDATE;
if(!unsignedPath || !isAbsolute(unsignedPath)) throw Error("QFCA_UNSIGNED_CANDIDATE must be an absolute reviewed offline rehearsal candidate");
const { app } = require("electron");
const { WebSocket } = require(hostRoot + "/node_modules/ws");
const { QqModuleManager } = require(hostRoot + "/dist/main/main/qq-modules/manager.js");
const { QqMediaBroker } = require(hostRoot + "/dist/main/main/qq-modules/media-broker.js");
const { createQqUtilityProcess } = require(hostRoot + "/dist/main/main/qq-modules/utility-process.js");
const {QqModuleHostService}=require(hostRoot+"/dist/main/main/qq-modules/host-service.js");
const {QqRoutingAdapter}=require(hostRoot+"/dist/main/main/channels/adapters/qq-routing-adapter.js");
const {QqModuleActionGateway}=require(hostRoot+"/dist/main/main/qq-modules/action-gateway.js");
const {getQqStartupMode}=require(hostRoot+"/dist/main/main/qq-modules/startup-recovery.js");
const {QQ_PACKAGE_SIGNATURE_DOMAIN}=require(hostRoot+"/dist/main/main/qq-modules/package-verifier.js");

const pngFixture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMQCegBAAFsAPH6cDjBAAAAAElFTkSuQmCC", "base64");
const configuration = () => ({ config: { configRevision: 1, listen: { host: "127.0.0.1", port: 30001 }, expectedSelfId: "10000", allowedPrivateUserIds: ["30000"], allowedGroupIds: ["20000"], groupRequireMention: true }, credentials: { accessToken: "synthetic-only-token" } });
const cleanups = [async()=>{await rm(root,{recursive:true,force:true})}];
let holdProbe = true, probeRelease, currentTransport;
const wait = async (fn) => { const end = Date.now() + 12000; while (!fn()) {
    if (Date.now() > end)
        throw Error("wait timeout");
    await new Promise(r => setTimeout(r, 20));
} };
app.disableHardwareAcceleration();
app.setPath("userData", root + "/runtime/userData");
async function startPair(options = {}) {
    const directory = await mkdtemp(join(root, "case-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const server = createServer();
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    await new Promise((resolve) => server.close(() => resolve()));
    const config = configuration();
    config.config.listen.port = port;
    const envelopes = [];
    let child;
    let exited;
    const received=[];
    const unsigned=JSON.parse(await readFile(unsignedPath,"utf8"));
    const manifest=Buffer.from(unsigned.manifest,"base64");
    const keys=generateKeyPairSync("ed25519");
    const candidate={manifest,signature:sign(null,Buffer.concat([Buffer.from(QQ_PACKAGE_SIGNATURE_DOMAIN),manifest]),keys.privateKey),files:new Map(unsigned.files.map(f=>[f.path,Buffer.from(f.data,"base64")]))};
    const context={trustedKeys:new Map([["ephemeral-rehearsal-only",keys.publicKey.export({type:"spki",format:"pem"}).toString()]]),hostVersion:"1.3.7",platform:process.platform,arch:process.arch,now:1500};
    const legacy={id:"qq",displayName:"synthetic absent legacy",onMessage:null,capability:{text:true},start:async()=>{throw Error("legacy must not start")},stop:async()=>{},send:async()=>({ok:false}),getStatus:()=>({enabled:false,phase:"offline"}),getMigrationIdentity:()=>null,prepareMigrationStop:async()=>{throw Error("first setup must not migrate")}};
    const router=new QqRoutingAdapter(legacy,"blocked");
    router.onMessage=async m=>{received.push(m);return null};
    let manager;
    const attach=router.attachModule.bind(router);
    router.attachModule=m=>{manager=m;attach(m)};
    const service=new QqModuleHostService({userDataPath:directory,router,verificationContext:()=>context,candidate:()=>candidate,readLegacySettings:()=>{throw Error("first setup must not read old settings")},secureStorage:{isSecureAvailable:()=>true,decryptString:()=>{throw Error("not used")}},appName:"isolated synthetic harness",readFirstConfiguration:id=>({...config.config,expectedSelfId:id}),readFirstCredential:()=>config.credentials.accessToken,verifyNoLegacyDriver:async()=>true,backendReconnectTimeoutMs:12000});
    const gateway=new QqModuleActionGateway(service),owner={key:{},isAuthorized:()=>true};
    const preview=await gateway.execute({action:"preview-install"},owner);
    assert.equal(preview.state,"preview-install");assert.equal(manager,undefined);
    assert.equal((await gateway.execute({action:"confirm-install",operationId:preview.preview.operationId,userConfirmed:true},owner)).state,"installed");
    assert.equal(manager,undefined,"install must not start a runtime");
    const setup=await gateway.execute({action:"preview-setup",accountId:"10000"},owner);
    assert.equal(setup.state,"preview-setup");
    const activating=gateway.execute({action:"confirm-setup",operationId:setup.preview.operationId,accountId:"10000",userConfirmed:true},owner);
    await wait(()=>manager&&manager.getState().phase==="waiting-backend");
    assert.equal(getQqStartupMode(directory),"blocked","durable prepared gates restart before account verification");
    cleanups.push(async()=>service.shutdown());
    const socket = new WebSocket(`ws://127.0.0.1:${port}/onebot/v11/ws`, { headers: { Authorization: `Bearer ${config.credentials.accessToken}`, "X-Self-ID": "10000" } });
    cleanups.push(async () => { socket.terminate(); });
    const actions = [];
    const uploads = new Map();
    const media = new Map([["picture.png", Buffer.concat([pngFixture, Buffer.alloc(70001 - pngFixture.length, 42)])], ["sound", Buffer.from("audio fixture")], ["document", Buffer.from("file fixture")], ["movie", Buffer.from("video fixture")]]);
    socket.on("message", (raw) => {
        const a = JSON.parse(raw.toString());
        actions.push(a);
        if (a.action.startsWith("send_") && JSON.stringify(a.params).includes("unanswered"))
            return;
        const respond = (data) => socket.send(JSON.stringify({ status: "ok", retcode: 0, echo: a.echo, data }));
        if (a.action === "get_login_info")
            return respond({ user_id: "10000" });
        if (a.action === "get_version_info")
            return respond({ app_name: "NapCat.Onebot", app_version: "0.0.0-not-used" });
        if (["can_send_image", "can_send_record"].includes(a.action))
            return respond({ yes: true });
        if (a.action === "test_download_stream") {
            if (holdProbe) {
                probeRelease = () => { for (let i = 1; i <= 10; i++)
                    respond({ type: "stream", data_type: "data_chunk", data: `Index-> ${i}` }); respond({ type: "response", data_type: "data_complete", data: "Stream transmission complete" }); };
                return;
            }
            if (options.stream === false)
                return socket.send(JSON.stringify({ status: "failed", retcode: 1404, echo: a.echo, data: null }));
            for (let i = 1; i <= 10; i++)
                respond({ type: "stream", data_type: "data_chunk", data: `Index-> ${i}` });
            return respond({ type: "response", data_type: "data_complete", data: "Stream transmission complete" });
        }
        if (a.action === "upload_file_stream") {
            const p = a.params;
            if (p.reset)
                return respond({ type: "response" });
            if (!p.is_complete) {
                const state = uploads.get(p.stream_id) ?? { chunks: [], size: p.file_size, sha256: p.expected_sha256, filename: p.filename };
                state.chunks.push(Buffer.from(p.chunk_data, "base64"));
                uploads.set(p.stream_id, state);
                return respond({ type: "stream", status: "chunk_received", stream_id: p.stream_id, received_chunks: state.chunks.length, total_chunks: p.total_chunks });
            }
            const state = uploads.get(p.stream_id);
            const bytes = Buffer.concat(state.chunks);
            return respond({ type: "response", status: "file_complete", stream_id: p.stream_id, file_size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), file_path: `/backend-private/${p.stream_id}/${state.filename}` });
        }
        if (/^download_file(?:_image|_record)?_stream$/.test(a.action)) {
            const bytes = media.get(a.params.file_id ?? a.params.file);
            if (!bytes)
                return socket.send(JSON.stringify({ status: "failed", retcode: 1200, echo: a.echo, data: null }));
            respond({ type: "stream", data_type: "file_info", ...(options.filename === null ? {} : { file_name: options.filename ?? "fixture.bin" }), file_size: bytes.length, chunk_size: 65536 });
            let chunks = 0;
            for (let offset = 0; offset < bytes.length; offset += 65536) {
                const block = bytes.subarray(offset, offset + 65536);
                respond({ type: "stream", data_type: "file_chunk", index: options.corruptDownload ? 999 : chunks, data: block.toString("base64"), size: block.length });
                chunks++;
            }
            return respond({ type: "response", data_type: "file_complete", total_chunks: chunks, total_bytes: bytes.length });
        }
        if (a.action === "get_group_member_info")
            return respond({ nickname: "Member" });
        return respond({ message_id: actions.length });
    });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    await wait(() => manager.getState().phase === "running");
    const incoming = (id, message) => socket.send(JSON.stringify({ self_id: 10000, post_type: "message", message_type: "private", message_id: id, user_id: 30000, time: 1700000000, sender: { nickname: "Isolated fixture" }, message }));
    assert.equal((await activating).state,"committed");
    console.log("PASS signed package install, actual trusted factory, first setup account confirmation, durable recovery gate and single route activation");
    return { manager, router, service, socket, directory, envelopes, actions, uploads, media, received, incoming, config };
}
let watchdog = setTimeout(() => { console.error("HARNESS_TIMEOUT"); app.exit(2); }, 45000);
(async () => {
    await app.whenReady();
    const p = await startPair({ filename: "image.txt" });
    await wait(() => !!probeRelease);
    p.incoming(1, [{ type: "text", data: { text: "early" } }, { type: "image", data: { file: "picture.png" } }]);
    p.incoming(2, [{ type: "text", data: { text: "ordered-after" } }]);
    await new Promise(r => setTimeout(r, 250));
    assert.equal(p.received.length, 0, "early media must wait; following text must stay ordered");
    holdProbe = false;
    probeRelease();
    await wait(() => p.received.length === 2);
    assert.equal(p.received[0].text, "early");
    assert.equal(p.received[0].attachments[0].mime, "image/png");
    assert.deepEqual(await readFile(p.received[0].attachments[0].filePath), p.media.get("picture.png"));
    assert.equal(p.received[1].text, "ordered-after");
    p.incoming(1, [{ type: "text", data: { text: "duplicate" } }]);
    await new Promise(r => setTimeout(r, 80));
    assert.equal(p.received.length, 2);
    console.log("PASS early image waits for probe, exact bytes/type, following text ordered, deduplication");
    const bytes = Buffer.alloc(1024 * 1024, 47), path = join(p.directory, "oneMiB.bin");
    await writeFile(path, bytes);
    const result = await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "file", filePath: path, name: "oneMiB.bin" }] });
    assert.equal(result.outcome, "sent");
    const uploaded = [...p.uploads.values()].find(x => x.size === bytes.length);
    assert.equal(uploaded.chunks.length, 16);
    assert.deepEqual(Buffer.concat(uploaded.chunks), bytes);
    console.log("PASS 1MiB file 16 chunks exact bytes");
    let release, oldResult;
    p.router.onMessage = async (m) => { if (m.text === "slow") {
        await new Promise(r => release = r);
        oldResult = await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "stale-turn" }] });
    } return null; };
    p.incoming(3, [{ type: "text", data: { text: "slow" } }]);
    await wait(() => !!release);
    p.socket.terminate();
    await wait(() => p.manager.getState().phase === "waiting-backend");
    const reconnect = new WebSocket(`ws://127.0.0.1:${p.config.config.listen.port}/onebot/v11/ws`, { headers: { Authorization: "Bearer " + p.config.credentials.accessToken, "X-Self-ID": "10000" } });
    cleanups.push(async () => reconnect.terminate());
    reconnect.on("message", raw => { let a = JSON.parse(raw); p.actions.push(a); if (a.action.startsWith("send_") && JSON.stringify(a.params).includes("unanswered"))
        return; reconnect.send(JSON.stringify({ status: "ok", retcode: 0, echo: a.echo, data: a.action === "get_login_info" ? { user_id: "10000" } : { message_id: 999 } })); });
    await wait(() => p.manager.getState().phase === "running");
    release();
    await wait(() => !!oldResult);
    assert.equal(oldResult.outcome, "failed");
    assert.equal(p.actions.filter(a => JSON.stringify(a.params).includes("stale-turn")).length, 0);
    console.log("PASS disconnect/reconnect rejects old async turn without backend send");
    const pending = p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "unanswered" }] });
    await wait(() => p.actions.some(a => JSON.stringify(a.params).includes("unanswered")));
    // Diagnostic-only process termination, not exposed to product IPC.
    await p.manager.current.runtime.transport.terminate();
    assert.equal((await pending).outcome, "unknown");
    assert.equal(p.manager.getState().phase, "crashed");
    reconnect.terminate();
    await p.manager.restart();
    const restarted = new WebSocket(`ws://127.0.0.1:${p.config.config.listen.port}/onebot/v11/ws`, { headers: { Authorization: "Bearer " + p.config.credentials.accessToken, "X-Self-ID": "10000" } });
    cleanups.push(async () => restarted.terminate());
    restarted.on("message", raw => { let a = JSON.parse(raw); p.actions.push(a); restarted.send(JSON.stringify({ status: "ok", retcode: 0, echo: a.echo, data: a.action === "get_login_info" ? { user_id: "10000" } : { message_id: 1000 } })); });
    await wait(() => p.manager.getState().phase === "running");
    assert.equal((await p.manager.send({ channel: "qq", chatType: "private", targetId: "30000", parts: [{ kind: "text", text: "after-restart" }] })).outcome, "sent");
    assert.equal(p.actions.filter(a => JSON.stringify(a.params).includes("unanswered")).length, 1);
    await p.manager.stop();
    assert.equal(p.manager.getState().phase, "stopped");
    console.log("PASS crash unknown outcome, explicit restart send, no automatic replay, confirmed stop");
})().then(async () => { for (const f of cleanups.reverse())
    await f(); clearTimeout(watchdog); console.log("ALL_SIGNED_HOST_ELECTRON_PASS"); app.exit(0); }).catch(async (e) => { console.error(e); for (const f of cleanups.reverse()) {
    try {
        await f();
    }
    catch { }
} clearTimeout(watchdog); app.exit(1); });
