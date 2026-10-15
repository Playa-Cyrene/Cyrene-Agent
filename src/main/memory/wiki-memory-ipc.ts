import { IPC } from "../../shared/ipc-channels";
import type {
  WikiClaim, WikiClaimCorrection, WikiClaimDeletion, WikiConflict,
  WikiPageDetail, WikiPageListRequest, WikiPageListResult, WikiPageSummary,
  WikiSearchRequest, WikiSource,
} from "../../shared/wiki-memory-types";
import { createIpcScope, type IpcScope } from "../application/ipc-scope";
import * as chatsStore from "../chats/chats-store";
import { workspaceScope } from "./wiki-paths";
import { getWikiMemoryStore } from "./wiki-memory-scheduler";
import type {
  WikiClaim as StoredClaim, WikiPage as StoredPage,
  WikiPageSummary as StoredSummary, WikiScope as StoredScope,
  WikiSourceRef as StoredSource,
} from "./wiki-types";

async function scopeForUi(scope: StoredScope): Promise<WikiPageSummary["scope"]> {
  if (scope.kind === "global") return scope;
  const workspaceName = (await chatsStore.listSessions()).find((session) => session.workspaceRoot &&
    workspaceScope(session.workspaceRoot).workspaceId === scope.workspaceId)?.workspaceDisplayName;
  return { ...scope, ...(workspaceName ? { workspaceName } : {}) };
}

async function summaryForUi(page: StoredSummary): Promise<WikiPageSummary> {
  return {
    id: page.id, title: page.title, kind: page.pageType,
    tags: page.tags, scope: await scopeForUi(page.scope), updatedAt: page.updatedAt,
    excerpt: page.summary, claimCount: page.claimCount, conflictCount: page.conflictCount,
  };
}

async function sourceForUi(source: StoredSource): Promise<WikiSource> {
  if (source.kind === "chat") {
    const session = (await chatsStore.getSessionRecord(source.conversationId));
    return {
      kind: "chat", sourceId: source.sourceId!,
      locator: `${source.conversationId}/${source.messageId}`,
      version: source.revision, recordedAt: source.assertedAt,
      label: session?.title || source.conversationId,
      quote: source.evidenceQuote,
      conversationId: source.conversationId, entryId: source.messageId,
    };
  }
  return source.kind === "manual"
    ? { kind: "manual", sourceId: source.sourceId, locator: source.sourceId,
      version: "1", recordedAt: source.assertedAt, label: source.note || "用户手动更正" }
    : { kind: "document", sourceId: source.sourceId, locator: source.originalPath,
      version: source.contentHash, recordedAt: source.assertedAt,
      label: source.originalPath, quote: source.evidenceQuote };
}

async function claimForUi(claim: StoredClaim): Promise<WikiClaim> {
  return {
    id: claim.id, subject: claim.subject, predicate: claim.predicate, value: claim.value,
    status: claim.status === "uncertain" ? "pending" : claim.status === "revoked" ? "retracted" : claim.status,
    assertedAt: claim.assertedAt, validFrom: claim.validFrom, validTo: claim.validTo,
    sources: await Promise.all(claim.sources.map(sourceForUi)),
  };
}

async function detailForUi(page: StoredPage): Promise<WikiPageDetail> {
  const store = getWikiMemoryStore();
  const relatedPages: WikiPageDetail["relatedPages"] = [];
  for (const id of page.links.slice(0, 30)) {
    try {
      const related = await store?.readPage(id);
      if (related) relatedPages.push({ id: related.id, title: related.title });
    } catch { /* An externally edited link may be invalid. */ }
  }
  const current = page.claims.filter((claim) => claim.status !== "revoked");
  const excerpt = current.filter((claim) => claim.status === "current").slice(0, 3)
    .map((claim) => `${claim.predicate}：${claim.value}`).join("；").slice(0, 300);
  return {
    id: page.id, title: page.title, kind: page.pageType, tags: page.tags,
    scope: await scopeForUi(page.scope), updatedAt: page.updatedAt, excerpt,
    claimCount: current.length,
    conflictCount: 0,
    body: page.body, claims: await Promise.all(page.claims.map(claimForUi)), relatedPages,
  };
}

function pageRequest(value: unknown): WikiPageListRequest {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const tag = ["chat", "learn", "work", "code"].includes(String(input.tag))
    ? input.tag as WikiPageListRequest["tag"] : undefined;
  const offset = Number.isFinite(Number(input.offset)) ? Math.max(0, Math.floor(Number(input.offset))) : 0;
  const limit = Number.isFinite(Number(input.limit)) ? Math.min(100, Math.max(1, Math.floor(Number(input.limit)))) : 30;
  return { tag, offset, limit };
}

export function registerWikiMemoryIpc(ipc: IpcScope = createIpcScope()): void {
  ipc.handle(IPC.MEMORY_WIKI_LIST_PAGES, async (_event, request: unknown): Promise<WikiPageListResult> => {
    const store = getWikiMemoryStore();
    if (!store) return { items: [], total: 0 };
    const options = pageRequest(request);
    const [items, total] = await Promise.all([store.listPages(options), store.countPages(options)]);
    return { items: await Promise.all(items.map(summaryForUi)), total };
  });
  ipc.handle(IPC.MEMORY_WIKI_SEARCH, async (_event, request: WikiSearchRequest): Promise<WikiPageListResult> => {
    const store = getWikiMemoryStore();
    if (!store || typeof request?.query !== "string") return { items: [], total: 0 };
    const options = pageRequest(request);
    const all = await store.search(request.query, undefined, 100, options.tag);
    return { items: await Promise.all(all.slice(options.offset, options.offset! + options.limit!).map(summaryForUi)), total: all.length };
  });
  ipc.handle(IPC.MEMORY_WIKI_READ_PAGE, async (_event, pageId: unknown): Promise<WikiPageDetail | null> => {
    const store = getWikiMemoryStore();
    if (!store || typeof pageId !== "string") return null;
    try {
      const page = await store.readPage(pageId);
      return page ? detailForUi(page) : null;
    } catch { return null; }
  });
  ipc.handle(IPC.MEMORY_WIKI_LIST_CONFLICTS, async (): Promise<WikiConflict[]> => {
    const store = getWikiMemoryStore();
    if (!store) return [];
    return (await store.listConflicts()).map((conflict) => ({
      pageId: conflict.pageId, pageTitle: conflict.title,
      claimIds: conflict.claims.map((claim) => claim.id),
      reason: `「${conflict.predicate}」${conflict.reason}`,
    }));
  });
  ipc.handle(IPC.MEMORY_WIKI_CORRECT_CLAIM, async (_event, input: WikiClaimCorrection) => {
    const store = getWikiMemoryStore();
    if (!store || typeof input?.pageId !== "string" || typeof input?.claimId !== "string" ||
      typeof input?.value !== "string") return { ok: false, error: "invalid-input" };
    try {
      await store.correctClaim(input);
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "unknown-error" }; }
  });
  ipc.handle(IPC.MEMORY_WIKI_DELETE_CLAIM, async (_event, input: WikiClaimDeletion) => {
    const store = getWikiMemoryStore();
    if (!store || typeof input?.pageId !== "string" || typeof input?.claimId !== "string") {
      return { ok: false, error: "invalid-input" };
    }
    try {
      await store.deleteClaim(input);
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "unknown-error" }; }
  });
}
