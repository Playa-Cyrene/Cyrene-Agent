import { describe, expect, it, vi } from "vitest";
import { QqAdoptionProofCoordinator, type QqAdoptionContext, type QqAdoptionProofPorts } from "./adoption-proof";
const context = (): QqAdoptionContext => ({ platform: "win32", scopeId: "isolated", sessionEpoch: "test-session", mode: "new-install", previousHostSha256: null, hostSha256: "a".repeat(64), moduleSha256: "b".repeat(64) });
function fixture() {
  let value = context(), held = true;
  const release = vi.fn(() => { held = false; });
  const ports: QqAdoptionProofPorts = { readContext: () => value, persistIntent: vi.fn(), reviewedPolicy: { approve: vi.fn(() => true) },
    exclusiveScope: { freezeAndProve: vi.fn(async () => ({ isHeld: () => held, release })) }, legacy: { stopAndDrain: vi.fn(async () => true) } };
  return { ports, release, change: (v: QqAdoptionContext) => { value = v; }, lose: () => { held = false; }, coordinator: new QqAdoptionProofCoordinator(ports) };
}
describe("reviewed adoption evidence bridge", () => {
  it("has no default release policy approval or scope proof", async () => {
    const f = fixture(); vi.mocked(f.ports.reviewedPolicy.approve).mockReturnValue(false);
    await expect(f.coordinator.prepare()).rejects.toThrow(); expect(f.ports.persistIntent).not.toHaveBeenCalled(); expect(f.ports.exclusiveScope.freezeAndProve).not.toHaveBeenCalled();
  });
  it("persists intent before freezing and stopping a validated upgrade", async () => {
    const f = fixture(), order: string[] = [];
    f.change({ ...context(), mode: "validated-upgrade", previousHostSha256: "c".repeat(64) });
    f.ports.persistIntent = () => { order.push("intent"); };
    const freeze = f.ports.exclusiveScope.freezeAndProve; f.ports.exclusiveScope.freezeAndProve = async c => { order.push("freeze"); return freeze(c); };
    f.ports.legacy!.stopAndDrain = async () => { order.push("stop"); return true; };
    const proof = await f.coordinator.prepare(); expect(order).toEqual(["intent", "freeze", "stop"]);
    expect(proof.bootstrap.verifyInitialScope()).toBe(true); expect(proof.bootstrap.verifyInitialScope()).toBe(false);
    proof.cancel(); expect(f.release).not.toHaveBeenCalled();
  });
  it("does not freeze after intent failure", async () => {
    const f = fixture(); f.ports.persistIntent = () => { throw Error("disk failure"); };
    await expect(f.coordinator.prepare()).rejects.toThrow(); expect(f.ports.exclusiveScope.freezeAndProve).not.toHaveBeenCalled();
  });
  it("rejects changed context, lost freeze, or revoked policy at consumption", async () => {
    for (const kind of ["context", "freeze", "policy"]) {
      const f = fixture(), proof = await f.coordinator.prepare();
      if (kind === "context") f.change({ ...context(), moduleSha256: "d".repeat(64) });
      if (kind === "freeze") f.lose();
      if (kind === "policy") vi.mocked(f.ports.reviewedPolicy.approve).mockReturnValue(false);
      expect(proof.bootstrap.verifyInitialScope()).toBe(false); expect(proof.bootstrap.verifyInitialScope()).toBe(false);
    }
  });
  it("requires continuously held evidence after consumption and permanently poisons a failed check", async () => {
    const f = fixture(), proof = await f.coordinator.prepare();
    expect(proof.bootstrap.verifyInitialScope()).toBe(true); expect(proof.isHeld()).toBe(true);
    vi.mocked(f.ports.reviewedPolicy.approve).mockReturnValue(false); expect(proof.isHeld()).toBe(false);
    vi.mocked(f.ports.reviewedPolicy.approve).mockReturnValue(true); expect(proof.isHeld()).toBe(false);
    proof.cancel(); expect(f.release).not.toHaveBeenCalled();
  });
  it("releases unconsumed cancellation exactly once and denies consumption", async () => {
    const f = fixture(), proof = await f.coordinator.prepare(); proof.cancel(); proof.cancel();
    expect(f.release).toHaveBeenCalledTimes(1); expect(proof.bootstrap.verifyInitialScope()).toBe(false);
  });
  it("does not produce upgrade proof from a failed listener drain", async () => {
    const f = fixture(); f.change({ ...context(), mode: "validated-upgrade", previousHostSha256: "c".repeat(64) });
    f.ports.legacy!.stopAndDrain = async () => false;
    await expect(f.coordinator.prepare()).rejects.toThrow(); expect(f.release).toHaveBeenCalledOnce();
  });
  it("invalidates an in-flight scope result without issuing a grant", async () => {
    const f = fixture(); let done!: () => void;
    const gate = new Promise<void>(r => { done = r; });
    const freeze = f.ports.exclusiveScope.freezeAndProve;
    f.ports.exclusiveScope.freezeAndProve = async c => { await gate; return freeze(c); };
    const pending = f.coordinator.prepare(); const rejected = expect(pending).rejects.toThrow();
    await expect(f.coordinator.prepare()).rejects.toThrow(); f.coordinator.invalidate(); done(); await rejected;
    expect(f.release).toHaveBeenCalledOnce();
  });
});
