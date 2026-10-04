"use strict";

// Fetch only public HTTPS images, without cookies, OAuth headers, or a shared
// connection pool. Resolve and pin every redirect's address to prevent rebinding.
const dns = require("node:dns/promises");
const https = require("node:https");
const net = require("node:net");

const MAX_REFERENCE_BYTES = 10 * 1024 * 1024;
const REFERENCE_TIMEOUT_MS = 20_000;
const PREPARATION_TIMEOUT_MS = 60_000;
const MAX_REDIRECTS = 3;

function imageTypeOf(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: "png", mime: "image/png" };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: "jpg", mime: "image/jpeg" };
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    return { extension: "webp", mime: "image/webp" };
  }
  return null;
}

function referenceUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("参考图必须是公网 HTTPS 图片地址"); }
  const host = url.hostname.toLowerCase();
  if (typeof value !== "string" || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)
    || url.protocol !== "https:" || url.username || url.password || url.port
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|lan)$/.test(host) || net.isIP(host)) {
    throw new Error("参考图必须是无凭据的公网 HTTPS 图片地址");
  }
  return url;
}

function checkImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error("参考图没有图片数据");
  if (buffer.length > MAX_REFERENCE_BYTES) throw new Error("单张参考图超过 10 MiB");
  const type = imageTypeOf(buffer);
  if (!type) throw new Error("参考图内容不是 PNG、JPEG 或 WebP 图片");
  return type;
}

