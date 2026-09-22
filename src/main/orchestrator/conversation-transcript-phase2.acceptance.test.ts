import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IPC } from "../../shared/ipc-channels";
import { ConversationJournalService } from "./conversation-journal-service";
import { ConversationTranscriptCompactor } from "./conversation-transcript-compactor";
import { ConversationTranscriptStore } from "./conversation-transcript-store";
import { buildAgentRunOptions, type BuildOptionsDeps } from "./build-options";
import { prepareHarnessRecoveryState } from "./harness/run-recovery";
import { HarnessRunStore } from "./harness/run-store";
import { ChannelDispatcher } from "../channels/dispatcher";
import { createChannelContext } from "../channels/channel-context";
import { createKeyedQueue } from "../channels/keyed-queue";
import { createChannelRateLimiter } from "../channels/rate-limiter";
import type { IncomingMessage } from "../channels/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function buildOptionsDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "model", apiKey: "key", contextWindowTokens: 256_000 }),
    loadGeneralSettings: () => ({ currentStyleId: "default", customStyle: {} }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "",
    buildSkillCatalog: () => "",
    buildAutoInjectedSkillContext: () => "",
    skillRegistry: {
      getEnabled: () => [],
      getEnabledForMode: () => [],
      getBody: () => null,
    },
    resolveSlashActivation: () => "",
    buildToneInjection: () => "",
    buildAlwaysOnContext: async () => "",
    buildRelationshipContext: async () => "",
    buildModePrompt: (mode) => `mode:${mode}`,
    buildToolSystemPrompt: () => "",
    buildSoulSystemBasePrompt: () => "",
    readStylePrompt: () => "",
    resolveSoulSampling: () => ({}),
    toolRegistry: {
      getEnabled: () => [],
      getEnabledToolsForMode: () => [],
    },
    normalizeChatMessages: () => [],
    chatRequestTimeoutMs: 1_000,
  };
}

function assertCanonicalContinuity(
  messages: Array<{ role: string; content?: unknown }>,
  options: { compacted?: boolean; expectSecond?: boolean } = {},
): void {
  const userContents = messages.filter((message) => message.role === "user").map((message) => message.content);
  if (options.expectSecond) expect(userContents).toContain("second turn");
  if (!options.compacted) expect(userContents.some((content) => String(content).startsWith("edited first turn"))).toBe(true);
  expect(messages.filter((message) => message.role === "assistant").length).toBeGreaterThan(0);
  expect(new Set(messages.map((message) => `${message.role}:${String(message.content)}`)).size).toBe(messages.length);
}

