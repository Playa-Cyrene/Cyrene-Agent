import { createRequire } from "node:module";
import OpenAI from "openai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAdapterForConfig } from "../../../src/main/orchestrator/vendors";
import { runModelRequestWithRetry } from "../../../src/main/orchestrator/vendors/model-retry-runner";
import { streamChatWithSdk, type SdkStreamRuntimeDeps } from "../../../src/main/orchestrator/vendors/sdk-stream/runtime";
import { withStreamActivity } from "../../../src/main/orchestrator/vendors/sdk-stream/client-config";
import type { ChatMessage } from "../../../src/main/orchestrator/vendors/types";

const require = createRequire(import.meta.url);
const { createProxy } = require("../lib/proxy.cjs");
const localFetch = globalThis.fetch;
const proxies: ReturnType<typeof createProxy>[] = [];

afterEach(async () => {
  for (const proxy of proxies.splice(0)) {
    proxy.server.closeAllConnections();
    await proxy.stop();
  }
  vi.unstubAllGlobals();
});

async function fixture(reply: (init?: RequestInit) => Response) {
  const upstream = vi.fn(async (url: string, init?: RequestInit) => {
    if (!["https://chatgpt.com/", "https://api.anthropic.com/", "https://api.x.ai/"].some((prefix) => String(url).startsWith(prefix))) throw new Error("Unexpected mocked destination");
    return reply(init);
  });
  vi.stubGlobal("fetch", upstream);
  const log = vi.fn();
  const proxy = createProxy({ getTokens: async () => ({ tokens: { accessToken: "test-token-only", accountId: "test-account-only" } }), log });
  proxies.push(proxy);
  return { port: await proxy.start(0), upstream, log };
}

const localSdk: SdkStreamRuntimeDeps = {
  responses: async ({ client: options, body, signal, onStreamActivity }) => {
    const client = new OpenAI({ ...options, fetch: withStreamActivity(localFetch, onStreamActivity) });
    return await client.responses.create({ ...body, stream: true } as never, { signal }) as unknown as AsyncIterable<unknown>;
  },
  openAI: async () => { throw new Error("unexpected transport"); },
  anthropic: async () => { throw new Error("unexpected transport"); },
};

