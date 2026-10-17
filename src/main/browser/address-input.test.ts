import { describe, expect, it } from "vitest";
import { normalizeAddressInput } from "./address-input";
import { navigationErrorCode, parseHttpUrl, type NavigationUrlError } from "./http-url";

/** [用户输入, 补全结果] */
type Rewrite = [string, string];

const PUBLIC_HTTPS: Rewrite[] = [
  ["google.com", "https://google.com"],
  ["  google.com  ", "https://google.com"],
  ["www.bilibili.com/video/BV1xx411c7mD?p=2", "https://www.bilibili.com/video/BV1xx411c7mD?p=2"],
  ["github.com:443", "https://github.com:443"],
  ["例子.中国", "https://例子.中国"],
  ["xn--fsqu00a.xn--fiqs8s", "https://xn--fsqu00a.xn--fiqs8s"],
  ["foo_bar.example.com", "https://foo_bar.example.com"],
  ["8.8.8.8", "https://8.8.8.8"],
  ["100.63.255.255", "https://100.63.255.255"],
  ["100.128.0.1", "https://100.128.0.1"],
  ["[2001:4860:4860::8888]", "https://[2001:4860:4860::8888]"],
  ["[::ffff:8.8.8.8]", "https://[::ffff:8.8.8.8]"],
];

const LOCAL_HTTP: Rewrite[] = [
  ["localhost", "http://localhost"],
  ["localhost:3000", "http://localhost:3000"],
  ["localhost:0", "http://localhost:0"],
  ["LOCALHOST:5173/settings#general", "http://LOCALHOST:5173/settings#general"],
  ["app.localhost:8080", "http://app.localhost:8080"],
  ["127.0.0.1:8080", "http://127.0.0.1:8080"],
  ["192.168.1.10", "http://192.168.1.10"],
  ["10.0.0.2:9000/api", "http://10.0.0.2:9000/api"],
  ["172.20.0.5", "http://172.20.0.5"],
  ["[::1]:3000", "http://[::1]:3000"],
  ["[fe80::1]", "http://[fe80::1]"],
  ["[fd00::1]:8080", "http://[fd00::1]:8080"],
  ["[::ffff:192.168.0.1]", "http://[::ffff:192.168.0.1]"],
];

const RESERVED_LOCAL_SUFFIX: Rewrite[] = [
  ["printer.local", "http://printer.local"],
  ["router.local:8080", "http://router.local:8080"],
  ["nas_01.home", "http://nas_01.home"],
  ["openwrt.lan", "http://openwrt.lan"],
  ["myapp.test:3000", "http://myapp.test:3000"],
  ["svc.internal/health", "http://svc.internal/health"],
  ["printer.home.arpa", "http://printer.home.arpa"],
];

const CGNAT_HTTP: Rewrite[] = [
  ["100.64.0.1", "http://100.64.0.1"],
  ["100.100.100.100:3000", "http://100.100.100.100:3000"],
  ["100.127.255.254", "http://100.127.255.254"],
  ["[::ffff:100.64.0.1]", "http://[::ffff:100.64.0.1]"],
];

const FULLWIDTH: Rewrite[] = [
  ["例子。中国", "https://例子.中国"],
  ["www。google。com", "https://www.google.com"],
  ["www．google．com", "https://www.google.com"],
  ["localhost：3000", "http://localhost:3000"],
  ["example.com/路径。不变", "https://example.com/路径。不变"],
  ["１２７。０。０。１", "http://127.0.0.1"],
  ["１９２．１６８．１．１：８０８０", "http://192.168.1.1:8080"],
  ["example.com/页码１２", "https://example.com/页码１２"],
];

const MISC_SHAPES: Rewrite[] = [
  ["//example.com/path", "https://example.com/path"],
  ["localhost.", "http://localhost."],
  ["127.0.0.1.", "http://127.0.0.1."],
  ["example.com/search?q=cyrene agent", "https://example.com/search?q=cyrene agent"],
  ["github.com/foo bar#a b", "https://github.com/foo bar#a b"],
  ["localhost:3000/a b", "http://localhost:3000/a b"],
  ["127.0.0.1\\status", "http://127.0.0.1\\status"],
  ["localhost:3000\\a", "http://localhost:3000\\a"],
  ["example.com\\a。b", "https://example.com\\a。b"],
];

// 解析器把补零段按八进制读：原文像内网的实为公网，原文像公网的实为本机
const OCTAL_IPV4: Rewrite[] = [
  ["010.010.010.010", "https://010.010.010.010"],
  ["01.02.03.04", "https://01.02.03.04"],
  ["0177.0.0.1", "http://0177.0.0.1"],
];

/** [用户输入, 控制器的结果]：原样返回，"ok" 表示本来就是可导航的 http(s) URL。 */
type Unchanged = [string, NavigationUrlError | "ok"];

