import { expect, it, vi } from "vitest";
import type { QqModuleActionCommand, QqModuleActionResult, QqModuleConfigurationChange } from "../../shared/qq-module-actions";
import { QqModuleActionGateway } from "./action-gateway";
const packageId = `pkg-${"a".repeat(64)}`;
const owner = () => ({ key: {}, isAuthorized: vi.fn(() => true) });
function setup() {
  let sequence = 0;
  const execute = vi.fn((command: QqModuleActionCommand): QqModuleActionResult | Promise<QqModuleActionResult> => {
    if (command.action === "status") return { ok: true, state: "ready" };
    if (command.action === "cancel") return { ok: true, state: "cancelled" };
    if (command.action === "preview-install") return { ok: true, state: "preview-install", preview: { operationId: `operation-${++sequence}`, packageId, version: "0.1.0" } };
    if (command.action === "preview-migration" || command.action === "preview-setup") return { ok: true, state: command.action,
      preview: { operationId: `operation-${++sequence}`, packageId, accountId: "10000" } };
    return { ok: true, state: command.action === "confirm-install" ? "installed" : "committed" };
  });
  return { execute, gateway: new QqModuleActionGateway({ execute }), owner: owner() };
}
async function preview(s: ReturnType<typeof setup>, action: "preview-install" | "preview-migration" = "preview-install") {
  const result = await s.gateway.execute({ action }, s.owner);
  if (!result.ok || !("preview" in result)) throw Error("missing preview");
  return result.preview;
}
it("defaults to unconfigured without inspecting sender or payload", async () => {
  const denied = { key: {}, isAuthorized: vi.fn(() => { throw Error("must not invoke"); }) };
  const input = { get action() { throw Error("private-secret"); } };
  expect(await new QqModuleActionGateway().execute(input, denied)).toEqual({ ok: false, error: "unconfigured" });
  expect(denied.isAuthorized).not.toHaveBeenCalled();
});
it.each([
  null, {}, { action: "status", ownerId: "fake" }, { action: "preview-install", path: "/tmp/package" },
  { action: "preview-install", key: "key" }, { action: "preview-migration", token: "secret" },
  { action: "preview-setup", accountId: "not-a-qq-id" }, { action: "confirm-install", operationId: "1", userConfirmed: false },
  { action: "cancel", operationId: "../../file" }, { action: "other" },
])("rejects invalid/extra authority before calling host (%j)", async (input) => {
  const s = setup(); expect(await s.gateway.execute(input, s.owner)).toEqual({ ok: false, error: "invalid" }); expect(s.execute).not.toHaveBeenCalled();
});
it("binds previews to a host owner; another authorized window cannot overwrite, confirm or cancel", async () => {
  const s = setup(); const p = await preview(s), other = owner();
  for (const request of [{ action: "preview-install" }, { action: "confirm-install", operationId: p.operationId, userConfirmed: true }, { action: "cancel", operationId: p.operationId }]) {
    expect(await s.gateway.execute(request, other)).toEqual({ ok: false, error: "unauthorized" });
  }
  expect(s.execute).toHaveBeenCalledOnce();
  expect(await s.gateway.execute({ action: "status" }, other)).toEqual({ ok: true, state: "ready" });
  expect(await s.gateway.execute({ action: "confirm-install", operationId: p.operationId, userConfirmed: true }, s.owner)).toEqual({ ok: true, state: "installed" });
  expect(await s.gateway.execute({ action: "confirm-install", operationId: p.operationId, userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
});
it("rejects wrong kind/account and invalidates cancelled or superseded operation IDs", async () => {
  const s = setup(); const first = await preview(s); const p = await preview(s, "preview-migration");
  expect(await s.gateway.execute({ action: "confirm-install", operationId: first.operationId, userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
  expect(await s.gateway.execute({ action: "confirm-install", operationId: p.operationId, userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
  expect(await s.gateway.execute({ action: "confirm-migration", operationId: p.operationId, accountId: "999", userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
  expect(await s.gateway.execute({ action: "cancel", operationId: p.operationId }, s.owner)).toEqual({ ok: true, state: "cancelled" });
  expect(await s.gateway.execute({ action: "confirm-migration", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
});
it("invalidates a pending preview on owner destruction and never revives that owner", async () => {
  const s = setup(); const p = await preview(s);
  await s.gateway.invalidate(s.owner.key);
  expect(s.execute).toHaveBeenLastCalledWith({ action: "cancel", operationId: p.operationId });
  expect(await s.gateway.execute({ action: "status" }, s.owner)).toEqual({ ok: false, error: "unauthorized" });
  expect((await s.gateway.execute({ action: "preview-install" }, owner())).ok).toBe(true);
});
it("discards and cancels a late preview after its window is invalidated", async () => {
  const s = setup(); let release!: (v: QqModuleActionResult) => void;
  s.execute.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = s.gateway.execute({ action: "preview-install" }, s.owner);
  expect(await s.gateway.execute({ action: "preview-install" }, owner())).toEqual({ ok: false, error: "busy" });
  await s.gateway.invalidate(s.owner.key);
  release({ ok: true, state: "preview-install", preview: { operationId: "late-preview", packageId } });
  expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.execute).toHaveBeenLastCalledWith({ action: "cancel", operationId: "late-preview" });
});
it("cleans an owned preview even if invalidation occurs during a status query", async () => {
  const s = setup(); const p = await preview(s); let release!: (v: QqModuleActionResult) => void;
  s.execute.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const status = s.gateway.execute({ action: "status" }, s.owner);
  await s.gateway.invalidate(s.owner.key); release({ ok: true, state: "ready" });
  expect(await status).toEqual({ ok: false, error: "unauthorized" });
  expect(s.execute).toHaveBeenLastCalledWith({ action: "cancel", operationId: p.operationId });
});
it("does not pretend to cancel an already confirmed migration when its window closes", async () => {
  const s = setup(); const p = await preview(s, "preview-migration"); let release!: (v: QqModuleActionResult) => void;
  s.execute.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const pending = s.gateway.execute({ action: "confirm-migration", operationId: p.operationId, accountId: "10000", userConfirmed: true }, s.owner);
  await s.gateway.invalidate(s.owner.key);
  expect(await s.gateway.execute({ action: "status" }, owner())).toEqual({ ok: false, error: "busy" });
  release({ ok: true, state: "committed" }); expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.execute.mock.calls.some(([c]) => c.action === "cancel")).toBe(false);
});
it("rechecks authorization, scrubs exceptions/extra output fields, and fails closed after cancellation failure", async () => {
  const s = setup(); s.owner.isAuthorized.mockReturnValue(false);
  expect(await s.gateway.execute({ action: "status" }, s.owner)).toEqual({ ok: false, error: "unauthorized" }); expect(s.execute).not.toHaveBeenCalled();
  const live = owner(); s.execute.mockImplementationOnce(() => { throw Error("token=private"); });
  expect(await s.gateway.execute({ action: "status" }, live)).toEqual({ ok: false, error: "operation-failed" });
  s.execute.mockReturnValueOnce({ ok: true, state: "ready", path: "/secret" } as any);
  expect(await s.gateway.execute({ action: "status" }, live)).toEqual({ ok: false, error: "operation-failed" });
  const response = await s.gateway.execute({ action: "preview-install" }, live); expect(response.ok).toBe(true);
  s.execute.mockImplementationOnce(() => { throw Error("private diagnostic"); });
  await s.gateway.invalidate(live.key);
  expect(await s.gateway.execute({ action: "status" }, owner())).toEqual({ ok: false, error: "recovery-required" });
});
it("accepts live committed status and bounded prerelease/build version metadata", async () => {
  const s = setup();
  s.execute.mockReturnValueOnce({ ok: true, state: "committed" });
  expect(await s.gateway.execute({ action: "status" }, s.owner)).toEqual({ ok: true, state: "committed" });
  s.execute.mockReturnValueOnce({ ok: true, state: "preview-install", preview: { operationId: "dev-build", packageId, version: "0.1.0-dev.0+test.1" } });
  expect(await s.gateway.execute({ action: "preview-install" }, s.owner)).toMatchObject({ ok: true, preview: { version: "0.1.0-dev.0+test.1" } });
});
it.each(["recovery", "reconfigure"] as const)("requires a fresh same-owner/account/type confirmation for %s", async (kind) => {
  const s = setup(); const action = `preview-${kind}` as const;
  s.execute.mockReturnValueOnce({ ok: true, state: action, preview: { operationId: `operation-${kind}`, packageId, accountId: "10000",
    ...(kind === "reconfigure" ? { desiredEnabled: false, changes: ["enabled", "credential", "configuration"] as QqModuleConfigurationChange[] } : {}) } });
  const response = await s.gateway.execute({ action }, s.owner);
  expect(response).toMatchObject({ ok: true, state: action });
  const confirm = { action: `confirm-${kind}`, operationId: `operation-${kind}`, accountId: "10000", userConfirmed: true };
  expect(await s.gateway.execute(confirm, owner())).toEqual({ ok: false, error: "unauthorized" });
  expect(await s.gateway.execute({ ...confirm, accountId: "99999" }, s.owner)).toEqual({ ok: false, error: "stale" });
  expect(await s.gateway.execute({ ...confirm, action: kind === "reconfigure" ? "confirm-recovery" : "confirm-reconfigure" }, s.owner)).toEqual({ ok: false, error: "stale" });
  const state = kind === "reconfigure" ? "disabled" : "committed";
  s.execute.mockReturnValueOnce({ ok: true, state });
  expect(await s.gateway.execute(confirm, s.owner)).toEqual({ ok: true, state });
  expect(await s.gateway.execute(confirm, s.owner)).toEqual({ ok: false, error: "stale" });
});
it.each([
  { action: "preview-recovery", accountId: "10000" }, { action: "preview-recovery", packageId },
  { action: "preview-reconfigure", desiredEnabled: false }, { action: "preview-reconfigure", allowedGroupIds: ["20000"] },
  { action: "preview-reconfigure", config: { enabled: false } }, { action: "preview-reconfigure", credentialRevision: "1" },
  { action: "confirm-reconfigure", operationId: "operation-1", accountId: "10000", userConfirmed: true, token: "secret" },
])("does not accept renderer-selected recovery/configuration authority (%j)", async (request) => {
  const s = setup(); expect(await s.gateway.execute(request, s.owner)).toEqual({ ok: false, error: "invalid" }); expect(s.execute).not.toHaveBeenCalled();
});
it.each([
  { desiredEnabled: true }, { changes: ["enabled"] }, { desiredEnabled: false, changes: ["credentials=secret"] },
  { desiredEnabled: false, changes: ["enabled", "enabled"] }, { desiredEnabled: false, changes: ["listen"], token: "secret" },
])("rejects malformed/private reconfiguration preview metadata (%j)", async (fields) => {
  const s = setup();
  s.execute.mockReturnValueOnce({ ok: true, state: "preview-reconfigure", preview: { operationId: "operation-1", packageId, accountId: "10000", ...fields } } as any);
  expect(await s.gateway.execute({ action: "preview-reconfigure" }, s.owner)).toEqual({ ok: false, error: "operation-failed" });
});
it("does not permit recovery to silently report a disabled outcome", async () => {
  const s = setup();
  s.execute.mockReturnValueOnce({ ok: true, state: "preview-recovery", preview: { operationId: "recover-1", packageId, accountId: "10000" } });
  await s.gateway.execute({ action: "preview-recovery" }, s.owner);
  s.execute.mockReturnValueOnce({ ok: true, state: "disabled" });
  expect(await s.gateway.execute({ action: "confirm-recovery", operationId: "recover-1", accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "operation-failed" });
});
it("discards and cancels a late reconfiguration preview after owner navigation", async () => {
  const s = setup(); let resolve!: (value: QqModuleActionResult) => void;
  s.execute.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const pending = s.gateway.execute({ action: "preview-reconfigure" }, s.owner);
  await s.gateway.invalidate(s.owner.key);
  resolve({ ok: true, state: "preview-reconfigure", preview: { operationId: "late-change", packageId, accountId: "10000", desiredEnabled: false, changes: ["enabled"] } });
  expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.execute).toHaveBeenLastCalledWith({ action: "cancel", operationId: "late-change" });
});
it("does not cancel/replay confirmed recovery when its owner disappears", async () => {
  const s = setup(); let resolve!: (value: QqModuleActionResult) => void;
  s.execute.mockReturnValueOnce({ ok: true, state: "preview-recovery", preview: { operationId: "recover-1", packageId, accountId: "10000" } });
  await s.gateway.execute({ action: "preview-recovery" }, s.owner);
  s.execute.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
  const pending = s.gateway.execute({ action: "confirm-recovery", operationId: "recover-1", accountId: "10000", userConfirmed: true }, s.owner);
  await s.gateway.invalidate(s.owner.key);
  resolve({ ok: true, state: "committed" });
  expect(await pending).toEqual({ ok: false, error: "unauthorized" });
  expect(s.execute.mock.calls.some(([command]) => command.action === "cancel")).toBe(false);
});
it("accepts a safe disabled status without granting recovery permission", async () => {
  const s = setup(); s.execute.mockReturnValueOnce({ ok: true, state: "disabled" });
  expect(await s.gateway.execute({ action: "status" }, s.owner)).toEqual({ ok: true, state: "disabled" });
  expect(await s.gateway.execute({ action: "confirm-recovery", operationId: "invented", accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "stale" });
});
it.each([true, false])("does not misreport the opposite enabled outcome after explicit desiredEnabled=%s", async (desiredEnabled) => {
  const s = setup();
  s.execute.mockReturnValueOnce({ ok: true, state: "preview-reconfigure", preview: { operationId: "intent-1", packageId, accountId: "10000", desiredEnabled, changes: ["enabled"] } });
  await s.gateway.execute({ action: "preview-reconfigure" }, s.owner);
  s.execute.mockReturnValueOnce({ ok: true, state: desiredEnabled ? "disabled" : "committed" });
  expect(await s.gateway.execute({ action: "confirm-reconfigure", operationId: "intent-1", accountId: "10000", userConfirmed: true }, s.owner)).toEqual({ ok: false, error: "operation-failed" });
});
