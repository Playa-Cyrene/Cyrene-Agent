"use strict";

/**
 * ChatGPT / Grok 订阅生图与本地媒体存储。
 *
 * 上游返回的图片是大段 Base64；这里在插件主进程内解码并保存，工具结果只
 * 返回随机图片 ID（旧宿主兼容短媒体 URL），不把 Base64 写入聊天记录。
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { authHeaders } = require("./vendor-http.cjs");
const { imageTypeOf, normalizeReferenceImages, prepareReferenceImages } = require("./reference-images.cjs");

const IMAGE_UPSTREAM = "https://chatgpt.com/backend-api/codex/responses";
const IMAGE_ORCHESTRATOR_MODEL = "gpt-5.6-luna";
const GROK_IMAGE_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/images/generations";
const GROK_IMAGE_EDIT_UPSTREAM = "https://cli-chat-proxy.grok.com/v1/images/edits";
const GROK_IMAGE_MODEL = "grok-imagine-image-quality";
const MAX_BASE64_CHARS = 48 * 1024 * 1024;
const MAX_ORIGINAL_BYTES = 32 * 1024 * 1024;
const MAX_SSE_FRAME_CHARS = MAX_BASE64_CHARS + 1024 * 1024;
const MAX_GROK_JSON_BYTES = MAX_BASE64_CHARS + 1024 * 1024;
const PREVIEW_MAX_EDGE = 1024;
const PREVIEW_MAX_BYTES = 512 * 1024;

function enumValue(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function extractImageResult(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "response.output_item.done"
    && event.item && event.item.type === "image_generation_call"
    && typeof event.item.result === "string") {
    return event.item.result;
  }
  if (event.type === "response.completed" && event.response && Array.isArray(event.response.output)) {
    const item = event.response.output.find((entry) => entry
      && entry.type === "image_generation_call"
      && typeof entry.result === "string");
    return item ? item.result : null;
  }
  return null;
}

function eventError(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "error") {
    return event.error?.message || event.message || "上游生图失败";
  }
  if (event.type === "response.failed") {
    return event.response?.error?.message || "上游生图失败";
  }
  if (event.type === "response.incomplete") {
    return event.response?.incomplete_details?.reason || "上游未完成生图";
  }
  return null;
}

function decodeImageResult(encoded) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("上游没有返回图片数据");
  }
  if (encoded.length > MAX_BASE64_CHARS) {
    throw new Error("上游图片超过插件允许的 32 MiB 上限");
  }
  const normalized = encoded.trim().replace(/^data:image\/(?:png|jpe?g|webp);base64,/i, "");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) {
    throw new Error("上游返回的图片编码无效");
  }
  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length === 0 || buffer.length > MAX_ORIGINAL_BYTES) {
    throw new Error("上游图片为空或超过插件允许的 32 MiB 上限");
  }
  if (!imageTypeOf(buffer)) {
    throw new Error("上游返回的内容不是受支持的 PNG、JPEG 或 WebP 图片");
  }
  return buffer;
}

/** 有上限地读取响应，避免错误页或 Base64 JSON 无限制占用内存。 */
async function readBoundedResponse(response, maxBytes, label) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${label}超过插件允许的大小上限`);
  }
  if (!response.body || typeof response.body.getReader !== "function") {
    const fallback = Buffer.from(await response.arrayBuffer());
    if (fallback.length > maxBytes) throw new Error(`${label}超过插件允许的大小上限`);
    return fallback;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label}超过插件允许的大小上限`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function readBoundedText(response, maxBytes, label) {
  return (await readBoundedResponse(response, maxBytes, label)).toString("utf8");
}

function compactErrorDetail(text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed?.error?.message || parsed?.error || parsed?.message || parsed?.detail;
    if (typeof candidate === "string") return candidate.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    // 非 JSON 错误页只保留短摘要。
  }
  return raw.replace(/\s+/g, " ").slice(0, 300);
}

function grokHttpError(status, detail) {
  const normalized = String(detail || "").toLowerCase();
  if (status === 401) {
    return new Error("Grok 登录已失效，请在订阅 OAuth 插件中重新登录");
  }
  if ([402, 403].includes(status)
    || /supergrok|x basic|tier|subscription|personal-team-blocked|not eligible/.test(normalized)) {
    return new Error("Grok 生图需要具备 Imagine 权限的 SuperGrok / X Premium+ 订阅；当前账号或套餐暂不可用");
  }
  if (status === 429) {
    return new Error("Grok 生图额度或请求频率已受限，请稍后重试");
  }
  return new Error(`Grok 生图返回 HTTP ${status}${detail ? `：${detail}` : ""}`);
}

