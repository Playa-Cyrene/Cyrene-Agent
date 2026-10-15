import { app } from "electron"
import { getConversationDatabase } from "../storage/conversation-database-client"
import type { MemoryPendingStore } from "./memory-pending-types"

// Lazy: importing the scheduler must not open a production database (including tests).
export const memoryPendingTurns: MemoryPendingStore = {
  record: (turn, legacyCount) => getConversationDatabase(app.getPath("userData")).call("memory.record", turn, legacyCount),
  batch: (conversationId, throughSeq) => getConversationDatabase(app.getPath("userData")).call("memory.batch", conversationId, throughSeq),
  current: turns => getConversationDatabase(app.getPath("userData")).call("memory.current", turns),
  consume: batch => getConversationDatabase(app.getPath("userData")).call("memory.consume", batch),
  count: () => getConversationDatabase(app.getPath("userData")).call("memory.count"),
}
