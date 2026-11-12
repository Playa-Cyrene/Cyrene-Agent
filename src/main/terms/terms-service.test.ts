import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import builtin from "../../shared/builtin-terms.json";
import type { TermsBundle } from "../../shared/terms-types";
import { createTermsService, TERMS_MAX_BYTES, TERMS_URL, termsContentHash, validateTermsBundle, writeTermsFile, type TermsFetch } from "./terms-service";

let directory: string;
const active: Array<ReturnType<typeof createTermsService>> = [];
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-terms-")); });
afterEach(() => {
  active.splice(0).forEach(service => service.dispose());
  vi.useRealTimers();
  fs.rmSync(directory, { recursive: true, force: true });
});
function bundle(revision = 2, consentVersion = "2026-11-03"): TermsBundle {
  return { ...structuredClone(builtin), schemaVersion: 1, revision, consentVersion } as TermsBundle;
}
function setup(extra: Partial<Parameters<typeof createTermsService>[0]> = {}) {
  const options = {
    cachePath: path.join(directory, "terms.json"), consentPath: path.join(directory, "consent.json"),
    readLegacyConsent: () => "2026-11-02", broadcast: vi.fn(),
    fetchImpl: vi.fn(async () => new Response(JSON.stringify(bundle()))) as TermsFetch, ...extra,
  };
  const service = createTermsService(options);
  active.push(service);
  return { ...service, options };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("verified terms snapshots", () => {
  it("uses builtin offline and preserves only explicit legacy consent", async () => {
    const h = setup({ fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) });
    await h.refresh();
    expect(h.getSnapshot()).toMatchObject({ revision: 1, consentVersion: "2026-11-02", source: "builtin", accepted: true });
    expect(setup({ readLegacyConsent: () => undefined }).getSnapshot().accepted).toBe(false);
    expect(h.options.broadcast).not.toHaveBeenCalled();
  });
  it("synchronizes one complete multilingual packet from the pinned URL and persists it before notification", async () => {
    const h = setup({ broadcast: vi.fn(() => {
      expect(JSON.parse(fs.readFileSync(path.join(directory, "terms.json"), "utf8")).bundle.revision).toBe(2);
    }) });
    await h.refresh();
    expect(h.options.fetchImpl).toHaveBeenCalledWith(TERMS_URL, expect.objectContaining({ redirect: "error", credentials: "omit", cache: "no-store" }));
    expect(h.getSnapshot()).toMatchObject({ revision: 2, accepted: false, source: "remote" });
    expect(Object.keys(h.getSnapshot().locales)).toEqual(["zh-CN", "en", "ja-JP"]);
    expect(setup().getSnapshot()).toMatchObject({ revision: 2, accepted: false, source: "cache" });
  });
  it("requires consent only for a consentVersion increase, not an editorial revision", async () => {
    const h = setup({ fetchImpl: vi.fn(async () => new Response(JSON.stringify(bundle(2, "2026-11-02")))) });
    await h.refresh();
    expect(h.getSnapshot().accepted).toBe(true);
    expect(h.accept(h.getSnapshot()).ok).toBe(true);
    const next = setup({ fetchImpl: vi.fn(async () => new Response(JSON.stringify(bundle(3, "2026-11-02")))) });
    await next.refresh();
    expect(next.getSnapshot().accepted).toBe(true);
  });
  it("binds acceptance to exactly the displayed revision, version and hash and persists across restart", async () => {
    const h = setup();
    const shown = h.getSnapshot();
    await h.refresh();
    expect(h.accept(shown)).toMatchObject({ ok: false, error: "changed" });
    expect(h.accept({ ...h.getSnapshot(), contentHash: "fake" }).ok).toBe(false);
    expect(h.getSnapshot().accepted).toBe(false);
    expect(h.accept(h.getSnapshot())).toMatchObject({ ok: true, snapshot: { accepted: true } });
    expect(setup().getSnapshot()).toMatchObject({ revision: 2, accepted: true });
    const receipt = JSON.parse(fs.readFileSync(h.options.consentPath, "utf8"));
    expect(receipt.contentHash).toBe(h.getSnapshot().contentHash);
    expect(receipt.acceptedAt).toMatch(/^\d{4}-/);
  });
  it("rejects stale, rolled-back consent, and changed contents under an existing revision", async () => {
    let remote = bundle();
    const h = setup({ fetchImpl: vi.fn(async () => new Response(JSON.stringify(remote))) });
    await h.refresh();
    const expected = h.getSnapshot();
    remote = bundle(3, "2026-11-02"); await h.refresh();
    expect(h.getSnapshot()).toEqual(expected);
    remote = bundle(1, "2026-11-04"); await h.refresh();
    expect(h.getSnapshot()).toEqual(expected);
    remote = bundle(); remote.locales.en.heading = "Changed"; await h.refresh();
    expect(h.getSnapshot()).toEqual(expected);
    expect(h.options.broadcast).toHaveBeenCalledTimes(1);
  });
  it("recovers the accepted full snapshot from its receipt when the primary cache is corrupt", async () => {
    const h = setup(); await h.refresh(); h.accept(h.getSnapshot());
    fs.writeFileSync(h.options.cachePath, "{broken");
    expect(setup().getSnapshot()).toMatchObject({ revision: 2, accepted: true, source: "cache" });
  });
  it("rejects corrupt hashes and does not resurrect legacy consent from a corrupt receipt", () => {
    writeTermsFile(path.join(directory, "terms.json"), { bundle: bundle(), contentHash: "bad" });
    fs.writeFileSync(path.join(directory, "consent.json"), "{broken");
    expect(setup().getSnapshot()).toMatchObject({ revision: 1, source: "builtin", accepted: false });
  });
  it("does not expose mutable internal content", () => {
    const h = setup(); const snapshot = h.getSnapshot();
    snapshot.locales.en.heading = "mutated";
    expect(h.getSnapshot().locales.en.heading).not.toBe("mutated");
  });
  it("keeps current memory and disk unchanged when cache replacement fails", async () => {
    const h = setup({ writeFile: () => { throw new Error("disk full"); } });
    await h.refresh();
    expect(h.getSnapshot().revision).toBe(1);
    expect(h.options.broadcast).not.toHaveBeenCalled();
    expect(fs.existsSync(h.options.cachePath)).toBe(false);
  });
  it("reports failed acceptance without advancing consent or notification", async () => {
    const h = setup({ writeFile: (file, data) => {
      if (file.endsWith("consent.json")) throw new Error("disk full");
      writeTermsFile(file, data);
    } });
    await h.refresh();
    expect(h.accept(h.getSnapshot())).toMatchObject({ ok: false, error: "saveFailed", snapshot: { accepted: false } });
    expect(setup().getSnapshot().accepted).toBe(false);
    expect(h.options.broadcast).toHaveBeenCalledTimes(1);
  });
  it("cleans temporary files after a failed atomic replacement", () => {
    const file = path.join(directory, "blocked"); fs.mkdirSync(file);
    expect(() => writeTermsFile(file, { hello: "world" })).toThrow();
    expect(fs.readdirSync(directory)).toEqual(["blocked"]);
  });
});

