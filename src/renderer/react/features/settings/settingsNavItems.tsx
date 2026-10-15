import type { ReactNode } from "react";
import {
  AudioLines,
  BarChart3,
  BookOpen,
  Bot,
  Boxes,
  Brain,
  FileText,
  Globe,
  Headphones,
  Heart,
  Monitor,
  Palette,
  Power,
  Puzzle,
  Settings2,
  Smartphone,
  Sparkles,
  Wrench,
} from "lucide-react";
import { MCP } from "@lobehub/icons";
import type { SettingsSection } from "./AppearanceSettingsPage";

export interface SettingsNavItem {
  section: SettingsSection;
  /** 导航与搜索结果共用的文案 key */
  labelKey: string;
  icon: ReactNode;
}

export interface SettingsNavGroup {
  /** 分组标题文案 key */
  titleKey: string;
  items: SettingsNavItem[];
}

/**
 * 侧栏导航与设置搜索共用这一份定义：搜索结果的分组图标必须与导航一致，
 * 共用定义可避免新增或调整分区后，导航与搜索各自维护导致图标、顺序不一致。
 */
export const SETTINGS_NAV_GROUPS: ReadonlyArray<SettingsNavGroup> = [
  {
    titleKey: "settingsPage.basicSettings",
    items: [
      { section: "general", labelKey: "settingsPage.general.title", icon: <Settings2 size={18} strokeWidth={1.8} /> },
      { section: "appearance", labelKey: "settingsPage.appearance", icon: <Palette size={18} strokeWidth={1.8} /> },
      { section: "preferences", labelKey: "settingsPage.preferencesLabel", icon: <Monitor size={18} strokeWidth={1.8} /> },
      { section: "models", labelKey: "settingsPage.modelSettings.title", icon: <Boxes size={18} strokeWidth={1.8} /> },
      { section: "usage", labelKey: "settingsPage.usage.title", icon: <BarChart3 size={18} strokeWidth={1.8} /> },
      { section: "browser", labelKey: "settingsPage.browserControl.navLabel", icon: <Globe size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    titleKey: "settingsPage.agentAbilities",
    items: [
      { section: "toolToggle", labelKey: "settingsPage.toolToggle.title", icon: <Power size={18} strokeWidth={1.8} /> },
      { section: "tools", labelKey: "settingsPage.tools.title", icon: <Wrench size={18} strokeWidth={1.8} /> },
      { section: "subagents", labelKey: "settingsPage.subagents.title", icon: <Bot size={18} strokeWidth={1.8} /> },
      { section: "plugins", labelKey: "pluginPanel.title", icon: <Puzzle size={18} strokeWidth={1.8} /> },
      { section: "mcp", labelKey: "settingsPage.mcp.menuLabel", icon: <MCP size={18} /> },
      { section: "memory", labelKey: "settingsPage.memory.title", icon: <Brain size={18} strokeWidth={1.8} /> },
      { section: "knowledge", labelKey: "settingsPage.knowledgeBase.title", icon: <BookOpen size={18} strokeWidth={1.8} /> },
      { section: "cyrene", labelKey: "settingsPage.cyrene.title", icon: <Heart size={18} strokeWidth={1.8} /> },
      { section: "skill", labelKey: "settingsPage.skill.title", icon: <Sparkles size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    titleKey: "settingsPage.externalChannels",
    items: [
      { section: "channels", labelKey: "settingsPage.channels.title", icon: <Smartphone size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    titleKey: "settingsPage.voiceAbilities",
    items: [
      { section: "tts", labelKey: "settingsPage.tts.title", icon: <AudioLines size={18} strokeWidth={1.8} /> },
      { section: "asr", labelKey: "settingsPage.asr.title", icon: <Headphones size={18} strokeWidth={1.8} /> },
    ],
  },
  {
    titleKey: "settingsPage.usageNotice",
    items: [
      { section: "disclaimer", labelKey: "settingsPage.disclaimer.navLabel", icon: <FileText size={18} strokeWidth={1.8} /> },
    ],
  },
];

export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = SETTINGS_NAV_GROUPS.flatMap((group) => group.items);
