import { describe, expect, it } from "vitest";
import { classifyToolError, classifyToolResultError } from "./error-classifier";
import { ToolExecutionError } from "../tools/registry/tool-execution-error";
import type { ToolCallResult } from "../types";

function makeResult(overrides: Partial<ToolCallResult> = {}): ToolCallResult {
  return { toolId: "read_file", args: {}, output: "", status: "failed", ...overrides };
}

function errorWith(name: string, message: string): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

describe("classifyToolError", () => {
  it("透传 ToolExecutionError 自带的 category（优先于任何文本匹配）", () => {
    const err = new ToolExecutionError("E_TOOL", "工具执行失败", "rate_limited", true);
    expect(classifyToolError(err)).toBe("rate_limited");
  });

  it("非 Error 值一律归为 transient", () => {
    expect(classifyToolError("boom")).toBe("transient");
    expect(classifyToolError(null)).toBe("transient");
    expect(classifyToolError(42)).toBe("transient");
    expect(classifyToolError({ message: "timeout" })).toBe("transient");
    expect(classifyToolError(undefined)).toBe("transient");
  });

  it("AbortError 归为 timeout（以 name 判定，不看消息内容）", () => {
    expect(classifyToolError(errorWith("AbortError", "This operation was aborted"))).toBe("timeout");
  });

  it.each([
    ["Request timeout after 30s", "timeout"],
    ["请求超时，请重试", "timeout"],
  ])("消息含超时关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it.each([
    ["EACCES: permission denied", "permission_denied"],
    ["权限不足，无法写入", "permission_denied"],
    ["operation not permitted, EPERM", "permission_denied"],
  ])("消息含权限关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it.each([
    ["File not found: /tmp/a.txt", "not_found"],
    ["ENOENT: no such file or directory", "not_found"],
    ["目标文件不存在", "not_found"],
  ])("消息含不存在关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it.each([
    ["rate limit exceeded", "rate_limited"],
    ["HTTP 429 Too Many Requests", "rate_limited"],
    ["触发速率限制", "rate_limited"],
  ])("消息含限流关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it.each([
    ["invalid argument: path must be string", "invalid_arguments"],
    ["EINVAL: invalid argument", "invalid_arguments"],
    ["参数错误：缺少必填字段", "invalid_arguments"],
  ])("消息含参数关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it.each([
    ["FATAL: unrecoverable crash", "fatal"],
    ["ENOMEM: out of memory", "fatal"],
    ["JavaScript heap out of memory", "fatal"],
  ])("消息含致命关键词 %s → %s", (message, expected) => {
    expect(classifyToolError(new Error(message))).toBe(expected);
  });

  it("其余 Error 默认归为 transient（网络抖动等）", () => {
    expect(classifyToolError(new Error("socket hang up"))).toBe("transient");
    expect(classifyToolError(new Error("完全无关的普通错误"))).toBe("transient");
  });
});

describe("classifyToolResultError", () => {
  it("结果自带 category 时直接采用（优先级最高）", () => {
    expect(classifyToolResultError(makeResult({ category: "fatal", errorCode: "TOOL_TIMEOUT" }))).toBe("fatal");
    expect(classifyToolResultError(makeResult({ category: "runtime_safety" }))).toBe("runtime_safety");
  });

  it.each([
    [{ errorCode: "TOOL_TIMEOUT" }, "timeout"],
    [{ output: "执行超时" }, "timeout"],
  ])("errorCode/output 含超时信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it.each([
    [{ errorCode: "PERMISSION_DENIED" }, "permission_denied"],
    [{ errorCode: "EPERM" }, "permission_denied"],
  ])("errorCode 含权限信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it.each([
    [{ errorCode: "NOT_FOUND" }, "not_found"],
    [{ errorCode: "ENOENT" }, "not_found"],
  ])("errorCode 含不存在信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it.each([
    [{ errorCode: "RATE_LIMIT" }, "rate_limited"],
    [{ errorCode: "HTTP_429" }, "rate_limited"],
  ])("errorCode 含限流信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it.each([
    [{ errorCode: "INVALID_ARG" }, "invalid_arguments"],
    [{ errorCode: "EINVAL" }, "invalid_arguments"],
  ])("errorCode 含参数信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it.each([
    [{ errorCode: "FATAL" }, "fatal"],
    [{ errorCode: "OOM" }, "fatal"],
  ])("errorCode 含致命信号 %j → %s", (overrides, expected) => {
    expect(classifyToolResultError(makeResult(overrides))).toBe(expected);
  });

  it("retryable=true 优先归为 transient", () => {
    expect(classifyToolResultError(makeResult({ retryable: true }))).toBe("transient");
    // retryable 优先于 terminal=false
    expect(classifyToolResultError(makeResult({ retryable: true, terminal: false }))).toBe("transient");
  });

  it("terminal=false 且不可重试归为 partial_failure", () => {
    expect(classifyToolResultError(makeResult({ terminal: false }))).toBe("partial_failure");
  });

  it("无任何信号时归为 semantic_failure（执行了但结果不对）", () => {
    expect(classifyToolResultError(makeResult({}))).toBe("semantic_failure");
    // terminal 默认 true 不影响
    expect(classifyToolResultError(makeResult({ terminal: true }))).toBe("semantic_failure");
  });
});
