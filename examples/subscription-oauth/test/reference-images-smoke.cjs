"use strict";

// Real Electron runtime, fake provider responses, no OAuth credentials and no
// live generation requests. An optional public reference exercises the network.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { app, nativeImage } = require("electron");
const { prepareReferenceImages } = require("../lib/reference-images.cjs");
const { generateImageViaChatGpt, generateImageViaGrok } = require("../lib/image-generation.cjs");

app.whenReady().then(async () => {
  const argument = process.argv.find((value) => value.startsWith("--reference-url="));
  const icon = fs.readFileSync(path.join(__dirname, "..", "icon.png"));
  const reference = argument ? argument.slice("--reference-url=".length) : `data:image/png;base64,${icon.toString("base64")}`;
  const [prepared] = await prepareReferenceImages([reference]);
  const bytes = Buffer.from(prepared.split(",")[1], "base64");
  const image = nativeImage.createFromBuffer(bytes);
  assert.ok(!image.isEmpty(), "参考图应可被真实宿主解码");
  let calls = 0;
  const chatgpt = await generateImageViaChatGpt({
    tokens: { accessToken: "fake-test-token" }, prompt: "offline reference test", referenceImages: [prepared],
    fetchImpl: async (_url, init) => {
      calls++;
      const body = JSON.parse(init.body);
      assert.equal(body.input[0].content[1].image_url, prepared);
      return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: { type: "image_generation_call", result: icon.toString("base64") } })}\n\n`);
    },
  });
  const grok = await generateImageViaGrok({
    tokens: { accessToken: "fake-test-token" }, prompt: "offline reference test", referenceImages: [prepared],
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://cli-chat-proxy.grok.com/v1/images/edits");
      assert.equal(JSON.parse(init.body).image.url, prepared);
      return new Response(JSON.stringify({ data: [{ b64_json: icon.toString("base64") }] }));
    },
  });
  assert.deepEqual(chatgpt.buffer, icon);
  assert.deepEqual(grok.buffer, icon);
  assert.equal(calls, 2);
  console.log(JSON.stringify({ runtime: "Electron", referenceBytes: bytes.length, dimensions: image.getSize(), providerWireFormat: "ChatGPT/Grok inline image", liveGenerationRequests: 0 }));
  app.exit(0);
}).catch((error) => {
  console.error(error.message);
  app.exit(1);
});
