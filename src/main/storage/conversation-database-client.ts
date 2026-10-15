import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { ConversationStoreError } from "./conversation-store-error";
/** One worker per user-data directory. A rejected command never poisons subsequent commands. */
export class ConversationDatabaseClient {
  private worker: Promise<Worker> | undefined;
  private sequence = 0;
  private generation = 0;
  private readonly pending = new Map<number, {
    resolve: (value: any) => void;
    reject: (error: Error) => void;
  }>();
  constructor(readonly root: string) { }
  private async start(): Promise<Worker> {
    const generation = ++this.generation;
    const file = path.join(__dirname, "conversation-database-worker.js");
    const compiled = fs.existsSync(file);
    // Development compiles inside the worker too; synchronous build never blocks Electron.
    const source = compiled ? file : `const { buildSync } = require(${JSON.stringify(require.resolve("esbuild"))});
   const path = require("node:path"), os = require("node:os");
   const { threadId } = require("node:worker_threads");
   const file = path.join(os.tmpdir(), "cyrene-conversation-worker-" + process.pid + "-" + threadId + ".cjs");
   buildSync({ entryPoints: [${JSON.stringify(path.join(__dirname, "conversation-database-worker.ts"))}], outfile: file,
    bundle: true, platform: "node", format: "cjs", logLevel: "silent" });
   require(file);
   require("node:fs").unlinkSync(file);`;
    const worker = new Worker(source, { eval: !compiled, workerData: { root: this.root } });
    const fail = (error: Error) => {
      if (generation !== this.generation)
        return;
      ++this.generation;
      if (this.worker)
        this.worker = undefined;
      for (const request of this.pending.values())
        request.reject(error);
      this.pending.clear();
    };
    worker.on('message', message => {
      const request = this.pending.get(message.id);
      if (!request)
        return;
      this.pending.delete(message.id);
      if (message.error)
        request.reject(new ConversationStoreError(message.error.code, message.error.details));
      else
        request.resolve(message.result);
      if (message.retired) {
        fail(new ConversationStoreError('CONVERSATION_DATABASE_CONNECTION_RETIRED'));
        void worker.terminate();
        return;
      }
      if (!this.pending.size)
        worker.unref();
    });
    worker.on('error', fail);
    worker.on('exit', code => fail(new Error(`CONVERSATION_DATABASE_WORKER_EXIT:${code}`)));
    worker.unref();
    return worker;
  }
  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const worker = await (this.worker ??= this.start().catch(error => { this.worker = undefined; throw error; }));
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.ref();
      try {
        worker.postMessage({ id, method, args });
      }
      catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }
  async close(): Promise<void> {
    if (!this.worker)
      return;
    const worker = await this.worker;
    await this.call('close');
    this.worker = undefined;
    ++this.generation;
    await worker.terminate();
  }
}
const registry = globalThis as typeof globalThis & {
  __cyreneConversationClients?: Map<string, ConversationDatabaseClient>;
};
const clients = registry.__cyreneConversationClients ??= new Map<string, ConversationDatabaseClient>();
export function getConversationDatabase(root: string): ConversationDatabaseClient {
  const key = path.resolve(root);
  let client = clients.get(key);
  if (!client) {
    client = new ConversationDatabaseClient(key);
    clients.set(key, client);
  }
  return client;
}
export async function closeConversationDatabases(): Promise<void> {
  // Facades can retain a client after shutdown; reopening must reuse the same owner.
  await Promise.all([...clients.values()].map(client => client.close()));
}
