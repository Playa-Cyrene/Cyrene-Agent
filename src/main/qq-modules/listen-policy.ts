import { BlockList, isIP } from "node:net";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
/** QFCA first-release policy. Numeric IPs only, no DNS/localhost resolution,
 * bracket stripping, scope IDs or token-based override. Mirrors QFCA #1's gate.
 * Keep the legacy built-in adapter's separate listen policy unchanged. */
export function isQqModuleLoopbackHost(host: unknown): host is string {
  if (typeof host !== "string" || host.includes("%")) return false;
  const family = isIP(host);
  return (family === 4 || family === 6) && loopback.check(host, family === 4 ? "ipv4" : "ipv6");
}