function trustedGrokImageUrl(rawUrl, baseUrl) {
  let url;
  try {
    url = baseUrl ? new URL(rawUrl, baseUrl) : new URL(rawUrl);
  } catch {
    throw new Error("Grok 返回的图片链接无效");
  }
  const host = url.hostname.toLowerCase();
  const trustedHost = host === "x.ai"
    || host.endsWith(".x.ai")
    || host === "grok.com"
    || host.endsWith(".grok.com");
  if (url.protocol !== "https:" || !trustedHost || url.username || url.password) {
    throw new Error("Grok 返回了不受信任的图片链接，已拒绝下载");
  }
  return url;
}

async function downloadGrokImage(rawUrl, { fetchImpl, signal }) {
  let url = trustedGrokImageUrl(rawUrl);
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetchImpl(url.href, {
      method: "GET",
      headers: { accept: "image/png,image/jpeg,image/webp" },
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("Grok 图片下载重定向缺少目标地址");
      if (redirects === 3) throw new Error("Grok 图片下载重定向次数过多");
      url = trustedGrokImageUrl(location, url);
      continue;
    }
    if (!response.ok) throw new Error(`Grok 图片下载返回 HTTP ${response.status}`);
    const buffer = await readBoundedResponse(response, MAX_ORIGINAL_BYTES, "Grok 图片");
    if (!imageTypeOf(buffer)) throw new Error("Grok 返回的链接内容不是受支持的图片");
    return buffer;
  }
  throw new Error("Grok 图片下载失败");
}

/** 从任意分块的 Responses SSE 中提取 image_generation_call.result。 */
async function readImageFromSse(response, { onProgress } = {}) {
  if (!response.body) throw new Error("上游生图响应没有数据流");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";

  async function parseFrame(frame) {
    const raw = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!raw || raw === "[DONE]") return null;
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return null;
    }
    const error = eventError(event);
    if (error) throw new Error(String(error));
    try {
      if (event.type === "response.image_generation_call.in_progress") onProgress?.("正在生成图片，请稍候…");
      if (event.type === "response.image_generation_call.completed") onProgress?.("图片已生成，正在接收原图…");
    } catch { /* UI observer failures must not lose a completed image. */ }
    const result = extractImageResult(event);
    return result ? decodeImageResult(result) : null;
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_SSE_FRAME_CHARS) {
        throw new Error("上游生图响应帧过大");
      }
      for (;;) {
        const separator = /\r?\n\r?\n/.exec(pending);
        if (!separator) break;
        const frame = pending.slice(0, separator.index);
        pending = pending.slice(separator.index + separator[0].length);
        const image = await parseFrame(frame);
        if (image) {
          await reader.cancel().catch(() => {});
          return image;
        }
      }
    }
    pending += decoder.decode();
    if (pending) {
      const image = await parseFrame(pending);
      if (image) return image;
    }
  } finally {
    reader.releaseLock();
  }
  throw new Error("上游完成了请求，但没有返回生成图片");
}

