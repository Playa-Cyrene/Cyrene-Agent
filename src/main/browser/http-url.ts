/**
 * 内置浏览器的导航 URL 判定：只允许 http / https。
 * 控制器与地址栏补全（address-input.ts）共用这里，保证「补全出来的地址一定能被控制器接受」，
 * 以及失败时的错误码与补全器对「是否写了协议」的判断一致。
 */

const SCHEME_PREFIX = /^([a-z][a-z\d+.-]*):/i;
/** `localhost:3000`、`nas:8080/x` 这类「主机:端口」形态：冒号后是纯数字端口，不算协议。 */
const HOST_PORT_REST = /^\d+(?:[/?#\\]|$)/;

export type NavigationUrlError = "unsupported_protocol" | "invalid_url";

export function parseHttpUrl(input: string): URL | null {
  try {
    const url = new URL(input.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** 输入是否显式写了协议（`javascript:`、`file:` 等）；「主机:端口」形态不算。 */
export function hasExplicitScheme(input: string): boolean {
  const trimmed = input.trim();
  const scheme = SCHEME_PREFIX.exec(trimmed);
  return !!scheme && !HOST_PORT_REST.test(trimmed.slice(scheme[0].length));
}

/** parseHttpUrl 失败时给用户看的错误码。 */
export function navigationErrorCode(input: string): NavigationUrlError {
  return hasExplicitScheme(input) ? "unsupported_protocol" : "invalid_url";
}
