import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal } from "antd";
import { useTranslation } from "../../../i18n";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../../../../shared/code-git-types";
import type { TodoState } from "../../../../../shared/todo-types";
import workingPngUrl from "../../../assets/status-moods/工作中.png?url";
import { buildGitStatusCopy } from "./code-git-presentation";
import { useFloatingCard } from "./floating-card";
import { createCodeGitRefreshController, type CodeGitRefreshController } from "./code-git-refresh";
import { PlanReviewEntry, type PlanReviewPhase } from "./PlanReviewPanel";
import "./CodeGitPanel.css";

interface CodeGitApi {
  getStatus(sessionId: string): Promise<CodeGitStatus>;
  watch(sessionId: string): Promise<void>;
  unwatch(sessionId: string): Promise<void>;
  switchBranch(sessionId: string, branch: string, create?: boolean): Promise<void>;
  commit(sessionId: string, message: string, paths: string[]): Promise<void>;
  push(sessionId: string): Promise<void>;
  onChanged(callback: (payload: CodeGitChangedPayload) => void): () => void;
}

export interface CodeGitPanelProps {
  sessionId: string;
  projectName?: string;
  todoState: TodoState | null;
  planPhase?: PlanReviewPhase;
  onOpenPlan?: () => void;
}

function codeGitApi(): CodeGitApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

