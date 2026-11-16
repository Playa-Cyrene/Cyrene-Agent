import * as path from "node:path";

export type ScreenshotMode = "clipboard-only" | "clipboard-and-file";

export type HelperEvent =
  | { type: "ready"; protocolVersion: number }
  | { type: "accepted"; requestId: string }
  | { type: "overlay-visible"; requestId: string; freezeDurationMs: number }
  | { type: "interaction-state"; requestId: string; state: "selecting" | "selected" | "committing" }
  | { type: "capture-released"; requestId: string; clipboardWritten: boolean; width: number; height: number }
  | { type: "completed"; requestId: string; fileName: string | null; width: number; height: number; mime: "image/png"; clipboardWritten: boolean; hasAnnotations: boolean }
  | { type: "cancelled"; requestId: string; reason: string }
  | { type: "error"; requestId?: string | null; code: string; message: string; recoverable: boolean };

const UUID_V4_PNG_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i;
const MAX_U32 = 0xffff_ffff;

function invalidEvent(): never {
  throw new Error("INVALID_HELPER_EVENT");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isU32(value: unknown, minimum = 0): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum
    && value <= MAX_U32;
}

function requireRequestId(event: Record<string, unknown>): string {
  if (!isNonEmptyString(event.requestId)) invalidEvent();
  return event.requestId;
}

export function parseHelperEvent(line: string): HelperEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return invalidEvent();
  }
  if (!isObject(parsed) || typeof parsed.type !== "string") return invalidEvent();

  switch (parsed.type) {
    case "ready":
      if (!isU32(parsed.protocolVersion, 1)) return invalidEvent();
      return { type: "ready", protocolVersion: parsed.protocolVersion };
    case "accepted":
      return { type: "accepted", requestId: requireRequestId(parsed) };
    case "overlay-visible":
      if (!isU32(parsed.freezeDurationMs)) return invalidEvent();
      return { type: "overlay-visible", requestId: requireRequestId(parsed), freezeDurationMs: parsed.freezeDurationMs };
    case "interaction-state":
      if (parsed.state !== "selecting" && parsed.state !== "selected" && parsed.state !== "committing") return invalidEvent();
      return { type: "interaction-state", requestId: requireRequestId(parsed), state: parsed.state };
    case "capture-released":
      if (typeof parsed.clipboardWritten !== "boolean" || !isU32(parsed.width, 1) || !isU32(parsed.height, 1)) return invalidEvent();
      return {
        type: "capture-released",
        requestId: requireRequestId(parsed),
        clipboardWritten: parsed.clipboardWritten,
        width: parsed.width,
        height: parsed.height,
      };
    case "completed":
      if ((typeof parsed.fileName !== "string" && parsed.fileName !== null)
        || (typeof parsed.fileName === "string" && !UUID_V4_PNG_FILE_NAME.test(parsed.fileName))
        || !isU32(parsed.width, 1)
        || !isU32(parsed.height, 1)
        || parsed.mime !== "image/png"
        || typeof parsed.clipboardWritten !== "boolean"
        || typeof parsed.hasAnnotations !== "boolean") return invalidEvent();
      return {
        type: "completed",
        requestId: requireRequestId(parsed),
        fileName: parsed.fileName,
        width: parsed.width,
        height: parsed.height,
        mime: "image/png",
        clipboardWritten: parsed.clipboardWritten,
        hasAnnotations: parsed.hasAnnotations,
      };
    case "cancelled":
      if (!isNonEmptyString(parsed.reason)) return invalidEvent();
      return { type: "cancelled", requestId: requireRequestId(parsed), reason: parsed.reason };
    case "error":
      if (!isNonEmptyString(parsed.code) || !isNonEmptyString(parsed.message) || typeof parsed.recoverable !== "boolean") return invalidEvent();
      if (parsed.requestId !== undefined && parsed.requestId !== null && !isNonEmptyString(parsed.requestId)) return invalidEvent();
      return {
        type: "error",
        ...(parsed.requestId === undefined ? {} : { requestId: parsed.requestId }),
        code: parsed.code,
        message: parsed.message,
        recoverable: parsed.recoverable,
      };
    default:
      return invalidEvent();
  }
}

export function resolveCompletedFile(outputDirectory: string, fileName: string): string {
  if (!UUID_V4_PNG_FILE_NAME.test(fileName)) {
    throw new Error("INVALID_SCREENSHOT_FILE_NAME");
  }
  const directory = path.win32.resolve(outputDirectory);
  const resolved = path.win32.resolve(directory, fileName);
  if (path.win32.dirname(resolved) !== directory) {
    throw new Error("INVALID_SCREENSHOT_FILE_NAME");
  }
  return resolved;
}