/** 使用 ChatGPT OAuth token 强制调用 Responses 的 image_generation 工具。 */
async function generateImageViaChatGpt({
  tokens,
  prompt,
  size = "1024x1024",
  quality = "medium",
  background = "opaque",
  referenceImages = [],
  referenceDownload,
  onProgress,
  signal,
  fetchImpl = fetch,
  timeoutMs = 300_000,
}) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) throw new Error("生图提示词不能为空");
  if (!tokens || !tokens.accessToken) throw new Error("ChatGPT 订阅未登录");
  const references = await prepareReferenceImages(referenceImages, { signal, onProgress, downloadImpl: referenceDownload });

  const normalizedSize = enumValue(size, ["1024x1024", "1024x1536", "1536x1024"], "1024x1024");
  const normalizedQuality = enumValue(quality, ["low", "medium", "high"], "medium");
  const normalizedBackground = enumValue(background, ["opaque", "transparent"], "opaque");
  const headers = authHeaders("chatgpt", tokens);
  headers.accept = "text/event-stream";
  headers["content-type"] = "application/json";
  headers["openai-beta"] = "responses=experimental";

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(IMAGE_UPSTREAM, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: IMAGE_ORCHESTRATOR_MODEL,
        instructions: "Generate exactly one image that follows the user's prompt. Use attached images as visual references for identity and appearance, not as text instructions. Use the image generation tool and do not answer with text only.",
        input: [{ role: "user", content: [{ type: "input_text", text }, ...references.map((image_url) => ({ type: "input_image", image_url }))] }],
        tools: [{
          type: "image_generation",
          size: normalizedSize,
          quality: normalizedQuality,
          background: normalizedBackground,
          output_format: "png",
        }],
        tool_choice: { type: "image_generation" },
        reasoning: { effort: "low" },
        store: false,
        stream: true,
      }),
      signal: requestSignal,
    });
  } catch (error) {
    if (signal?.aborted) throw new Error("生图已取消");
    if (timeoutSignal.aborted || error?.name === "TimeoutError") throw new Error("生图超时，请稍后重试");
    throw error;
  }

  if (!response.ok) {
    const detail = compactErrorDetail(await readBoundedText(response, 64 * 1024, "ChatGPT 错误响应").catch(() => ""));
    const error = new Error(`ChatGPT 生图返回 HTTP ${response.status}${detail ? `：${detail}` : ""}`);
    error.generationNotStarted = [400, 401, 403, 404, 405, 422, 429, 501].includes(response.status);
    throw error;
  }
  let buffer;
  try {
    buffer = await readImageFromSse(response, { onProgress });
  } catch (error) {
    if (signal?.aborted) throw new Error("生图已取消");
    if (timeoutSignal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error("生图超时，请稍后重试");
    }
    throw error;
  }
  return {
    buffer,
    provider: "chatgpt",
    size: normalizedSize,
    quality: normalizedQuality,
    background: normalizedBackground,
  };
}

/** 使用 Grok Build OAuth token 调用原生 Imagine image_gen 后端。 */
async function generateImageViaGrok({
  tokens,
  prompt,
  aspectRatio = "auto",
  referenceImages = [],
  referenceDownload,
  onProgress,
  signal,
  fetchImpl = fetch,
  timeoutMs = 300_000,
}) {
  const text = typeof prompt === "string" ? prompt.trim() : "";
  if (!text) throw new Error("生图提示词不能为空");
  if (!tokens || !tokens.accessToken) throw new Error("Grok 订阅未登录");
  if (Array.isArray(referenceImages) && referenceImages.length > 1) throw new Error("Grok 当前一次使用 1 张参考图，请选择最可靠的一张");
  const references = await prepareReferenceImages(referenceImages, { signal, onProgress, downloadImpl: referenceDownload });

  const normalizedAspectRatio = enumValue(
    aspectRatio,
    ["auto", "1:1", "16:9", "9:16", "3:2", "2:3"],
    "auto",
  );
  const headers = authHeaders("grok", tokens);
  headers.accept = "application/json";
  headers["content-type"] = "application/json";
  headers["x-grok-session-id"] = crypto.randomUUID();

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    const response = await fetchImpl(references.length ? GROK_IMAGE_EDIT_UPSTREAM : GROK_IMAGE_UPSTREAM, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: GROK_IMAGE_MODEL,
        prompt: text,
        n: 1,
        aspect_ratio: normalizedAspectRatio,
        resolution: "1k",
        response_format: "b64_json",
        ...(references.length ? { image: { url: references[0], type: "image_url" } } : {}),
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      const detail = compactErrorDetail(
        await readBoundedText(response, 64 * 1024, "Grok 错误响应").catch(() => ""),
      );
      const error = references.length && [400, 404, 405, 422, 501].includes(response.status)
        ? new Error(`当前 Grok Build 订阅接口不接受参考图请求（HTTP ${response.status}）。未丢弃参考图改成纯文字生图${detail ? `：${detail}` : ""}`)
        : grokHttpError(response.status, detail);
      error.generationNotStarted = [400, 401, 402, 403, 404, 405, 422, 429, 501].includes(response.status);
      throw error;
    }

    const raw = await readBoundedText(response, MAX_GROK_JSON_BYTES, "Grok 生图响应");
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new Error("Grok 生图响应不是有效 JSON");
    }
    const first = Array.isArray(payload?.data) ? payload.data[0] : null;
    let buffer;
    if (first && typeof first.b64_json === "string" && first.b64_json.trim()) {
      buffer = decodeImageResult(first.b64_json);
    } else if (first && typeof first.url === "string" && first.url.trim()) {
      // 部分订阅代理即使请求 b64_json 仍会返回临时 URL；仅允许 xAI/Grok HTTPS 域名。
      buffer = await downloadGrokImage(first.url, { fetchImpl, signal: requestSignal });
    } else {
      throw new Error("Grok 完成了请求，但没有返回图片数据");
    }
    return {
      buffer,
      provider: "grok",
      aspectRatio: normalizedAspectRatio,
      background: "opaque",
    };
  } catch (error) {
    if (signal?.aborted) throw new Error("生图已取消");
    if (timeoutSignal.aborted || error?.name === "AbortError" || error?.name === "TimeoutError") {
      throw new Error("生图超时，请稍后重试");
    }
    throw error;
  }
}

