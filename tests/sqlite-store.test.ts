import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CACHE_VERSION, cachePathFor, loadFacts, persistFacts, readEnrolledBoundaries } from "../src/core/build.js";
import { loadSqliteSnapshot, querySqliteNeighborhood, querySqliteSeeds, saveSqliteSnapshot, sqliteAvailability } from "../src/core/sqlite-store.js";
import { dwell, ensureState, evictState, focus, impact, setResidentPreference } from "../src/core/ops.js";
import { hasAstGrep } from "../src/core/astgrep.js";
import { resetSessions } from "../src/core/session.js";
import { ensureWorktreeCache } from "../src/core/worktree-cache.js";
import type { Graph } from "../src/core/types.js";

const roots: string[] = [];
const rootAt = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fovea-sqlite-store-"));
  roots.push(root);
  return root;
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    const cache = await ensureWorktreeCache(root).catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
    if (cache) rmSync(cache.dir, { recursive: true, force: true });
  }
});

const graphFor = (file: string, name = "answer"): Graph => {
  const nodes = [
    { id: `file:${file}`, name: file, kind: "file" as const, file, line: 0, sig: file, lang: "TypeScript" },
    { id: `${name}@${file}`, name, kind: "function" as const, file, line: 1, sig: `function ${name}()`, lang: "TypeScript" },
  ];
  return {
    nodes,
    edges: [{ a: 0, b: 1, kind: "contains", w: 1 }],
    byName: new Map([[name.toLowerCase(), [1]]]),
    byFile: new Map([[file, [0, 1]]]),
    anchors: [],
    files: [file],
  };
};

const lazyGraphFor = (): Graph => {
  const nodes = [
    { id: "file:caller.ts", name: "caller.ts", kind: "file" as const, file: "caller.ts", line: 0, sig: "caller.ts", lang: "TypeScript" },
    { id: "caller@caller.ts", name: "caller", kind: "function" as const, file: "caller.ts", line: 3, sig: "function caller()", lang: "TypeScript" },
    { id: "file:subject.ts", name: "subject.ts", kind: "file" as const, file: "subject.ts", line: 0, sig: "subject.ts", lang: "TypeScript" },
    { id: "subject@subject.ts", name: "subject", kind: "function" as const, file: "subject.ts", line: 5, sig: "function subject()", lang: "TypeScript" },
    { id: "file:subject.test.ts", name: "subject.test.ts", kind: "file" as const, file: "subject.test.ts", line: 0, sig: "subject.test.ts", lang: "TypeScript" },
    { id: "anchor:GET /things", name: "GET /things", kind: "anchor" as const, file: "subject.ts", line: 5, sig: "GET /things", lang: "anchor" },
  ];
  const edges: Graph["edges"] = [
    { a: 0, b: 1, kind: "contains", w: 1 }, { a: 2, b: 3, kind: "contains", w: 1 },
    { a: 4, b: 2, kind: "tests", w: 0.6 }, { a: 0, b: 2, kind: "imports", w: 0.3 },
    { a: 1, b: 3, kind: "invokes", w: 0.7 }, { a: 5, b: 3, kind: "anchors", w: 1 },
  ];
  const byFile = new Map<string, number[]>();
  nodes.forEach((node, i) => (byFile.get(node.file) ?? byFile.set(node.file, []).get(node.file)!).push(i));
  return { nodes, edges, byName: new Map([["caller", [1]], ["subject", [3]]]), byFile, anchors: [], files: [...byFile.keys()].sort() };
};

const storeFor = (root: string, file = "a.ts", name = "answer") => {
  const path = join(root, file);
  if (!existsSync(path)) writeFileSync(path, `export function ${name}() {}\n`);
  const info = statSync(path);
  return {
  root,
  facts: new Map([[file, {
    sha1: "a".repeat(40),
    symbols: [{ name, kind: "function" as const, file, line: 1, sig: `function ${name}()`, lang: "TypeScript" }],
    imports: [{ file, spec: "./dep", line: 2 }],
    calls: [{ file, callee: "other", line: 3 }],
    literals: [{ file, text: "GET /things", line: 4 }],
    anchors: [{ id: "GET /things", kind: "route", label: "GET /things", nodeId: `${name}@${file}`, file, line: 4 }],
    sigs: { "call:other": [1, 0] as [number, number] },
  }]]),
  meta: new Map([[file, { size: info.size, mtime: info.mtimeMs }]]),
  tainted: new Set<string>(),
  failedSha: new Map<string, string>(),
  unreadable: new Set<string>(),
  oversized: new Set<string>(),
  generated: new Set<string>(),
  rulesSha: "rules-v1",
  enrolled: new Set(["nested"]),
  savedAt: 0,
  };
};

