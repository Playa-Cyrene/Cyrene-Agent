export const SETTINGS_SEARCH_HISTORY_KEY = "cyrene.settings-search-history.v1";
export const SETTINGS_SEARCH_HISTORY_LIMIT = 30;

export function normalizeSearchHistory(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const entries = value.filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().slice(0, 200)).filter(Boolean);
  return [...new Set(entries)].slice(0, SETTINGS_SEARCH_HISTORY_LIMIT);
}

export function readSearchHistory(): string[] {
  try {
    return normalizeSearchHistory(JSON.parse(localStorage.getItem(SETTINGS_SEARCH_HISTORY_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function writeSearchHistory(history: string[]): void {
  try {
    localStorage.setItem(SETTINGS_SEARCH_HISTORY_KEY, JSON.stringify(normalizeSearchHistory(history)));
  } catch {
    // Search remains usable when browser storage is unavailable.
  }
}

export function rememberSearch(history: string[], query: string): string[] {
  return normalizeSearchHistory([query, ...history]);
}
