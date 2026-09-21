import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ userDataDir: "" }));

vi.mock("electron", () => ({
  app: { getPath: () => mocks.userDataDir },
}));

describe("proactive state durable intent compatibility", () => {
  beforeEach(() => {
    mocks.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cta-proactive-state-"));
  });

  afterEach(() => {
    fs.rmSync(mocks.userDataDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("loads legacy state with no pending intent or sequence", async () => {
    const { loadProactiveState } = await import("./proactive-state-store");
    fs.writeFileSync(path.join(mocks.userDataDir, "proactive-state.json"), JSON.stringify({ proactiveEpoch: 4 }), "utf8");
    const state = loadProactiveState();
    expect(state.proactiveEpoch).toBe(4);
    expect(state.pendingCommitIntent).toBeUndefined();
    expect(state.proactiveCommitSequence).toBeUndefined();
  });

  it("preserves a valid pending intent and rejects malformed durable intent", async () => {
    const { loadProactiveState } = await import("./proactive-state-store");
    fs.writeFileSync(path.join(mocks.userDataDir, "proactive-state.json"), JSON.stringify({
      proactiveCommitSequence: 3,
      pendingCommitIntent: {
        intentId: "proactive-intent-3",
        sequence: 3,
        candidate: { sceneId: "work_break", score: 90, sceneCooldownMs: 0 },
        generationEpoch: 2,
        intentAt: 123,
        text: "固定文本",
        source: "model",
      },
    }), "utf8");
    expect(loadProactiveState().pendingCommitIntent).toMatchObject({ intentId: "proactive-intent-3", text: "固定文本" });

    fs.writeFileSync(path.join(mocks.userDataDir, "proactive-state.json"), JSON.stringify({
      pendingCommitIntent: { intentId: "bad", sequence: 0, text: "" },
    }), "utf8");
    expect(loadProactiveState().pendingCommitIntent).toBeUndefined();
  });

  it("keeps atomic state write failures observable", async () => {
    const { defaultProactiveState, saveProactiveState, loadProactiveState } = await import("./proactive-state-store");
    const state = defaultProactiveState();
    state.proactiveEpoch = 9;

    const originalUserDataDir = mocks.userDataDir;
    mocks.userDataDir = path.join(originalUserDataDir, "missing-parent");
    expect(() => saveProactiveState(state)).toThrow();
    mocks.userDataDir = originalUserDataDir;

    fs.mkdirSync(path.join(originalUserDataDir, "proactive-state.json"));
    expect(() => saveProactiveState(state)).toThrow();
    fs.rmSync(path.join(originalUserDataDir, "proactive-state.json"), { recursive: true, force: true });

    saveProactiveState(state);
    expect(loadProactiveState().proactiveEpoch).toBe(9);
    expect(fs.existsSync(path.join(mocks.userDataDir, `proactive-state.json.${process.pid}.tmp`))).toBe(false);
  });
});