const sqliteOnly = async (): Promise<boolean> => await sqliteAvailability();

const cacheSecrets = {
  apiKey: "sk-proj-0123456789abcdefghijklmnop",
  passwordUrl: "postgres://alice:correct-horse-battery-staple@db.example.test/app",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJm b3ZlYS11c2VyIn0.signaturepart12345".replace(" ", ""),
};
const secretValues = Object.values(cacheSecrets);
const expectRedacted = (value: string): void => {
  for (const secret of secretValues) expect(value).not.toContain(secret);
  expect(value).toContain("[REDACTED]");
};

const sensitiveStoreFor = (root: string) => {
  const store = storeFor(root);
  const facts = store.facts.get("a.ts")!;
  facts.symbols[0]!.sig = `function answer(key = '${cacheSecrets.apiKey}', url = '${cacheSecrets.passwordUrl}', jwt = '${cacheSecrets.jwt}')`;
  facts.literals = Object.values(cacheSecrets).map((text, index) => ({ file: "a.ts", text, line: index + 4 }));
  facts.anchors[0]!.label = `diagnostic ${cacheSecrets.passwordUrl}`;
  facts.sigs = { ...facts.sigs, [`call:${cacheSecrets.jwt}`]: [1, 0] };
  const graph = graphFor("a.ts");
  graph.nodes[1]!.sig = facts.symbols[0]!.sig;
  return { store, graph };
};

