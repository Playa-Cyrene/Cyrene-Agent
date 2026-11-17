import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { QqConfigurationProposalStore, diffQqConfigurationProposals, type QqConfigurationProposalInput } from "./configuration-proposal";
import { configuration } from "../../../scripts/verify/qq-module/fixtures";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const gen = "11111111-1111-4111-8111-111111111111";
const input = (revision = 1): QqConfigurationProposalInput => ({ config: { ...configuration().config, configRevision: revision }, enabled: true, credentialGeneration: gen });
const metadata = { accountId: "10000", generation: gen, status: "active" as const };
function setup() { const parent = mkdtempSync(join(tmpdir(), "qq-proposal-")); roots.push(parent); const root = join(parent, "proposal"); return { parent, root, store: new QqConfigurationProposalStore(root) }; }
it("has no construction/read side effects, persists only host proposal and returns independent snapshots", () => {
  const s = setup(); expect(s.store.read()).toBeNull(); expect(existsSync(s.root)).toBe(false);
  const original = input(); const first = s.store.propose(original, null); original.config.allowedPrivateUserIds.push("999"); first.config.expectedSelfId = "999";
  const stored = s.store.read()!; expect(stored.config.expectedSelfId).toBe("10000"); expect(stored.config.allowedPrivateUserIds).not.toContain("999");
  expect(new QqConfigurationProposalStore(s.root).read()).toEqual(stored);
  expect(s.store.readDesired({ proposalId: stored.proposalId, revision: stored.revision }, metadata).credentialRevision).toBe(gen);
  expect(readFileSync(join(s.root, "state.json"), "utf8")).not.toContain("test-only-token");
});
it("CAS and immutable proposal binding reject newer proposals and nonmonotonic config revisions", () => {
  const s = setup(); const one = s.store.propose(input(), null);
  expect(() => s.store.propose(input(2), null)).toThrow("stale-proposal");
  expect(() => s.store.propose(input(), 1)).toThrow("non-monotonic-revision");
  const two = s.store.propose(input(2), 1); expect(two.revision).toBe(2); expect(two.proposalId).not.toBe(one.proposalId);
  expect(() => s.store.assertCurrent({ proposalId: one.proposalId, revision: one.revision })).toThrow("stale-proposal");
  expect(() => s.store.readDesired({ proposalId: one.proposalId, revision: one.revision }, metadata)).toThrow("stale-proposal");
});
it.each(["0.0.0.0", "localhost", "192.168.1.1"])("rejects unsupported listener %s before writes", host => {
  const s = setup(); const value = input(); value.config.listen.host = host;
  expect(() => s.store.propose(value, null)).toThrow("invalid-input"); expect(existsSync(s.root)).toBe(false);
});
it("rejects extra secret/path/key/schema fields, invalid revisions and invalid metadata without decrypting", () => {
  const s = setup();
  for (const extra of [{ token: "secret" }, { path: "/tmp/other" }, { key: "key" }, { schemaVersion: 2 }]) expect(() => s.store.propose({ ...input(), ...extra } as any, null)).toThrow("invalid-input");
  expect(() => s.store.propose(input(), -1)).toThrow("invalid-input");
  const record = s.store.propose(input(), null); const binding = { proposalId: record.proposalId, revision: record.revision };
  for (const m of [null, { ...metadata, status: "revoked" as const }, { ...metadata, generation: "22222222-2222-4222-8222-222222222222" }, { ...metadata, accountId: "999" }]) expect(() => s.store.readDesired(binding, m)).toThrow("credential-generation-mismatch");
});
it("fails closed for residual locks, unknown files, missing/corrupt state and unknown stores", () => {
  for (const mutate of [
    (s: ReturnType<typeof setup>) => writeFileSync(join(s.root, "proposal-lock"), ""),
    (s: ReturnType<typeof setup>) => writeFileSync(join(s.root, ".state-leftover"), ""),
    (s: ReturnType<typeof setup>) => rmSync(join(s.root, "state.json")),
    (s: ReturnType<typeof setup>) => writeFileSync(join(s.root, "state.json"), "{}"),
    (s: ReturnType<typeof setup>) => writeFileSync(join(s.root, "marker"), "different"),
  ]) { const s = setup(); s.store.propose(input(), null); mutate(s); expect(() => s.store.read()).toThrow(); expect(() => s.store.propose(input(2), 1)).toThrow(); }
});
it("atomic write failure preserves prior bytes and invalidates nothing already committed", () => {
  const s = setup(); const one = s.store.propose(input(), null); const bytes = readFileSync(join(s.root, "state.json"));
  const failing = new QqConfigurationProposalStore(s.root, () => { throw Error("simulated crash before rename"); });
  expect(() => failing.propose(input(2), 1)).toThrow("simulated"); expect(readFileSync(join(s.root, "state.json"))).toEqual(bytes);
  expect(s.store.assertCurrent({ proposalId: one.proposalId, revision: 1 })).toEqual(one);
});
it("interrupted first commit leaves a recognizable but unusable store, never an empty default", () => {
  const s = setup(); const failing = new QqConfigurationProposalStore(s.root, () => { throw Error("failure"); });
  expect(() => failing.propose(input(), null)).toThrow(); expect(() => s.store.read()).toThrow("invalid-state");
});
it.skipIf(process.platform === "win32")("rejects symbolic and hard linked state without following it", () => {
  for (const hard of [false, true]) { const s = setup(); s.store.propose(input(), null); const state = join(s.root, "state.json"), other = join(s.parent, "external");
    writeFileSync(other, readFileSync(state)); rmSync(state); if (hard) linkSync(other, state); else symlinkSync(other, state);
    expect(() => s.store.read()).toThrow(); }
});
it("diff exposes exact nonsecret before/after configuration without credential generation", () => {
  const previous = input(); const next = input(2); next.config.allowedPrivateUserIds = ["444"]; next.config.listen.port = 9000; next.enabled = false;
  next.credentialGeneration = "22222222-2222-4222-8222-222222222222";
  const diff = diffQqConfigurationProposals(previous, next);
  expect(diff.changes).toEqual(["allowlist", "enabled", "credential", "listen"]);
  expect(diff.before?.config.allowedPrivateUserIds).toEqual(["30000"]); expect(diff.after.config.allowedPrivateUserIds).toEqual(["444"]);
  expect(JSON.stringify(diff)).not.toContain(gen); expect(JSON.stringify(diff)).not.toContain(next.credentialGeneration);
  diff.after.config.expectedSelfId = "0"; expect(next.config.expectedSelfId).toBe("10000");
});

it("allows a bound disable proposal without available credentials or decryption", () => {
  const s = setup(); const value = input(); value.enabled = false; const saved = s.store.propose(value, null);
  expect(s.store.readDesired({ proposalId: saved.proposalId, revision: saved.revision }, null).enabled).toBe(false);
  expect(s.store.readDesired(undefined, { ...metadata, status: "revoked" }).enabled).toBe(false);
});
it("does not create a store for stale initial CAS and rejects revision overflow", () => {
  const s = setup(); expect(() => s.store.propose(input(), 1)).toThrow("stale-proposal"); expect(existsSync(s.root)).toBe(false);
  s.store.propose(input(), null); const statePath = join(s.root, "state.json"); const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.revision = Number.MAX_SAFE_INTEGER; writeFileSync(statePath, JSON.stringify(state));
  expect(() => s.store.propose(input(2), Number.MAX_SAFE_INTEGER)).toThrow("non-monotonic-revision");
});
