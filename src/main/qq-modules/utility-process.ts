import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { app, utilityProcess } from "electron";
import type { QqProcessTransport } from "./runtime";

/** Host-only trusted package selection; callers must verify provenance before use.
 * Path containment is NOT package signature validation or an OS sandbox.
 * Not wired into startup until installation/migration trust is implemented. */
export function createQqUtilityProcess(packageDirectory: string, entryPath: string): QqProcessTransport {
  if (!app.isReady()) throw new Error("QQ_MODULE_APP_NOT_READY");
  if (!isAbsolute(packageDirectory) || !isAbsolute(entryPath)) throw new Error("QQ_MODULE_INVALID_PATH");
  const root = realpathSync(packageDirectory);
  const entry = realpathSync(entryPath);
  const childPath = relative(root, entry);
  if (!childPath || childPath === ".." || childPath.startsWith(`..${sep}`) || isAbsolute(childPath)) throw new Error("QQ_MODULE_ENTRY_OUTSIDE_PACKAGE");
  // No access tokens, NODE_OPTIONS, proxy credentials or full process.env inheritance.
  // Electron treats an empty env map as inherit-all on some versions.
  const env: Record<string, string> = { QFCA_RUNTIME: "1" };
  for (const key of ["SystemRoot", "WINDIR", "TMP", "TEMP", "TMPDIR", "LANG"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  const child = utilityProcess.fork(entry, [], { cwd: root, env, execArgv: [], stdio: "ignore", serviceName: "QFCA QQ module" });
  // UtilityProcess emits Node EventEmitter "error" on V8 fatal failures. Keep a
  // sink even after RPC observers detach; never expose its raw report/location.
  child.on("error", () => {});
  let exited = false;
  const exit = new Promise<void>((resolve) => { child.once("exit", () => { exited = true; resolve(); }); });
  return {
    postMessage: (message) => child.postMessage(message),
    onMessage: (listener) => { child.on("message", listener); return () => { child.removeListener("message", listener); }; },
    onError: (listener) => { const safe = () => listener(); child.on("error", safe); return () => { child.removeListener("error", safe); }; },
    onExit: (listener) => { child.on("exit", listener); return () => { child.removeListener("exit", listener); }; },
    terminate: async () => {
      if (exited) return;
      // Electron kill() is graceful (SIGTERM on POSIX), not proof of exit.
      // Keep the generation unavailable if it hangs; do not launch a second one.
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([exit, new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("QQ_MODULE_TERMINATION_FAILED")), 1000);
        })]);
      } finally { clearTimeout(timer); }
    },
  };
}
