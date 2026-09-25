import "./window-corner-radius";
import "./message-typography";
import { normalizeUiTheme, type UiTheme } from "../../shared/ui-theme";
import { DEFAULT_UI_FONT, normalizeUiFont, type UiFont } from "../../shared/ui-font";

declare global {
  interface Window {
    cyreneTheme?: {
      get: () => Promise<UiTheme>;
      onChanged: (callback: (theme: UiTheme) => void) => () => void;
      getRadius: () => Promise<boolean>;
      onRadiusChanged: (callback: (theme: boolean) => void) => () => void;
    };
    cyreneFont?: {
      get: () => Promise<UiFont>;
      onChanged: (callback: (font: UiFont) => void) => () => void;
    };
  }
}

function applyTheme(theme: unknown): void {
  document.documentElement.dataset.uiTheme = normalizeUiTheme(theme);
}

function applyRadius(radius: boolean): void {
  document.documentElement.dataset.uiRadius = radius ? undefined : "false";
}

const CUSTOM_FONT_STYLE_ID = "cyrene-custom-font";

function applyFont(value: unknown): void {
  const font = normalizeUiFont(value);
  const style = document.getElementById(CUSTOM_FONT_STYLE_ID);
  if (font.kind !== "custom") {
    style?.remove();
    document.documentElement.style.removeProperty("--rb-font-sans");
    document.documentElement.dataset.uiFont = "source-han";
    return;
  }
  const customStyle = style ?? document.head.appendChild(Object.assign(document.createElement("style"), { id: CUSTOM_FONT_STYLE_ID }));
  const format = font.fileName.toLowerCase().endsWith(".otf") ? "opentype" : "truetype";
  customStyle.textContent = `@font-face { font-family: "Cyrene Custom Font"; src: url("local-font://${encodeURIComponent(font.fileName)}") format("${format}"); font-display: swap; }`;
  document.documentElement.style.setProperty("--rb-font-sans", '"Cyrene Custom Font", var(--rb-font-ui)');
  document.documentElement.dataset.uiFont = "custom";
}

applyTheme("pearl-white");

void window.cyreneTheme?.get()
  .then(applyTheme)
  .catch(() => applyTheme("pearl-white"));

window.cyreneTheme?.onChanged((theme) => {
  applyTheme(theme);
});

void window.cyreneTheme?.getRadius()
  .then(applyRadius)
  .catch(() => applyRadius(true));

window.cyreneTheme?.onRadiusChanged((theme) => {
  applyRadius(theme);
});

applyFont(DEFAULT_UI_FONT);
void window.cyreneFont?.get().then(applyFont).catch(() => applyFont(DEFAULT_UI_FONT));
window.cyreneFont?.onChanged((font) => applyFont(font));