describe("SQLite graph store", () => {
  it("auto-initializes a versioned normalized store and round-trips facts plus graph edges", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    expect(await loadSqliteSnapshot(root, CACHE_VERSION)).toBeUndefined();
    const cache = await ensureWorktreeCache(root);
    expect(existsSync(cache.databasePath)).toBe(true);
    expect(await cachePathFor(root)).toBe(join(cache.dir, "facts.jsonl"));

    const store = storeFor(root);
    expect(await saveSqliteSnapshot(store, graphFor("a.ts"), CACHE_VERSION)).toBe(true);
    await persistFacts(store, graphFor("a.ts"));
    // A successful SQLite persistence has no JSONL mirror at all.
    expect(existsSync(await cachePathFor(root))).toBe(false);
    const loaded = await loadSqliteSnapshot(root, CACHE_VERSION);
    expect(loaded?.generation).toBe(1);
    expect(loaded?.rulesSha).toBe("rules-v1");
    expect(loaded?.enrolled).toEqual(["nested"]);
    expect(loaded?.facts.get("a.ts")).toMatchObject({
      sha1: "a".repeat(40),
      symbols: [{ name: "answer", line: 1 }],
      imports: [{ spec: "./dep", line: 2 }],
      calls: [{ callee: "other", line: 3 }],
      literals: [{ text: "GET /things", line: 4 }],
      anchors: [{ id: "GET /things", nodeId: "answer@a.ts" }],
    });

    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(cache.databasePath, { readOnly: true });
    try {
      expect(db.prepare("SELECT value FROM metadata WHERE key = 'semantic_version'").get()).toMatchObject({ value: String(CACHE_VERSION) });
      expect(db.prepare("SELECT COUNT(*) AS n FROM symbols").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM imports").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM calls").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM anchors").get()).toMatchObject({ n: 1 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM edges").get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("redacts secret values in SQLite rows and lazy structured details", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const { store, graph } = sensitiveStoreFor(root);
    expect(await saveSqliteSnapshot(store, graph, CACHE_VERSION)).toBe(true);

    const cache = await ensureWorktreeCache(root);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(cache.databasePath, { readOnly: true });
    try {
      const raw = JSON.stringify({
        literals: db.prepare("SELECT text FROM literals").all(),
        symbols: db.prepare("SELECT name, sig FROM symbols").all(),
        anchors: db.prepare("SELECT anchor_key, label, node_key FROM anchors").all(),
        diagnostics: db.prepare("SELECT sigs_json FROM file_facts").all(),
        nodes: db.prepare("SELECT node_key, name, sig FROM graph_nodes").all(),
      });
      expectRedacted(raw);
    } finally {
      db.close();
    }

    resetSessions();
    const result = await focus(root, "answer", 512, { fresh: true });
    expect(result.details.queryMode).toBe("sqlite-index");
    expectRedacted(JSON.stringify(result.details));
  });

  it("redacts secret values in the private JSONL fallback", async () => {
    const root = rootAt();
    const { store, graph } = sensitiveStoreFor(root);
    vi.stubEnv("FOVEA_SQLITE_DISABLE", "1");
    try {
      await persistFacts(store, graph);
      const fallback = await cachePathFor(root);
      expectRedacted(readFileSync(fallback, "utf8"));
      expect(statSync(fallback).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("does not consult the historic predictable /tmp JSONL cache", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const unsafe = join(tmpdir(), `pi-fovea-${createHash("sha1").update(root).digest("hex").slice(0, 16)}.json`);
    try {
      writeFileSync(unsafe, `${JSON.stringify({ fovea: CACHE_VERSION, root, rulesSha: "unsafe", enrolled: ["attacker-boundary"] })}\n`, { mode: 0o666 });
      expect(await readEnrolledBoundaries(root)).toEqual([]);
    } finally {
      rmSync(unsafe, { force: true });
    }
  });

  it("uses a mode-0600 private JSONL fallback only when SQLite is disabled", async () => {
    const root = rootAt();
    const file = join(root, "a.ts");
    writeFileSync(file, "export const answer = 42;\n");
    const info = statSync(file);
    const facts = storeFor(root);
    const fallback = await cachePathFor(root);
    writeFileSync(fallback, `${JSON.stringify({ fovea: CACHE_VERSION, root, rulesSha: "rules-v1", enrolled: ["nested"] })}\n${JSON.stringify({ file: "a.ts", sha1: "a".repeat(40), size: info.size, mtime: info.mtimeMs, facts: (() => { const { sha1: _sha, ...rest } = facts.facts.get("a.ts")!; return rest; })() })}\n`, { mode: 0o600 });
    vi.stubEnv("FOVEA_SQLITE_DISABLE", "1");
    try {
      const loaded = await loadFacts(root, ["a.ts"]);
      expect(loaded.dirty).toEqual([]);
      expect(loaded.store.facts.get("a.ts")?.calls[0]?.callee).toBe("other");
      expect(statSync(fallback).mode & 0o777).toBe(0o600);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("discards an obsolete SQLite database rather than retaining a recovery copy", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const file = join(root, "a.ts");
    writeFileSync(file, "export const answer = 42;\n");
    const info = statSync(file);
    const facts = storeFor(root);
    // A legacy cache is deliberately usable without ast-grep: matching stat
    // metadata makes this test prove the storage migration path, not parsing.
    writeFileSync(await cachePathFor(root), `${JSON.stringify({ fovea: CACHE_VERSION, root, rulesSha: "rules-v1", enrolled: ["nested"] })}\n${JSON.stringify({ file: "a.ts", sha1: "a".repeat(40), size: info.size, mtime: info.mtimeMs, facts: (() => { const { sha1: _sha, ...rest } = facts.facts.get("a.ts")!; return rest; })() })}\n`, { mode: 0o600 });
    expect(await saveSqliteSnapshot(facts, graphFor("a.ts"), CACHE_VERSION - 1)).toBe(true);

    const loaded = await loadFacts(root, ["a.ts"]);
    expect(loaded.dirty).toEqual(["a.ts"]);
    // SQLite recovered and is authoritative, so even a private fallback is
    // ignored rather than importing stale compatibility facts.
    expect(loaded.store.facts.get("a.ts")?.sha1).not.toBe("a".repeat(40));
    const cache = await ensureWorktreeCache(root);
    expect(readdirSync(cache.dir).some((name) => name.startsWith("fovea.sqlite.recovered-"))).toBe(false);
  });

  it("does not read JSONL after SQLite successfully recovers corruption", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const file = join(root, "a.ts");
    writeFileSync(file, "export const answer = 42;\n");
    const info = statSync(file);
    const facts = storeFor(root);
    writeFileSync(await cachePathFor(root), `${JSON.stringify({ fovea: CACHE_VERSION, root, rulesSha: "rules-v1" })}\n${JSON.stringify({ file: "a.ts", sha1: "a".repeat(40), size: info.size, mtime: info.mtimeMs, facts: (() => { const { sha1: _sha, ...rest } = facts.facts.get("a.ts")!; return rest; })() })}\n`, { mode: 0o600 });
    const cache = await ensureWorktreeCache(root);
    writeFileSync(cache.databasePath, "this is not sqlite");

    const loaded = await loadFacts(root, ["a.ts"]);
    expect(loaded.dirty).toEqual(["a.ts"]);
    expect(loaded.store.facts.get("a.ts")?.calls[0]?.callee).not.toBe("other");
    expect((await loadSqliteSnapshot(root, CACHE_VERSION))?.facts.get("a.ts")?.sha1).not.toBe("a".repeat(40));
    expect(readdirSync(cache.dir).some((name) => name.startsWith("fovea.sqlite.recovered-"))).toBe(true);
  });

  it("keeps reader snapshots valid while concurrent writers publish one transactional live generation", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    expect(await saveSqliteSnapshot(storeFor(root, "a.ts", "v0"), graphFor("a.ts", "v0"), CACHE_VERSION)).toBe(true);
    const results = await Promise.all(Array.from({ length: 10 }, async (_, i) => {
      const writer = saveSqliteSnapshot(storeFor(root, "a.ts", `v${i + 1}`), graphFor("a.ts", `v${i + 1}`), CACHE_VERSION);
      const reader = loadSqliteSnapshot(root, CACHE_VERSION);
      const [written, seen] = await Promise.all([writer, reader]);
      return { written, seen };
    }));
    expect(results.every((result) => result.written)).toBe(true);
    // A reader can observe an older generation, but never a partial one.
    expect(results.every((result) => result.seen === undefined || result.seen.facts.get("a.ts")?.symbols.length === 1)).toBe(true);
    const final = await loadSqliteSnapshot(root, CACHE_VERSION);
    expect(final?.generation).toBe(1);
    expect(final?.facts.get("a.ts")?.symbols[0]?.name).toMatch(/^v\d+$/);
  });

  it("queries indexed seeds and only a weighted relationship neighborhood with typed edges", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    expect(await saveSqliteSnapshot(storeFor(root), lazyGraphFor(), CACHE_VERSION)).toBe(true);
    const subject = await querySqliteSeeds(root, CACHE_VERSION, "subject");
    expect(subject?.seeds).toContain("subject@subject.ts");
    const neighborhood = await querySqliteNeighborhood(root, CACHE_VERSION, subject!.seeds, { depth: 1, cap: 16 });
    const kinds = new Set(neighborhood?.graph.edges.map((edge) => edge.kind));
    expect([...kinds]).toEqual(expect.arrayContaining(["contains", "invokes", "anchors"]));
    expect(neighborhood?.graph.nodes).toHaveLength(4); // seed + direct caller/file/anchor, not all six rows
    expect(neighborhood?.uncertain).toBe(true);
    const repeated = await querySqliteNeighborhood(root, CACHE_VERSION, subject!.seeds, { depth: 1, cap: 16 });
    expect(repeated?.graph.nodes.map((node) => node.id)).toEqual(neighborhood?.graph.nodes.map((node) => node.id));
    expect(repeated?.graph.edges).toEqual(neighborhood?.graph.edges);

    const route = await querySqliteSeeds(root, CACHE_VERSION, "/things");
    expect(route?.seeds).toContain("anchor:GET /things");
    const caller = await querySqliteSeeds(root, CACHE_VERSION, "caller");
    const callerNeighborhood = await querySqliteNeighborhood(root, CACHE_VERSION, caller!.seeds, { depth: 3, cap: 16 });
    expect(callerNeighborhood?.graph.edges.some((edge) => edge.kind === "imports")).toBe(true);
    expect(callerNeighborhood?.graph.edges.some((edge) => edge.kind === "tests")).toBe(true);
  });

  it("rejects lazy snapshots when the current file manifest gains or loses a file", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const store = storeFor(root);
    expect(await saveSqliteSnapshot(store, graphFor("a.ts"), CACHE_VERSION)).toBe(true);
    expect((await querySqliteSeeds(root, CACHE_VERSION, "answer"))?.seeds).toContain("answer@a.ts");

    const added = join(root, "b.ts");
    writeFileSync(added, "export const b = 1;\n");
    expect(await querySqliteSeeds(root, CACHE_VERSION, "answer")).toBeUndefined();

    const a = store.facts.get("a.ts")!;
    const info = statSync(added);
    store.meta.set("b.ts", { size: info.size, mtime: info.mtimeMs });
    store.facts.set("b.ts", { ...a, sha1: "b".repeat(40), symbols: [], imports: [], calls: [], literals: [], anchors: [] });
    expect(await saveSqliteSnapshot(store, graphFor("a.ts"), CACHE_VERSION)).toBe(true);
    expect((await querySqliteSeeds(root, CACHE_VERSION, "answer"))?.seeds).toContain("answer@a.ts");

    rmSync(added);
    expect(await querySqliteSeeds(root, CACHE_VERSION, "answer")).toBeUndefined();
  });

  it("bootstraps SQLite on first graph use, then uses bounded SQLite reads", async () => {
    if (!await sqliteOnly() || !hasAstGrep()) return;
    const root = rootAt();
    writeFileSync(join(root, "a.ts"), "export function answer() {}\n");
    setResidentPreference(root, false);
    resetSessions();
    try {
      const first = await focus(root, "answer", 512);
      expect(first.text).toContain("answer");
      const cache = await ensureWorktreeCache(root);
      expect(existsSync(cache.databasePath)).toBe(true);
      expect((await loadSqliteSnapshot(root, CACHE_VERSION))?.facts.has("a.ts")).toBe(true);

      const second = await focus(root, "answer", 512, { fresh: true });
      expect(second.details.queryMode).toBe("sqlite-index");
      expect(second.text).toContain("answer");
    } finally {
      setResidentPreference(root, true);
      evictState(root);
    }
  });

  it("falls back to a fresh graph for dirty added and deleted files", async () => {
    if (!await sqliteOnly() || !hasAstGrep()) return;
    const root = rootAt();
    writeFileSync(join(root, "a.ts"), "export function answer() {}\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["add", "a.ts"], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fovea Test", "-c", "user.email=fovea@example.invalid", "commit", "-qm", "initial"], { cwd: root });
    setResidentPreference(root, false);
    resetSessions();
    try {
      await focus(root, "answer", 512); // cold bootstrap and SQLite publish
      writeFileSync(join(root, "added.ts"), "export function added() {}\n");
      const added = await focus(root, "added", 512, { fresh: true });
      expect(added.text).toContain("added");
      expect(added.details.queryMode).toBe("resident-fallback");
      expect(added.details.freshness).toContain("dirty worktree");

      rmSync(join(root, "added.ts"));
      // Keep the worktree dirty after deleting the untracked addition: SQLite
      // must refresh, not reuse the snapshot that still contains added.ts.
      writeFileSync(join(root, "a.ts"), "export function answer() { return 1; }\n");
      const deleted = await focus(root, "added", 512, { fresh: true });
      expect(deleted.text).toContain("no graph match");
      expect(deleted.details.queryMode).toBe("resident-fallback");
    } finally {
      setResidentPreference(root, true);
      evictState(root);
    }
  });

  it("serves focus, dwell, and impact from SQLite within hard token budgets", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    expect(await saveSqliteSnapshot(storeFor(root), lazyGraphFor(), CACHE_VERSION)).toBe(true);
    resetSessions();
    const focused = await focus(root, "subject", 256);
    expect(focused.tokens).toBeLessThanOrEqual(256);
    expect(focused.details.queryMode).toBe("sqlite-index");
    expect(focused.text).toContain("← caller");
    expect(focused.text).toContain("← route");
    const widened = await dwell(root, 2, 256);
    expect(widened.tokens).toBeLessThanOrEqual(256);
    expect(widened.details.queryMode).toBe("sqlite-index");
    const cascade = await impact(root, { files: ["caller.ts"], includeUncommitted: false, budget: 256 });
    expect(cascade.tokens).toBeLessThanOrEqual(256);
    expect(cascade.details.queryMode).toBe("sqlite-index");
    expect(cascade.text).toContain("subject.ts");
  });

  it("prefers a fresher resident graph over an older matching SQLite snapshot", async () => {
    if (!await sqliteOnly() || !hasAstGrep()) return;
    const root = rootAt();
    setResidentPreference(root, true); // mirrors intentional turn-sync retention
    // Facts/manifest match the worktree, while the persisted graph is
    // deliberately old. A resident build must render the fresh graph instead.
    const store = storeFor(root, "a.ts", "fresh");
    expect(await saveSqliteSnapshot(store, graphFor("a.ts", "old"), CACHE_VERSION)).toBe(true);
    await ensureState(root);
    try {
      resetSessions();
      const focused = await focus(root, "fresh", 512);
      expect(focused.details.queryMode).not.toBe("sqlite-index");
      expect(focused.text).toContain("fresh");
      const widened = await dwell(root, 2, 512);
      expect(widened.details.queryMode).not.toBe("sqlite-index");
      const cascade = await impact(root, { files: ["a.ts"], includeUncommitted: false, budget: 512 });
      expect(cascade.details.queryMode).not.toBe("sqlite-index");
    } finally {
      evictState(root);
    }
  });

  it("updates changed file rows in place and persists skipped-file lifecycle states", async () => {
    if (!await sqliteOnly()) return;
    const root = rootAt();
    const store = storeFor(root);
    const graph = graphFor("a.ts");
    expect(await saveSqliteSnapshot(store, graph, CACHE_VERSION)).toBe(true);
    const cache = await ensureWorktreeCache(root);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(cache.databasePath, { readOnly: true });
    let snapshotId: number;
    let fileId: number;
    try {
      snapshotId = Number(db.prepare("SELECT id FROM snapshots").get()?.id);
      fileId = Number(db.prepare("SELECT id FROM files WHERE path = 'a.ts'").get()?.id);
    } finally { db.close(); }

    store.meta.set("b.ts", { size: 5, mtime: 2 });
    store.oversized.add("b.ts");
    store.meta.set("c.ts", { size: 0, mtime: 3 });
    store.unreadable.add("c.ts");
    store.facts.set("a.ts", { ...store.facts.get("a.ts")!, sha1: "b".repeat(40) });
    expect(await saveSqliteSnapshot(store, graphFor("a.ts"), CACHE_VERSION)).toBe(true);

    const after = await loadSqliteSnapshot(root, CACHE_VERSION);
    expect(after?.generation).toBe(1);
    expect(after?.facts.get("a.ts")?.sha1).toBe("b".repeat(40));
    expect(after?.oversized.has("b.ts")).toBe(true);
    expect(after?.unreadable.has("c.ts")).toBe(true);
    const verify = new DatabaseSync(cache.databasePath, { readOnly: true });
    try {
      expect(verify.prepare("SELECT id FROM snapshots").get()).toMatchObject({ id: snapshotId! });
      expect(verify.prepare("SELECT id FROM files WHERE path = 'a.ts'").get()).toMatchObject({ id: fileId! });
      expect(verify.prepare("SELECT state FROM file_facts WHERE file_id = (SELECT id FROM files WHERE path = 'b.ts')").get()).toEqual({ state: "oversized" });
      expect(verify.prepare("SELECT state FROM file_facts WHERE file_id = (SELECT id FROM files WHERE path = 'c.ts')").get()).toEqual({ state: "unreadable" });
    } finally { verify.close(); }
  });
});
