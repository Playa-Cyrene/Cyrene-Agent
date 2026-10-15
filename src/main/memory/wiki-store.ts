import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertSafeWikiFile, ensureWikiDirectories, pageIdFor, pageRelativePath, readWikiFile,
  safeWikiPath, wikiHash, wikiRootForUserData, writeWikiFileAtomic,
} from "./wiki-paths";
import {
  mergeWikiCandidate, newWikiPage, parseWikiPage, renderWikiPageBody,
  stringifyWikiPage, stripConversationSources,
} from "./wiki-page";
import type {
  WikiClaim, WikiClaimCandidate, WikiConflict, WikiPage, WikiPageSummary,
  WikiScope, WikiSearchResult, WikiTag, WikiVisibility,
} from "./wiki-types";

interface PageRow {
  id: string;
  title: string;
  aliases: string;
  page_type: string;
  tags: string;
  scope_kind: string;
  workspace_id: string | null;
  updated_at: number;
  excerpt: string;
  claim_count: number;
  conflict_count: number;
}

let jieba: import("@node-rs/jieba").Jieba | null = null;
function tokenizer(): import("@node-rs/jieba").Jieba {
  return jieba ??= new (require("@node-rs/jieba").Jieba)();
}
const INDEX_FILE = "wiki.sqlite";
const DIRTY_FILE = "index-state.json";
const TOMBSTONES_FILE = "source-tombstones.json";
const MAX_SEARCH_ROWS = 100;
const SCHEMA_DOCUMENT = `# Cyrene Wiki 页面规则

- Markdown 页面及其中的来源引用是知识内容；wiki.sqlite 只是可重建的检索索引。
- 页面 YAML 头部的 claims 是事实记录，正文由程序生成。请在应用内更正或删除事实。
- status 为 current、historical、uncertain 或 revoked；待确认事实不能当作确定信息。
- 聊天来源按会话、消息条目、修订号定位。短引文不能替代完整原文。
- global 页面可被所有会话读取；workspace 页面只在对应工作区或用户明确指定该项目时对模型可见。
- document 来源类型为后续知识库预留，当前不会摄取导入文件。
`;

function visible(scope: WikiScope, visibility?: WikiVisibility): boolean {
  return !visibility || scope.kind === "global" || visibility.workspaceIds?.includes(scope.workspaceId) === true;
}

function tokenized(text: string): string {
  return tokenizer().cut(text.normalize("NFKC"), true).filter((part: string) => part.trim()).join(" ");
}

function summary(page: WikiPage): WikiPageSummary {
  const active = page.claims.filter((claim) => claim.status !== "revoked");
  const predicates = new Map<string, number>();
  for (const claim of active.filter((item) => item.status === "uncertain")) {
    predicates.set(claim.predicate, (predicates.get(claim.predicate) ?? 0) + 1);
  }
  return {
    id: page.id, title: page.title, pageType: page.pageType,
    tags: page.tags, scope: page.scope, updatedAt: page.updatedAt,
    summary: active.filter((claim) => claim.status === "current").slice(0, 3)
      .map((claim) => `${claim.predicate}：${claim.value}`).join("；").slice(0, 300),
    claimCount: active.length,
    conflictCount: predicates.size,
  };
}

function rowToSummary(row: PageRow): WikiPageSummary {
  return {
    id: row.id, title: row.title, pageType: row.page_type as WikiPage["pageType"],
    tags: JSON.parse(row.tags) as WikiTag[],
    scope: row.scope_kind === "global" ? { kind: "global" } : { kind: "workspace", workspaceId: row.workspace_id! },
    updatedAt: row.updated_at, summary: row.excerpt,
    claimCount: row.claim_count, conflictCount: row.conflict_count,
  };
}

function cloneWithTombstones(page: WikiPage, tombstones: ReadonlySet<string>): WikiPage {
  if (tombstones.size === 0) return page;
  const copy: WikiPage = structuredClone(page);
  stripConversationSources(copy, (source) => tombstones.has(source.conversationId));
  return copy;
}

/** Markdown is authoritative. SQLite is a disposable search and progress index. */
export class WikiStore {
  readonly root: string;
  private db: DatabaseSync | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private tombstones = new Set<string>();
  private recoveryAttempted = false;

