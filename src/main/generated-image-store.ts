import { randomUUID, createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { GENERATED_IMAGE_ID, type GeneratedImageInput, type GeneratedImageResult } from "../shared/generated-image";

function imageType(bytes: Buffer): { mime: string; extension: string } | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { mime: "image/png", extension: "png" };
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { mime: "image/jpeg", extension: "jpg" };
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return { mime: "image/webp", extension: "webp" };
  return null;
}

export function createGeneratedImageStore(userData: string) {
  const root = path.resolve(userData, "generated-images");
  function imagePath(id: string, variant: "preview" | "original") {
    if (!GENERATED_IMAGE_ID.test(id) || (variant !== "preview" && variant !== "original")) throw new Error("Invalid generated image id or variant");
    return path.join(root, id.toLowerCase(), variant);
  }
  function writeImmutable(target: string, bytes: Buffer) {
    if (fs.existsSync(target)) {
      const old = fs.readFileSync(target);
      if (createHash("sha256").update(old).digest("hex") !== createHash("sha256").update(bytes).digest("hex")) throw new Error("Image id already contains different bytes");
      return;
    }
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, bytes, { flag: "wx", mode: 0o600 });
    try { fs.renameSync(temp, target); } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  }
  return {
    async save(input: GeneratedImageInput): Promise<GeneratedImageResult> {
      if (!(input.original instanceof Uint8Array) || !(input.preview instanceof Uint8Array)) throw new Error("Invalid generated image bytes");
      if (input.original.byteLength > 32 * 1024 * 1024 || input.preview.byteLength > 512 * 1024) throw new Error("Generated image exceeds size limit");
      const original = Buffer.from(input.original);
      const preview = Buffer.from(input.preview);
      if (!imageType(original) || !imageType(preview)) throw new Error("Unsupported generated image format");
      const target = imagePath(input.id, "original");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      writeImmutable(target, original);
      writeImmutable(imagePath(input.id, "preview"), preview);
      return { kind: "cyrene.generated-image", id: input.id.toLowerCase() };
    },
    read(id: string, variant: "preview" | "original") {
      const filePath = imagePath(id, variant);
      if (fs.statSync(filePath).size > (variant === "original" ? 32 * 1024 * 1024 : 512 * 1024)) throw new Error("Generated image exceeds size limit");
      const bytes = fs.readFileSync(filePath);
      const type = imageType(bytes);
      if (!type) throw new Error("Invalid generated image");
      return { filePath, bytes, ...type };
    },
  };
}