async function appendAssistant(
  journal: ConversationJournalService,
  conversationId: string,
  runId: string,
  text: string,
  toolCall = false,
): Promise<void> {
  const sink = journal.createRunSink({ conversationId, runId, assistantTurnId: `${runId}:assistant` });
  const assistantEntryId = await sink.appendAssistant({
    message: {
      role: "assistant",
      content: text,
      ...(toolCall ? { toolCalls: [{ id: `${runId}:tool`, name: "send_email", arguments: '{"to":"user@example.test"}' }] } : {}),
    },
  });
  if (!toolCall) {
    await sink.checkpoint();
    return;
  }
  const runSession = {
    schemaVersion: 1 as const,
    conversationId,
    runId,
    status: "interrupted" as const,
    messages: [],
    state: { todoItems: [], uncertainEffects: [] },
    toolOutputs: [],
    toolCalls: [{
      toolCallId: `${runId}:tool`,
      toolName: "send_email",
      sideEffect: "non_idempotent_side_effect" as const,
      status: "started" as const,
      updatedAt: Date.now(),
    }],
    rounds: 1,
    cache: { cacheEpoch: 1, epochReason: "run_start" as const },
    request: {
      provider: "test", model: "model", contextWindowTokens: 256_000,
      promptFingerprint: "p", toolSchemaFingerprint: "t",
    },
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await sink.closeInterruption({ reason: "user_cancel", runSession });
  expect(assistantEntryId).toContain(runId);
}

async function runDesktopMode(mode: "chat" | "work" | "code" | "learn"): Promise<void> {
  const root = makeRoot(`cyrene-cta-phase2-${mode}-`);
  const store = new ConversationTranscriptStore(root);
  const journal = new ConversationJournalService({
    store,
    runReader: { get: (runId) => new HarnessRunStore(root).get(runId) },
  });
  const conversationId = `${mode}-conversation`;

  await journal.appendUser(conversationId, { id: "u1", turnId: "u1", text: "first turn\n" + "old details ".repeat(200) });
  await appendAssistant(journal, conversationId, "run-first", "first answer ".repeat(100));
  await journal.appendRewind(conversationId, {
    anchorUserTurnId: "u1", disposition: "replace_user", runId: "run-edit",
    replacementUser: { turnId: "u1", text: "edited first turn\n" + "edited details ".repeat(200) },
  });
  await appendAssistant(journal, conversationId, "run-edited", "edited answer ".repeat(100));
  await journal.appendRewind(conversationId, {
    anchorUserTurnId: "u1", disposition: "keep_user", runId: "run-regenerate",
  });

  const runStore = new HarnessRunStore(root);
  const run = runStore.create({
    conversationId,
    runId: "run-regenerate",
    messages: [{
      role: "assistant", content: "regenerate", toolCalls: [{ id: "run-regenerate:tool", name: "send_email", arguments: '{"to":"user@example.test"}' }],
    }],
    request: { provider: "test", model: "model", contextWindowTokens: 256_000, promptFingerprint: "p", toolSchemaFingerprint: "t" },
  });
  runStore.recordTool(run.runId, {
    toolCallId: "run-regenerate:tool", toolName: "send_email",
    sideEffect: "non_idempotent_side_effect", status: "started",
  });
  const restartedRuns = new HarnessRunStore(root);
  const interrupted = restartedRuns.get(run.runId);
  expect(interrupted?.status).toBe("interrupted");
  const recovered = prepareHarnessRecoveryState(interrupted!, { conversationId });
  expect(recovered.uncertainEffects).toEqual([expect.objectContaining({ toolCallId: "run-regenerate:tool", toolName: "send_email" })]);

  await appendAssistant(journal, conversationId, "run-regenerate", "regenerated answer ".repeat(100), true);

  const beforeCompaction = await journal.buildModelContext(conversationId);
  expect(beforeCompaction.messages.some((message) => (
    message.role === "tool" && typeof message.content === "string" && message.content.includes('"outcome":"unknown"')
  ))).toBe(true);
  assertCanonicalContinuity(beforeCompaction.messages);

  await appendAssistant(journal, conversationId, "run-tail", "tail marker");

  const compactor = new ConversationTranscriptCompactor({ store, summarize: async () => "summary of the completed and interrupted work" });
  await compactor.compact({ conversationId, trigger: "manual", retainTokens: 20 });

  // A new turn after the checkpoint proves the active suffix remains visible after restart.
  await journal.appendUser(conversationId, { id: "u2", turnId: "u2", text: "second turn" });
  await appendAssistant(journal, conversationId, "run-second", "second answer ".repeat(100));

  const afterRestart = new ConversationJournalService(new ConversationTranscriptStore(root));
  const afterCompaction = await afterRestart.buildModelContext(conversationId);
  assertCanonicalContinuity(afterCompaction.messages, { compacted: true, expectSecond: true });
  expect(afterCompaction.messages.some((message) => typeof message.content === "string" && message.content.includes("cyrene_compaction_checkpoint"))).toBe(true);

  const built = await buildAgentRunOptions({
    sessionId: conversationId,
    mode,
    executionMode: mode === "chat" ? "chat" : "work",
    currentUser: { turnId: "u2", text: "second turn", visibleContent: "second turn" },
    modelContext: afterCompaction,
  }, buildOptionsDeps());
  assertCanonicalContinuity(built.options.messages, { compacted: true, expectSecond: true });
  expect(built.latestUserText).toBe("second turn");
}

describe("CTA Phase 2 production acceptance", () => {
  it.each(["chat", "work", "code", "learn"] as const)(
    "%s keeps canonical continuity through edit, regenerate, cancel, restart and compaction",
    async (mode) => runDesktopMode(mode),
  );

  it("channel dispatcher writes and reads the same production journal context", async () => {
    const root = makeRoot("cyrene-cta-phase2-channel-");
    const journal = new ConversationJournalService(new ConversationTranscriptStore(root));
    const observed: string[][] = [];
    const incoming: IncomingMessage = {
      channel: "qq",
      chatType: "private",
      chatId: "chat-1",
      senderId: "sender-1",
      text: "第一轮渠道问题",
      at: new Date("2026-09-21T00:00:00Z"),
    };
    const dispatcher = new ChannelDispatcher({
      queue: createKeyedQueue(),
      limiter: createChannelRateLimiter({ limits: { perUser: 10, perChannel: 10 } }),
      context: createChannelContext({ migrateHistory: () => undefined }),
      journal,
      composer: {
        compose: async ({ replyText }) => ({ message: { parts: [{ kind: "text", text: replyText }] }, assistantText: replyText, transientFiles: [] }),
        cleanupTransientFiles: async () => undefined,
      },
      delivery: { send: async (message) => ({ ok: true as const, message }) },
      buildAndRunAgent: async (_message, input) => {
        if (typeof input === "string") throw new Error("legacy channel input");
        observed.push(input.modelContext.messages.map((message) => String(message.content)));
        const assistantEntryId = await input.transcriptSink.appendAssistant({ message: { role: "assistant", content: "渠道回复" } });
        await journal.appendPresentation(input.target.conversationId, assistantEntryId, 1, { content: "渠道回复" });
        return { text: "渠道回复", sticker: null };
      },
      loadSettings: () => ({ enabled: true, mirrorToDesktop: false, rateLimitPerUser: 10, rateLimitPerChannel: 10, ttsEnabled: false, stickerEnabled: false, toolSandbox: "safe" }),
      loadGeneralSettings: () => ({}),
    });
    await dispatcher.handleIncoming(incoming);
    await dispatcher.handleIncoming({ ...incoming, messageId: "second", text: "第二轮引用第一轮" });
    expect(observed).toHaveLength(2);
    expect(observed[1]).toEqual(expect.arrayContaining(["第一轮渠道问题", "渠道回复", "第二轮引用第一轮"]));
  });

  it("does not expose retired desktop message IPC values", () => {
    expect(Object.values(IPC)).not.toEqual(expect.arrayContaining([
      "chats:append", "chats:upsert", "chats:set-message-tts-cache", "chats:replace-messages", "chats:replace-tail",
    ]));
  });
});
