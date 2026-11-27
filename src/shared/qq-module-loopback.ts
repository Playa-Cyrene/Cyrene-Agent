/** Renderer-side mirror of the QFCA host policy, not an authorization check.
 * Accept numeric IPv4 loopback and IPv6 loopback (including mapped IPv4 loopback).
 * Keep the Node host's independent policy authoritative. */
export function isQqModuleLoopbackLiteral(host: string): boolean {
  // URL parsing can discard whitespace and accept bracketed input; the host does neither.
  if (!host || /[^0-9a-f:.]/i.test(host)) return false;
  if (!host.includes(":")) {
    return /^127(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host) && host.split(".").every(part => Number(part) <= 255);
  }
  try {
    // WHATWG URL only parses and normalizes here; it never resolves or opens the address.
    const { hostname } = new URL(`http://[${host}]/`);
    return hostname === "[::1]" || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(hostname);
  } catch {
    return false;
  }
}
