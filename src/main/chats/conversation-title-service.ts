import type { ChatSession } from "../../shared/chat-types";
import type { ModelSettings } from "../settings/model-settings";
import type { LlmClient } from "../services/llm/llm-client";

const TITLE_GENERATION_DELAY_MS = 3_000;
const TITLE_PROMPT = "你是一个标题生成器，根据下面的文字生成一个5-8个字的标题。只输出标题，不要解释，不要添加引号。";

export function normalizeGeneratedTitle(raw: string): string | null {
  const firstLine = raw.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
  const title = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:会话)?标题\s*[:：]\s*/, "")
    .replace(/^(?:\*\*|__|`)+|(?:\*\*|__|`)+$/g, "")
    .replace(/^[“”"'「」『』《》【】（）()\[\]]+|[“”"'「」『』《》【】（）()\[\]]+$/g, "")
    .replace(/[。！？!?，,；;：:]+$/g, "")
    .replace(/\s+/g, "")
    .trim();
  const length = Array.from(title).length;
  return length >= 5 && length <= 8 ? title : null;
}

export interface ConversationTitleService {
  schedule(input: { sessionId: string; userMessageId: string; text: string }): boolean;
}

export interface ConversationTitleServiceDependencies {
  getSession(sessionId: string): ChatSession | null;
  setGeneratedTitle(sessionId: string, userMessageId: string, title: string): boolean;
  resolveSettings(session: ChatSession): ModelSettings;
  isPrimaryModelBusy?(): boolean;
  llmClient: Pick<LlmClient, "chatNonStream">;
  enqueueTask<T>(label: string, task: () => Promise<T>): Promise<T>;
  onTitleChanged(sessionId: string): void;
}

export function createConversationTitleService(
  deps: ConversationTitleServiceDependencies,
): ConversationTitleService {
  const attemptedSessions = new Set<string>();

  function enqueueWhenIdle(input: { sessionId: string; userMessageId: string; text: string }): void {
    if (!deps.getSession(input.sessionId)) return;
    if (deps.isPrimaryModelBusy?.()) {
      setTimeout(() => enqueueWhenIdle(input), TITLE_GENERATION_DELAY_MS);
      return;
    }
    void deps.enqueueTask(`会话标题:${input.sessionId}`, async () => {
      const latest = deps.getSession(input.sessionId);
      if (!latest || latest.titleIsCustom) return;
      const settings = deps.resolveSettings(latest);
      if (!settings.baseUrl || !settings.model) return;
      const response = await deps.llmClient.chatNonStream(
        settings,
        [
          { role: "system", content: TITLE_PROMPT },
          { role: "user", content: input.text.trim() },
        ],
        undefined,
        15_000,
        "ConversationTitle",
        { mode: "off" },
        { maxTokens: 32 },
      );
      const title = normalizeGeneratedTitle(response.text);
      if (title && deps.setGeneratedTitle(input.sessionId, input.userMessageId, title)) {
        deps.onTitleChanged(input.sessionId);
      }
    }).catch((error) => {
      console.warn("[ConversationTitle] 标题生成失败，保留临时标题:", error);
    });
  }

  return {
    schedule(input): boolean {
      if (attemptedSessions.has(input.sessionId)) return false;
      const current = deps.getSession(input.sessionId);
      const firstUserMessage = current?.messages.find(
        (message) => message.role === "user" && message.content.trim(),
      );
      if (!current || current.titleIsCustom || firstUserMessage?.id !== input.userMessageId || !input.text.trim()) {
        return false;
      }

      attemptedSessions.add(input.sessionId);
      setTimeout(() => enqueueWhenIdle(input), TITLE_GENERATION_DELAY_MS);
      return true;
    },
  };
}
