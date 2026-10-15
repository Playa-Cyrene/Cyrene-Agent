import type { ChatResponse } from "../types";
import type { StreamAccumulatorSnapshot } from "./types";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(record).filter((item): item is Record<string, unknown> => item !== undefined)
    : [];
}

function argumentLength(value: unknown): number | undefined {
  return typeof value === "string" ? value.length : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function summarizeCall(item: Record<string, unknown>) {
  return {
    itemId: stringValue(item.id),
    callId: stringValue(item.call_id),
    name: stringValue(item.name),
    status: stringValue(item.status),
    argumentChars: argumentLength(item.arguments),
  };
}

function parsedCalls(snapshot: StreamAccumulatorSnapshot) {
  return snapshot.toolCalls.map((call) => ({
    index: call.index,
    callId: call.id,
    name: call.name,
    ended: call.ended,
    argumentChars: call.arguments.length,
  }));
}

/** CYRENE_RESPONSES_TRACE=1 时输出工具元数据，不输出完整请求或事件正文。 */
export function createResponsesTrace(traceId: string) {
  if (process.env.CYRENE_RESPONSES_TRACE !== "1") return undefined;

  const write = (phase: string, data: unknown) => {
    console.log(`[responses-trace][${traceId}] ${phase} ${JSON.stringify(data)}`);
  };

  return {
    request(body: Record<string, unknown>) {
      const items = records(body.input);
      write("request", {
        model: stringValue(body.model),
        inputCount: items.length,
        declaredToolCount: Array.isArray(body.tools) ? body.tools.length : 0,
        inputToolCalls: items.filter((item) => item.type === "function_call").map(summarizeCall),
        inputToolResults: items.filter((item) => item.type === "function_call_output").map((item) => ({
          callId: stringValue(item.call_id),
          outputChars: argumentLength(item.output),
        })),
      });
    },

    event(value: unknown) {
      const event = record(value);
      if (!event) return;
      if (event.type === "response.output_item.added" || event.type === "response.output_item.done") {
        const item = record(event.item);
        if (item?.type !== "function_call") return;
        write("received", { type: event.type, index: numberValue(event.output_index), ...summarizeCall(item) });
      } else if (event.type === "response.function_call_arguments.done") {
        write("received", {
          type: event.type,
          index: numberValue(event.output_index),
          itemId: stringValue(event.item_id),
          callId: stringValue(event.call_id),
          name: stringValue(event.name),
          argumentChars: argumentLength(event.arguments),
        });
      } else if (
        event.type === "response.completed" || event.type === "response.incomplete" || event.type === "response.failed"
      ) {
        const response = record(event.response);
        const output = records(response?.output);
        write("received", {
          type: event.type,
          status: stringValue(response?.status),
          outputCount: output.length,
          toolCalls: output.filter((item) => item.type === "function_call").map(summarizeCall),
        });
      }
    },

    parsed(snapshot: StreamAccumulatorSnapshot) {
      write("parsed", { toolCalls: parsedCalls(snapshot) });
    },

    result(response: ChatResponse) {
      write("result", {
        kind: response.toolCalls.length > 0 ? "tool_calls" : "answer",
        finishReason: response.finishReason,
        toolCalls: response.toolCalls.map((call) => ({
          callId: call.id,
          name: call.name,
          argumentChars: call.arguments.length,
        })),
      });
    },

    failure(error: unknown, snapshot: StreamAccumulatorSnapshot) {
      write("error", {
        code: stringValue(record(error)?.code),
        message: error instanceof Error ? error.message : String(error),
        toolCalls: parsedCalls(snapshot),
      });
    },
  };
}