describe("OAuth upstream error transparency", () => {
  it("continues todo → native search → image tool → final reply through the real SDK with opaque context intact", async () => {
    const imageId = "bce7e272-0c22-4c45-975d-69c6c1db15c7";
    const outputs = [
      [
        { type: "reasoning", id: "rs-todo", encrypted_content: "opaque-todo-context", summary: [] },
        { type: "function_call", id: "fc-todo", call_id: "call-todo", name: "update_todo", arguments: "{}" },
      ],
      [
        { type: "reasoning", id: "rs-image", encrypted_content: "opaque-image-context", summary: [] },
        { type: "web_search_call", id: "ws-reference", status: "completed", action: { type: "search", query: "Cyrene official reference" } },
        { type: "function_call", id: "fc-image", call_id: "call-image", name: "subscription-oauth_generate_image", arguments: '{"provider":"chatgpt","prompt":"portrait"}' },
      ],
      [{ type: "message", id: "msg-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "图片已生成" }] }],
    ];
    let round = 0;
    const f = await fixture((init) => {
      const body = JSON.parse(String(init?.body));
      expect(body.include).toContain("reasoning.encrypted_content");
      expect(body.store).toBe(false);
      if (round > 0) {
        expect(body.input).toContainEqual(outputs[0][0]);
        expect(body.input).toContainEqual(outputs[0][1]);
        expect(body.input).toContainEqual({ type: "function_call_output", call_id: "call-todo", output: "待办已更新" });
      }
      if (round > 1) {
        expect(body.input).toContainEqual(outputs[1][0]);
        expect(body.input).toContainEqual(outputs[1][1]);
        expect(body.input).toContainEqual(outputs[1][2]);
        expect(body.input).toContainEqual({ type: "function_call_output", call_id: "call-image", output: JSON.stringify({ kind: "cyrene.generated-image", id: imageId }) });
      }
      const events = [
        { type: "response.web_search_call.searching" },
        ...outputs[round].map((item, index) => ({ type: "response.output_item.done", output_index: index, item })),
        { type: "response.completed", response: { id: `resp-${round++}`, status: "completed", output: [] } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = { provider: "ChatGPT（OpenAI）订阅", model: "gpt-6.1-sol", apiKey: "oauth-subscription", baseUrl: `http://127.0.0.1:${f.port}/v1`, explicitTransport: "responses" as const };
    const adapter = getAdapterForConfig(config);
    const statuses = vi.fn();
    const activity = vi.fn();
    let messages: ChatMessage[] = [{ role: "user", content: "生成角色图片" }];
    for (let index = 0; index < 3; index += 1) {
      const response = await runModelRequestWithRetry((attempt) => streamChatWithSdk({
        adapter, config, request: { model: config.model, messages }, signal: attempt.signal, timeoutMs: 10_000,
        onStreamActivity: () => { activity(); attempt.onStreamActivity(); },
      }, localSdk), { provider: adapter.id, model: config.model, maxRetries: 5, idleTimeoutMs: 60_000, onStatus: statuses });
      if (index < 2) {
        expect(response.toolCalls).toHaveLength(1);
        messages = adapter.appendToolResults([...messages, response.assistantMessage], [{
          toolCall: response.toolCalls[0], success: true,
          output: index === 0 ? "待办已更新" : JSON.stringify({ kind: "cyrene.generated-image", id: imageId }),
        }]);
      } else expect(response.assistantMessage.rawAssistant).toEqual(outputs[2]);
    }
    expect(f.upstream).toHaveBeenCalledTimes(3);
    expect(statuses).not.toHaveBeenCalled();
    expect(activity).toHaveBeenCalled();
  });
  it("does not retry todo continuation with a late image-tool name and partial terminal output", async () => {
    const todo = { type: "function_call", id: "fc-todo", call_id: "call-todo", name: "update_todo", arguments: "{}" };
    const context = { type: "reasoning", id: "rs-image", encrypted_content: "opaque-test-context", summary: [] };
    const search = { type: "web_search_call", id: "ws-image", status: "completed", action: { type: "search", query: "official character reference" } };
    const image = { type: "function_call", id: "fc-image", call_id: "call-image", name: "subscription-oauth_generate_image", arguments: '{"prompt":"portrait"}' };
    const text = { type: "message", id: "msg-final", role: "assistant", status: "completed", content: [{ type: "output_text", text: "完成" }] };
    let round = 0;
    const f = await fixture((init) => {
      const body = JSON.parse(String(init?.body));
      const current = round++;
      if (current > 0) {
        expect(body.input).toContainEqual(todo);
        expect(body.input).toContainEqual({ type: "function_call_output", call_id: todo.call_id, output: "todo updated" });
      }
      if (current > 1) {
        expect(body.input).toContainEqual(context);
        expect(body.input).toContainEqual(search);
        expect(body.input).toContainEqual(image);
        expect(body.input).toContainEqual({ type: "function_call_output", call_id: image.call_id, output: "image created" });
      }
      const events = current === 0 ? [
        { type: "response.output_item.done", output_index: 0, item: todo },
        { type: "response.completed", response: { status: "completed", output: [todo] } },
      ] : current === 1 ? [
        { type: "response.output_item.done", output_index: 0, item: context },
        { type: "response.output_item.done", output_index: 17, item: search },
        { type: "response.output_item.added", output_index: 18, item: { type: "function_call", id: image.id, call_id: image.call_id, arguments: "" } },
        { type: "response.function_call_arguments.delta", output_index: 18, item_id: image.id, delta: image.arguments },
        { type: "response.function_call_arguments.done", output_index: 18, item_id: image.id, name: image.name, arguments: image.arguments },
        { type: "response.completed", response: { status: "completed", output: [context] } },
      ] : [
        { type: "response.output_text.delta", delta: "完成" },
        { type: "response.completed", response: { status: "completed", output: [text] } },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
    });
    const config = { provider: "ChatGPT（OpenAI）订阅", model: "gpt-6.1-sol", apiKey: "oauth-subscription", baseUrl: `http://127.0.0.1:${f.port}/v1`, explicitTransport: "responses" as const };
    const adapter = getAdapterForConfig(config);
    const statuses = vi.fn();
    let messages: ChatMessage[] = [{ role: "user", content: "generate a character image" }];
    for (let index = 0; index < 3; index += 1) {
      const response = await runModelRequestWithRetry((attempt) => streamChatWithSdk({
        adapter, config, request: { model: config.model, messages }, signal: attempt.signal, timeoutMs: 10_000,
        onStreamActivity: attempt.onStreamActivity,
      }, localSdk), { provider: adapter.id, model: config.model, maxRetries: 5, idleTimeoutMs: 60_000, onStatus: statuses });
      if (index < 2) messages = adapter.appendToolResults([...messages, response.assistantMessage], [{
        toolCall: response.toolCalls[0], success: true, output: index === 0 ? "todo updated" : "image created",
      }]);
      else expect(response.text).toBe("完成");
    }
    expect(f.upstream).toHaveBeenCalledTimes(3);
    expect(statuses).not.toHaveBeenCalled();
  });

  it.each([
    ["chatgpt", "gpt-6.1-sol", "/v1/responses"],
    ["claude", "claude-sonnet-4-6", "/v1/messages"],
    ["grok", "grok-4.6", "/v1/responses"],
  ])("preserves %s admission errors as JSON before streaming starts", async (provider, model, route) => {
    const f = await fixture(() => new Response(JSON.stringify({ error: {
      message: "Permission denied", code: "forbidden", type: "permission_error", param: "model", access_token: "must-not-forward",
    } }), { status: 403, headers: { "x-request-id": "req-proxy-1", "retry-after": "5", "set-cookie": "private=session", "authorization": "Bearer private" } }));
    const response = await localFetch(`http://127.0.0.1:${f.port}${route}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true, messages: [] }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toBe("req-proxy-1");
    expect(response.headers.get("retry-after")).toBe("5");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("authorization")).toBeNull();
    expect(await response.json()).toEqual({ error: {
      message: "Permission denied", code: "forbidden", type: "permission_error", param: "model", provider, request_id: "req-proxy-1",
    } });
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });

  it("round-trips a 403 through the real SDK and host retry runner without repeating the request", async () => {
    const f = await fixture(() => new Response(JSON.stringify({ detail: "This model is unavailable for this account" }), {
      status: 403, headers: { "x-request-id": "req-admission-1" },
    }));
    const config = { provider: "ChatGPT（OpenAI）订阅", model: "gpt-6.1-sol", baseUrl: `http://127.0.0.1:${f.port}/v1`, apiKey: "oauth-subscription", explicitTransport: "responses" as const };
    const adapter = getAdapterForConfig(config);
    const statuses = vi.fn();
    const promise = runModelRequestWithRetry((attempt) => streamChatWithSdk({
      adapter, config, request: { model: config.model, messages: [{ role: "user", content: "hello" }] },
      signal: attempt.signal, timeoutMs: 10_000, onStreamActivity: attempt.onStreamActivity,
    }, {
      responses: async ({ client: options, body, signal }) => {
        const client = new OpenAI({ ...options, fetch: localFetch });
        return await client.responses.create({ ...body, stream: true } as never, { signal }) as unknown as AsyncIterable<unknown>;
      },
      openAI: async () => { throw new Error("unexpected transport"); },
      anthropic: async () => { throw new Error("unexpected transport"); },
    }), { provider: adapter.id, model: config.model, maxRetries: 5, idleTimeoutMs: 60_000, onStatus: statuses });
    await expect(promise).rejects.toMatchObject({ modelFailure: {
      provider: "chatgpt", category: "PERMISSION", status: 403, requestId: "req-admission-1", retryable: false,
      providerMessage: "This model is unavailable for this account",
    } });
    expect(f.upstream).toHaveBeenCalledTimes(1);
    expect(statuses).not.toHaveBeenCalled();
  });

  it.each(["Permission denied for web_search", "web_search is not available for this account"])("does not replay a 403 denial even when it mentions native search: %s", async (message) => {
    const f = await fixture(() => new Response(JSON.stringify({ error: { code: "chatpass_v2_scope_not_authorized", message } }), { status: 403 }));
    const response = await localFetch(`http://127.0.0.1:${f.port}/v1/responses`, {
      method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", stream: false }),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("chatpass_v2_scope_not_authorized");
    expect(f.upstream).toHaveBeenCalledTimes(1);
  });

  it("redacts credential echoes and handles non-JSON HTML errors without displaying their contents", async () => {
    let html = false;
    const f = await fixture(() => new Response(html ? "<!doctype html><script>private-challenge</script>" : JSON.stringify({ error: {
      message: "Denied Bearer secret-token sk-private-key cookie: private-session, test@example.com account_id: account_private1234",
    } }), { status: 403 }));
    for (const mode of [false, true]) {
      html = mode;
      const response = await localFetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", stream: true }) });
      const text = await response.text();
      expect(text).not.toMatch(/secret-token|sk-private-key|private-session|test@example.com|account_private1234|private-challenge|<script>/);
      expect(JSON.parse(text).error.message).toBeTruthy();
    }
    expect(f.log.mock.calls.join(" ")).not.toMatch(/private-session|secret-token/);
  });

  it("bounds oversized upstream error bodies", async () => {
    const f = await fixture(() => new Response("x".repeat(100_000), { status: 502 }));
    const response = await localFetch(`http://127.0.0.1:${f.port}/v1/responses`, { method: "POST", body: JSON.stringify({ model: "gpt-6.1-sol", stream: true }) });
    expect(response.status).toBe(502);
    expect((await response.text()).length).toBeLessThan(1500);
  });
});
