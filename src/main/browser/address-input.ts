/**
 * 地址栏输入补全：用户手输 `google.com`、`localhost:3000` 这类不带协议的地址时补上协议。
 *
 * 只用于地址栏（BROWSER_PANEL_NAVIGATE）。Agent 浏览器工具仍要求完整 URL，不经过这里。
 * 补全后仍交给控制器的 http(s) 校验（http-url.ts），因此 `file:`、`javascript:` 等协议照旧被拒绝；
 * 认不出的输入（普通文字、单段主机名、带用户信息的串、UNC 路径）原样返回，由控制器给出错误码。
 *
 * 单段主机名一律不补全（`localhost` 除外）：`nas:8080` 与 `ssh:22`、`redis:6379` 这类「协议:端口」
 * 形态完全相同，任何协议名单都不完整，宁可提示「网址无效」让用户写全 `http://nas:8080`。
 *
 * 主机分类一律基于 WHATWG URL 解析后的规范主机名，而不是用户原文：
 * 八进制 / 补零 IPv4（`010.010.010.010` 实为 8.8.8.8）、IDN、全角字母都先由解析器规范化，
 * 再判断走 http 还是 https，避免「原文看着像内网、实际访问公网」的错配。
 */

import { hasExplicitScheme } from "./http-url";

/** 用户原文是四段纯数字（可带补零 / 尾点）才当 IP 补全，`1.5`、`0x7f.0.0.1` 这类不当地址。 */
const DOTTED_QUAD = /^\d+(?:\.\d+){3}\.?$/;
const CANONICAL_IPV4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/;
const DOMAIN_LABEL = /^[a-z\d_](?:[a-z\d_-]*[a-z\d_])?$/;
const TLD = /^(?:[a-z]{2,}|xn--[a-z\d-]+)$/;
/**
 * 只在本机 / 局域网解析的保留后缀（RFC 6761 / 6762 / 8375 及常见路由器默认域）：
 * 这类设备基本只有 http，补 https 会把「网址无效」变成更难懂的「页面加载失败」。
 * 必须前面还有一段名字（`printer.local`）；单独的 `local`、`test` 只是一个词，不补全。
 */
const LOCAL_SUFFIXES = ["localhost", "local", "test", "invalid", "internal", "home.arpa", "lan", "home"];

export function normalizeAddressInput(input: string): string {
  let trimmed = input.trim();
  if (!trimmed) return input;
  // 协议相对地址 `//example.com/path`：按省略协议处理
  if (trimmed.startsWith("//")) trimmed = trimmed.slice(2);
  const candidate = normalizeAuthorityPunctuation(trimmed);
  const authority = readAuthority(candidate);
  // 主机部分为空（`\\server\share` 这类 UNC 路径、`/path`）不是网址；
  // 只有主机部分出现空白才视为普通文字（如 `cyrene agent`），路径 / 查询里的空格由解析器编码
  if (!authority || /\s/.test(authority)) return input;

  // 已带协议（含 http/https 以外的协议）一律不动；`localhost:3000` 这类「主机:端口」不算协议
  if (hasExplicitScheme(candidate)) return input;

  let url: URL;
  try {
    url = new URL(`http://${candidate}`);
  } catch {
    return input;
  }
  if (url.username || url.password) return input;

  const kind = classifyHost(url.hostname, authority);
  if (kind === "local") return `http://${candidate}`;
  if (kind === "public") return `https://${candidate}`;
  return input;
}

/** 中文输入法下常见的全角句点 / 冒号 / 数字，只在主机部分归一化，路径与查询保持原样。 */
function normalizeAuthorityPunctuation(value: string): string {
  const authority = readAuthority(value);
  return authority
    .replace(/[。．｡]/g, ".")
    .replace(/：/g, ":")
    .replace(/[０-９]/g, (digit) => String.fromCharCode(digit.charCodeAt(0) - 0xfee0))
    + value.slice(authority.length);
}

/** 主机部分到第一个 `/ ? # \` 为止；WHATWG URL 对 http(s) 把 `\` 当作 `/`。 */
function readAuthority(value: string): string {
  const end = value.search(/[/?#\\]/);
  return end === -1 ? value : value.slice(0, end);
}

type HostKind = "local" | "public" | null;

/** hostname 是解析器给出的规范主机名，rawAuthority 是用户原文（已做全角归一化）的主机部分。 */
function classifyHost(hostname: string, rawAuthority: string): HostKind {
  if (hostname.startsWith("[")) return classifyIpv6(hostname.slice(1, -1));
  const host = hostname.replace(/\.$/, "");
  const ipv4 = readCanonicalIpv4(host);
  if (ipv4) {
    if (!DOTTED_QUAD.test(rawAuthority.replace(/:\d*$/, ""))) return null;
    return isLocalIpv4(ipv4) ? "local" : "public";
  }
  if (host === "localhost") return "local";
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label))) return null;
  if (LOCAL_SUFFIXES.some((suffix) => host.endsWith(`.${suffix}`))) return "local";
  return TLD.test(labels[labels.length - 1]) ? "public" : null;
}

function readCanonicalIpv4(host: string): number[] | null {
  const match = CANONICAL_IPV4.exec(host);
  return match ? match.slice(1).map(Number) : null;
}

/** 本机与局域网地址默认走 http：本地开发服务器、NAS、路由器通常没有证书。 */
function isLocalIpv4([a, b]: number[]): boolean {
  return a === 127 || a === 10 || a === 0
    || (a === 192 && b === 168)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 169 && b === 254)
    // RFC 6598 运营商级 NAT 段，Tailscale 等组网工具也用它
    || (a === 100 && b >= 64 && b <= 127);
}

/** 解析器已把 IPv6 规范化（小写、压缩、内嵌 IPv4 转十六进制），这里只需展开成 8 组。 */
function classifyIpv6(address: string): HostKind {
  const hextets = expandIpv6(address);
  if (!hextets) return null;
  const [first] = hextets;
  const leadingZero = hextets.slice(0, 5).every((part) => part === 0);
  if (leadingZero && hextets[5] === 0xffff) {
    // IPv4 映射地址 ::ffff:a.b.c.d 按内嵌的 IPv4 判断
    const a = hextets[6] >> 8, b = hextets[6] & 0xff;
    return isLocalIpv4([a, b]) ? "local" : "public";
  }
  const unspecifiedOrLoopback = hextets.slice(0, 7).every((part) => part === 0) && hextets[7] <= 1;
  const linkLocal = (first & 0xffc0) === 0xfe80;
  const uniqueLocal = (first & 0xfe00) === 0xfc00;
  return unspecifiedOrLoopback || linkLocal || uniqueLocal ? "local" : "public";
}

function expandIpv6(address: string): number[] | null {
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (parts.length !== 8 || !parts.every((part) => /^[\da-f]{1,4}$/.test(part))) return null;
  return parts.map((part) => parseInt(part, 16));
}
