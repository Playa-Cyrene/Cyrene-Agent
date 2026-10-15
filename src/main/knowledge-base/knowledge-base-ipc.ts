import { dialog, shell } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type {
  KnowledgePathEntry, KnowledgePathKind, KnowledgeScope, KnowledgeWorkspaceOption,
} from "../../shared/knowledge-base-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as chatsStore from "../chats/chats-store";
import { getActiveChatSessionId } from "../chats/chat-ui-ipc";
import { workspaceScope } from "../memory/wiki-paths";
import { getKnowledgeBase } from "./knowledge-base-service";

function store() {
  const instance = getKnowledgeBase();
  if (!instance) throw new Error("知识库尚未初始化");
  return instance;
}

async function workspaces(): Promise<KnowledgeWorkspaceOption[]> {
  const found = new Map<string, KnowledgeWorkspaceOption>();
  const activeSessionId = getActiveChatSessionId();
  for (const session of (await chatsStore.listSessions())) {
    if (!session.workspaceRoot) continue;
    try {
      const workspaceId = workspaceScope(session.workspaceRoot).workspaceId;
      found.set(workspaceId, {
        workspaceId, workspaceRoot: session.workspaceRoot,
        workspaceName: session.workspaceDisplayName || session.workspaceRoot,
        active: session.id === activeSessionId || found.get(workspaceId)?.active === true,
      });
    } catch { /* An obsolete workspace binding is not a selectable scope. */ }
  }
  return [...found.values()].sort((a, b) => a.workspaceName.localeCompare(b.workspaceName));
}

async function trustedScope(value: KnowledgeScope): Promise<KnowledgeScope> {
  if (value?.kind === "global") return { kind: "global" };
  if (value?.kind === "workspace") {
    const match = (await workspaces()).find((item) => item.workspaceId === value.workspaceId);
    if (!match) throw new Error("工作区不存在");
    return { kind: "workspace", ...match };
  }
  throw new Error("资料集范围无效");
}

export function registerKnowledgeBaseIpc(ipc: IpcScope = createIpcScope()): void {
  ipc.handle(IPC.KNOWLEDGE_GET_STATE, () => store().state());
  ipc.handle(IPC.KNOWLEDGE_SET_ENABLED, (_event, enabled: boolean) => store().setEnabled(enabled));
  ipc.handle(IPC.KNOWLEDGE_LIST_WORKSPACES, () => workspaces());
  ipc.handle(IPC.KNOWLEDGE_CREATE_COLLECTION, async (_event, input: { name: string; scope: KnowledgeScope }) =>
    store().createCollection({ name: input?.name, scope: await trustedScope(input?.scope) }));
  ipc.handle(IPC.KNOWLEDGE_DELETE_COLLECTION, (_event, id: string) => store().deleteCollection(id));
  ipc.handle(IPC.KNOWLEDGE_SET_COLLECTION_ENABLED, (_event, id: string, enabled: boolean) =>
    store().setCollectionEnabled(id, enabled));
  ipc.handle(IPC.KNOWLEDGE_PICK_PATHS, async (_event, kind: KnowledgePathKind): Promise<string[]> => {
    if (kind !== "file" && kind !== "directory") throw new Error("路径类型无效");
    const result = await dialog.showOpenDialog({ properties: kind === "file"
      ? ["openFile", "multiSelections"] : ["openDirectory"] });
    return result.canceled ? [] : result.filePaths;
  });
  ipc.handle(IPC.KNOWLEDGE_ADD_PATHS, (_event, id: string, paths: KnowledgePathEntry[]) =>
    store().addPaths(id, paths));
  ipc.handle(IPC.KNOWLEDGE_REMOVE_PATH, (_event, id: string, sourcePath: string) =>
    store().removePath(id, sourcePath));
  ipc.handle(IPC.KNOWLEDGE_REFRESH_COLLECTION, (_event, id: string) => store().refreshCollection(id));
  ipc.handle(IPC.KNOWLEDGE_LIST_DOCUMENTS, (_event, id: string) => store().listDocuments(id));
  ipc.handle(IPC.KNOWLEDGE_SEARCH, (_event, query: string, id?: string) =>
    store().search(query, { collectionId: id }));
  ipc.handle(IPC.KNOWLEDGE_OPEN_SOURCE, async (_event, documentId: string) => {
    try {
      const filePath = await store().sourcePath(documentId);
      const error = await shell.openPath(filePath);
      return error ? { ok: false, error } : { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "打开失败" };
    }
  });
}