const UNCHANGED: Unchanged[] = [
  ["https://google.com", "ok"],
  ["http://localhost:3000", "ok"],
  ["HTTPS://Example.com", "ok"],
  ["javascript:alert(1)", "unsupported_protocol"],
  ["file:///C:/Windows/win.ini", "unsupported_protocol"],
  ["about:blank", "unsupported_protocol"],
  ["mailto:someone@example.com", "unsupported_protocol"],
  ["data:text/html,hi", "unsupported_protocol"],
  ["localhost:abc", "unsupported_protocol"],
  ["", "invalid_url"],
  ["   ", "invalid_url"],
  ["cyrene agent", "invalid_url"],
  ["google.com is great", "invalid_url"],
  ["example.com hello/world", "invalid_url"],
  ["昔涟", "invalid_url"],
  ["intranet", "invalid_url"],
  ["1.5", "invalid_url"],
  ["1.2.3", "invalid_url"],
  ["0x7f.0.0.1", "invalid_url"],
  ["user@example.com", "invalid_url"],
  ["-bad-.com", "invalid_url"],
  ["999.1.1.1", "invalid_url"],
  ["[foo]:80", "invalid_url"],
  ["[fe80::1%25eth0]", "invalid_url"],
  // 端口越界：形态是「主机:端口」，提示「网址无效」而不是「不支持的协议」
  ["localhost:65536", "invalid_url"],
  ["localhost:99999", "invalid_url"],
  ["nas:99999", "invalid_url"],
  // 单段主机名 + 端口与「协议:端口」形态相同，一律不补全，提示「网址无效」
  ["nas:8080", "invalid_url"],
  ["router:80", "invalid_url"],
  ["my-server:3000", "invalid_url"],
  ["my_server:3000/api", "invalid_url"],
  ["ssh:22", "invalid_url"],
  ["git:9418", "invalid_url"],
  ["redis:6379", "invalid_url"],
  ["javascript:80", "invalid_url"],
  ["about:80", "invalid_url"],
  ["mailto:80", "invalid_url"],
  ["file:8080", "invalid_url"],
  // 保留后缀单独出现只是一个词，不补全
  ["local", "invalid_url"],
  ["test", "invalid_url"],
  ["home", "invalid_url"],
  ["internal", "invalid_url"],
  ["lan", "invalid_url"],
  ["invalid", "invalid_url"],
  ["test:3000", "invalid_url"],
  // UNC 共享路径与以斜杠开头的路径不是网址
  ["\\\\example.com\\share", "invalid_url"],
  ["\\\\10.0.0.5\\share", "invalid_url"],
  ["/\\example.com", "invalid_url"],
  ["///example.com", "invalid_url"],
];

describe("地址栏输入补全协议", () => {
  it.each(PUBLIC_HTTPS)("公网域名 / IP 补 https：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each(LOCAL_HTTP)("本机 / 局域网地址补 http：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each(RESERVED_LOCAL_SUFFIX)("本机 / 局域网保留后缀补 http：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each(CGNAT_HTTP)("运营商级 NAT（Tailscale）100.64.0.0/10 补 http：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each(FULLWIDTH)("主机部分的全角句点 / 冒号 / 数字归一化，路径保持原样：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each(MISC_SHAPES)("协议相对、尾部点、路径空格与反斜杠路径：%s", (input, expected) => {
    expect(normalizeAddressInput(input)).toBe(expected);
  });

  it.each([
    ["010.010.010.010", "8.8.8.8"],
    ["01.02.03.04", "1.2.3.4"],
    ["0177.0.0.1", "127.0.0.1"],
  ])("按解析器规范化后的 IPv4 选协议：%s 实为 %s", (input, canonicalHost) => {
    const expected = OCTAL_IPV4.find(([raw]) => raw === input)![1];
    expect(normalizeAddressInput(input)).toBe(expected);
    expect(parseHttpUrl(expected)!.hostname).toBe(canonicalHost);
  });

  it.each([
    ["example.com/search?q=cyrene agent", "https://example.com/search?q=cyrene%20agent"],
    ["github.com/foo bar#a b", "https://github.com/foo%20bar#a%20b"],
    ["127.0.0.1\\status", "http://127.0.0.1/status"],
    ["localhost:3000\\a", "http://localhost:3000/a"],
    ["example.com\\a。b", "https://example.com/a%E3%80%82b"],
  ])("控制器最终导航到的地址：%s → %s", (input, href) => {
    expect(parseHttpUrl(normalizeAddressInput(input))!.href).toBe(href);
  });

  it.each(UNCHANGED)("认不出、已带协议或解析器不接受的输入原样返回：%j", (input) => {
    expect(normalizeAddressInput(input)).toBe(input);
  });
});

/**
 * 不变式：补全器与控制器口径一致。
 * - 凡被改写的输入，控制器 parseHttpUrl 一定接受，协议与补全一致，且不带用户信息；
 * - 凡原样返回的输入，控制器给出的结果（可导航 / 错误码）与预期一致。
 */
describe("补全结果与控制器校验一致", () => {
  const rewrites = [
    ...PUBLIC_HTTPS, ...LOCAL_HTTP, ...RESERVED_LOCAL_SUFFIX, ...CGNAT_HTTP,
    ...FULLWIDTH, ...MISC_SHAPES, ...OCTAL_IPV4,
  ];

  it.each(rewrites)("改写后的地址可被控制器导航：%s", (input) => {
    const output = normalizeAddressInput(input);
    expect(output).not.toBe(input);
    const url = parseHttpUrl(output);
    expect(url).not.toBeNull();
    expect(url!.protocol).toBe(output.startsWith("https://") ? "https:" : "http:");
    expect(url!.username).toBe("");
    expect(url!.password).toBe("");
  });

  it.each(UNCHANGED)("原样返回时控制器结果符合预期：%j → %s", (input, outcome) => {
    const output = normalizeAddressInput(input);
    if (outcome === "ok") {
      expect(parseHttpUrl(output)).not.toBeNull();
    } else {
      expect(parseHttpUrl(output)).toBeNull();
      expect(navigationErrorCode(output)).toBe(outcome);
    }
  });
});
