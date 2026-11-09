import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeReadToolResult } from "./read-tool-result";
import { FileToolOutputStore } from "./file-tool-output-store";

const roots: string[] = [];

async function setup(output = "AAA😀BBB昔涟CCC", toolName = "search_code") {
  const root = await mkdtemp(path.join(tmpdir(), "cyrene-read-output-"));
  roots.push(root);
  const store = new FileToolOutputStore(root);
  const ref = await store.put({
    conversationId: "conversation-a", runId: "run-a", toolCallId: "call-a",
    toolName, outcome: "success", output, truncatedForModel: false,
  });
  return { store, ref };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("read_tool_result", () => {
  it.each([{}, { query: "private" }])("isolates saved desktop browser results from a bound channel (%j)", async (args) => {
    const { store, ref } = await setup("private page", "browser_get_page_elements");
    const context = { userQuery: "", conversationId: "conversation-a", runId: "run-b" };
    const call = { id: "read-1", name: "read_tool_result", arguments: JSON.stringify({ result_ref: ref.resultRef, ...args }) };
    const desktop = await executeReadToolResult(call, store, context);
    expect(desktop).toMatchObject({ outcome: "success", output: expect.stringContaining("private page") });
    const channel = await executeReadToolResult(call, store, { ...context, channelRun: true });
    expect(channel).toMatchObject({ outcome: "failure", category: "not_found" });

    const { store: otherStore, ref: otherRef } = await setup("private notes");
    const ordinaryCall = { ...call, arguments: JSON.stringify({ result_ref: otherRef.resultRef, ...args }) };
    const ordinary = await executeReadToolResult(ordinaryCall, otherStore, { ...context, channelRun: true });
    expect(ordinary).toMatchObject({ outcome: "success", output: expect.stringContaining("private notes") });
  });
  it("reads a bounded slice through an opaque result reference", async () => {
    const { store, ref } = await setup("0123456789");
    const result = await executeReadToolResult({ id: "read-1", name: "read_tool_result", arguments: JSON.stringify({
      result_ref: ref.resultRef, offset: 3, length: 4,
    }) }, store, { userQuery: "", conversationId: "conversation-a", runId: "run-a" });

    expect(result).toMatchObject({ outcome: "success", tool: "read_tool_result" });
    expect(JSON.parse(result.output ?? "{}")).toMatchObject({ content: "3456", offset: 3 });
  });

  it("resolves a current-run tool_call_id without exposing a path", async () => {
    const { store } = await setup("full result");
    const result = await executeReadToolResult({ id: "read-1", name: "read_tool_result", arguments: JSON.stringify({
      tool_call_id: "call-a", length: 20,
    }) }, store, { userQuery: "", conversationId: "conversation-a", runId: "run-a" });

    expect(JSON.parse(result.output ?? "{}")).toMatchObject({ content: "full result" });
    expect(result.message).not.toContain("cyrene-runs");
  });

  it("returns query offsets in the same code-point coordinate system as reading", async () => {
    const { store, ref } = await setup();
    const found = await executeReadToolResult({ id: "find-1", name: "read_tool_result", arguments: JSON.stringify({
      result_ref: ref.resultRef, query: "昔涟",
    }) }, store, { userQuery: "", conversationId: "conversation-a", runId: "run-a" });
    const offset = JSON.parse(found.output ?? "{}").matches[0].offset as number;
    const read = await executeReadToolResult({ id: "read-1", name: "read_tool_result", arguments: JSON.stringify({
      result_ref: ref.resultRef, offset, length: 2,
    }) }, store, { userQuery: "", conversationId: "conversation-a", runId: "run-a" });

    expect(JSON.parse(read.output ?? "{}").content).toBe("昔涟");
  });

  it("returns not_found for a ref from another conversation and rejects oversized reads", async () => {
    const { store, ref } = await setup();
    const isolated = await executeReadToolResult({ id: "read-1", name: "read_tool_result", arguments: JSON.stringify({
      result_ref: ref.resultRef,
    }) }, store, { userQuery: "", conversationId: "conversation-b", runId: "run-b" });
    const invalid = await executeReadToolResult({ id: "read-2", name: "read_tool_result", arguments: JSON.stringify({
      result_ref: ref.resultRef, length: 8_193,
    }) }, store, { userQuery: "", conversationId: "conversation-a", runId: "run-a" });

    expect(isolated).toMatchObject({ outcome: "failure", category: "not_found" });
    expect(invalid).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
  });
});
