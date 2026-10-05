import type { AssistantContent } from "ai";
import type { GeneratedImageOutput } from "../../../shared/generated-image";

type RecordValue = Record<string, unknown>;

/** Extract the stable, provider-executed image tool result from SDK stream or terminal entries. */
export function collectGeneratedImages(results: Iterable<unknown>, existing: GeneratedImageOutput[] = []): GeneratedImageOutput[] {
  const collected = [...existing];
  const seen = new Set(collected.map(image => image.toolCallId));
  for (const value of results) {
    const entry = asRecord(value);
    if (!entry || entry.type !== "tool-result" || !isImageTool(entry.toolName)) continue;
    const toolCallId = typeof entry.toolCallId === "string" ? entry.toolCallId : "";
    if (!toolCallId || seen.has(toolCallId)) continue;
    const payload = asRecord(entry.output) ?? asRecord(entry.result);
    const base64 = typeof payload?.result === "string" ? payload.result : undefined;
    if (!base64) continue;
    seen.add(toolCallId);
    collected.push({ id: toolCallId, toolCallId, base64, mime: "image/png" });
  }
  return collected;
}

/** Drop only image generation protocol items from assistant history replay. */
export function stripGeneratedImageReplay(content: AssistantContent): AssistantContent {
  if (typeof content === "string") return content;
  const imageCallIds = new Set(content.flatMap(part => part.type === "tool-call" && isImageTool(part.toolName) ? [part.toolCallId] : []));
  return content.filter(part => {
    if ((part.type === "tool-call" || part.type === "tool-result") && isImageTool(part.toolName)) return false;
    return !(part.type === "tool-result" && imageCallIds.has(part.toolCallId));
  });
}

/** Remove image bytes from nested provider response dumps and raw response snapshots. */
export function sanitizeGeneratedImageRaw<T>(value: T): T {
  return sanitize(value, false) as T;
}

function sanitize(value: unknown, imageContext: boolean): unknown {
  if (Array.isArray(value)) return value.map(item => sanitize(item, imageContext));
  const record = asRecord(value);
  if (!record) return value;
  const imageTool = record.type === "image_generation_call" || isImageTool(record.toolName) || isImageTool(record.name);
  const result: RecordValue = {};
  for (const [key, child] of Object.entries(record)) {
    if ((imageContext || imageTool) && ["result", "output", "base64", "partial_image_b64"].includes(key)) continue;
    result[key] = sanitize(child, imageTool);
  }
  return result;
}

function isImageTool(value: unknown): boolean {
  return typeof value === "string" && (value === "image_generation" || value.endsWith(".image_generation"));
}

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
}
