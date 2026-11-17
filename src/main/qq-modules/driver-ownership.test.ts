import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, parse } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QqDriverOwnershipSupervisor } from "./driver-ownership";
import type { QqProcessTransport } from "./runtime";
const roots: string[] = [];
function options() {
  const root = mkdtempSync(join(tmpdir(), "qq-ownership-")); roots.push(root);
  return { directory: join(root, "ownership"), scopeId: "synthetic-profile", bootstrap: { verifyInitialScope: () => true } };
}
function fake() {
  let exit: (() => void) | undefined;
  const transport: QqProcessTransport = { postMessage() {}, onMessage: () => () => {}, onExit: (fn) => { exit = fn; return () => {}; }, terminate: async () => {} };
  return { transport, exit: () => exit?.() };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
describe("closed-world driver ownership", () => {
  it("rejects relative and filesystem-root directories", () => {
    const o = options();
    expect(() => QqDriverOwnershipSupervisor.open({ ...o, directory: "relative" })).toThrow();
    expect(() => QqDriverOwnershipSupervisor.open({ ...o, directory: parse(o.directory).root })).toThrow();
  });
  it.skipIf(process.platform === "win32")("rejects a symlinked ancestor", () => {
    const o = options(); const alias = `${o.directory}-alias`;
    symlinkSync(parse(o.directory).root, alias);
    expect(() => QqDriverOwnershipSupervisor.open({ ...o, directory: join(alias, "qq-leaf") })).toThrow();
  });
  it("rejects unexpected clean-state fields", () => {
    const o = options(); QqDriverOwnershipSupervisor.open(o).retire();
    const file = join(o.directory, "ownership.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), extra: true }));
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("requires explicit bootstrap and preserves failed lease", () => {
    const o = options();
    expect(() => QqDriverOwnershipSupervisor.open({ ...o, bootstrap: undefined })).toThrow();
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("rejects historical empty unmanaged directory", () => {
    const o = options(); mkdirSync(o.directory);
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("excludes parallel hosts and rejects dirty state even after external lease removal", () => {
    const o = options(); QqDriverOwnershipSupervisor.open(o);
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
    unlinkSync(join(o.directory, "owner.lock"));
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("inherits clean retirement without invoking bootstrap again", () => {
    const o = options(); const first = QqDriverOwnershipSupervisor.open(o); first.retire();
    const second = QqDriverOwnershipSupervisor.open({ ...o, bootstrap: { verifyInitialScope: () => { throw Error(); } } });
    expect(second.epoch).not.toBe(first.epoch); expect(second.verifyAllStopped()).toBe(true);
    second.retire();
  });
  it("requires actual exit, not terminate resolution, and consumes grants exactly once", async () => {
    const owner = QqDriverOwnershipSupervisor.open(options()); const child = fake();
    const grant = await owner.beginActivation(); const create = owner.wrapCreateTransport(() => child.transport, grant);
    expect(create()).toBe(child.transport); expect(() => create()).toThrow();
    await child.transport.terminate(); expect(owner.verifyAllStopped()).toBe(false);
    expect(owner.verifyNoOtherDrivers(child.transport)).toBe(true);
    expect(owner.verifyNoOtherDrivers(fake().transport)).toBe(false);
    await expect(owner.beginActivation()).rejects.toThrow();
    child.exit(); expect(owner.verifyAllStopped()).toBe(true); owner.retire();
  });
  it("retirement with a live child is terminal even after its late exit", async () => {
    const o = options(); const owner = QqDriverOwnershipSupervisor.open(o); const child = fake();
    owner.wrapCreateTransport(() => child.transport, await owner.beginActivation())();
    expect(() => owner.retire()).toThrow(); child.exit();
    await expect(owner.beginActivation()).rejects.toThrow();
    expect(owner.verifyAllStopped()).toBe(false);
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("invalidates old generation grants and prevents post-retirement spawn", async () => {
    const owner = QqDriverOwnershipSupervisor.open(options());
    const old = await owner.beginActivation(); const current = await owner.beginActivation();
    const create = vi.fn(() => fake().transport);
    expect(() => owner.wrapCreateTransport(create, old)()).toThrow();
    owner.retire(); expect(() => owner.wrapCreateTransport(create, current)()).toThrow(); expect(create).not.toHaveBeenCalled();
  });
  it("persists dirty intent before spawn and cannot recover ambiguous creation failure", async () => {
    const o = options(); const owner = QqDriverOwnershipSupervisor.open(o); const grant = await owner.beginActivation();
    expect(() => owner.wrapCreateTransport(() => {
      expect(JSON.parse(readFileSync(join(o.directory, "ownership.json"), "utf8")).phase).toBe("dirty");
      throw Error("possible spawn");
    }, grant)()).toThrow();
    expect(owner.verifyAllStopped()).toBe(false); expect(() => owner.retire()).toThrow();
  });
  it("freezes activation while legacy listener close and drain proof is pending", async () => {
    let resolve!: (value: boolean) => void;
    const owner = QqDriverOwnershipSupervisor.open({ ...options(), legacy: { stopAndDrain: () => new Promise((r) => { resolve = r; }) } });
    expect(owner.verifyAllStopped()).toBe(false);
    const pending = owner.beginActivation(); await expect(owner.beginActivation()).rejects.toThrow();
    expect(owner.verifyAllStopped()).toBe(false); resolve(true); await pending;
    expect(owner.verifyAllStopped()).toBe(true);
  });
  it("legacy proof failure never authorizes spawn", async () => {
    const owner = QqDriverOwnershipSupervisor.open({ ...options(), legacy: { stopAndDrain: async () => false } });
    await expect(owner.beginActivation()).rejects.toThrow(); expect(owner.verifyAllStopped()).toBe(false);
  });
  it("rejects a forged grant with identical public fields", async () => {
    const owner = QqDriverOwnershipSupervisor.open(options()); const grant = await owner.beginActivation();
    expect(() => owner.wrapCreateTransport(() => fake().transport, { ...grant })()).toThrow();
  });
  it("is terminal when clean-retirement persistence fails", async () => {
    const o = options(); const owner = QqDriverOwnershipSupervisor.open(o); const grant = await owner.beginActivation();
    unlinkSync(join(o.directory, "ownership.json")); mkdirSync(join(o.directory, "ownership.json"));
    expect(() => owner.retire()).toThrow();
    expect(() => owner.wrapCreateTransport(() => fake().transport, grant)()).toThrow();
    expect(() => QqDriverOwnershipSupervisor.open(o)).toThrow();
  });
  it("cannot inherit a different profile's retirement", () => {
    const o = options(); QqDriverOwnershipSupervisor.open(o).retire();
    expect(() => QqDriverOwnershipSupervisor.open({ ...o, scopeId: "another-profile" })).toThrow();
  });
  it("supports replayed early exit", async () => {
    const owner = QqDriverOwnershipSupervisor.open(options()); const child = fake().transport;
    child.onExit = (fn) => { fn(); return () => {}; };
    owner.wrapCreateTransport(() => child, await owner.beginActivation())();
    expect(owner.verifyAllStopped()).toBe(true);
  });
});
