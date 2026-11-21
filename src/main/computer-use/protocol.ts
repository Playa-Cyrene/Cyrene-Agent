/** 与 native/cyrene-computer 的 NDJSON 协议；字段名必须与 Rust 侧 protocol.rs 保持一致。 */
export const COMPUTER_HELPER_PROTOCOL_VERSION = 1;

export type ComputerScrollDirection = "up" | "down" | "left" | "right";

export type ComputerHelperCommand =
  | { type: "screenshot"; id: string; maxEdge: number }
  | { type: "click"; id: string; x: number; y: number; spaceWidth: number; spaceHeight: number; button: "left" | "right"; count: 1 | 2 }
  | { type: "type-text"; id: string; text: string }
  | { type: "scroll"; id: string; x: number; y: number; spaceWidth: number; spaceHeight: number; direction: ComputerScrollDirection; amount: number }
  | { type: "shutdown" };

export type ComputerHelperEvent =
  | { type: "ready"; protocolVersion: number }
  | { type: "screenshot-result"; id: string; fileName: string; width: number; height: number; screenWidth: number; screenHeight: number }
  | { type: "done"; id: string }
  | { type: "error"; id?: string; code: string; message: string };

const MAX_EDGE = 16_384;

function invalidEvent(): never {
  throw new Error("INVALID_HELPER_EVENT");
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= MAX_EDGE;
}

function nonEmptyString(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : invalidEvent();
}

/** helper 是独立进程，输出按不可信输入校验：字段缺失或类型不对一律拒绝，不做猜测性修复。 */
export function parseComputerHelperEvent(line: string): ComputerHelperEvent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return invalidEvent();
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return invalidEvent();
  const event = parsed as Record<string, unknown>;
  switch (event.type) {
    case "ready":
      return typeof event.protocolVersion === "number" && Number.isSafeInteger(event.protocolVersion)
        ? { type: "ready", protocolVersion: event.protocolVersion }
        : invalidEvent();
    case "screenshot-result":
      if (!isDimension(event.width) || !isDimension(event.height)
        || !isDimension(event.screenWidth) || !isDimension(event.screenHeight)) return invalidEvent();
      return {
        type: "screenshot-result",
        id: nonEmptyString(event.id),
        fileName: nonEmptyString(event.fileName),
        width: event.width,
        height: event.height,
        screenWidth: event.screenWidth,
        screenHeight: event.screenHeight,
      };
    case "done":
      return { type: "done", id: nonEmptyString(event.id) };
    case "error":
      if (event.id !== undefined && typeof event.id !== "string") return invalidEvent();
      return {
        type: "error",
        ...(typeof event.id === "string" ? { id: event.id } : {}),
        code: nonEmptyString(event.code),
        message: typeof event.message === "string" ? event.message : "",
      };
    default:
      return invalidEvent();
  }
}
