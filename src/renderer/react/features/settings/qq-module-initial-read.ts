import type { QqModuleActionCommand, QqModuleActionResult } from "../../../../shared/qq-module-actions";

type Action = (command: QqModuleActionCommand) => Promise<QqModuleActionResult>;
type InitialRead = "status" | "read-configuration";
type PendingResult = Promise<QqModuleActionResult>;

const runningByAction = new WeakMap<Action, Set<PendingResult>>();

function runningFor(action: Action): Set<PendingResult> {
  let running = runningByAction.get(action);
  if (!running) {
    running = new Set();
    runningByAction.set(action, running);
  }
  return running;
}

/** Track calls from these controls so a newly mounted read can wait for a local operation. */
export function runQqModuleAction(action: Action, command: QqModuleActionCommand): PendingResult {
  const running = runningFor(action);
  let promise: PendingResult;
  try { promise = Promise.resolve(action(command)); } catch (error) { promise = Promise.reject(error); }
  running.add(promise);
  const release = () => { running.delete(promise); };
  void promise.then(release, release);
  return promise;
}

/** One reader per mounted component: StrictMode replay shares only the pending read. */
export function createQqModuleInitialReader() {
  let current: { action: Action; kind: InitialRead; promise: PendingResult } | undefined;
  return (action: Action, kind: InitialRead): PendingResult => {
    if (current?.action === action && current.kind === kind) return current.promise;

    const promise = (async () => {
      const running = runningFor(action);
      // The host has one action slot. A real remount waits for the old call, then reads fresh data.
      while (running.size) await Promise.allSettled(running);
      return runQqModuleAction(action, { action: kind });
    })();
    current = { action, kind, promise };
    const release = () => { if (current?.promise === promise) current = undefined; };
    void promise.then(release, release);
    return promise;
  };
}
