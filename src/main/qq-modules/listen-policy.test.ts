import { expect, it } from "vitest";
import { isQqModuleLoopbackLiteral } from "../../shared/qq-module-loopback";
import { isQqModuleLoopbackHost } from "./listen-policy";

it.each([
  ["127.0.0.1", true], ["127.255.255.255", true], ["::1", true],
  ["0:0:0:0:0:0:0:1", true], ["::ffff:127.0.0.2", true], ["::FFFF:7f00:A", true],
  ["0:0:0:0:0:ffff:127.255.255.255", true],
  ["", false], ["localhost", false], ["127.1", false], ["127.0.0.02", false],
  ["127.0.0.256", false], ["192.0.2.1", false], ["::", false], ["::2", false],
  ["::127.0.0.2", false], ["::ffff:192.0.2.1", false], ["::ffff:127.0.0.02", false],
  ["::1%lo", false], ["[::1]", false], ["::1\n", false], [" 127.0.0.1", false],
] as const)("QFCA editor and host agree on the numeric loopback policy for %j", (host, allowed) => {
  expect(isQqModuleLoopbackHost(host)).toBe(allowed);
  expect(isQqModuleLoopbackLiteral(host)).toBe(allowed);
});
