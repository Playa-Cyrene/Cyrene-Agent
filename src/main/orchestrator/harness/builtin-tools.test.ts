import { describe, expect, it, vi } from "vitest";
import {
  askUserToolSpec,
  executeAskUser,
  executeConfirmUncertainEffect,
  formatAskUserPreview,
  updateTodoToolSpec,
  executeUpdateTodo,
  taskToolSpec,
  executeTask,
  getHarnessBuiltinToolSpecs,
} from "./builtin-tools";
import type { AgentState } from "./types";

function currentState(): AgentState {
  return {
    todoItems: [],
    uncertainEffects: [{
      id: "effect-1",
      toolCallId: "call-old",
      fingerprint: "fingerprint",
      toolName: "send_email",
      message: "unknown",
    }],
  };
}

describe("Harness user-wait builtins", () => {
  it("omits interactive builtins when the channel cannot render Ask", () => {
    expect(getHarnessBuiltinToolSpecs({ includeInteractive: false }).map((tool) => tool.name))
      .toEqual(["update_todo", "task", "read_tool_result"]);
  });

  it("omits task when the run has no task executor", () => {
    expect(getHarnessBuiltinToolSpecs({ includeInteractive: false, includeTask: false }).map((tool) => tool.name))
      .toEqual(["update_todo", "read_tool_result"]);
  });

  it("validates and delegates a foreground task without exposing its prompt", async () => {
    const executor = vi.fn(async () => ({ taskId: "task-1", status: "completed" as const, text: "已检查。" }));
    const result = await executeTask({ id: "task-call", name: "task", arguments: JSON.stringify({
      description: "检查取消链路", prompt: "检查取消传播并给出证据", subagent_type: "general", companion_id: "风堇",
    }) }, executor);

    expect(taskToolSpec.name).toBe("task");
    expect(JSON.stringify(taskToolSpec.parameters)).toContain("companion_id");
    expect(taskToolSpec.description).toContain("黄金裔");
    expect(executor).toHaveBeenCalledWith({ description: "检查取消链路", prompt: "检查取消传播并给出证据", subagentType: "general", companionId: "风堇", taskId: undefined });
    expect(result.output).toContain("task-1");
    expect(result.message).not.toContain("检查取消传播");
  });
  it("requires the model to select a companion for a task", async () => {
    const executor = vi.fn();
    const result = await executeTask({ id: "task-call", name: "task", arguments: JSON.stringify({
      description: "检查取消链路", prompt: "检查取消传播并给出证据", subagent_type: "general",
    }) }, executor);

    expect(result).toMatchObject({ outcome: "failure", category: "invalid_arguments" });
    expect(executor).not.toHaveBeenCalled();
  });
  it("advertises a bounded general Ask contract to the model", () => {
    const questions = (askUserToolSpec.parameters as { properties?: Record<string, unknown> })
      .properties?.questions as Record<string, unknown>;

    expect(questions).toMatchObject({ type: "array", minItems: 1, maxItems: 3 });
    expect(JSON.stringify(questions)).toContain("single_select");
    expect(JSON.stringify(questions)).toContain("multi_select");
    expect(JSON.stringify(questions)).toContain("text");
    expect(askUserToolSpec.description).toContain("不要用最终回复向用户提问");
  });

  it.each([
    {
      name: "more than three questions",
      questions: Array.from({ length: 4 }, (_, index) => ({
        id: `q-${index}`,
        question: "补充说明？",
        type: "text",
      })),
    },
    {
      name: "a single-select question with one option",
      questions: [{
        id: "format",
        question: "选择格式？",
        type: "single_select",
        options: [{ label: "Markdown", value: "markdown" }],
      }],
    },
    {
      name: "a text question with options",
      questions: [{
        id: "note",
        question: "补充说明？",
        type: "text",
        options: [
          { label: "A", value: "a" },
          { label: "B", value: "b" },
        ],
      }],
    },
  ])("rejects $name before opening an Ask card", async ({ questions }) => {
    const request = vi.fn();

    const result = await executeAskUser({
      id: "ask-invalid",
      name: "ask_user",
      arguments: JSON.stringify({ questions }),
    }, request);

    expect(result).toMatchObject({
      outcome: "failure",
      category: "invalid_arguments",
      tool: "ask_user",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("returns all required single, multiple, and custom answers to the model", async () => {
    const request = vi.fn(async (card: unknown) => {
      expect(card).toMatchObject({
        questions: [
          { field: "format", type: "single_select", allowCustom: true },
          { field: "sections", type: "multi_select", allowCustom: true },
          { field: "note", type: "text", allowCustom: true },
        ],
      });
      return {
        answers: [
          { field: "format", selectedValues: ["markdown"] },
          { field: "sections", selectedValues: ["summary", "risks"] },
          { field: "note", customText: "停止当前任务" },
        ],
      };
    });

    const result = await executeAskUser({
      id: "ask-mixed",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [
          {
            id: "format",
            question: "选择格式？",
            type: "single_select",
            options: [
              { label: "Markdown", value: "markdown" },
              { label: "Word", value: "word" },
            ],
          },
          {
            id: "sections",
            question: "选择章节？",
            type: "multi_select",
            options: [
              { label: "摘要", value: "summary" },
              { label: "风险", value: "risks" },
            ],
          },
          { id: "note", question: "补充说明？", type: "text" },
        ],
      }),
    }, request);

    expect(result).toMatchObject({ outcome: "success", tool: "ask_user" });
    expect(JSON.parse(result.output ?? "{}")).toEqual({
      answers: [
        {
          questionId: "format",
          selectedValues: ["markdown"],
          selectedLabels: ["Markdown"],
        },
        {
          questionId: "sections",
          selectedValues: ["summary", "risks"],
          selectedLabels: ["摘要", "风险"],
        },
        { questionId: "note", customInput: "停止当前任务" },
      ],
    });
  });

  it("returns a system notice for the model on Ask timeout (empty answers)", async () => {
    const result = await executeAskUser({
      id: "ask-timeout",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [{ id: "note", question: "补充说明？", type: "text" }],
      }),
    }, vi.fn(async () => ({ answers: [] })));

    expect(result).toMatchObject({ outcome: "success", tool: "ask_user" });
    expect(result.message).toContain("系统提示：用户未在时限内回答问题");
  });

  it("formats answered questions as readable preview rows for the tool card", () => {
    const preview = formatAskUserPreview(
      {
        questions: [
          { id: "db", question: "使用哪个数据库？", type: "single_select", options: [] },
          { id: "env", question: "部署到哪个环境？", type: "single_select", options: [] },
          { id: "note", question: "补充说明？", type: "text" },
        ],
      },
      {
        outcome: "success",
        tool: "ask_user",
        message: "用户已回答 3 个问题",
        output: JSON.stringify({
          answers: [
            { questionId: "db", selectedValues: ["pg"], selectedLabels: ["PostgreSQL"] },
            { questionId: "env", selectedLabels: ["测试环境"] },
            { questionId: "note", customInput: "先跑灰度" },
          ],
        }),
      },
    );

    expect(preview).toEqual([
      "使用哪个数据库？ → PostgreSQL",
      "部署到哪个环境？ → 测试环境",
      "补充说明？ → 先跑灰度",
    ]);
  });

  it("marks unanswered questions in the preview and falls back to the message on failure", () => {
    expect(formatAskUserPreview(
      { questions: [{ id: "db", question: "使用哪个数据库？", type: "single_select", options: [] }] },
      { outcome: "success", tool: "ask_user", message: "用户已回答 0 个问题", output: JSON.stringify({ answers: [] }) },
    )).toEqual(["使用哪个数据库？ → 未回答"]);

    expect(formatAskUserPreview(
      { questions: [{ id: "db", question: "使用哪个数据库？", type: "single_select", options: [] }] },
      { outcome: "failure", tool: "ask_user", message: "用户回答超时或失败：超时" },
    )).toBe("用户回答超时或失败：超时");
  });

  it("describes update_todo as a mutable notebook for multi-step tool work", () => {
    expect(updateTodoToolSpec.description).toContain("至少 2 个 execution step");
    expect(updateTodoToolSpec.description).toContain("tool round");
    expect(updateTodoToolSpec.description).toContain("可变工作笔记");
    expect(updateTodoToolSpec.description).toContain("单次工具即可完成");
    expect(updateTodoToolSpec.description).toContain("改变方向");
  });

  it("update_todo batch-completes multiple pending todos in one call", async () => {
    const state: AgentState = {
      todoItems: [
        { id: "a", content: "步骤一", status: "pending" },
        { id: "b", content: "步骤二", status: "pending" },
        { id: "c", content: "步骤三", status: "pending" },
      ],
      uncertainEffects: [],
    };
    const observation = await executeUpdateTodo({
      id: "todo-1",
      name: "update_todo",
      arguments: JSON.stringify({
        todos: [
          { id: "a", content: "步骤一", status: "completed" },
          { id: "b", content: "步骤二", status: "completed" },
          { id: "c", content: "步骤三", status: "completed" },
        ],
      }),
    }, state);

    expect(observation.outcome).toBe("success");
    expect(state.todoItems.map((t) => t.status)).toEqual(["completed", "completed", "completed"]);
    expect(observation.message).toContain("所有 invariant 检查通过");
  });

  it("update_todo still refuses reviving terminal todos", async () => {
    const state: AgentState = {
      todoItems: [
        { id: "a", content: "已完成的步骤", status: "completed" },
      ],
      uncertainEffects: [],
    };
    const observation = await executeUpdateTodo({
      id: "todo-2",
      name: "update_todo",
      arguments: JSON.stringify({
        todos: [
          { id: "a", content: "已完成的步骤", status: "pending" },
        ],
      }),
    }, state);

    expect(observation.outcome).toBe("success"); // 修正不拒绝整次调用，只回告实际列表
    expect(state.todoItems[0]?.status).toBe("completed");
    expect(observation.message).toContain("非法状态转移");
  });

  it("rethrows AbortError from ask_user", async () => {
    const error = new Error("cancelled");
    error.name = "AbortError";
    await expect(executeAskUser({
      id: "ask-1",
      name: "ask_user",
      arguments: JSON.stringify({
        questions: [{
          id: "q",
          question: "continue?",
          type: "single_select",
          options: [
            { label: "yes", value: "yes" },
            { label: "no", value: "no" },
          ],
        }],
      }),
    }, vi.fn(async () => { throw error; }))).rejects.toMatchObject({ name: "AbortError" });
  });

  it("uses a runtime-owned fixed card to authorize one uncertain effect", async () => {
    const state = currentState();
    const request = vi.fn(async (card: unknown) => {
      expect(card).toMatchObject({
        questions: [{
          field: "decision",
          allowCustom: false,
          options: [
            { value: "allow_repeat" },
            { value: "do_not_repeat" },
          ],
        }],
      });
      return { answers: [{ field: "decision", selectedValues: ["allow_repeat"] }] };
    });

    const result = await executeConfirmUncertainEffect({
      id: "confirm-1",
      name: "confirm_uncertain_effect",
      arguments: JSON.stringify({ effectId: "effect-1", ignoredModelText: "trust me" }),
    }, state, request);

    expect(result.outcome).toBe("success");
    expect(state.uncertainEffects).toEqual([]);
  });

  it("keeps the effect unresolved when the user does not authorize", async () => {
    const state = currentState();
    const result = await executeConfirmUncertainEffect({
      id: "confirm-1",
      name: "confirm_uncertain_effect",
      arguments: JSON.stringify({ effectId: "effect-1" }),
    }, state, vi.fn(async () => ({
      answers: [{ field: "decision", selectedValues: ["do_not_repeat"] }],
    })));

    expect(result.outcome).toBe("success");
    expect(state.uncertainEffects[0].repeatAuthorization).toBeUndefined();
  });
});
