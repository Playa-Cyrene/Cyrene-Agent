// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { releaseFocusedDescendant } from "./focus-handoff";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("releaseFocusedDescendant", () => {
  it("blurs focus inside the container before the container is hidden", () => {
    document.body.innerHTML = '<div id="tree"><button id="file">file</button></div>';
    const tree = document.querySelector<HTMLElement>("#tree");
    const file = document.querySelector<HTMLButtonElement>("#file");
    file?.focus();

    expect(releaseFocusedDescendant(tree)).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });

  it("does not blur focus outside the container", () => {
    document.body.innerHTML = '<div id="tree"></div><button id="outside">outside</button>';
    const tree = document.querySelector<HTMLElement>("#tree");
    const outside = document.querySelector<HTMLButtonElement>("#outside");
    outside?.focus();

    expect(releaseFocusedDescendant(tree)).toBe(false);
    expect(document.activeElement).toBe(outside);
  });
});
