import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { waitForStartupTask } from "./startup-cancellation";

// Execute the production registration callback without starting Electron or a user profile.
const source = readFileSync(new URL("./default-dependencies.ts", import.meta.url), "utf8");
const start = source.indexOf("ipc: afterStartup(ipc, (channel, payload) => {", source.indexOf("registerMemoryUserToolIpc({"));
const callback = source.slice(start + "ipc: afterStartup(ipc, ".length, source.indexOf("}),", start) + 1);
function route(waitForMcp: (select: (id: string) => boolean) => Promise<void>) {
  const code = ts.transpileModule("return " + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("IPC", "waitForMcp", code)(IPC, waitForMcp) as (channel: string, payload?: unknown) => Promise<void> | void;
}
it("lists current servers and changes unrelated IDs while one restore is pending", async () => {
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const wait = vi.fn(async (select: (id: string) => boolean) => { if (select("slow")) await slow; });
  const ready = route(wait);
  expect(ready(IPC.MCP_LIST_SERVERS)).toBeUndefined();
  await ready(IPC.MCP_ADD_SERVER, { id: "new" });
  await ready(IPC.MCP_REMOVE_SERVER, "connected");
  let removed = false;
  const pending = Promise.resolve(ready(IPC.MCP_REMOVE_SERVER, "slow")).then(() => { removed = true; });
  await Promise.resolve();
  expect(removed).toBe(false);
  release();
  await pending;
  expect(removed).toBe(true);
});

it("lets Chat proceed while Work waits for the selected MCP", async () => {
  const from = source.indexOf("  async function waitForConversation(");
  const to = source.indexOf("\n  return {", from);
  const code = ts.transpileModule(source.slice(from, to) + "\nreturn waitForConversation;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ready = async () => {};
  const slow = Promise.withResolvers<void>();
  const waitForMcp = vi.fn(async (select: (id: string) => boolean) => {
    if (select("slow")) await slow.promise;
  });
  const deps = {
    checkStartupActive: () => {}, shutdown: {}, readiness: { waitFor: ready },
    loadGeneralSettings: () => ({ toolModeOverrides: {}, chatToolsEnabled: false, momentsEnabled: false }),
    loadModelSettings: () => ({ memoryMode: "summary" }),
    shouldExposeSearchTool: () => true, vectorReady: ready, memoryReady: ready,
    skillsReady: ready, sandboxReady: ready, momentsReady: Promise.resolve(),
    toolRegistry: { getEnabledToolsForMode: () => [] },
    pluginManager: { waitForStartupTools: ready },
    waitForMcp,
    PLAYWRIGHT_MCP_ID: "playwright", FILESYSTEM_MCP_ID: "filesystem", waitForStartupTask,
  };
  const wait = new Function(...Object.keys(deps), code)(...Object.values(deps));
  let workReleased = false;
  const work = wait("work").then(() => { workReleased = true; });
  try {
    await wait("chat");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(waitForMcp).toHaveBeenCalledOnce();
    expect(waitForMcp.mock.calls[0]![0]("slow")).toBe(true);
    expect(workReleased).toBe(false);
  } finally {
    slow.resolve();
    await work;
  }
  expect(workReleased).toBe(true);
});

it("search settings wait only for affected builtins", async () => {
  const from = source.indexOf("ipc: afterStartup(ipc, (channel, patch) => {");
  const callback = source.slice(from + "ipc: afterStartup(ipc, ".length, source.indexOf("}),", from) + 1);
  const wait = vi.fn(async (select: (id: string) => boolean) => {
    expect(select("unrelated-slow")).toBe(false);
    expect(select("minimax-web-search")).toBe(true);
    expect(select("playwright")).toBe(false);
  });
  const code = ts.transpileModule("return " + callback, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ready = new Function("IPC", "waitForMcp", "PLAYWRIGHT_MCP_ID", "FILESYSTEM_MCP_ID", code)(IPC, wait, "playwright", "filesystem");
  await ready(IPC.TTS_SAVE_SETTINGS, { searchEngine: "tavily" });
  await ready(IPC.SETTINGS_SAVE_GENERAL, { searchEngine: "disabled" });
  expect(wait).toHaveBeenCalledTimes(2);
});
