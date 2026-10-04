import { createGeneratedImageStore } from "../generated-image-store";
import { GENERATED_IMAGE_ID } from "../../shared/generated-image";

/** Only opaque image IDs and two fixed variants can address the host-owned store. */
export function createGeneratedImageProtocol(userData: string) {
  const store = createGeneratedImageStore(userData);
  return (request: { url: string; method: string }): Response => {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "generated-image:" || !["GET", "HEAD"].includes(request.method)
        || url.username || url.password || url.port || url.search || url.hash
        || !GENERATED_IMAGE_ID.test(url.hostname) || !/^\/(preview|original)$/.test(url.pathname)) return new Response(null, { status: 404 });
      const image = store.read(url.hostname, url.pathname.slice(1) as "preview" | "original");
      return new Response(request.method === "HEAD" ? null : new Uint8Array(image.bytes), { headers: {
        "Content-Type": image.mime, "Content-Length": String(image.bytes.length),
        "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff",
      } });
    } catch { return new Response(null, { status: 404 }); }
  };
}
