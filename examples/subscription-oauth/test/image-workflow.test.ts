import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
const require = createRequire(import.meta.url);
const { createImageWorkflow } = require("../lib/image-workflow.cjs");
const { createImageMediaStore, generateImageViaChatGpt, generateImageViaGrok, normalizeReferenceImages, GROK_IMAGE_EDIT_UPSTREAM } = require("../lib/image-generation.cjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4VQAAAAASUVORK5CYII=", "base64");
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
function fixture(preview?: () => Promise<unknown>, prepareReferences?: (...args: unknown[]) => Promise<string[]>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-image-workflow-test-")); roots.push(root);
  const mediaStore = createImageMediaStore({ rootDir: root, getPort: () => 6231, createPreview: preview ?? (async () => ({ buffer: png })) });
  let clock = Date.now();
  const workflow = createImageWorkflow({ rootDir: root, mediaStore, now: () => clock, prepareReferences });
  const generate = vi.fn(async (_input: { prompt: string; referenceImages: string[]; onProgress?: (message: string) => void }) => ({ buffer: png, background: "opaque" }));
  const context = { conversationId: "conversation-a", userMessageId: "message-a", runId: "run-a", userQuery: "画一张角色图", reportProgress: vi.fn(), storeGeneratedImage: vi.fn(async (image) => ({ kind: "cyrene.generated-image", id: image.id })) };
  const deps = { providerId: "chatgpt", providerName: "ChatGPT", generate };
  return { root, mediaStore, workflow, generate, context, deps, advance: (ms: number) => { clock += ms; } };
}
const args = { prompt: "A reference portrait" };
describe("subscription image workflow", () => {
  it("reuses one committed image across a new run and an LLM-rewritten prompt", async () => {
    const f = fixture();
    const first = JSON.parse(await f.workflow.execute(args, f.context, f.deps));
    const second = JSON.parse(await f.workflow.execute({ prompt: "rewritten prompt" }, { ...f.context, runId: "retry-run" }, f.deps));
    expect(second).toEqual({ ...first, reused: true });
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.context.reportProgress.mock.calls.flat().join(" ")).toContain("没有再次请求生图");
  });
  it("allows the same prompt in a genuinely new user action", async () => {
    const f = fixture();
    await f.workflow.execute(args, f.context, f.deps);
    await f.workflow.execute(args, { ...f.context, userMessageId: "message-b" }, f.deps);
    expect(f.generate).toHaveBeenCalledTimes(2);
  });
  it("coalesces simultaneous duplicate invocations", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([f.workflow.execute(args, f.context, f.deps), f.workflow.execute(args, f.context, f.deps)]);
    expect(a).toBe(b);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("recovers after UI publication fails without another upstream request", async () => {
    const f = fixture();
    f.context.storeGeneratedImage.mockRejectedValueOnce(new Error("UI publication failed"));
    await expect(f.workflow.execute(args, f.context, f.deps)).rejects.toThrow("UI publication");
    const fresh = createImageWorkflow({ rootDir: f.root, mediaStore: f.mediaStore });
    expect(JSON.parse(await fresh.execute(args, f.context, f.deps)).reused).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("keeps an original if preview encoding fails, then rebuilds just the preview", async () => {
    const preview = vi.fn().mockRejectedValueOnce(new Error("preview failed")).mockResolvedValue({ buffer: png });
    const f = fixture(preview);
    await expect(f.workflow.execute(args, f.context, f.deps)).rejects.toThrow("preview failed");
    expect(JSON.parse(await f.workflow.execute(args, f.context, f.deps)).reused).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(preview).toHaveBeenCalledTimes(2);
  });
  it("recovers an original committed just before a missing metadata write", async () => {
    const f = fixture();
    const image = JSON.parse(await f.workflow.execute(args, f.context, f.deps));
    fs.unlinkSync(path.join(f.root, "generated-images", "records", `${image.id}.json`));
    expect(JSON.parse(await f.workflow.execute(args, f.context, f.deps)).id).toBe(image.id);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("whitelists host descriptors and does not leak private disk errors", async () => {
    const f = fixture();
    f.context.storeGeneratedImage.mockImplementationOnce(async (image) => ({ kind: "cyrene.generated-image", id: image.id, filePath: f.root }));
    expect(await f.workflow.execute(args, f.context, f.deps)).not.toContain(f.root);
    f.context.storeGeneratedImage.mockRejectedValueOnce(Object.assign(new Error(`permission denied: ${f.root}`), { code: "EACCES" }));
    await expect(f.workflow.execute(args, f.context, f.deps)).rejects.toThrow("本地图片数据读写失败");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("does not blindly resubmit after an uncertain network failure", async () => {
    const f = fixture();
    f.generate.mockRejectedValueOnce(new Error("network timeout"));
    await expect(f.workflow.execute(args, f.context, f.deps)).rejects.toThrow("network timeout");
    await expect(f.workflow.execute(args, { ...f.context, runId: "retry" }, f.deps)).rejects.toThrow("未自动重试");
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("does not start generation after cancellation", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.workflow.execute(args, { ...f.context, signal: controller.signal }, f.deps)).rejects.toThrow("取消");
    expect(f.generate).not.toHaveBeenCalled();
  });
  it("does not journal a generation until reference download succeeds, and permits corrected references", async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new Error("参考图下载超时")).mockResolvedValue([`data:image/png;base64,${png.toString("base64")}`]);
    const f = fixture(undefined, prepare);
    await expect(f.workflow.execute({ ...args, reference_urls: ["https://official.test/bad.png"] }, f.context, f.deps)).rejects.toThrow("下载超时");
    expect(f.generate).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.root, "image-jobs"))).toBe(false);
    await f.workflow.execute({ ...args, reference_urls: ["https://official.test/good.png"] }, f.context, f.deps);
    expect(f.generate.mock.calls[0][0].referenceImages).toEqual([`data:image/png;base64,${png.toString("base64")}`]);
    expect(f.generate).toHaveBeenCalledTimes(1);
    await f.workflow.execute(args, { ...f.context, runId: "retry" }, f.deps);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });
  it("isolates reference cache by conversation, subject/version, and age", () => {
    const f = fixture();
    f.workflow.resolveReferences({ subject: "Character / official outfit", visual_description: "Pink hair, blue eyes", reference_urls: ["https://official.test/character.png"], source_urls: ["https://official.test/character"] }, f.context);
    expect(f.workflow.referencePrompt("conversation-a")).toContain("Pink hair");
    expect(f.workflow.referencePrompt("conversation-b")).toBe("");
    expect(f.workflow.resolveReferences({ subject: "Character / official outfit" }, f.context).references).toHaveLength(1);
    expect(f.workflow.resolveReferences({ subject: "Character / alternate outfit" }, f.context).references).toHaveLength(0);
    expect(f.workflow.resolveReferences({ subject: "Character / official outfit", refresh_references: true }, f.context).references).toHaveLength(0);
    f.advance(8 * 24 * 60 * 60_000);
    expect(f.workflow.referencePrompt("conversation-a")).toBe("");
  });
  it("prioritizes current user attachments over retrieved images", () => {
    const f = fixture(); const url = `data:image/png;base64,${png.toString("base64")}`;
    expect(f.workflow.resolveReferences({ reference_urls: ["https://official.test/ref.png"] }, { ...f.context, inputImages: [{ url }] }).references).toEqual([url]);
    expect(() => normalizeReferenceImages(["https://127.0.0.1/private.png"])).toThrow("公网");
    expect(() => normalizeReferenceImages(["https://user:password@public.test/a.png"])).toThrow("公网");
    expect(() => normalizeReferenceImages(["file:///C:/secret.png"])).toThrow("公网");
  });
  it("keeps Markdown compatibility when the host lacks image storage", async () => {
    const f = fixture(); const { storeGeneratedImage: _unused, ...legacy } = f.context;
    const output = await f.workflow.execute(args, legacy, f.deps);
    expect(output).toContain("![生成图片](http://127.0.0.1:6231/media/");
    expect(output).not.toContain(png.toString("base64"));
    expect(output).not.toContain(f.root);
  });
});

describe("provider reference-image wire format", () => {
  it("sends real input_image blocks to ChatGPT, with no extra partial-image cost", async () => {
    const referenceDownload = vi.fn(async () => png);
    const fetchImpl = vi.fn(async () => new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: png.toString("base64") } })}\n\n`, { status: 200 }));
    await generateImageViaChatGpt({ tokens: { accessToken: "test-token" }, prompt: "draw", referenceImages: ["https://official.test/ref.png"], referenceDownload, fetchImpl });
    const body = JSON.parse((fetchImpl.mock.calls as unknown as Array<[string, { body: string }]>)[0][1].body);
    expect(body.input[0].content[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${png.toString("base64")}` });
    expect(referenceDownload).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(body.tools[0]).not.toHaveProperty("partial_images");
  });
  it("uses Grok's JSON edits request and never silently drops unsupported references", async () => {
    const fetchImpl = vi.fn(async () => new Response("unsupported image input", { status: 404 }));
    await expect(generateImageViaGrok({ tokens: { accessToken: "test-token" }, prompt: "draw", referenceImages: ["https://official.test/ref.png"], referenceDownload: async () => png, fetchImpl })).rejects.toThrow("未丢弃参考图");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl.mock.calls as unknown as Array<[string, { body: string }]>)[0];
    expect(call[0]).toBe(GROK_IMAGE_EDIT_UPSTREAM);
    expect(JSON.parse(call[1].body).image).toEqual({ url: `data:image/png;base64,${png.toString("base64")}`, type: "image_url" });
  });
  it.each([generateImageViaChatGpt, generateImageViaGrok])("does not send an upstream request when reference preparation fails", async (generate) => {
    const fetchImpl = vi.fn();
    await expect(generate({ tokens: { accessToken: "test-token" }, prompt: "draw", referenceImages: ["https://official.test/ref.png"], referenceDownload: async () => { throw new Error("参考图下载失败"); }, fetchImpl })).rejects.toMatchObject({ generationNotStarted: true });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
