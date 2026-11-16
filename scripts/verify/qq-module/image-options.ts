import type { ChannelAttachment } from "../../../src/main/channels/types";
import { buildAgentRunOptions, type BuildOptionsDeps } from "../../../src/main/orchestrator/build-options";

/** Exercise the production image consumer without invoking a model or reading user configuration. */
export async function buildImageOptions(attachment: ChannelAttachment) {
  const empty = () => "";
  const deps: BuildOptionsDeps = {
    loadModelSettings: () => ({ provider: "fixture", baseUrl: "https://example.invalid", model: "fixture", apiKey: "unused" }),
    loadGeneralSettings: () => ({ currentStyleId: "default", chatSocialContextEnabled: false }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: empty, buildSkillCatalog: empty, buildAutoInjectedSkillContext: empty,
    skillRegistry: { getEnabled: () => [], getEnabledForMode: () => [], getBody: () => null },
    resolveSlashActivation: empty, buildToneInjection: empty,
    buildAlwaysOnContext: async () => "", buildRelationshipContext: async () => "",
    buildToolSystemPrompt: empty, buildSoulSystemBasePrompt: empty, readStylePrompt: empty,
    resolveSoulSampling: () => ({}),
    toolRegistry: { getEnabled: () => [], getEnabledToolsForMode: () => [] },
    normalizeChatMessages: (raw) => raw as never, chatRequestTimeoutMs: 1000,
  };
  return buildAgentRunOptions({
    sessionId: "isolated-qq-image", mode: "chat", channel: "qq",
    modelContext: { messages: [{ role: "user", content: "fixture image" }], uncertainEffects: [], throughSeq: 0 },
    imageAttachments: [{ name: "QQ image", filePath: attachment.filePath!, mime: attachment.mime }],
  }, deps);
}
