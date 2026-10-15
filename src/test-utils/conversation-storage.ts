import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
/** Direct access is limited to temporary test fixtures and deliberate failure injection. */
export function withConversationDatabase<T>(root: string, action: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(path.join(root, "cyrene.sqlite"));
  try {
    return action(database);
  }
  finally {
    database.close();
  }
}
export function readSessionFixture(file: string): string {
  const root = path.dirname(path.dirname(path.dirname(file)));
  if (!fs.existsSync(path.join(root, "cyrene.sqlite")))
    return fs.readFileSync(file, "utf8");
  const row = withConversationDatabase(root, db => db.prepare("SELECT record_json FROM conversations WHERE id=?").get(path.basename(file, ".json")));
  return row?.record_json as string ?? fs.readFileSync(file, "utf8");
}
export function writeSessionFixture(file: string, value: string): void {
  const root = path.dirname(path.dirname(path.dirname(file)));
  if (!fs.existsSync(path.join(root, "cyrene.sqlite"))) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, value);
    return;
  }
  const record = JSON.parse(value);
  withConversationDatabase(root, db => db.prepare("INSERT INTO conversations(id,record_json) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json").run(record.id, value));
}
