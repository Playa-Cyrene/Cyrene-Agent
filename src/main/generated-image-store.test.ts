import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedImageStore } from "./generated-image-store";
import { generatedImageUrl, parseGeneratedImageResult } from "../shared/generated-image";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4VQAAAAASUVORK5CYII=", "base64");
const id = "bce7e272-0c22-4c45-975d-69c6c1db15c7";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function store() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-generated-test-")); roots.push(root); return { root, media: createGeneratedImageStore(root) }; }

describe("durable generated image storage", () => {
  it("stores raw bytes without paths or base64 in the result, and survives a new store instance", async () => {
    const { root, media } = store();
    const result = await media.save({ id, original: png, preview: png });
    expect(result).toEqual({ kind: "cyrene.generated-image", id });
    expect(createGeneratedImageStore(root).read(id, "original").bytes).toEqual(png);
    expect(generatedImageUrl(id, "preview")).toBe(`generated-image://${id}/preview`);
  });
  it("republishes identical bytes but rejects an id collision with different content", async () => {
    const { media } = store();
    await media.save({ id, original: png, preview: png });
    await expect(media.save({ id, original: png, preview: png })).resolves.toMatchObject({ id });
    await expect(media.save({ id, original: Buffer.concat([png, Buffer.from("different")]), preview: png })).rejects.toThrow("different bytes");
  });
  it("rejects traversal, oversized previews, and unsupported payloads", async () => {
    const { media } = store();
    expect(() => media.read("../original", "original")).toThrow();
    await expect(media.save({ id, original: png, preview: Buffer.alloc(513 * 1024) })).rejects.toThrow("size");
    await expect(media.save({ id, original: Buffer.from("<html>"), preview: png })).rejects.toThrow("format");
  });
  it("does not accept URL injection or arbitrary JSON as an image card", () => {
    expect(parseGeneratedImageResult('{"kind":"cyrene.generated-image","id":"../../secret"}')).toBeNull();
    expect(parseGeneratedImageResult("![pic](https://example.test/a.png)")).toBeNull();
    expect(parseGeneratedImageResult(JSON.stringify({ kind: "cyrene.generated-image", id, originalUrl: "https://evil.test", reused: true }))).toEqual({ kind: "cyrene.generated-image", id, reused: true });
    expect(parseGeneratedImageResult(JSON.stringify({ kind: "cyrene.generated-image", id: id.toUpperCase() }))?.id).toBe(id);
    expect(parseGeneratedImageResult({ kind: "cyrene.generated-image", id } as unknown as string)).toBeNull();
  });
});
