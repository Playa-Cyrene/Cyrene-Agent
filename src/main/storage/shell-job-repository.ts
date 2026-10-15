import type { ConversationDatabase } from "./conversation-database";

export type ShellJobStatus = "running" | "exited" | "timed_out" | "stopped" | "failed";

export interface ShellJobRecord {
  jobId: string;
  command: string;
  shell: string;
  status: ShellJobStatus;
  exitCode: number | null;
  reason: string | null;
  totalBytes: number;
  logFile: string;
  startedAtMs: number;
  endedAtMs: number | null;
}

/** Called only by the existing SQLite worker; process handles never cross this boundary. */
export function runShellJobCommand(database: ConversationDatabase, method: string, args: any[]): unknown {
  const db = database.db;
  switch (method) {
    case "shellJobs.create": {
      const record = args[0] as ShellJobRecord;
      db.prepare("INSERT INTO shell_jobs(job_id,status,ended_at,record_json) VALUES(?,?,?,?)")
        .run(record.jobId, record.status, record.endedAtMs, JSON.stringify(record));
      return;
    }
    case "shellJobs.get": {
      const row = db.prepare("SELECT record_json FROM shell_jobs WHERE job_id=?").get(args[0]);
      return row ? JSON.parse(row.record_json as string) : null;
    }
    case "shellJobs.finish": {
      const record = args[0] as ShellJobRecord;
      // The first terminal fact wins, including after a retried database call.
      db.prepare("UPDATE shell_jobs SET status=?,ended_at=?,record_json=? WHERE job_id=? AND status='running'")
        .run(record.status, record.endedAtMs, JSON.stringify(record), record.jobId);
      return;
    }
    case "shellJobs.recover": {
      // Called once by the process owner, NOT on every database-worker restart.
      for (const row of db.prepare("SELECT record_json FROM shell_jobs WHERE status='running'").all()) {
        const record = JSON.parse(row.record_json as string) as ShellJobRecord;
        record.status = "failed";
        record.reason = "app_restarted_execution_unknown";
        record.exitCode = null;
        record.endedAtMs = args[0]; // reconciliation time; the actual exit time is unknown
        runShellJobCommand(database, "shellJobs.finish", [record]);
      }
      return;
    }
    case "shellJobs.expired":
      return db.prepare("SELECT record_json FROM shell_jobs WHERE status<>'running' AND ended_at<?")
        .all(args[0]).map(row => JSON.parse(row.record_json as string));
    case "shellJobs.delete":
      db.prepare("DELETE FROM shell_jobs WHERE job_id=? AND status<>'running'").run(args[0]);
      return;
    default:
      throw new Error("SHELL_JOB_UNKNOWN_COMMAND");
  }
}
