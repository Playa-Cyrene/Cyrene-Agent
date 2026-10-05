import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGeneratedImageStore, persistGeneratedImages } from "./generated-image-store";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function image(id = "image-1", bytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("image-data")])) {
  return { id, toolCallId: `call-${id}`, base64: bytes.toString("base64"), mime: "image/png" as const };
}

describe("generated image store", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "cyrene-generated-images-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("saves a PNG and returns a stable completed attachment", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const source = image();

    const attachment = await store.save({ conversationId: "conversation-1", image: source });

    expect(attachment).toMatchObject({
      id: source.id,
      kind: "image",
      mime: "image/png",
      source: "model",
      status: "done",
      byteLength: Buffer.from(source.base64, "base64").byteLength,
    });
    expect(await readFile(attachment.filePath)).toEqual(Buffer.from(source.base64, "base64"));
  });

  it("returns the same reference when the same image is saved twice", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const input = { conversationId: "conversation-1", image: image() };

    const first = await store.save(input);
    const second = await store.save(input);

    expect(second).toEqual(first);
  });

  it("rejects concurrent saves that reuse an image id with different bytes", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const firstBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("first")]);
    const secondBytes = Buffer.concat([PNG_SIGNATURE, Buffer.from("second")]);

    const results = await Promise.allSettled([
      store.save({ conversationId: "conversation-1", image: image("same-id", firstBytes) }),
      store.save({ conversationId: "conversation-1", image: image("same-id", secondBytes) }),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("persists outputs independently and reports failures without leaking encoded data", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const result = await persistGeneratedImages(store, "conversation-1", [
      image("saved"),
      { ...image("invalid"), base64: "invalid" },
    ]);

    expect(result.attachments).toHaveLength(1);
    expect(result.failedCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("base64");
  });

  it("only reads a regular PNG inside its managed root", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const attachment = await store.save({ conversationId: "conversation-1", image: image() });

    expect(await store.readManagedPng(attachment.filePath)).toEqual(Buffer.concat([PNG_SIGNATURE, Buffer.from("image-data")]));
    await expect(store.readManagedPng(path.join(root, "outside.png"))).rejects.toThrow();
  });

  it.each([
    ["invalid base64", { ...image(), base64: "not base64!" }],
    ["non-PNG data", image("jpeg", Buffer.from("not a PNG"))],
    ["oversized data", image("large", Buffer.concat([PNG_SIGNATURE, Buffer.alloc(MAX_IMAGE_BYTES - PNG_SIGNATURE.length + 1)]))],
  ])("rejects %s", async (_label, invalidImage) => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });

    await expect(store.save({ conversationId: "conversation-1", image: invalidImage })).rejects.toThrow();
  });

  it("does not return a completed reference when file creation fails", async () => {
    const rootDirectory = path.join(root, "generated-images");
    await writeFile(rootDirectory, "blocks directory creation");
    const store = createGeneratedImageStore({ rootDirectory });

    await expect(store.save({ conversationId: "conversation-1", image: image() })).rejects.toThrow();
  });

  it("deletes only the generated files for the requested conversation", async () => {
    const store = createGeneratedImageStore({ rootDirectory: path.join(root, "generated-images") });
    const first = await store.save({ conversationId: "conversation-1", image: image("first") });
    const second = await store.save({ conversationId: "conversation-2", image: image("second") });

    await store.deleteConversation("conversation-1");

    await expect(readFile(first.filePath)).rejects.toThrow();
    expect(await readFile(second.filePath)).toEqual(Buffer.concat([PNG_SIGNATURE, Buffer.from("image-data")]));
  });
});
