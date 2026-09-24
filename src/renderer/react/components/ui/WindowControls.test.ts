// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(resolve(__dirname, "WindowControls.css"), "utf8");

describe("标题栏窗口按钮", () => {
  it("默认只显示图标，不带圆形边框或底色", () => {
    const style = document.createElement("style");
    style.textContent = stylesheet;
    document.head.append(style);

    const button = document.createElement("button");
    button.className = "cy-winbtn cy-winbtn--minimize";
    document.body.append(button);

    const computed = getComputedStyle(button);
    expect(computed.borderTopWidth).toBe("0px");
    expect(computed.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(computed.borderRadius).not.toBe("50%");
  });
});
