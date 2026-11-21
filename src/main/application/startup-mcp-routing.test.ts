import { readFileSync } from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { IPC } from "../../shared/ipc-channels";

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

import { waitForStartupTask } from "./startup-cancellation";
import { performance } from "node:perf_hooks";
it("measures Work waiting for selected MCP while Chat can proceed without it", async () => {
  const from = source.indexOf("  async function waitForConversation(");
  const to = source.indexOf("\n  return {", from);
  const code = ts.transpileModule(source.slice(from, to) + "\nreturn waitForConversation;", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const ready = async () => {};
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  let discovered = false;
  const deps = {
    checkStartupActive: () => {}, shutdown: {}, readiness: { waitFor: ready },
    loadGeneralSettings: () => ({ toolModeOverrides: {}, chatToolsEnabled: false, momentsEnabled: false }),
    loadModelSettings: () => ({ memoryMode: "summary" }),
    shouldExposeSearchTool: () => true, vectorReady: ready, memoryReady: ready,
    skillsReady: ready, sandboxReady: ready, momentsReady: Promise.resolve(),
    toolRegistry: { getEnabledToolsForMode: () => [] },
    pluginManager: { waitForStartupTools: ready },
    waitForMcp: async (select: (id: string) => boolean) => { if (select("slow")) await slow; },
    PLAYWRIGHT_MCP_ID: "playwright", FILESYSTEM_MCP_ID: "filesystem", waitForStartupTask,
  };
  const wait = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const started = performance.now();
  let workReleased = false;
  const work = wait("work").then(() => { expect(discovered).toBe(true); workReleased = true; return performance.now() - started; });
  await wait("chat");
  const chatMs = performance.now() - started;
  expect(workReleased).toBe(false);
  await new Promise(resolve => setTimeout(resolve, 1500));
  discovered = true;
  release();
  const workMs = await work;
  const readyAt = performance.now();
  await wait("work");
  process.stdout.write("WORK_MCP_MEASUREMENT " + JSON.stringify({ chatUnselectedMs: chatMs, workSelectedMs: workMs, workAlreadyReadyMs: performance.now() - readyAt, injectedDiscoveryDelayMs: 1500 }) + "\n");
  expect(workMs).toBeGreaterThanOrEqual(1500);
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
