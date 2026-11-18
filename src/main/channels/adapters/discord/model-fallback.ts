import { setTimeout as delay } from "node:timers/promises";
import { RetryableModelRunError } from "../../../orchestrator/agent-runtime-error";

export async function runDiscordChatWithFallback<T>(
  run: (profileId?: string) => Promise<T>,
  primaryProfileId?: string,
  fallbackProfileId?: string,
): Promise<T> {
  try {
    return await run(primaryProfileId);
  } catch (error) {
    if (!fallbackProfileId || fallbackProfileId === primaryProfileId || !(error instanceof RetryableModelRunError)) {
      throw error;
    }
    if (error.reason === "quota") return run(fallbackProfileId);
  }

  await delay(650);
  try {
    return await run(primaryProfileId);
  } catch (error) {
    if (error instanceof RetryableModelRunError && error.reason === "quota") {
      return run(fallbackProfileId);
    }
    throw error;
  }
}
