import { PluginModePanel } from "../chat/components/PluginModePanel";
import "./PluginSettingsPanel.css";

export function PluginSettingsPanel({ searchRevealRequest = 0, searchRevealView = "installed" }: {
  searchRevealRequest?: number;
  searchRevealView?: "installed" | "market";
} = {}) {
  return <div className="cy-settings-plugin-panel"><PluginModePanel searchRevealRequest={searchRevealRequest} searchRevealView={searchRevealView} /></div>;
}
