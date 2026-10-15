// Orchestrator Context Builder — post-chat 副作用（记忆写入 + Reflection）
import { memoryScheduler } from "../memory/memory-scheduler";
import { isMemoryEnabled } from "../memory/memory-mode";
import type { MemoryTurnSource } from "../memory/memory-pending-types";

export async function scheduleMemoryWrite(userInput: string, assistantReply: string, conversationId?: string, source?: MemoryTurnSource): Promise<void> {
  if (!isMemoryEnabled()) return;
  await memoryScheduler.scheduleMemoryWrite(userInput, assistantReply, conversationId, source);
}