function ToggleIcon() {
  return <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M27 9V21H39M21 39V27H9M27 21L42 6M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CodeGitPanel({ sessionId, projectName, todoState, planPhase, onOpenPlan }: CodeGitPanelProps) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CodeGitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dialog, setDialog] = useState<"branch" | "commit" | null>(null);
  const [newBranch, setNewBranch] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operating, setOperating] = useState(false);
  const refreshControllerRef = useRef<CodeGitRefreshController | null>(null);
  const api = codeGitApi();
  const floating = useFloatingCard({ width: 260 });

  useEffect(() => {
    if (!api) return undefined;
    const controller = createCodeGitRefreshController({
      load: () => api.getStatus(sessionId),
      apply: setStatus,
      failed: () => setStatus(null),
      busy: setRefreshing,
    });
    refreshControllerRef.current = controller;
    void api.watch(sessionId).catch(() => undefined);
    controller.request();
    return () => {
      controller.dispose();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      void api.unwatch(sessionId).catch(() => undefined);
    };
  }, [api, sessionId]);

  useEffect(() => api?.onChanged((payload) => {
    if (payload.sessionId === sessionId) refreshControllerRef.current?.request();
  }), [api, sessionId]);

  const todos = todoState?.todos ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const branchName = status?.branch?.current ?? (status?.branch?.detached ? "detached HEAD" : t("codeGit.noBranch"));
  const statusCopy = status ? buildGitStatusCopy(status) : t("codeGit.readingStatus");
  const runOperation = async (action: () => Promise<void>, onSuccess?: () => void) => {
    setOperating(true);
    setOperationError(null);
    try {
      await action();
      refreshControllerRef.current?.request();
      onSuccess?.();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : t("codeGit.operationFailed"));
    } finally {
      setOperating(false);
    }
  };

  return (
    <aside
      className={`cy-code-git ${floating.collapsed ? "cy-code-git--collapsed" : ""}`}
      style={{ left: floating.position.x, top: floating.position.y }}
      aria-label={t("codeGit.panelAria")}
    >
      <button type="button" className="cy-code-git__dragbar" onMouseDown={floating.onHeaderMouseDown} onClick={floating.onHeaderClick} aria-expanded={!floating.collapsed} title={t("codeGit.drag")}>
        <span className="cy-code-git__dragline" />
        <span className="cy-code-git__toggle" data-floating-toggle onClick={(event) => { event.stopPropagation(); floating.toggle(); }}><ToggleIcon /></span>
      </button>

      <div className="cy-code-git__body">
        <div className="cy-code-git__mode"><i aria-hidden="true" />Coding</div>
        <div className="cy-code-git__hero">
          <img className="cy-code-git__mascot" src={workingPngUrl} alt={t("codeGit.workingAlt")} />
          <div className="cy-code-git__project">
            <strong>{projectName ?? t("codeGit.noWorkspace")}</strong>
            <span title={statusCopy}>{statusCopy}</span>
          </div>
          <button className="cy-code-git__refresh" type="button" onClick={() => refreshControllerRef.current?.request()} disabled={!api || refreshing} aria-label={t("codeGit.refresh")}>↻</button>
        </div>

        <div className="cy-code-git__git-actions">
          <button type="button" disabled={status?.state !== "ready"} onClick={() => setDialog("branch")}>
            <span>{t("codeGit.branchSwitch")}</span><code>{branchName}</code><b>›</b>
          </button>
          <div className="cy-code-git__change-row">
            <span>{t("codeGit.changes")}</span>
            <span className="cy-code-git__added">+{status?.lines.insertions ?? 0}</span>
            <span className="cy-code-git__deleted">-{status?.lines.deletions ?? 0}</span>
          </div>
          <button type="button" disabled={status?.state !== "ready" || (status.files.length === 0 && status.ahead === 0)} onClick={() => setDialog("commit")}>
            <span>{t("codeGit.commitOrPush")}</span><code>{status?.files.length ? t("codeGit.commitChanges") : status?.ahead ? t("codeGit.pushCommits", { count: status.ahead }) : t("codeGit.noAction")}</code><b>›</b>
          </button>
          {operationError && <p className="cy-code-git__operation-error">{operationError}</p>}
        </div>

        <div className="cy-code-git__divider" />
        <div className="cy-code-git__todo-heading"><span>{t("codeGit.currentTasks")}</span><small>{t("codeGit.todoProgress", { completed, total: todos.length })}</small></div>
        <ul className="cy-code-git__todos" data-testid="code-todo-list">
          {todos.length === 0 ? <li className="is-empty"><i />{t("codeGit.noTasks")}</li> : todos.map((todo) => (
            <li key={todo.id} className={todo.status === "completed" ? "is-completed" : ""}>
              <i /> <span>{todo.content}</span>
            </li>
          ))}
        </ul>
        {planPhase && onOpenPlan && (
          <div className="cy-code-git__plan-status" data-testid="code-plan-status">
            <PlanReviewEntry phase={planPhase} onOpen={onOpenPlan} />
          </div>
        )}
      </div>

      <Modal open={dialog === "branch"} title={t("codeGit.switchBranch")} footer={null} onCancel={() => setDialog(null)} className="cy-code-git-modal">
        <p className="cy-code-git-modal__hint">{t("codeGit.currentBranch")}<code>{branchName}</code></p>
        <div className="cy-code-git-modal__branch-list">
          {status?.branch?.branches.map((branch) => <button key={branch} type="button" disabled={branch === status.branch?.current || operating} onClick={() => api && void runOperation(() => api.switchBranch(sessionId, branch), () => setDialog(null))}>{branch === status.branch?.current ? "✓ " : ""}{branch}</button>)}
        </div>
        <div className="cy-code-git-modal__new-branch">
          <Input value={newBranch} onChange={(event) => setNewBranch(event.target.value)} placeholder={t("codeGit.newBranchPlaceholder")} disabled={operating} onPressEnter={() => api && newBranch.trim() && void runOperation(() => api.switchBranch(sessionId, newBranch.trim(), true), () => { setNewBranch(""); setDialog(null); })} />
          <button type="button" disabled={!api || !newBranch.trim() || operating} onClick={() => api && void runOperation(() => api.switchBranch(sessionId, newBranch.trim(), true), () => { setNewBranch(""); setDialog(null); })}>{t("codeGit.createAndSwitch")}</button>
        </div>
      </Modal>

      <Modal open={dialog === "commit"} title={t("codeGit.commitOrPush")} footer={null} onCancel={() => setDialog(null)} className="cy-code-git-modal">
        {status?.files.length ? <section className="cy-code-git-modal__commit-section">
          <p className="cy-code-git-modal__hint">{t("codeGit.commitHint", { count: status.files.length })}</p>
          <Input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder={t("codeGit.commitMessagePlaceholder")} disabled={operating} />
          <button type="button" disabled={!api || !commitMessage.trim() || operating} onClick={() => api && void runOperation(() => api.commit(sessionId, commitMessage, status.files.map((file) => file.path)), () => { setCommitMessage(""); setDialog(null); })}>{t("codeGit.commitAll")}</button>
        </section> : null}
        {status?.ahead ? <section className="cy-code-git-modal__commit-section">
          <p className="cy-code-git-modal__hint">{t("codeGit.pushHint", { count: status.ahead })}</p>
          <button type="button" disabled={!api || operating} onClick={() => api && void runOperation(() => api.push(sessionId), () => setDialog(null))}>{t("codeGit.pushCommits", { count: status.ahead })}</button>
        </section> : null}
        {operationError && <p className="cy-code-git__operation-error">{operationError}</p>}
      </Modal>
    </aside>
  );
}