  constructor(userDataRoot: string) {
    this.root = wikiRootForUserData(userDataRoot);
  }

  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.catch(() => undefined).then(run);
    this.queue = next;
    return next;
  }

  async initialize(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = this.open().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  private async open(): Promise<void> {
    await ensureWikiDirectories(this.root);
    const tombstoneRaw = await readWikiFile(this.root, TOMBSTONES_FILE);
    if (tombstoneRaw) {
      const ids: unknown = JSON.parse(tombstoneRaw);
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id.length < 512)) {
        throw new Error("WIKI_INVALID_TOMBSTONES");
      }
      this.tombstones = new Set(ids);
    }
    const dbPath = safeWikiPath(this.root, INDEX_FILE);
    try {
      const stat = await fs.lstat(dbPath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("WIKI_UNSAFE_INDEX");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.db = new DatabaseSync(dbPath);
    try {
      const check = this.db.prepare("PRAGMA quick_check").get() as { quick_check: string };
      if (check.quick_check !== "ok") throw new Error("WIKI_SQLITE_CORRUPT");
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS pages (id TEXT PRIMARY KEY, title TEXT NOT NULL, aliases TEXT NOT NULL, page_type TEXT NOT NULL, tags TEXT NOT NULL, scope_kind TEXT NOT NULL, workspace_id TEXT, updated_at INTEGER NOT NULL, excerpt TEXT NOT NULL, claim_count INTEGER NOT NULL, conflict_count INTEGER NOT NULL, search_text TEXT NOT NULL); CREATE TABLE IF NOT EXISTS progress (conversation_id TEXT PRIMARY KEY, through_seq INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS page_sources (page_id TEXT NOT NULL, conversation_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY(page_id,source_id)); CREATE INDEX IF NOT EXISTS page_sources_conversation ON page_sources(conversation_id);");
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(id UNINDEXED, search_text);");
      if (await readWikiFile(this.root, "schema.md") === null) {
        await writeWikiFileAtomic(this.root, "schema.md", SCHEMA_DOCUMENT);
      }
      const dirty = await readWikiFile(this.root, DIRTY_FILE);
      const count = this.db.prepare("SELECT COUNT(*) AS count FROM pages").get() as { count: number };
      if (dirty || count.count === 0) await this.rebuildIndexInternal();
    } catch (error) {
      this.db.close();
      this.db = null;
      if (!this.recoveryAttempted && /WIKI_SQLITE_CORRUPT|malformed|corrupt|file is not a database/i.test(String(error))) {
        this.recoveryAttempted = true;
        await fs.rename(dbPath, `${dbPath}.corrupt-${Date.now()}`);
        return this.open();
      }
      throw error;
    }
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error("WIKI_INDEX_UNAVAILABLE");
    return this.db;
  }

  private async setDirty(): Promise<void> {
    await writeWikiFileAtomic(this.root, DIRTY_FILE, JSON.stringify({ dirty: true, at: Date.now() }));
  }

  private async clearDirty(): Promise<void> {
    await fs.rm(safeWikiPath(this.root, DIRTY_FILE), { force: true });
  }

  private async readPageRaw(pageId: string): Promise<WikiPage | null> {
    const raw = await readWikiFile(this.root, pageRelativePath(pageId));
    return raw === null ? null : parseWikiPage(raw, pageId);
  }

  private indexPage(page: WikiPage): void {
    const db = this.database();
    const info = summary(page);
    const searchText = tokenized([
      page.title, ...page.aliases, ...page.tags, page.body,
      ...page.claims.filter((claim) => claim.status !== "revoked")
        .flatMap((claim) => [claim.subject, claim.predicate, claim.value]),
    ].join(" "));
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT OR REPLACE INTO pages (id,title,aliases,page_type,tags,scope_kind,workspace_id,updated_at,excerpt,claim_count,conflict_count,search_text) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(page.id, page.title, JSON.stringify(page.aliases), page.pageType, JSON.stringify(page.tags),
          page.scope.kind, page.scope.kind === "workspace" ? page.scope.workspaceId : null,
          page.updatedAt, info.summary, info.claimCount, info.conflictCount, searchText);
      db.prepare("DELETE FROM pages_fts WHERE id=?").run(page.id);
      db.prepare("INSERT INTO pages_fts (id,search_text) VALUES (?,?)").run(page.id, searchText);
      db.prepare("DELETE FROM page_sources WHERE page_id=?").run(page.id);
      const insertSource = db.prepare("INSERT OR IGNORE INTO page_sources (page_id,conversation_id,source_id) VALUES (?,?,?)");
      for (const claim of page.claims) for (const source of claim.sources) {
        if (source.kind === "chat") insertSource.run(page.id, source.conversationId, source.sourceId!);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private async persist(page: WikiPage, shouldCommit?: () => boolean | Promise<boolean>): Promise<void> {
    if (shouldCommit && !(await shouldCommit())) return;
    await this.setDirty();
    try {
      await writeWikiFileAtomic(this.root, pageRelativePath(page.id), stringifyWikiPage(page), shouldCommit);
      this.indexPage(page);
      await this.writeIndexDocument();
      await this.clearDirty();
      await this.appendLog(`更新页面 ${page.id}，事实 ${page.claims.length} 条`).catch(() => undefined);
    } catch (error) {
      // A cancelled or failed cross-file write may have committed Markdown but not SQLite.
      await this.rebuildIndexInternal().catch(() => undefined);
      throw error;
    }
  }

  private async removePage(pageId: string): Promise<void> {
    await this.setDirty();
    const relative = pageRelativePath(pageId);
    const file = await assertSafeWikiFile(this.root, relative);
    await fs.rm(file, { force: true });
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("DELETE FROM pages_fts WHERE id=?").run(pageId);
      db.prepare("DELETE FROM page_sources WHERE page_id=?").run(pageId);
      db.prepare("DELETE FROM pages WHERE id=?").run(pageId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    await this.writeIndexDocument();
    await this.clearDirty();
  }

  private async allPageIds(): Promise<string[]> {
    const root = safeWikiPath(this.root, "pages");
    const result: string[] = [];
    const walk = async (directory: string): Promise<void> => {
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error("WIKI_UNSAFE_DIRECTORY");
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile() && entry.name.endsWith(".md")) {
          const relative = path.relative(this.root, absolute);
          const parts = relative.split(path.sep);
          const id = parts.length === 2 && parts[1] === "self.md" ? "global/self"
            : parts.length === 3 && parts[1] === "global" ? `global/${path.basename(parts[2], ".md")}`
            : parts.length === 4 && parts[1] === "projects" ? `workspace/${parts[2]}/${path.basename(parts[3], ".md")}` : "";
          if (id) {
            try { if (pageRelativePath(id) === relative) result.push(id); }
            catch { /* Ignore files outside the supported wiki page layout. */ }
          }
        }
      }
    };
    await walk(root);
    return result;
  }

  private async rebuildIndexInternal(): Promise<void> {
    const db = this.database();
    await this.setDirty();
    db.exec("DELETE FROM pages_fts; DELETE FROM page_sources; DELETE FROM pages");
    for (const id of await this.allPageIds()) {
      const page = await this.readPageRaw(id);
      if (page) this.indexPage(page);
    }
    await this.writeIndexDocument();
    await this.clearDirty();
  }

  async rebuildIndex(): Promise<void> {
    await this.initialize();
    return this.enqueue(() => this.rebuildIndexInternal());
  }

  private async writeIndexDocument(): Promise<void> {
    const rows = this.database().prepare("SELECT id,title,excerpt FROM pages ORDER BY title COLLATE NOCASE").all() as unknown as Array<Pick<PageRow,"id"|"title"|"excerpt">>;
    const content = ["# Cyrene Wiki", "", ...rows.map((row) => `- [${row.title.replace(/[\[\]]/g, "")}](${pageRelativePath(row.id).replaceAll("\\", "/")})${row.excerpt ? ` — ${row.excerpt.replace(/[\r\n]/g, " ")}` : ""}`), ""].join("\n");
    await writeWikiFileAtomic(this.root, "index.md", content);
  }

  private async appendLog(event: string): Promise<void> {
    const existing = await readWikiFile(this.root, "log.md") ?? "# 维基维护记录\n\n";
    const lines = existing.split("\n");
    const kept = lines.length > 500 ? [lines[0], "", ...lines.slice(-498)] : lines;
    await writeWikiFileAtomic(this.root, "log.md", `${kept.join("\n").trimEnd()}\n- ${new Date().toISOString()} ${event}\n`);
  }

  async applyClaims(candidates: WikiClaimCandidate[], options: { shouldCommit?: () => boolean | Promise<boolean> } = {}): Promise<WikiPage[]> {
    await this.initialize();
    return this.enqueue(async () => {
      const changed = new Map<string, WikiPage>();
      const known = this.database().prepare("SELECT id,title,aliases,scope_kind,workspace_id FROM pages")
        .all() as unknown as Array<Pick<PageRow, "id" | "title" | "aliases" | "scope_kind" | "workspace_id">>;
      const references = [
        ...known.map((row) => ({
          id: row.id, names: [row.title, ...(JSON.parse(row.aliases) as string[])],
          scope: row.scope_kind === "global" ? { kind: "global" as const } :
            { kind: "workspace" as const, workspaceId: row.workspace_id! },
        })),
      ];
      const sameScope = (left: WikiScope, right: WikiScope): boolean => left.kind === right.kind &&
        (left.kind === "global" || (right.kind === "workspace" && left.workspaceId === right.workspaceId));
      const normalized = (name: string): string => name.normalize("NFKC").trim().toLocaleLowerCase();
      for (const candidate of candidates) {
        if (options.shouldCommit && !(await options.shouldCommit())) break;
        if (this.tombstones.has(candidate.source.conversationId)) continue;
        const candidateNames = new Set([candidate.subject, ...(candidate.aliases ?? [])].map(normalized));
        const exactMatches = [
          ...known.filter((row) => sameScope(
            row.scope_kind === "global" ? { kind: "global" } : { kind: "workspace", workspaceId: row.workspace_id! },
            candidate.scope,
          ) && [row.title, ...(JSON.parse(row.aliases) as string[])].some((name) => candidateNames.has(normalized(name)))).map((row) => row.id),
          ...[...changed.values()].filter((page) => sameScope(page.scope, candidate.scope) &&
            [page.title, ...page.aliases].some((name) => candidateNames.has(normalized(name)))).map((page) => page.id),
        ];
        const uniqueMatches = [...new Set(exactMatches)];
        const id = uniqueMatches.length === 1 ? uniqueMatches[0] : pageIdFor(candidate.subject, candidate.scope);
        const page = changed.get(id) ?? await this.readPageRaw(id) ?? newWikiPage(id, candidate);
        const relatedPageIds = [...references, ...[...changed.values()].map((current) => ({
          id: current.id, names: [current.title, ...current.aliases], scope: current.scope,
        }))].filter((reference) => reference.id !== id &&
          (reference.scope.kind === "global" || (candidate.scope.kind === "workspace" &&
            reference.scope.kind === "workspace" && reference.scope.workspaceId === candidate.scope.workspaceId)) &&
          reference.names.some((name) => name.length >= 2 && candidate.value.includes(name)))
          .map((reference) => reference.id);
        if (mergeWikiCandidate(page, {
          ...candidate,
          aliases: page.title === candidate.subject ? candidate.aliases : [...(candidate.aliases ?? []), candidate.subject],
          relatedPageIds: [...new Set(relatedPageIds)],
        })) changed.set(id, page);
      }
      for (const page of changed.values()) {
        if (options.shouldCommit && !(await options.shouldCommit())) break;
        await this.persist(page, options.shouldCommit);
      }
      return [...changed.values()];
    });
  }

  async findPage(subject: string, scope: WikiScope): Promise<WikiPage | null> {
    return this.readPage(pageIdFor(subject, scope));
  }

  async readPage(pageId: string, visibility?: WikiVisibility): Promise<WikiPage | null> {
    await this.initialize();
    const page = await this.readPageRaw(pageId);
    return page && visible(page.scope, visibility) ? cloneWithTombstones(page, this.tombstones) : null;
  }

  async listPages(options: { tag?: WikiTag; offset?: number; limit?: number; visibility?: WikiVisibility } = {}): Promise<WikiPageSummary[]> {
    await this.initialize();
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 30)));
    const { where, params } = this.pageFilter(options);
    const rows = this.database().prepare(`SELECT * FROM pages ${where} ORDER BY updated_at DESC, id LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as unknown as PageRow[];
    return rows.map(rowToSummary);
  }

  async countPages(options: { tag?: WikiTag; visibility?: WikiVisibility } = {}): Promise<number> {
    await this.initialize();
    const { where, params } = this.pageFilter(options);
    const row = this.database().prepare(`SELECT COUNT(*) AS count FROM pages ${where}`).get(...params) as { count: number };
    return row.count;
  }

  private pageFilter(options: { tag?: WikiTag; visibility?: WikiVisibility }): { where: string; params: string[] } {
    const clauses: string[] = [];
    const params: string[] = [];
    if (options.tag) {
      clauses.push("tags LIKE ?");
      params.push(`%"${options.tag}"%`);
    }
    if (options.visibility) {
      const ids = options.visibility.workspaceIds ?? [];
      clauses.push(ids.length ? `(scope_kind='global' OR workspace_id IN (${ids.map(() => "?").join(",")}))` : "scope_kind='global'");
      params.push(...ids);
    }
    return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
  }

  async search(query: string, visibility?: WikiVisibility, limit = 20, tag?: WikiTag): Promise<WikiSearchResult[]> {
    await this.initialize();
    const normalized = query.normalize("NFKC").trim().slice(0, 200);
    if (!normalized) return [];
    const tokens = tokenizer().cut(normalized, true).map((part: string) => part.trim()).filter(Boolean).slice(0, 12);
    const ftsQuery = tokens.map((part) => `"${part.replaceAll('"', '""')}"`).join(" OR ");
    const ids = new Set<string>();
    if (ftsQuery) {
      try {
        const matches = this.database().prepare("SELECT id FROM pages_fts WHERE pages_fts MATCH ? LIMIT ?")
          .all(ftsQuery, MAX_SEARCH_ROWS) as unknown as Array<{ id: string }>;
        for (const row of matches) ids.add(row.id);
      } catch {
        // Punctuation-only input can be invalid FTS syntax; title matching still works.
      }
    }
    const candidateIds = [...ids];
    const placeholders = candidateIds.map(() => "?").join(",");
    const rows = this.database().prepare(`SELECT * FROM pages WHERE ${candidateIds.length ? `id IN (${placeholders}) OR ` : ""}title LIKE ? OR aliases LIKE ? LIMIT 200`)
      .all(...candidateIds, `%${normalized}%`, `%${normalized}%`) as unknown as PageRow[];
    const scored: WikiSearchResult[] = [];
    for (const row of rows) {
      const item = rowToSummary(row);
      if (!visible(item.scope, visibility) || (tag && !item.tags.includes(tag))) continue;
      const title = item.title.normalize("NFKC").toLowerCase();
      const aliases = (JSON.parse(row.aliases) as string[]).join(" ").normalize("NFKC").toLowerCase();
      const needle = normalized.toLowerCase();
      const titleHit = title.includes(needle) || aliases.includes(needle);
      const bodyHit = ids.has(row.id);
      if (!titleHit && !bodyHit) continue;
      let original: WikiPage | null;
      try { original = await this.readPageRaw(row.id); }
      catch { continue; }
      if (!original) continue;
      const page = cloneWithTombstones(original, this.tombstones);
      const shown = summary(page);
      if (shown.claimCount === 0) continue;
      scored.push({ ...shown, score: titleHit ? 100 + (title === needle ? 50 : 0) : 10 });
    }
    return scored.sort((a, b) => b.score - a.score || b.updatedAt - a.updatedAt).slice(0, Math.min(100, Math.max(1, limit)));
  }

  async listConflicts(visibility?: WikiVisibility): Promise<WikiConflict[]> {
    await this.initialize();
    const rows = this.database().prepare("SELECT id FROM pages WHERE conflict_count>0").all() as unknown as Array<{ id: string }>;
    const result: WikiConflict[] = [];
    for (const row of rows) {
      const page = await this.readPage(row.id, visibility);
      if (!page) continue;
      const groups = new Map<string, WikiClaim[]>();
      for (const claim of page.claims.filter((item) => item.status === "uncertain")) {
        groups.set(claim.predicate, [...(groups.get(claim.predicate) ?? []), claim]);
      }
      for (const [predicate, claims] of groups) {
        result.push({ pageId: page.id, title: page.title, predicate, claims,
          reason: claims.length > 1 ? "不同说法需要确认" : "这条事实的来源尚待确认" });
      }
    }
    return result;
  }

  async correctClaim(input: { pageId: string; claimId: string; value: string; note?: string }): Promise<WikiPage> {
    await this.initialize();
    return this.enqueue(async () => {
      const page = await this.readPageRaw(input.pageId);
      const claim = page?.claims.find((item) => item.id === input.claimId);
      const value = input.value.trim();
      if (!page || !claim || !value || value.length > 2000) throw new Error("WIKI_INVALID_CORRECTION");
      const at = Date.now();
      for (const old of page.claims.filter((item) => item.predicate === claim.predicate &&
        (item.status === "current" || item.status === "uncertain" || item.id === claim.id))) {
        old.status = "revoked";
        old.manuallyRevoked = true;
        this.suppressReplay(page, old);
      }
      const manualId = `manual:${randomUUID()}`;
      page.claims.push({
        id: `claim:${wikiHash(manualId)}`, subject: claim.subject, predicate: claim.predicate,
        value, status: "current", assertedAt: at,
        sources: [{ kind: "manual", sourceId: manualId, assertedAt: at, ...(input.note ? { note: input.note.slice(0, 500) } : {}) }],
      });
      page.updatedAt = at;
      page.body = renderWikiPageBody(page);
      await this.persist(page);
      return page;
    });
  }

  async deleteClaim(input: { pageId: string; claimId: string }): Promise<WikiPage> {
    await this.initialize();
    return this.enqueue(async () => {
      const page = await this.readPageRaw(input.pageId);
      const claim = page?.claims.find((item) => item.id === input.claimId);
      if (!page || !claim) throw new Error("WIKI_CLAIM_NOT_FOUND");
      this.suppressReplay(page, claim);
      claim.status = "revoked";
      claim.manuallyRevoked = true;
      claim.sources.push({ kind: "manual", sourceId: `manual:${randomUUID()}`, assertedAt: Date.now(), note: "用户删除" });
      page.updatedAt = Date.now();
      page.body = renderWikiPageBody(page);
      await this.persist(page);
      return page;
    });
  }

  private suppressReplay(page: WikiPage, claim: WikiClaim): void {
    for (const source of claim.sources) {
      if (source.kind !== "chat") continue;
      const marker = `${source.sourceId}:${wikiHash(JSON.stringify([claim.predicate, claim.value]))}`;
      if (!page.suppressedSourceIds.includes(marker)) page.suppressedSourceIds.push(marker);
    }
  }

  async tombstoneConversation(conversationId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const had = this.tombstones.has(conversationId);
      this.tombstones.add(conversationId);
      try {
        await writeWikiFileAtomic(this.root, TOMBSTONES_FILE, JSON.stringify([...this.tombstones]));
      } catch (error) {
        if (!had) this.tombstones.delete(conversationId);
        throw error;
      }
    });
  }

  async listTombstonedConversations(): Promise<string[]> {
    await this.initialize();
    return [...this.tombstones];
  }

  async untombstoneConversation(conversationId: string): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      const had = this.tombstones.has(conversationId);
      this.tombstones.delete(conversationId);
      try {
        await writeWikiFileAtomic(this.root, TOMBSTONES_FILE, JSON.stringify([...this.tombstones]));
      } catch (error) {
        if (had) this.tombstones.add(conversationId);
        throw error;
      }
    });
  }

  async reconcileConversationSources(conversationId: string, activeSourceIds: readonly string[]): Promise<void> {
    await this.initialize();
    const active = new Set(activeSourceIds);
    await this.enqueue(async () => {
      const rows = this.database().prepare("SELECT DISTINCT page_id AS id FROM page_sources WHERE conversation_id=?")
        .all(conversationId) as unknown as Array<{ id: string }>;
      for (const row of rows) {
        const page = await this.readPageRaw(row.id);
        if (page && stripConversationSources(page, (source) => source.conversationId === conversationId &&
          (this.tombstones.has(conversationId) || !active.has(source.sourceId!)))) {
          if (page.claims.length === 0 && page.suppressedSourceIds.length === 0) await this.removePage(page.id);
          else await this.persist(page);
        }
      }
    });
  }

  async getProcessedSeq(conversationId: string): Promise<number> {
    await this.initialize();
    const row = this.database().prepare("SELECT through_seq FROM progress WHERE conversation_id=?").get(conversationId) as { through_seq: number } | undefined;
    return row?.through_seq ?? 0;
  }

  async markProcessedSeq(conversationId: string, seq: number): Promise<void> {
    await this.initialize();
    await this.enqueue(async () => {
      this.database().prepare("INSERT INTO progress (conversation_id,through_seq) VALUES (?,?) ON CONFLICT(conversation_id) DO UPDATE SET through_seq=MAX(through_seq,excluded.through_seq)").run(conversationId, seq);
    });
  }

  async close(): Promise<void> {
    await this.ready?.catch(() => undefined);
    await this.queue.catch(() => undefined);
    this.db?.close();
    this.db = null;
    this.ready = null;
    this.tombstones.clear();
    this.recoveryAttempted = false;
    jieba = null;
  }
}
