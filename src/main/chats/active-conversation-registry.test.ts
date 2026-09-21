import { describe, expect, it } from "vitest";
import { ActiveConversationRegistry } from "./active-conversation-registry";

describe("ActiveConversationRegistry", () => {
  it("returns the most recently selected live window", () => {
    const registry = new ActiveConversationRegistry();

    registry.set(1, "conversation-1", "chat");
    registry.set(2, "conversation-2", "work");
    registry.set(1, "conversation-3", "code");

    expect(registry.getMostRecent()).toEqual({ sessionId: "conversation-3", mode: "code" });
  });

  it("clearing a window exposes the next most recent selection", () => {
    const registry = new ActiveConversationRegistry();
    registry.set(1, "conversation-1", "chat");
    registry.set(2, "conversation-2", "work");

    registry.clearWindow(2);

    expect(registry.getMostRecent()).toEqual({ sessionId: "conversation-1", mode: "chat" });
  });

  it("supports null disposal and mode updates for the same window", () => {
    const registry = new ActiveConversationRegistry();
    registry.set(1, "conversation-1", "chat");
    registry.set(1, "conversation-1", "work");
    expect(registry.getMostRecent()).toEqual({ sessionId: "conversation-1", mode: "work" });
    registry.set(1, null);
    expect(registry.getMostRecent()).toBeNull();
  });
});
