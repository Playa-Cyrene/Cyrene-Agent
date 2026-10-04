import type { PluginGeneratedImageInput, PluginGeneratedImageResult } from "../plugins/api";

/** Small, durable tool result. The public plugin API owns this contract. */
export type GeneratedImageResult = PluginGeneratedImageResult;
export type GeneratedImageInput = PluginGeneratedImageInput;

export const GENERATED_IMAGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseGeneratedImageResult(text: string | undefined): GeneratedImageResult | null {
  if (typeof text !== "string" || !text || text.length > 2000) return null;
  try {
    const value = JSON.parse(text);
    if (value?.kind !== "cyrene.generated-image" || typeof value.id !== "string" || !GENERATED_IMAGE_ID.test(value.id)) return null;
    return {
      kind: "cyrene.generated-image", id: value.id.toLowerCase(),
      ...(typeof value.provider === "string" ? { provider: value.provider.slice(0, 60) } : {}),
      ...(value.reused === true ? { reused: true } : {}),
    };
  } catch { return null; }
}

export function generatedImageUrl(id: string, variant: "preview" | "original"): string {
  if (!GENERATED_IMAGE_ID.test(id) || (variant !== "preview" && variant !== "original")) throw new Error("Invalid generated image id or variant");
  return `generated-image://${id.toLowerCase()}/${variant}`;
}