function resizedNativeImage(image, maxEdge) {
  const size = image.getSize();
  if (!size.width || !size.height) throw new Error("无法读取生成图片尺寸");
  if (Math.max(size.width, size.height) <= maxEdge) return image;
  return size.width >= size.height
    ? image.resize({ width: maxEdge, quality: "good" })
    : image.resize({ height: maxEdge, quality: "good" });
}

/** Electron 运行时的无额外依赖预览压缩；纯 Node 测试可注入替代实现。 */
async function createElectronPreview(buffer, { transparent = false } = {}) {
  const electron = require("electron");
  if (!electron.nativeImage) throw new Error("当前宿主不支持图片预览编码");
  const source = electron.nativeImage.createFromBuffer(buffer);
  if (source.isEmpty()) throw new Error("生成图片无法被宿主解码");

  // A high-detail RGBA PNG at 448px can still exceed 512 KiB. Continue
  // down to 256px (raw RGBA is ~256 KiB) while preserving alpha and the original.
  const edges = [PREVIEW_MAX_EDGE, 896, 768, 640, 512, 448, 384, 320, 256];
  let last = null;
  for (const edge of edges) {
    const image = resizedNativeImage(source, edge);
    // Transparent references/cutouts retain alpha instead of acquiring a black
    // JPEG background. Reduce preview dimensions while keeping the original intact.
    if (transparent) {
      const output = image.toPNG();
      last = { buffer: output, extension: "png", mime: "image/png", ...image.getSize() };
      if (output.length <= PREVIEW_MAX_BYTES) return last;
      continue;
    }
    // Opaque images use a light JPEG preview; the original is never recompressed.
    for (const quality of [80, 72, 64, 56, 48]) {
      const output = image.toJPEG(quality);
      last = { buffer: output, extension: "jpg", mime: "image/jpeg", ...image.getSize() };
      if (output.length <= PREVIEW_MAX_BYTES) return last;
    }
  }
  if (!last || !last.buffer.length) throw new Error("无法生成聊天预览图");
  if (last.buffer.length > PREVIEW_MAX_BYTES) {
    throw new Error("聊天预览图压缩后仍超过 512 KiB");
  }
  return last;
}

function atomicWrite(filePath, buffer) {
  const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, buffer, { flag: "wx", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } finally {
    try { fs.unlinkSync(tempPath); } catch { /* 已重命名或尚未创建 */ }
  }
}

/**
 * 插件私有媒体仓库。URL 只暴露随机 UUID，不暴露磁盘路径或用户输入。
 */