function normalizeReferenceImages(values = []) {
  if (!Array.isArray(values) || values.length > 3) throw new Error("最多提供 3 张参考图");
  return values.map((value) => {
    if (typeof value !== "string") throw new Error("参考图地址无效");
    if (/^data:/i.test(value)) {
      if (value.length > Math.ceil(MAX_REFERENCE_BYTES / 3) * 4 + 32) throw new Error("单张参考图超过 10 MiB");
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/i.exec(value);
      if (!match) throw new Error("参考图图片编码无效");
      const buffer = Buffer.from(match[2], "base64");
      if (buffer.toString("base64") !== match[2]) throw new Error("参考图图片编码无效");
      if (checkImage(buffer).mime !== match[1].toLowerCase()) throw new Error("参考图声明格式与实际图片不匹配");
      return `data:${match[1].toLowerCase()};base64,${match[2]}`;
    }
    return referenceUrl(value).href;
  });
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 192 && b === 88 && c === 99)
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113) || address === "168.63.129.16");
  }
  if (family !== 6 || address.includes("%")) return false;
  // Only native global unicast. This excludes IPv4-mapped, NAT64, local,
  // multicast, and tunnel addresses, including their alternate textual forms.
  const canonical = new URL(`https://[${address}]/`).hostname.slice(1, -1);
  const [first, second = "0"] = canonical.split(":");
  const a = parseInt(first, 16), b = parseInt(second || "0", 16);
  return a >= 0x2000 && a <= 0x3fff
    && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
    && a !== 0x2002 && !(a === 0x3fff && b < 0x1000);
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(new Error("参考图下载已取消"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("参考图下载已取消"));
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function pinnedAddress(url, lookupImpl, signal, requestImpl) {
  let addresses;
  try { addresses = await abortable(lookupImpl(url.hostname, { all: true, verbatim: true }), signal); }
  catch { throw new Error("参考图域名解析失败，请更换可靠的图片地址后重试"); }
  if (Array.isArray(addresses) && addresses.length && addresses.every((entry) => entry?.family === 4
    && typeof entry.address === "string" && /^198\.(?:18|19)\./.test(entry.address) && net.isIP(entry.address) === 4)) {
    // Fake-IP proxies commonly return 198.18/15. Never connect to that reserved
    // range: independently verify the public domain through a fixed DoH endpoint.
    try { addresses = await lookupPublicDns(url.hostname, { requestImpl, signal }); }
    catch { throw new Error("参考图代理 DNS 公网核验失败，未放行内网地址；请检查网络或更换参考图"); }
  }
  if (!Array.isArray(addresses) || !addresses.length || addresses.some((entry) => !entry
    || typeof entry.address !== "string" || !isPublicAddress(entry.address) || net.isIP(entry.address) !== entry.family)) {
    throw new Error("参考图域名指向内网或保留地址，已拦截下载");
  }
  // Prefer IPv4 for networks without working IPv6. No second DNS lookup occurs.
  return addresses.find((entry) => entry.family === 4) ?? addresses[0];
}

function downloadHop(url, address, { requestImpl, signal, dnsQuery = false }) {
  return new Promise((resolve, reject) => {
    let request, response, settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error) { response?.destroy(); request?.destroy(); reject(error); }
      else resolve(result);
    };
    const abort = () => finish(new Error("参考图下载已取消"));
    try {
      request = requestImpl(url, {
        method: "GET", agent: false, autoSelectFamily: false, signal,
        headers: {
          Accept: dnsQuery ? "application/dns-json" : "image/png,image/jpeg,image/webp",
          "Accept-Encoding": "identity",
          "User-Agent": "Cyrene subscription-oauth (reference image)",
        },
        lookup(hostname, options, callback) {
          if (hostname.toLowerCase() !== url.hostname.toLowerCase()) return callback(new Error("参考图主机不匹配"));
          if (options?.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      }, (incoming) => {
        response = incoming;
        // Keep an error listener even after cancellation/redirect teardown.
        response.on("error", () => finish(new Error("参考图传输中断，请更换图片地址后重试")));
        if (settled) { response.destroy(); return; }
        const status = response.statusCode;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location;
          response.destroy();
          finish(null, { location });
          return;
        }
        if (status !== 200) { finish(new Error(`参考图下载返回 HTTP ${status}；未发起生图请求`)); return; }
        const contentType = (response.headers["content-type"] ?? "").split(";", 1)[0].trim().toLowerCase();
        const allowedTypes = dnsQuery ? ["application/json", "application/dns-json"] : ["image/png", "image/jpeg", "image/webp", "application/octet-stream"];
        if (contentType && !allowedTypes.includes(contentType)) {
          finish(new Error("参考图地址返回的不是 PNG、JPEG 或 WebP 图片（可能是网页或登录页）")); return;
        }
        const encoding = response.headers["content-encoding"];
        if (encoding && encoding.toLowerCase() !== "identity") {
          finish(new Error("参考图返回了不支持的压缩传输格式")); return;
        }
        const length = response.headers["content-length"];
        const maxBytes = dnsQuery ? 32 * 1024 : MAX_REFERENCE_BYTES;
        if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
          finish(new Error("单张参考图超过 10 MiB 或下载长度无效")); return;
        }
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          if (settled) return;
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > maxBytes) { finish(new Error(dnsQuery ? "公网 DNS 响应超过上限" : "单张参考图超过 10 MiB")); return; }
          chunks.push(buffer);
        });
        response.once("end", () => {
          if (settled) return;
          try {
            if (length !== undefined && Number(length) !== bytes) throw new Error("参考图下载不完整，请更换图片地址后重试");
            const buffer = Buffer.concat(chunks, bytes);
            if (!dnsQuery) {
              const type = checkImage(buffer);
              if (contentType.startsWith("image/") && type.mime !== contentType) throw new Error("参考图实际格式与响应类型不匹配");
            }
            finish(null, { buffer });
          } catch (error) { finish(error); }
        });
        response.once("close", () => {
          if (!settled) finish(new Error("参考图传输中断，请更换图片地址后重试"));
        });
      });
      request.once("error", () => finish(new Error("参考图网络连接失败，请更换图片地址后重试")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      else request.end();
    } catch { finish(new Error("参考图网络连接失败，请更换图片地址后重试")); }
  });
}

