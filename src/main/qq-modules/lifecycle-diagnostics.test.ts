import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQqLifecycleDiagnostics } from "./lifecycle-diagnostics";
import { validateQqLifecycleDiagnostics } from "../../shared/qq-module-diagnostics";
const roots: string[] = [];
const root = () => { const r = mkdtempSync(join(tmpdir(), "qq-diagnostic-")); roots.push(r); return r; };
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
const ownership = (r: string, phase = "dirty") => {
  const d = join(r, "qq-module-driver-ownership"); mkdirSync(d);
  writeFileSync(join(d, "ownership.json"), JSON.stringify({ schema: 1, scopeId: "PRIVATE-SCOPE", epoch: "12345678-1234-1234-1234-123456789abc", phase })); return d;
};
describe("read-only lifecycle diagnostics", () => {
  it("observes absence without creating stores or granting ownership", () => {
    const r = root(); const value = readQqLifecycleDiagnostics(r);
    expect(value.startupMode).toBe("legacy"); expect(value.manualReviewRequired).toBe(false);
    expect(readdirSync(r)).toEqual([]); expect(validateQqLifecycleDiagnostics(value)).toBe(true);
  });
  it.each(["dirty", "clean-retired"])("reports %s without returning private identifiers or clearing evidence", phase => {
    const r = root(), d = ownership(r, phase), before = readFileSync(join(d, "ownership.json"));
    const value = readQqLifecycleDiagnostics(r);
    expect(value.stores.driverOwnership.status).toBe(phase); expect(value.startupMode).toBe("blocked");
    expect(value.manualReviewRequired).toBe(phase === "dirty"); expect(JSON.stringify(value)).not.toContain("PRIVATE-SCOPE");
    expect(JSON.stringify(value)).not.toContain(r); expect(readFileSync(join(d, "ownership.json"))).toEqual(before);
  });
  it("never treats a stale-looking lock as removable", () => {
    const r = root(), d = ownership(r); writeFileSync(join(d, "owner.lock"), "dead-owner-secret");
    expect(readQqLifecycleDiagnostics(r).stores.driverOwnership.status).toBe("locked");
    expect(readFileSync(join(d, "owner.lock"), "utf8")).toBe("dead-owner-secret");
  });
  it.each(["qq-module-migration", "qq-module-first-setup", "qq-module-recovery"])("reports incomplete %s and preserves it", name => {
    const r = root(), d = join(r, name); mkdirSync(d);
    const v = readQqLifecycleDiagnostics(r); expect(v.manualReviewRequired).toBe(true);
    expect(Object.values(v.stores).some(s => s.status === "incomplete")).toBe(true); expect(readdirSync(d)).toEqual([]);
  });
  it("validates lifecycle records but exposes only enum phase", () => {
    const r = root(), d = join(r, "qq-module-first-setup"); mkdirSync(d);
    writeFileSync(join(d, "marker"), "Cyrene QQ first setup v1\n");
    writeFileSync(join(d, "state.json"), JSON.stringify({ schemaVersion: 1, transactionId: "12345678-1234-1234-1234-123456789abc", packageId: `pkg-${"a".repeat(64)}`, phase: "selected", config: { configRevision: 1, expectedSelfId: "12345", listen: { host: "127.0.0.1", port: 6200 }, allowedPrivateUserIds: [], allowedGroupIds: [], groupRequireMention: true } }));
    expect(readQqLifecycleDiagnostics(r).stores.firstSetup).toEqual({ status: "recorded", phase: "selected" });
  });
  it.each(["json", "oversize", "unknown", "hardlink", "symlink"])("fails closed on %s ownership state", kind => {
    const r = root(), d = ownership(r), f = join(d, "ownership.json");
    if (kind === "json") writeFileSync(f, "{secret");
    if (kind === "oversize") writeFileSync(f, "x".repeat(4097));
    if (kind === "unknown") writeFileSync(join(d, "unexpected"), "secret");
    if (kind === "hardlink") linkSync(f, join(r, "alias"));
    if (kind === "symlink") { rmSync(f); symlinkSync(join(r, "missing"), f); }
    expect(readQqLifecycleDiagnostics(r).stores.driverOwnership.status).toBe("corrupt");
  });
  it("rejects root aliases and missing profile parents without probing targets", () => {
    const r = root(), alias = join(r, "alias"); symlinkSync(r, alias);
    expect(readQqLifecycleDiagnostics(alias).stores.driverOwnership.status).toBe("unavailable");
    expect(readQqLifecycleDiagnostics(join(r, "absent")).manualReviewRequired).toBe(true);
    expect(readQqLifecycleDiagnostics("relative").manualReviewRequired).toBe(true);
  });
  it("rejects extra diagnostic fields, arbitrary phases, and misleading all-clear responses", () => {
    const v = readQqLifecycleDiagnostics(root());
    expect(validateQqLifecycleDiagnostics({ ...v, path: "/secret" })).toBe(false);
    expect(validateQqLifecycleDiagnostics({ ...v, stores: { ...v.stores, migration: { status: "recorded", phase: "secret" } } })).toBe(false);
    expect(validateQqLifecycleDiagnostics({ ...v, stores: { ...v.stores, driverOwnership: { status: "dirty" } } })).toBe(false);
  });
});
it("reports adoption intent as a durable record, not a grant, and never clears its permanent lock", async () => {
  const { QqAdoptionIntentStore } = await import("./adoption-intent");
  const r = root(), store = new QqAdoptionIntentStore(r);
  store.persistIntent({ platform: "win32", scopeId: "private", sessionEpoch: "private-session", mode: "new-install", previousHostSha256: null, hostSha256: "a".repeat(64), moduleSha256: "b".repeat(64) });
  const before = readFileSync(join(store.root, "intent-lock"));
  const v = readQqLifecycleDiagnostics(r);
  expect(v.stores.adoption).toEqual({ status: "recorded", phase: "prepared" }); expect(v.startupMode).toBe("blocked");
  expect(validateQqLifecycleDiagnostics(v)).toBe(true); expect(JSON.stringify(v)).not.toContain("private");
  expect(readFileSync(join(store.root, "intent-lock"))).toEqual(before);
  writeFileSync(join(store.root, "state.tmp"), "partial");
  expect(readQqLifecycleDiagnostics(r).stores.adoption).toEqual({ status: "incomplete" });
});
