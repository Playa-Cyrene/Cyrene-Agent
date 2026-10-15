import { closeConversationDatabases } from "../storage/conversation-database-client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runHarness, permissionCheck, getById } = vi.hoisted(() => ({
  runHarness: vi.fn(),
  permissionCheck: vi.fn(),
  getById: vi.fn(),
}));

vi.mock("./harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness")>();
  return { ...actual, runCyreneHarness: runHarness };
});

vi.mock("./tools/registry/tool-registry", () => ({
  toolRegistry: {
    getEnabledTools: vi.fn(() => []),
    getById,
  },
}));

vi.mock("../permission", () => ({
  checkPermission: permissionCheck,
}));

vi.mock("../prompts/prompt-loader", () => ({
  loadPromptFile: vi.fn(() => "runtime policy"),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn() },
}));

import { runHarnessWithAdapter } from "./harness-adapter";
import type { HarnessInput } from "./harness";
import { app } from "electron";

let userDataRoot: string;

describe("runHarnessWithAdapter cancellation context", () => {
  beforeEach(() => {
    userDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-adapter-cancel-"));
    vi.mocked(app.getPath).mockReturnValue(userDataRoot);
    runHarness.mockReset();
    permissionCheck.mockReset();
    getById.mockReset();
    runHarness.mockResolvedValue({
      finalAnswer: "done",
      finalState: { todoItems: [], uncertainEffects: [] },
      terminated: true,
      rounds: 1,
    });
  });

  afterEach(async () => {
    await closeConversationDatabases();
    fs.rmSync(userDataRoot, { recursive: true, force: true });
  });

  it("threads the same run signal into tools, permission, and clarification", async () => {
    const signal = new AbortController().signal;
    const clarify = vi.fn(async () => ({ answers: [] }));
    getById.mockReturnValue({
      id: "read_file",
      name: "Read File",
      description: "reads a file",
      risk: "safe",
    });
    permissionCheck.mockResolvedValue({ allowed: true });

    await runHarnessWithAdapter({
      runId: "run-signal",
      settings: {
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "hi" }],
      timeoutMs: 60_000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      requestUserClarification: clarify,
    } as never, signal, vi.fn());

    const input = runHarness.mock.calls[0]?.[0] as HarnessInput;
    expect(input.signal).toBe(signal);
    expect(input.toolContext?.signal).toBe(signal);

    await input.checkPermission?.("read_file", { path: "x" });
    expect(permissionCheck).toHaveBeenCalledWith(expect.objectContaining({
      runId: "run-signal",
      signal,
    }));

    await input.requestUserClarification?.({ question: "continue?" });
    expect(clarify).toHaveBeenCalledWith({ question: "continue?" }, signal);
  });

  it("passes the mobile non-interactive policy and allows tools without approval", async () => {
    getById.mockReturnValue({
      id: "write_file",
      name: "Write File",
      description: "writes a file",
      risk: "dangerous",
    });

    await runHarnessWithAdapter({
      runId: "run-mobile-all",
      settings: {
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        contextWindowTokens: 256_000,
      },
      messages: [{ role: "user", content: "写文件" }],
      timeoutMs: 60_000,
      toolSystemContent: "",
      soulSystemBaseContent: "",
      executionMode: "work",
      harnessInteractiveTools: false,
      permissionMode: "allow_all",
    } as never, new AbortController().signal, vi.fn());

    const input = runHarness.mock.calls[0]?.[0] as HarnessInput;
    expect(input.includeInteractiveTools).toBe(false);
    expect(input.toolContext?.permissionMode).toBe("allow_all");
    await expect(input.checkPermission?.("write_file", { path: "x" })).resolves.toBe(true);
    expect(permissionCheck).not.toHaveBeenCalled();
  });
});
