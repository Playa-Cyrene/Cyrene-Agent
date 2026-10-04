"use strict";

/**
 * 生图回归：ChatGPT Responses、Grok Imagine、本地媒体 URL/缓存/路径隔离。
 * 运行：node examples/subscription-oauth/test/image-generation-verify.cjs
 */
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  GROK_IMAGE_MODEL,
  GROK_IMAGE_UPSTREAM,
  IMAGE_ORCHESTRATOR_MODEL,
  createImageMediaStore,
  generateImageViaChatGpt,
  generateImageViaGrok,
} = require("../lib/image-generation.cjs");
const { createProxy } = require("../lib/proxy.cjs");

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const JPEG_PREVIEW = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0xff, 0xd9]);

function get(port, pathname, method = "GET") {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on("error", reject);
    request.end();
  });
}

(async () => {
  let capturedRequest = null;
  const fetchImpl = async (url, init) => {
    capturedRequest = { url: String(url), init };
    const event = {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        type: "image_generation_call",
        status: "completed",
        result: PNG_1X1.toString("base64"),
      },
    };
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 19));
        controller.enqueue(bytes.slice(19, 67));
        controller.enqueue(bytes.slice(67));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };

  const generated = await generateImageViaChatGpt({
    tokens: { accessToken: "secret-token", accountId: "account-1" },
    prompt: "一只在月光下看书的白猫",
    size: "1536x1024",
    quality: "high",
    background: "transparent",
    fetchImpl,
  });
  assert.deepStrictEqual(generated.buffer, PNG_1X1, "应从任意分块 SSE 中取出并解码图片");
  assert.ok(capturedRequest.url.includes("chatgpt.com/backend-api/codex/responses"));
  assert.strictEqual(capturedRequest.init.headers.authorization, "Bearer secret-token");
  assert.strictEqual(capturedRequest.init.headers["chatgpt-account-id"], "account-1");
  const requestBody = JSON.parse(capturedRequest.init.body);
  assert.strictEqual(requestBody.model, IMAGE_ORCHESTRATOR_MODEL);
  assert.ok(requestBody.instructions.includes("image generation tool"));
  assert.strictEqual(requestBody.store, false);
  assert.strictEqual(requestBody.stream, true);
  assert.deepStrictEqual(requestBody.tool_choice, { type: "image_generation" });
  assert.strictEqual(requestBody.tools[0].type, "image_generation");
  assert.strictEqual(requestBody.tools[0].output_format, "png");
  assert.strictEqual(requestBody.tools[0].background, "transparent");
  assert.ok(!capturedRequest.init.body.includes("secret-token"), "token 不得进入请求体");
  console.log("  ok - OAuth Responses 生图请求及 SSE 解码");

  let capturedGrokRequest = null;
  const grokGenerated = await generateImageViaGrok({
    tokens: { accessToken: "grok-secret-token" },
    prompt: "粉色云海上飞行的鲸鱼",
    aspectRatio: "16:9",
    fetchImpl: async (url, init) => {
      capturedGrokRequest = { url: String(url), init };
      return new Response(JSON.stringify({
        data: [{ b64_json: PNG_1X1.toString("base64") }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  assert.deepStrictEqual(grokGenerated.buffer, PNG_1X1, "应解码 Grok b64_json 图片");
  assert.strictEqual(grokGenerated.provider, "grok");
  assert.strictEqual(grokGenerated.aspectRatio, "16:9");
  assert.strictEqual(capturedGrokRequest.url, GROK_IMAGE_UPSTREAM);
  assert.strictEqual(capturedGrokRequest.init.headers.authorization, "Bearer grok-secret-token");
  assert.strictEqual(capturedGrokRequest.init.headers["x-xai-token-auth"], "xai-grok-cli");
  assert.match(capturedGrokRequest.init.headers["x-grok-session-id"], /^[0-9a-f-]{36}$/i);
  const grokBody = JSON.parse(capturedGrokRequest.init.body);
  assert.deepStrictEqual(grokBody, {
    model: GROK_IMAGE_MODEL,
    prompt: "粉色云海上飞行的鲸鱼",
    n: 1,
    aspect_ratio: "16:9",
    resolution: "1k",
    response_format: "b64_json",
  });
  assert.ok(!capturedGrokRequest.init.body.includes("grok-secret-token"), "Grok token 不得进入请求体");
  console.log("  ok - Grok Build Imagine OAuth 请求及 Base64 解码");

  const grokFetchCalls = [];
  const grokUrlGenerated = await generateImageViaGrok({
    tokens: { accessToken: "grok-secret-token" },
    prompt: "临时链接回退",
    fetchImpl: async (url, init) => {
      grokFetchCalls.push({ url: String(url), init });
      if (String(url) === GROK_IMAGE_UPSTREAM) {
        return new Response(JSON.stringify({ data: [{ url: "https://imgen.x.ai/result.jpg" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JPEG_PREVIEW, {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      });
    },
  });
  assert.deepStrictEqual(grokUrlGenerated.buffer, JPEG_PREVIEW);
  assert.strictEqual(grokFetchCalls.length, 2);
  assert.strictEqual(grokFetchCalls[1].url, "https://imgen.x.ai/result.jpg");
  assert.strictEqual(grokFetchCalls[1].init.redirect, "manual", "临时 URL 重定向必须逐跳校验");
  assert.ok(!grokFetchCalls[1].init.headers.authorization, "临时图片 URL 不得携带 OAuth token");

  await assert.rejects(
    generateImageViaGrok({
      tokens: { accessToken: "grok-secret-token" },
      prompt: "不可信链接",
      fetchImpl: async () => new Response(JSON.stringify({
        data: [{ url: "https://evil.example/steal.jpg" }],
      }), { status: 200 }),
    }),
    /不受信任的图片链接/,
  );
  await assert.rejects(
    generateImageViaGrok({
      tokens: { accessToken: "grok-secret-token" },
      prompt: "套餐限制",
      fetchImpl: async () => new Response(JSON.stringify({
        error: { message: "Image generation is not available on the X Basic tier" },
      }), { status: 403 }),
    }),
    /SuperGrok/,
  );
  console.log("  ok - Grok 临时 URL 白名单、无凭据下载与套餐错误提示");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "subscription-oauth-image-test-"));
  let port = 0;
  let previewCalls = 0;
  const mediaStore = createImageMediaStore({
    rootDir: tempRoot,
    getPort: () => port,
    createPreview: async () => {
      previewCalls += 1;
      return { buffer: JPEG_PREVIEW, extension: "jpg", mime: "image/jpeg", width: 640, height: 640 };
    },
  });
  const proxy = createProxy({
    getTokens: async () => null,
    mediaStore,
  });

  try {
    port = await proxy.start(0);
    const saved = await mediaStore.save(generated.buffer, { background: "transparent" });
    assert.strictEqual(previewCalls, 1);
    assert.ok(saved.previewUrl.startsWith(`http://127.0.0.1:${port}/media/`));
    assert.ok(saved.previewUrl.endsWith("/preview.jpg"));
    assert.ok(saved.originalUrl.endsWith("/original.png"));
    assert.ok(!saved.previewUrl.includes(tempRoot), "URL 不得暴露插件磁盘目录");
    assert.ok(!saved.previewUrl.includes(PNG_1X1.toString("base64").slice(0, 12)), "URL 不得包含 Base64");

    const previewUrl = new URL(saved.previewUrl);
    const previewResponse = await get(port, previewUrl.pathname);
    assert.strictEqual(previewResponse.status, 200);
    assert.strictEqual(previewResponse.headers["content-type"], "image/jpeg");
    assert.strictEqual(previewResponse.headers["x-content-type-options"], "nosniff");
    assert.ok(String(previewResponse.headers["cache-control"]).includes("immutable"));
    assert.deepStrictEqual(previewResponse.body, JPEG_PREVIEW);

    const originalResponse = await get(port, new URL(saved.originalUrl).pathname);
    assert.strictEqual(originalResponse.status, 200);
    assert.strictEqual(originalResponse.headers["content-type"], "image/png");
    assert.deepStrictEqual(originalResponse.body, PNG_1X1);

    const headResponse = await get(port, previewUrl.pathname, "HEAD");
    assert.strictEqual(headResponse.status, 200);
    assert.strictEqual(headResponse.body.length, 0);

    const traversal = await get(port, "/media/not-a-uuid/original.png");
    assert.strictEqual(traversal.status, 404);
    const mutation = await get(port, previewUrl.pathname, "POST");
    assert.strictEqual(mutation.status, 405);
    console.log("  ok - 私有落盘、轻量 URL、只读媒体服务与安全缓存头");
  } finally {
    await proxy.stop();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log("\n生图回归断言全部通过 ✓");
})().catch((error) => {
  console.error("IMAGE-GENERATION 失败:", error);
  process.exit(1);
});
