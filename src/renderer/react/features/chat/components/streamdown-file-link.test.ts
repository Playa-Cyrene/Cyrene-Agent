import { describe, expect, it } from "vitest";
import {
  decodeStreamdownFileHref,
  encodeStreamdownFileLinksInHast,
  encodeStreamdownFileHref,
} from "./streamdown-file-link";

describe("Streamdown workspace file-link placeholder", () => {
  it("round-trips a file URL through the application-owned HTTPS placeholder", () => {
    const href = "file:///E:/ws/src/a.ts#L12";
    const encoded = encodeStreamdownFileHref(href);

    expect(encoded).toMatch(/^https:\/\/cyrene\.invalid\/__file-link__\//);
    expect(decodeStreamdownFileHref(encoded)).toBe(href);
  });

  it("leaves non-file URLs unchanged", () => {
    expect(encodeStreamdownFileHref("https://example.com/a")).toBe("https://example.com/a");
  });

  it("normalizes double-slash file URLs (file://E:/x) to the standard triple slash", () => {
    // 模型偶尔写成两个斜杠；归一成三斜杠再编码，解码回来即标准格式
    const encoded = encodeStreamdownFileHref("file://E:/ws/src/a.ts#L12");
    expect(encoded).toMatch(/^https:\/\/cyrene\.invalid\/__file-link__\//);
    expect(decodeStreamdownFileHref(encoded)).toBe("file:///E:/ws/src/a.ts#L12");
  });

  it("rejects malformed and foreign placeholders", () => {
    expect(decodeStreamdownFileHref("https://cyrene.invalid/__file-link__/not-base64!")).toBeNull();
    expect(decodeStreamdownFileHref("https://attacker.invalid/__file-link__/ZmlsZTovLy9FL3g")).toBeNull();
  });

  it("encodes file links in a HAST tree without changing external links", () => {
    const tree = {
      type: "root",
      children: [
        { type: "element", tagName: "a", properties: { href: "file:///E:/ws/src/a.ts#L12" }, children: [] },
        { type: "element", tagName: "a", properties: { href: "https://example.com" }, children: [] },
      ],
    };
    const transform = encodeStreamdownFileLinksInHast() as unknown as (input: typeof tree) => void;

    transform(tree);

    expect(tree.children[0].properties.href).toMatch(/^https:\/\/cyrene\.invalid\/__file-link__\//);
    expect(tree.children[1].properties.href).toBe("https://example.com");
  });
});