async function lookupPublicDns(hostname, { requestImpl, signal }) {
  for (const type of [1, 28]) {
    // A fixed public address also avoids trusting local DNS for the DNS service
    // itself. TLS still verifies cloudflare-dns.com's certificate and hostname.
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", String(type));
    const result = await downloadHop(url, { address: "1.1.1.1", family: 4 }, { requestImpl, signal, dnsQuery: true });
    if (!result.buffer) throw new Error("公网 DNS 核验接口不能跳转");
    const answer = JSON.parse(result.buffer.toString("utf8"));
    if (answer.Status !== 0 || answer.TC === true || !Array.isArray(answer.Question) || answer.Question.length !== 1
      || answer.Question[0]?.name?.toLowerCase().replace(/\.$/, "") !== hostname.toLowerCase()
      || answer.Question[0]?.type !== type || (answer.Answer !== undefined && !Array.isArray(answer.Answer))) {
      throw new Error("公网 DNS 响应不匹配");
    }
    const addresses = (answer.Answer ?? []).filter((entry) => entry.type === type)
      .map((entry) => ({ address: entry.data, family: type === 1 ? 4 : 6 }));
    if (addresses.length) return addresses;
  }
  return [];
}

async function downloadReferenceImage(value, {
  signal, timeoutMs = REFERENCE_TIMEOUT_MS, lookupImpl = dns.lookup, requestImpl = https.request,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    let url = referenceUrl(value);
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      if (combined.aborted) throw new Error("参考图下载已取消");
      const address = await pinnedAddress(url, lookupImpl, combined, requestImpl);
      if (combined.aborted) throw new Error("参考图下载已取消");
      const result = await downloadHop(url, address, { requestImpl, signal: combined });
      if (result.buffer) return result.buffer;
      if (redirects === MAX_REDIRECTS) throw new Error("参考图跳转次数过多，未发起生图请求");
      if (typeof result.location !== "string" || !result.location) throw new Error("参考图跳转缺少有效目标地址");
      try { url = referenceUrl(new URL(result.location, url).href); }
      catch { throw new Error("参考图跳转目标不是安全的公网 HTTPS 地址，已拦截下载"); }
    }
  } catch (error) {
    if (signal?.aborted) throw new Error("参考图下载已取消，未发起生图请求");
    if (controller.signal.aborted) throw new Error("参考图下载超时，未发起生图请求；请更换图片地址后重试");
    throw error;
  } finally { clearTimeout(timer); }
}

async function prepareReferenceImages(values, { signal, onProgress, downloadImpl = downloadReferenceImage } = {}) {
  const report = (text) => { try { onProgress?.(text); } catch { /* progress is observational */ } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREPARATION_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const references = normalizeReferenceImages(values);
    const prepared = [], downloaded = new Map();
    for (const [index, reference] of references.entries()) {
      if (combined.aborted) throw new Error("参考图准备已取消");
      if (reference.startsWith("data:")) { prepared.push(reference); continue; }
      report(`正在下载并校验第 ${index + 1}/${references.length} 张参考图…`);
      let dataUrl = downloaded.get(reference);
      if (!dataUrl) {
        const buffer = await abortable(downloadImpl(reference, { signal: combined }), combined);
        const type = checkImage(buffer);
        dataUrl = `data:${type.mime};base64,${buffer.toString("base64")}`;
        downloaded.set(reference, dataUrl);
      }
      prepared.push(dataUrl);
    }
    if (combined.aborted) throw new Error("参考图准备已取消");
    if (references.length) report("参考图已就绪，将随生图请求发送，无需上游下载外链");
    return prepared;
  } catch (cause) {
    const detail = signal?.aborted ? "参考图准备已取消"
      : controller.signal.aborted ? "参考图准备超时" : cause.message;
    // A preflight failure cannot have consumed a generation request. This lets
    // the workflow safely recover when a corrected reference is supplied.
    const error = new Error(`${detail}；未发起生图请求，也未丢弃参考图改为纯文字生成`);
    error.generationNotStarted = true;
    throw error;
  } finally { clearTimeout(timer); }
}

module.exports = {
  MAX_REFERENCE_BYTES, imageTypeOf, normalizeReferenceImages,
  isPublicAddress, downloadReferenceImage, prepareReferenceImages,
};
