import fs from "node:fs";
import ts from "typescript";
import { expect, it, vi } from "vitest";
const source = fs.readFileSync(new URL("./ChatPage.tsx", import.meta.url), "utf8");
const send = source.slice(source.indexOf("  async function sendMessage("), source.indexOf("  async function enqueueAndConsumeDraft("));
const queue = source.slice(source.indexOf("  async function queueCurrentDraft("), source.indexOf("\n  }", source.indexOf("  async function queueCurrentDraft(")) + 4);
it.each([false, true])("deduplicates and orders drafts, releasing failed predecessors (failFirst=%s)", async failFirst => {
  const submissions = { current: new Map() };
  const submissionTails = { current: new Map() };
  const persisted: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let finish!: () => void;
  const consume = new Promise<void>(resolve => { finish = resolve; });
  const deps = { submissions, submissionTails, mode: "chat", scopeKey: "session", attachments: [],
    crypto: { randomUUID: (() => { let n = 0; return () => String(++n); })() },
    parseComposerMessage: (_mode: string, content: string) => ({ rawContent: content }),
    updateSubmittingDraft: (id: string, value?: unknown) => value ? submissions.current.set(id, value) : submissions.current.delete(id),
    enqueueAndConsumeDraft: async (id: string, draft: any, _parsed: unknown, committed: () => void) => {
      await barrier;
      if (failFirst && draft.content === "A") throw new Error("enqueue failed");
      persisted.push(draft.content);
      submissions.current.set(id, { ...draft, committedId: id });
      committed();
      await consume;
    }, feedback: { notice: vi.fn() }, t: (s: string) => s,
  };
  const code = ts.transpileModule(send + queue + ";return {sendMessage, queueCurrentDraft};", { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const api = new Function(...Object.keys(deps), code)(...Object.values(deps));
  const a = api.sendMessage("A");
  const duplicate = api.queueCurrentDraft("A");
  const b = api.queueCurrentDraft("B");
  await duplicate;
  expect(persisted).toEqual([]);
  release();
  await vi.waitFor(() => expect(persisted).toEqual(failFirst ? ["B"] : ["A", "B"]));
  finish();
  await Promise.all([a, b]);
  expect(submissionTails.current.size).toBe(0);
});
