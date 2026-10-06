/** Domain failures cross the worker boundary without exposing message contents. */
import { createHash } from "node:crypto";

export function diagnosticHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "undefined").digest("hex").slice(0, 12);
}

export class ConversationStoreError extends Error {
  constructor(readonly code: string, readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "ConversationStoreError";
  }
}
