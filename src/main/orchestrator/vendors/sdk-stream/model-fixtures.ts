import type { Transport } from "../types";

export const weatherTool = { name: "weather", description: "查询天气", parameters: {
  type: "object", properties: { city: { type: "string" } }, required: ["city"],
} };

export function responseBody(transport: Transport, options: { tool?: boolean; toolInput?: unknown; reasoning?: boolean; text?: string } = {}): Record<string, unknown> {
  const text = options.text ?? "answer";
  const input = "toolInput" in options ? options.toolInput : { city: "北京" };
  if (transport === "openai") return {
    id: "chat_test", model: "model-test", choices: [{ index: 0, message: { role: "assistant", content: text,
      ...(options.reasoning ? { reasoning_content: "reason" } : {}),
      ...(options.tool ? { tool_calls: [{ id: "call_test", type: "function", function: { name: "weather", arguments: JSON.stringify(input) } }] } : {}),
    }, finish_reason: options.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 },
  };
  if (transport === "anthropic") return {
    id: "msg_test", model: "model-test", role: "assistant", type: "message", stop_reason: options.tool ? "tool_use" : "end_turn", stop_sequence: null,
    content: [ ...(options.reasoning ? [{ type: "thinking", thinking: "reason", signature: "sig_private" }] : []),
      { type: "text", text }, ...(options.tool ? [{ type: "tool_use", id: "call_test", name: "weather", input }] : []),
    ], usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 1, cache_creation_input_tokens: 2 },
  };
  return {
    id: "resp_test", model: "model-test", created_at: 1, status: "completed",
    output: [ ...(options.reasoning ? [{ id: "rs_test", type: "reasoning", encrypted_content: "encrypted_private", summary: [{ type: "summary_text", text: "reason" }] }] : []),
      { id: "msg_test", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] },
      ...(options.tool ? [{ id: "fc_test", type: "function_call", call_id: "call_test", name: "weather", arguments: JSON.stringify(input), status: "completed" }] : []),
    ], usage: { input_tokens: 3, output_tokens: 2, input_tokens_details: { cached_tokens: 1 }, output_tokens_details: { reasoning_tokens: 1 } },
  };
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

export function sseResponse(events: Array<Record<string, unknown>>, done = false): Response {
  return new Response(events.map(event => `event: ${event.type ?? "data"}\ndata: ${JSON.stringify(event)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : ""), { headers: { "content-type": "text/event-stream" } });
}

export function streamEvents(transport: Transport, options: { tool?: boolean; toolInput?: unknown; reasoning?: boolean; text?: string } = {}): Array<Record<string, unknown>> {
  const text = options.text ?? "answer";
  const args = JSON.stringify("toolInput" in options ? options.toolInput : { city: "北京" });
  if (transport === "openai") return [
    ...(options.reasoning ? [{ choices: [{ index: 0, delta: { reasoning_content: "reason" }, finish_reason: null }] }] : []),
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    ...(options.tool ? [{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_test", type: "function", function: { name: "weather", arguments: args.slice(0, 5) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(5) } }] }, finish_reason: null }] }] : []),
    { choices: [{ index: 0, delta: {}, finish_reason: options.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
  ];
  if (transport === "anthropic") {
    const final = responseBody(transport, options);
    const blocks = final.content as Array<Record<string, unknown>>;
    return [{ type: "message_start", message: { ...final, content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 0 } } },
      ...blocks.flatMap((block, index) => [
        { type: "content_block_start", index, content_block: block.type === "tool_use" ? { ...block, input: {} }
          : block.type === "thinking" ? { type: "thinking", thinking: "", signature: "" } : { type: "text", text: "" } },
        { type: "content_block_delta", index, delta: block.type === "tool_use" ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
          : block.type === "thinking" ? { type: "thinking_delta", thinking: block.thinking } : { type: "text_delta", text: block.text } },
        ...(block.type === "thinking" ? [{ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }] : []),
        { type: "content_block_stop", index },
      ]),
      { type: "message_delta", delta: { stop_reason: final.stop_reason, stop_sequence: null }, usage: { output_tokens: 2 } },
      { type: "message_stop" }];
  }
  const final = responseBody(transport, options);
  const output = final.output as Array<Record<string, unknown>>;
  return [{ type: "response.created", response: { id: final.id, model: final.model, created_at: 1 } },
    ...output.flatMap((item, output_index) => [
      { type: "response.output_item.added", output_index, item: item.type === "function_call" ? { ...item, arguments: "" }
        : item.type === "reasoning" ? { ...item, summary: [] } : { ...item, content: [] } },
      ...(item.type === "message" ? [{ type: "response.output_text.delta", item_id: item.id, output_index, content_index: 0, delta: text }]
        : item.type === "reasoning" ? [{ type: "response.reasoning_summary_part.added", item_id: item.id, output_index, summary_index: 0, part: { type: "summary_text", text: "" } },
          { type: "response.reasoning_summary_text.delta", item_id: item.id, output_index, summary_index: 0, delta: "reason" }]
          : [{ type: "response.function_call_arguments.delta", item_id: item.id, output_index, delta: item.arguments }]),
      { type: "response.output_item.done", output_index, item },
    ]), { type: "response.completed", response: final }];
}
