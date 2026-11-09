import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 实际 stdio 协议及目录边界冒烟，既可测独立构建，也可用已打包的 Electron 运行。 */
export async function verifyFilesystemMcp({ entry, executable = process.execPath }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "cyrene-filesystem-mcp-"));
  const allowed = path.join(temp, "allowed");
  await mkdir(allowed);
  const marker = "cyrene-filesystem-mcp-smoke";
  await writeFile(path.join(allowed, "fixture.txt"), marker);
  await writeFile(path.join(temp, "outside.txt"), "must not be readable");
  let child;
  let closed;
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
    delete env.NODE_PATH;
    child = spawn(executable, [path.resolve(entry), allowed], {
      cwd: temp, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    closed = new Promise((resolve) => child.once("close", resolve));
    return await new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      let toolCount = 0;
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        error ? reject(error) : resolve({ toolCount, allowedRead: true, outsideReadDenied: true });
      };
      const timeout = setTimeout(() => finish(new Error(`Filesystem MCP timed out: ${stderr}`)), 15_000);
      const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
      child.on("error", finish);
      child.stdin.on("error", finish);
      child.on("close", (code) => finish(new Error(`Filesystem MCP exited (${code}): ${stderr}`)));
      child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-16_384); });
      child.stdout.on("data", (chunk) => {
        buffer += chunk;
        try {
          let newline;
          while ((newline = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newline);
            buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const message = JSON.parse(line);
            if (!message.id) continue;
            assert.equal(message.error, undefined, JSON.stringify(message.error));
            if (message.id === 1) {
              assert.ok(message.result?.serverInfo, "initialize must return serverInfo");
              send({ method: "notifications/initialized" });
              send({ id: 2, method: "tools/list", params: {} });
            } else if (message.id === 2) {
              assert.ok(message.result.tools.some((tool) => tool.name === "read_text_file"));
              toolCount = message.result.tools.length;
              send({ id: 3, method: "tools/call", params: { name: "read_text_file", arguments: { path: path.join(allowed, "fixture.txt") } } });
            } else if (message.id === 3) {
              assert.ok(!message.result.isError, JSON.stringify(message.result));
              assert.ok(message.result.content.some((content) => content.text?.includes(marker)));
              send({ id: 4, method: "tools/call", params: { name: "read_text_file", arguments: { path: path.join(temp, "outside.txt") } } });
            } else if (message.id === 4) {
              assert.equal(message.result.isError, true, "outside read must be rejected");
              assert.ok(!message.result.content.some((content) => content.text?.includes("must not be readable")));
              finish();
            }
          }
        } catch (error) { finish(error); }
      });
      send({ id: 1, method: "initialize", params: {
        protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "cyrene-packaging-check", version: "1" },
      } });
    });
  } finally {
    if (child) {
      child.stdin.end();
      if (child.exitCode === null) child.kill();
      await closed;
    }
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await verifyFilesystemMcp({
    entry: process.argv[2] ?? "dist/main/main/filesystem-mcp.mjs",
    executable: process.argv[3] ?? process.execPath,
  }));
}
