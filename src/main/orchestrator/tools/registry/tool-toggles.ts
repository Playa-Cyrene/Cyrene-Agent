import type { GeneralSettings } from "../../../settings/general-settings";
import { toolRegistry } from "./tool-registry";

export function syncBuiltInToolToggles(settings: GeneralSettings): void {
  toolRegistry.setEnabled("weather", settings.weatherEnabled);
  toolRegistry.setEnabled("plan_trip", settings.travelEnabled);
}
