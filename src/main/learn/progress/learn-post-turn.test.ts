import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { obsidianWorkspace } from "../obsidian/obsidian-workspace-service";
import { ensureProgressFile } from "./learn-progress-service";
import { runLearnPostTurnHook, type LearnPostTurnDeps } from "./learn-post-turn";

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock("./learn-progress-extractor", () => ({ extractProgress: mocks.extract }));

it("keeps delayed progress writes in the source vault after the global binding changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-learn-progress-"));
  const a = path.join(root, "A"), b = path.join(root, "B");
  await fs.mkdir(a); await fs.mkdir(b);
  let release!: () => void;
  let entered!: () => void;
  const extracting = new Promise<void>(resolve => { entered = resolve; });
  mocks.extract.mockImplementation(async () => {
    entered();
    await new Promise<void>(resolve => { release = resolve; });
    return { hasMeaningfulChange: true, topic: "SOURCE_A", masteryDelta: 10 };
  });
  try {
    obsidianWorkspace.configure({ enabled: true, vaultPath: b });
    await ensureProgressFile();
    const beforeB = await fs.readFile(path.join(b, "learn/progress.md"), "utf8");
    obsidianWorkspace.configure({ enabled: true, vaultPath: a });
    await runLearnPostTurnHook({ workspaceRoot: a, assistantMessage: "lesson".repeat(20) } as LearnPostTurnDeps);
    await extracting;
    obsidianWorkspace.configure({ enabled: true, vaultPath: b });
    release();
    await expect.poll(() => fs.readFile(path.join(a, "learn/progress.md"), "utf8")).toContain("SOURCE_A");
    expect(await fs.readFile(path.join(b, "learn/progress.md"), "utf8")).toBe(beforeB);
  } finally {
    release?.();
    obsidianWorkspace.configure({ enabled: false, vaultPath: "" });
    await fs.rm(root, { recursive: true, force: true });
  }
});
