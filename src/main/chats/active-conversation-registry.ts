import type { ConversationMode } from "../../shared/chat-types";

export interface ActiveConversationSelection {
  sessionId: string;
  mode?: ConversationMode;
}

interface Entry extends ActiveConversationSelection {
  updatedAt: number;
}

/**
 * Thin in-memory glue for choosing the most recently active chat window.
 * It deliberately owns no conversation state and emits no events.
 */
export class ActiveConversationRegistry {
  private readonly entries = new Map<number, Entry>();
  private clock = 0;

  set(windowId: number, sessionId: string | null, mode?: ConversationMode): void {
    if (!sessionId) {
      this.clearWindow(windowId);
      return;
    }
    this.entries.set(windowId, { sessionId, ...(mode ? { mode } : {}), updatedAt: ++this.clock });
  }

  getMostRecent(): ActiveConversationSelection | null {
    let latest: Entry | undefined;
    for (const entry of this.entries.values()) {
      if (!latest || entry.updatedAt > latest.updatedAt) latest = entry;
    }
    if (!latest) return null;
    return {
      sessionId: latest.sessionId,
      ...(latest.mode ? { mode: latest.mode } : {}),
    };
  }

  clearWindow(windowId: number): void {
    this.entries.delete(windowId);
  }
}

export const activeConversationRegistry = new ActiveConversationRegistry();
