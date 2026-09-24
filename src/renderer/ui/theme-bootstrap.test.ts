import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const rendererRoot = fileURLToPath(new URL("../", import.meta.url));
const windowEntries = [
  "index.html",
  "call/index.html",
  "sidebar/index.html",
  "sticker-manager/index.html",
  "react/index.html",
];

describe("renderer theme bootstrap", () => {
  it.each(windowEntries)("boots %s directly into the white theme", (entry) => {
    const html = fs.readFileSync(`${rendererRoot}/${entry}`, "utf8");
    expect(html).toMatch(/<html\b[^>]*\bdata-ui-theme="pearl-white"/);
    const stylesheets = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
    expect(stylesheets.at(-1)?.[1]).toMatch(/ui\/theme\.css$/);
  });
});
