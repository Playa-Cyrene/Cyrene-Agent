import { describe, expect, it } from "vitest";
import { isExplicitStreamUnsupported } from "./stream-support";

describe("SDK 流式能力拒绝", () => {
  it("识别 SDK 错误中的原始拒绝响应体", () => {
    expect(isExplicitStreamUnsupported({ cause: { statusCode: 400, message: "Bad Request", responseBody: "stream unsupported" } })).toBe(true);
  });
  it("服务器故障不能触发非流式重发", () => {
    expect(isExplicitStreamUnsupported({ statusCode: 503, message: "Service Unavailable", responseBody: "stream unsupported" })).toBe(false);
  });
});
