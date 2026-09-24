import type { SettingsSection } from "../../features/settings/AppearanceSettingsPage";

export type SettingsDestination =
  | { kind: "settings"; section: SettingsSection; openMusicModal?: boolean }
  | { kind: "scheduledTasks" };

const SECTION_MAP: Record<string, SettingsSection> = {
  appearance: "appearance",
  preferences: "preferences",
  api: "models",
  "api-advanced": "models",
  models: "models",
  tokens: "usage",
  usage: "usage",
  general: "general",
  plugins: "tools",
  tools: "tools",
  music: "tools",
  toolToggle: "toolToggle",
  memory: "memory",
  cyrene: "cyrene",
  skill: "skill",
  asr: "asr",
  tts: "tts",
  mcp: "mcp",
  channels: "channels",
  disclaimer: "disclaimer",
};

export function resolveSettingsDestination(section?: string): SettingsDestination {
  if (section === "tasks") return { kind: "scheduledTasks" };
  const destinationSection = SECTION_MAP[section ?? ""] ?? "appearance";
  return { kind: "settings", section: destinationSection, ...(section === "music" ? { openMusicModal: true } : {}) };
}
