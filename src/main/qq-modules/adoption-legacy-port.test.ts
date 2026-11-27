import { expect, it, vi } from "vitest";
import { QqRoutingAdapter } from "../channels/adapters/qq-routing-adapter";
import type { ChannelAdapter } from "../channels/adapters/base";
import { capabilities } from "../../../scripts/verify/qq-module/fixtures";
import { createQqCurrentHostLegacyAdoptionPort } from "./adoption-legacy-port";
import type { QqAdoptionContext } from "./adoption-proof";
const context: QqAdoptionContext = { platform: "win32", scopeId: "test", sessionEpoch: "session", mode: "validated-upgrade", previousHostSha256: "c".repeat(64), hostSha256: "a".repeat(64), moduleSha256: "b".repeat(64) };
function fixture() {
  const legacy = { id: "qq" as const, displayName: "legacy", capability: capabilities.messages, onMessage: null as ChannelAdapter["onMessage"],
    start: vi.fn(async () => {}), stop: vi.fn(async () => {}), send: vi.fn(async () => ({ ok: true })), getStatus: () => ({ enabled: true, phase: "running" as const }),
    getMigrationIdentity: () => ({ accountId: "10000", connectionEpoch: 1 }), prepareMigrationStop: vi.fn(async () => ({ safeToSwitch: true, drained: true, stopped: true })) };
  const router = new QqRoutingAdapter(legacy);
  return { legacy, router, port: createQqCurrentHostLegacyAdoptionPort(router, { accountId: "10000", connectionEpoch: 1 }) };
}
it("uses real router freeze while awaiting observed listener/drain evidence", async () => {
  const f = fixture(); let finish!: () => void;
  f.legacy.prepareMigrationStop.mockImplementation(() => new Promise(r => { finish = () => r({ safeToSwitch: true, drained: true, stopped: true }); }));
  const stopped = f.port.stopAndDrain(context);
  await expect(f.router.start()).rejects.toThrow();
  finish(); expect(await stopped).toBe(true);
  expect(f.router.getDriver()).toBe("blocked"); await expect(f.router.start()).rejects.toThrow();
  expect(await f.port.stopAndDrain(context)).toBe(false);
});
it("does not turn an uncertain listener stop into proof or restart", async () => {
  const f = fixture(); f.legacy.prepareMigrationStop.mockResolvedValue({ safeToSwitch: false, drained: true, stopped: false });
  expect(await f.port.stopAndDrain(context)).toBe(false); await expect(f.router.start()).rejects.toThrow();
});
it("refuses a different legacy identity before stopping", async () => {
  const f = fixture(); f.legacy.getMigrationIdentity = () => ({ accountId: "20000", connectionEpoch: 2 });
  expect(await f.port.stopAndDrain(context)).toBe(false); expect(f.legacy.prepareMigrationStop).not.toHaveBeenCalled();
});