describe("untrusted remote input and lifecycle", () => {
  it.each([
    ["missing language", (v: any) => { delete v.locales.en; }],
    ["unknown locale", (v: any) => { v.locales.fr = v.locales.en; }],
    ["HTML block", (v: any) => { v.locales.en.sections[0].blocks[0] = { kind: "html", text: "<script>" }; }],
    ["empty body", (v: any) => { v.locales.en.sections = []; }],
    ["invalid schema", (v: any) => { v.schemaVersion = 2; }],
    ["invalid date", (v: any) => { v.consentVersion = "2026-02-30"; }],
    ["invalid revision", (v: any) => { v.revision = Number.MAX_SAFE_INTEGER + 1; }],
    ["unexpected URL", (v: any) => { v.url = "https://example.com"; }],
  ])("rejects %s without partially replacing any language", async (_name, mutate) => {
    const remote = bundle(); mutate(remote);
    const h = setup({ fetchImpl: vi.fn(async () => new Response(JSON.stringify(remote))) });
    await h.refresh();
    expect(h.getSnapshot().revision).toBe(1);
    expect(h.options.broadcast).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON, HTML error pages and oversized streams", async () => {
    for (const body of ["<html>error</html>", "{bad", "x".repeat(TERMS_MAX_BYTES + 1)]) {
      const h = setup({ fetchImpl: vi.fn(async () => new Response(body)) });
      await h.refresh();
      expect(h.getSnapshot().revision).toBe(1);
    }
  });
  it("rejects redirects even if a fetch implementation follows them", async () => {
    const response = new Response(JSON.stringify(bundle()));
    Object.defineProperty(response, "url", { value: "https://example.com/terms.json" });
    const h = setup({ fetchImpl: vi.fn(async () => response) }); await h.refresh();
    expect(h.getSnapshot().revision).toBe(1);
  });
  it("single-flights concurrent refreshes and does not activate requests completing after disposal", async () => {
    const remote = deferred<Response>();
    const fetchImpl = vi.fn(() => remote.promise);
    const h = setup({ fetchImpl });
    const first = h.refresh(); const second = h.refresh();
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    h.dispose();
    remote.resolve(new Response(JSON.stringify(bundle())));
    await first;
    expect(h.getSnapshot().revision).toBe(1);
    expect(h.options.broadcast).not.toHaveBeenCalled();
  });
  it("aborts timed-out requests and stops polling on disposal", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const h = setup({ fetchImpl, timeoutMs: 10, intervalMs: 100 });
    h.start(); h.start();
    await vi.advanceTimersByTimeAsync(11);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(h.getSnapshot().revision).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    h.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("supports same-day substantive versions while canonical hashing ignores key order", () => {
    expect(validateTermsBundle(bundle(3, "2026-11-03.1")).consentVersion).toBe("2026-11-03.1");
    const value = bundle();
    expect(termsContentHash(validateTermsBundle(value))).toBe(termsContentHash(validateTermsBundle({ locales: value.locales, consentVersion: value.consentVersion, revision: value.revision, schemaVersion: 1 })));
  });
});
