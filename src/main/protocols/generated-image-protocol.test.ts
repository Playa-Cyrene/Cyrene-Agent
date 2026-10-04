import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createGeneratedImageStore } from "../generated-image-store";
import { createGeneratedImageProtocol } from "./generated-image-protocol";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
describe("generated image protocol", () => {
  it("serves durable original/preview bytes and rejects paths, credentials, and non-image requests", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-protocol-test-")); roots.push(root);
    const id = "11111111-1111-4111-8111-111111111111";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4VQAAAAASUVORK5CYII=", "base64");
    await createGeneratedImageStore(root).save({ id, original: png, preview: png });
    const handler = createGeneratedImageProtocol(root);
    for (const variant of ["preview", "original"]) {
      const response = handler({ url: `generated-image://${id}/${variant}`, method: "GET" });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
      const head = handler({ url: `generated-image://${id}/${variant}`, method: "HEAD" });
      expect(head.headers.get("content-length")).toBe(String(png.length));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    }
    for (const url of [
      `generated-image://${id}/../../settings.json`, `generated-image://user:pass@${id}/original`,
      `generated-image://${id}/original?path=C:/secret`, `generated-image://${id}/original#ignored`,
      `generated-image://${id}/original.png`, `generated-image://${id}:123/original`, `https://${id}/original`,
    ]) expect(handler({ url, method: "GET" }).status).toBe(404);
    expect(handler({ url: `generated-image://${id}/original`, method: "POST" }).status).toBe(404);
  });
});
