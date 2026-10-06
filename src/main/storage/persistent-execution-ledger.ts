import { getConversationDatabase } from "./conversation-database-client";
import { ExecutionLedger } from "../orchestrator/execution-ledger";
import type { ToolExecutionOutcome } from "../orchestrator/types";
/** Production receipts become successful in the same transaction as the canonical tool result. */
export function createPersistentExecutionLedger(root: string, conversationId: string): ExecutionLedger {
  const database = getConversationDatabase(root);
  return new ExecutionLedger({
    begin: (id, fingerprint) => database.call<{
      outcome: ToolExecutionOutcome;
    } | null>("tools.begin", conversationId, id, fingerprint),
    finish: (id, fingerprint, outcome) => database.call("tools.finish", conversationId, id, fingerprint, outcome, true),
  });
}
