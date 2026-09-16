import { randomUUID } from "crypto";
import * as path from "path";
import type {
  DocumentIndexJobStatus,
  DocumentIndexProgress,
} from "../../shared/document-index";

// 进度类型已下沉 shared（preload 跨层引用），此处 re-export 保持本模块对外类型面不变
export type { DocumentIndexJobStatus, DocumentIndexProgress };

export type DocumentIndexJobResult =
  | { kind: "indexed"; name: string; chunks: number; importId: string; cached?: boolean }
  | { kind: "text"; name: string; text: string }
  | { kind: "empty"; name: string }
  | { kind: "unsupported"; name: string; reason: string }
  | { kind: "error"; name: string; reason: string };

export type EnqueueDocumentIndexJobInput = {
  filePath: string;
  query: string;
  onProgress: (progress: DocumentIndexProgress) => void;
};

export type QueuedDocumentIndexJob = {
  id: string;
  input: EnqueueDocumentIndexJobInput;
  cancelled: boolean;
  reportProgress: (progress: Omit<DocumentIndexProgress, "jobId" | "filePath" | "fileName">) => void;
  onCancel: (listener: () => void) => () => void;
};

export type DocumentIndexRunner = (job: QueuedDocumentIndexJob) => Promise<DocumentIndexJobResult>;

export type DocumentIndexJobHandle = {
  jobId: string;
  promise: Promise<DocumentIndexJobResult>;
};

export type DocumentIndexQueueStats = {
  activeJobId: string | null;
  pendingJobs: number;
  cancellationListeners: number;
};

type QueueJob = QueuedDocumentIndexJob & {
  resolve: (result: DocumentIndexJobResult) => void;
  cancellationListeners: Set<() => void>;
};

export function createDocumentIndexQueue({ runner }: { runner: DocumentIndexRunner }) {
  const pending: QueueJob[] = [];
  let active: QueueJob | null = null;

  function enqueue(input: EnqueueDocumentIndexJobInput): DocumentIndexJobHandle {
    const id = randomUUID();
    let resolve!: (result: DocumentIndexJobResult) => void;
    const promise = new Promise<DocumentIndexJobResult>((done) => { resolve = done; });
    const fileName = path.basename(input.filePath);
    const cancellationListeners = new Set<() => void>();
    const job: QueueJob = {
      id,
      input,
      cancelled: false,
      resolve,
      cancellationListeners,
      reportProgress: (progress) => input.onProgress({
        jobId: id,
        filePath: input.filePath,
        fileName,
        ...progress,
      }),
      onCancel: (listener) => {
        if (job.cancelled) {
          listener();
          return () => undefined;
        }
        cancellationListeners.add(listener);
        return () => cancellationListeners.delete(listener);
      },
    };

    pending.push(job);
    job.reportProgress({ status: "queued" });
    void pumpQueue();
    return { jobId: id, promise };
  }

  async function pumpQueue(): Promise<void> {
    if (active) return;
    active = pending.shift() ?? null;
    if (!active) return;

    const job = active;
    try {
      const result = await runner(job);
      if (job.cancelled) {
        job.resolve({ kind: "error", name: path.basename(job.input.filePath), reason: "cancelled" });
      } else {
        job.resolve(result);
      }
    } catch (error) {
      if (job.cancelled) {
        job.resolve({ kind: "error", name: path.basename(job.input.filePath), reason: "cancelled" });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      job.reportProgress({ status: "failed", reason });
      job.resolve({ kind: "error", name: path.basename(job.input.filePath), reason });
    } finally {
      active = null;
      void pumpQueue();
    }
  }

  return {
    enqueue,
    cancel: (jobId: string): boolean => {
      const pendingIndex = pending.findIndex((job) => job.id === jobId);
      if (pendingIndex >= 0) {
        const [job] = pending.splice(pendingIndex, 1);
        job.cancelled = true;
        job.reportProgress({ status: "cancelled" });
        job.resolve({ kind: "error", name: path.basename(job.input.filePath), reason: "cancelled" });
        return true;
      }
      if (active?.id === jobId) {
        active.cancelled = true;
        for (const listener of active.cancellationListeners) listener();
        active.reportProgress({ status: "cancelled" });
        return true;
      }
      return false;
    },
    getStats: (): DocumentIndexQueueStats => ({
      activeJobId: active?.id ?? null,
      pendingJobs: pending.length,
      cancellationListeners:
        (active?.cancellationListeners.size ?? 0) +
        pending.reduce((total, job) => total + job.cancellationListeners.size, 0),
    }),
  };
}

let defaultQueue = createDocumentIndexQueue({
  runner: async (job) => ({
    kind: "error",
    name: path.basename(job.input.filePath),
    reason: "document index queue is not configured",
  }),
});

export function configureDocumentIndexQueue(runner: DocumentIndexRunner): void {
  defaultQueue = createDocumentIndexQueue({ runner });
}

export function enqueueDocumentIndexJob(input: EnqueueDocumentIndexJobInput): Promise<DocumentIndexJobResult> {
  return defaultQueue.enqueue(input).promise;
}

export function cancelDocumentIndexJob(jobId: string): boolean {
  return defaultQueue.cancel(jobId);
}

export function getDocumentIndexQueueStats(): DocumentIndexQueueStats {
  return defaultQueue.getStats();
}