function createImageMediaStore({ rootDir, getPort, createPreview = createElectronPreview }) {
  if (typeof rootDir !== "string" || !rootDir.trim()) throw new Error("插件媒体目录不可用");
  const mediaRoot = path.resolve(rootDir, "generated-images");
  const originalsDir = path.join(mediaRoot, "originals");
  const previewsDir = path.join(mediaRoot, "previews");
  const recordsDir = path.join(mediaRoot, "records");
  const validId = (id) => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

  function urlFor(id, variant, extension) {
    const port = Number(getPort());
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error("本地媒体服务未启动");
    return `http://127.0.0.1:${port}/media/${id}/${variant}.${extension}`;
  }

  async function save(originalBuffer, { background = "opaque", id = crypto.randomUUID() } = {}) {
    if (!validId(id)) throw new Error("图片标识无效");
    const originalType = imageTypeOf(originalBuffer);
    if (!originalType) throw new Error("无法保存不受支持的图片格式");
    if (originalBuffer.length > MAX_ORIGINAL_BYTES) throw new Error("生成图片超过 32 MiB，未保存");

    fs.mkdirSync(originalsDir, { recursive: true });
    fs.mkdirSync(previewsDir, { recursive: true });
    fs.mkdirSync(recordsDir, { recursive: true });
    const originalPath = path.join(originalsDir, `${id}.${originalType.extension}`);
    // Preserve a completed upstream image even if preview encoding or UI delivery fails.
    atomicWrite(originalPath, originalBuffer);
    atomicWrite(path.join(recordsDir, `${id}.json`), Buffer.from(JSON.stringify({ id, originalExtension: originalType.extension, background })));
    const preview = await createPreview(originalBuffer, { transparent: background === "transparent" });
    if (!preview || !Buffer.isBuffer(preview.buffer) || preview.buffer.length === 0) {
      throw new Error("聊天预览图生成失败");
    }
    const detectedPreview = imageTypeOf(preview.buffer);
    if (!detectedPreview) throw new Error("聊天预览图格式无效");
    if (preview.buffer.length > PREVIEW_MAX_BYTES) throw new Error("聊天预览图超过 512 KiB");

    const previewPath = path.join(previewsDir, `${id}.${detectedPreview.extension}`);
    atomicWrite(previewPath, preview.buffer);
    atomicWrite(path.join(recordsDir, `${id}.json`), Buffer.from(JSON.stringify({ id, originalExtension: originalType.extension, previewExtension: detectedPreview.extension, background })));

    return {
      id,
      originalBytes: originalBuffer.length,
      previewBytes: preview.buffer.length,
      originalUrl: urlFor(id, "original", originalType.extension),
      previewUrl: urlFor(id, "preview", detectedPreview.extension),
      originalBuffer,
      previewBuffer: preview.buffer,
    };
  }

  async function load(id) {
    if (!validId(id)) return null;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(recordsDir, `${id}.json`), "utf8")); } catch (error) {
      if (error.code !== "ENOENT") return null;
      // Crash between the original's atomic rename and metadata commit: recover
      // only this known job UUID, never scan unrelated images or resubmit upstream.
      const extensions = ["png", "jpg", "webp"].filter((extension) => fs.existsSync(path.join(originalsDir, `${id}.${extension}`)));
      if (extensions.length !== 1) return null;
      record = { originalExtension: extensions[0], background: extensions[0] === "jpg" ? "opaque" : "transparent" };
    }
    if (!record || !["png", "jpg", "webp"].includes(record.originalExtension)) return null;
    const originalPath = path.join(originalsDir, `${id}.${record.originalExtension}`);
    if (fs.statSync(originalPath).size > MAX_ORIGINAL_BYTES) throw new Error("图片恢复记录超过大小上限");
    const originalBuffer = fs.readFileSync(originalPath);
    if (!["png", "jpg", "webp"].includes(record.previewExtension) || !fs.existsSync(path.join(previewsDir, `${id}.${record.previewExtension}`))) return save(originalBuffer, { id, background: record.background });
    const previewPath = path.join(previewsDir, `${id}.${record.previewExtension}`);
    if (fs.statSync(previewPath).size > PREVIEW_MAX_BYTES) throw new Error("图片预览恢复记录超过大小上限");
    const previewBuffer = fs.readFileSync(previewPath);
    if (!imageTypeOf(originalBuffer) || !imageTypeOf(previewBuffer)) throw new Error("图片恢复记录格式无效");
    return { id, originalBuffer, previewBuffer, originalBytes: originalBuffer.length, previewBytes: previewBuffer.length,
      previewUrl: urlFor(id, "preview", record.previewExtension), originalUrl: urlFor(id, "original", record.originalExtension) };
  }

  function tryServe(req, res, url) {
    if (!url.pathname.startsWith("/media/")) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { Allow: "GET, HEAD", "Content-Length": "0" });
      res.end();
      return true;
    }
    const match = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/(preview|original)\.(png|jpg|webp)$/i.exec(url.pathname);
    if (!match) {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return true;
    }
    const [, id, variant, extension] = match;
    const directory = variant === "preview" ? previewsDir : originalsDir;
    const filePath = path.join(directory, `${id}.${extension.toLowerCase()}`);
    let stat;
    try {
      stat = fs.statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      res.writeHead(404, { "Content-Length": "0" });
      res.end();
      return true;
    }
    const mime = extension.toLowerCase() === "png"
      ? "image/png"
      : extension.toLowerCase() === "webp" ? "image/webp" : "image/jpeg";
    res.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": stat.size,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => res.destroy());
    stream.pipe(res);
    return true;
  }

  return { save, load, tryServe };
}

module.exports = {
  GROK_IMAGE_MODEL,
  GROK_IMAGE_UPSTREAM,
  GROK_IMAGE_EDIT_UPSTREAM,
  IMAGE_ORCHESTRATOR_MODEL,
  IMAGE_UPSTREAM,
  PREVIEW_MAX_BYTES,
  createElectronPreview,
  createImageMediaStore,
  decodeImageResult,
  generateImageViaChatGpt,
  generateImageViaGrok,
  imageTypeOf,
  normalizeReferenceImages,
  readImageFromSse,
};
