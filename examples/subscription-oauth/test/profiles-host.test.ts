import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cyrene-subscription-host-test" } }));

import { normalizeModelSettings, resolveSessionModelSettings } from "../../../src/main/settings/model-settings";
import { resolveConfiguredReasoningCapability } from "../../../src/shared/manual-reasoning";
import { getProfileSelectableModels } from "../../../src/shared/session-model";

const { buildProfiles } = createRequire(import.meta.url)("../lib/profiles.cjs");

describe("subscription profiles in the Cyrene 1.3 host", () => {
  it("round-trips one channel with model-specific context, vision and reasoning", () => {
    const profiles = buildProfiles("chatgpt", [
      { id: "gpt-6-sol", contextWindow: 512000, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt-5.5", contextWindow: 400000, efforts: ["low", "high"] },
    ], { port: 6231 });
    profiles[0].modelOptions["gpt-5.5"].multimodal = false;
    const settings = normalizeModelSettings({ modelProfiles: profiles, defaultModelProfileId: profiles[0].id });
    const saved = settings.modelProfiles![0];
    expect(getProfileSelectableModels(saved)).toEqual(["gpt-6-sol", "gpt-5.5"]);
    expect(saved.nativeWebSearch).toBe(true);
    const sol = resolveSessionModelSettings(settings, { modelProfileId: saved.id, model: "gpt-6-sol" });
    const older = resolveSessionModelSettings(settings, { modelProfileId: saved.id, model: "gpt-5.5" });
    expect(sol.contextWindowTokens).toBe(512000);
    expect(sol.multimodal).toBe(true);
    expect(older.contextWindowTokens).toBe(400000);
    expect(older.multimodal).toBe(false);
    expect(older.explicitTransport).toBe("responses");
    expect(older.nativeWebSearch).toBe(true);
    expect(resolveConfiguredReasoningCapability("chatgpt", sol.model, sol.manualReasoning).supportedEfforts).toContain("max");
    expect(resolveConfiguredReasoningCapability("chatgpt", older.model, older.manualReasoning).supportedEfforts).toEqual(["low", "high"]);
  });

  it("merged legacy profile ids stay valid and each migrated conversation uses its original model", () => {
    const profiles = buildProfiles("grok", [], { port: 6234 }, {
      defaultModelProfileId: "oauth-sub-grok-grok-4.6-lite",
      modelProfiles: [
        { id: "oauth-sub-grok-grok-4.6", model: "grok-4.6", contextWindowTokens: 256000, multimodal: true },
        { id: "oauth-sub-grok-grok-4.6-lite", model: "grok-4.6-lite", contextWindowTokens: 131072, multimodal: false },
      ],
    });
    const settings = normalizeModelSettings({ modelProfiles: profiles, defaultModelProfileId: profiles[0].id });
    expect(settings.modelProfiles).toHaveLength(1);
    const saved = settings.modelProfiles![0];
    expect(saved.model).toBe("grok-4.6-lite");
    expect(saved.id).toBe("oauth-sub-grok-grok-4.6-lite");
    const migrated = resolveSessionModelSettings(settings, { modelProfileId: saved.id, model: "grok-4.6" });
    expect(migrated.model).toBe("grok-4.6");
    expect(migrated.contextWindowTokens).toBe(256000);
    expect(migrated.multimodal).toBe(true);
    expect(migrated.baseUrl).toBe("http://127.0.0.1:6234/v1");
  });

  it("single-model channels and Anthropic transport remain valid", () => {
    const profiles = buildProfiles("claude", [{ id: "claude-sonnet-4.6", contextWindow: 200000 }], { port: 6231 });
    const settings = normalizeModelSettings({ modelProfiles: profiles, defaultModelProfileId: profiles[0].id });
    const saved = settings.modelProfiles![0];
    expect(saved.models).toBeUndefined();
    expect(getProfileSelectableModels(saved)).toEqual(["claude-sonnet-4.6"]);
    const model = resolveSessionModelSettings(settings, { modelProfileId: saved.id });
    expect(model.explicitTransport).toBe("anthropic");
    expect(model.contextWindowTokens).toBe(200000);
  });
});
