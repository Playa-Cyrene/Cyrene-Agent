import { describe, expect, it } from "vitest";
import { createStreamActivityFetch } from "./stream-activity-fetch";

describe("响应数据活动监测", () => {
  it("数据、状态、响应头和网络元数据原样保留，仅非空数据报告活动", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([97]));
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array([98, 99]));
        controller.close();
      },
    });
    const source = new Response(body, { status: 206, statusText: "Partial Content", headers: { "x-request-id": "kept" } });
    Object.defineProperties(source, {
      url: { value: "https://host.test/stream" }, redirected: { value: true }, type: { value: "basic" },
    });
    let activityCount = 0;
    const response = await createStreamActivityFetch(() => { activityCount++; }, async () => source)("https://host.test/stream");

    expect(await response.text()).toBe("abc");
    expect(activityCount).toBe(2);
    expect(response.status).toBe(206);
    expect(response.statusText).toBe("Partial Content");
    expect(response.headers.get("x-request-id")).toBe("kept");
    expect(response.url).toBe("https://host.test/stream");
    expect(response.redirected).toBe(true);
    expect(response.type).toBe("basic");
  });

  it("没有响应体时直接返回响应且不报告活动", async () => {
    const source = new Response(null, { status: 204 });
    let activityCount = 0;
    const response = await createStreamActivityFetch(() => { activityCount++; }, async () => source)("https://host.test/stream");
    expect(response).toBe(source);
    expect(activityCount).toBe(0);
  });

  it("下游取消会传给原始响应流", async () => {
    let cancelled: unknown;
    const source = new Response(new ReadableStream<Uint8Array>({ cancel(reason) { cancelled = reason; } }));
    const response = await createStreamActivityFetch(() => {}, async () => source)("https://host.test/stream");
    await response.body!.cancel("user-cancelled");
    expect(cancelled).toBe("user-cancelled");
  });

  it("原始流读取错误原样传给下游", async () => {
    const error = new Error("connection dropped");
    const source = new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(error); } }));
    const response = await createStreamActivityFetch(() => {}, async () => source)("https://host.test/stream");
    await expect(response.text()).rejects.toBe(error);
  });
});
