import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { snapshotQqAdoptionContext, type QqAdoptionContext } from "./adoption-proof";
const fail = (): never => { throw new Error("QQ_ADOPTION_INTENT_REQUIRES_REVIEW"); };
function absent(path: string): boolean {
  try { lstatSync(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; return fail(); }
}
function directory(path: string): void {
  const parent = dirname(path); if (parent !== path) directory(parent);
  const st = lstatSync(path); if (!st.isDirectory() || st.isSymbolicLink()) fail();
}
function read(path: string): string {
  const st = lstatSync(path); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > 8192) fail();
  const data = readFileSync(path); if (data.length > 8192) fail(); return data.toString("utf8");
}
function write(path: string, value: string): void {
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
}
export function qqAdoptionIntentDirectory(userDataPath: string): string {
  if (!isAbsolute(userDataPath) || resolve(userDataPath) === parse(resolve(userDataPath)).root) fail();
  return join(resolve(userDataPath), "qq-module-adoption");
}
export interface QqAdoptionIntent { schemaVersion: 1; operationId: string; phase: "prepared"; context: QqAdoptionContext }
/** One-shot durable intent. No overwrite, rollback inference, unlock or repair API.
 * Its existence always gates startup; it never certifies historical absence. */
export class QqAdoptionIntentStore {
  readonly root: string;
  constructor(userDataPath: string) { this.root = qqAdoptionIntentDirectory(userDataPath); }
  read(): QqAdoptionIntent | null {
    directory(dirname(this.root)); if (absent(this.root)) return null; directory(this.root);
    if (readdirSync(this.root).sort().join(",") !== "intent-lock,state.json") fail();
    const id = read(join(this.root, "intent-lock"));
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id)) fail();
    const value = JSON.parse(read(join(this.root, "state.json")));
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "context,operationId,phase,schemaVersion"
      || value.schemaVersion !== 1 || value.operationId !== id || value.phase !== "prepared") fail();
    return { schemaVersion: 1, operationId: id, phase: "prepared", context: snapshotQqAdoptionContext(value.context) };
  }
  persistIntent(context: Readonly<QqAdoptionContext>): void {
    const snapshot = snapshotQqAdoptionContext(context);
    directory(dirname(this.root)); if (!absent(this.root)) fail();
    // mkdir is exclusive: a parallel adopter cannot overwrite even an empty root.
    mkdirSync(this.root, { mode: 0o700 });
    const operationId = randomUUID();
    write(join(this.root, "intent-lock"), operationId);
    write(join(this.root, "state.tmp"), JSON.stringify({ schemaVersion: 1, operationId, phase: "prepared", context: snapshot }));
    renameSync(join(this.root, "state.tmp"), join(this.root, "state.json"));
    if (process.platform !== "win32") {
      for (const path of [this.root, dirname(this.root)]) {
        const fd = openSync(path, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    }
  }
}
