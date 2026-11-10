import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeExternalContentManifest } from "./external-content-manifest.mjs";

test("build manifest hashes nested shipped content deterministically and stays unchanged after edits", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "cyrene-content-build-"));
  try {
    mkdirSync(path.join(root, "prompts"));
    mkdirSync(path.join(root, "skills", "nested"), { recursive: true });
    writeFileSync(path.join(root, "prompts", "soul.md"), "original prompt");
    writeFileSync(path.join(root, "skills", "nested", "SKILL.md"), "original skill");
    const output = path.join(root, "dist", "main", "main", "shipped-external-content-manifest.json");
    const hash = (value) => createHash("sha1").update(value).digest("hex");
    const expected = { formatVersion: 2, source: "build", prompts: { "soul.md": hash("original prompt") }, skills: { "nested/SKILL.md": hash("original skill") } };
    assert.deepEqual(writeExternalContentManifest(root, output), expected);
    const first = readFileSync(output, "utf8");
    writeExternalContentManifest(root, output);
    assert.equal(readFileSync(output, "utf8"), first);
    writeFileSync(path.join(root, "prompts", "soul.md"), "user edit after install");
    assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), expected);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
