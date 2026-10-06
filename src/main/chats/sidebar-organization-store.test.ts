import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ root: "", listSessions: vi.fn(async () => [] as unknown[]) }));
vi.mock("./chats-store", () => ({ getRootDir: () => mocks.root, listSessions: mocks.listSessions }));
beforeEach(() => { vi.resetModules(); mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-sidebar-async-")); mocks.listSessions.mockReset().mockResolvedValue([]); });
afterEach(() => fs.rmSync(mocks.root, { recursive: true, force: true }));

describe("sidebar with asynchronous conversation storage", () => {
  it("waits for initialization before reading the snapshot", async () => {
    const store = await import("./sidebar-organization-store");
    expect(await store.getSnapshot()).toMatchObject({ version: 1, projects: [], groups: [] });
  });
  it("only accepts one concurrent draft for a revision", async () => {
    const store = await import("./sidebar-organization-store");
    const current = await store.getSnapshot();
    const first = { ...current, groups: [{ id: "g1", title: "first", color: "#000000" }], topLevelOrder: [{ type: "group" as const, groupId: "g1" }] };
    const second = { ...current, groups: [{ id: "g2", title: "second", color: "#000000" }], topLevelOrder: [{ type: "group" as const, groupId: "g2" }] };
    const results = await Promise.all([store.applyDraft(current.revision, first), store.applyDraft(current.revision, second)]);
    expect(results[0]).toMatchObject({ ok: true });
    expect(results[1]).toMatchObject({ ok: false, reason: "conflict" });
    expect((await store.getSnapshot()).groups.map(group => group.id)).toEqual(["g1"]);
  });
});
