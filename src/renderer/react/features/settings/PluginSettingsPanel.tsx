import { PluginModePanel } from "../chat/components/PluginModePanel";
import "./PluginSettingsPanel.css";

export function PluginSettingsPanel({ searchRevealRequest = 0 }: { searchRevealRequest?: number } = {}) {
  return <div className="cy-settings-plugin-panel"><PluginModePanel searchRevealRequest={searchRevealRequest} /></div>;
}
