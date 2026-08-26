// Feature-detected, private SQLite persistence for graph facts. This module is
// deliberately isolated from the graph builder: Node versions without
// node:sqlite (and any database failure) return undefined/false so JSONL can
// remain the durable fallback.

import { createHash, randomUUID } from "node:crypto";
import { rename, rm, stat, statfs } from "node:fs/promises";
import type { AnchorDraft } from "./anchors.js";
import type { CallSite, Graph, ImportSite, LiteralSite, NodeRec, SymbolRec } from "./types.js";
import { gitProbe, type GitProbe } from "./git.js";
import { ensureWorktreeCache } from "./worktree-cache.js";
import { redactSensitiveCacheValue, redactSensitiveValue } from "./privacy.js";

// v5 makes redaction a persistence invariant; older databases may contain
// source credentials and are discarded rather than retained as recoveries.
const SCHEMA_VERSION = 5;
const META_SCHEMA = "schema_version";
const META_SEMANTIC = "semantic_version";
const META_ROOT = "root";
const META_CURRENT = "current_snapshot";
const SQLITE_TIMEOUT_MS = 250;

interface SqliteFileFacts {
  sha1: string;
  symbols: SymbolRec[];
  imports: ImportSite[];
  calls: CallSite[];
  literals: LiteralSite[];
  anchors: AnchorDraft[];
  sigs?: Record<string, [number, number]>;
}

export interface SqliteFactStore {
  root: string;
  facts: Map<string, SqliteFileFacts>;
  meta: Map<string, { size: number; mtime: number }>;
  tainted: Set<string>;
  failedSha: Map<string, string>;
  unreadable: Set<string>;
  oversized: Set<string>;
  generated: Set<string>;
  rulesSha: string;
  enrolled: Set<string>;
}

export interface SqliteSnapshot {
  root: string;
  rulesSha: string;
  enrolled: string[];
  facts: Map<string, SqliteFileFacts>;
  meta: Map<string, { size: number; mtime: number }>;
  tainted: Set<string>;
  failedSha: Map<string, string>;
  unreadable: Set<string>;
  oversized: Set<string>;
  generated: Set<string>;
  generation: number;
}

interface Database {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): {
    all(...values: unknown[]): Array<Record<string, unknown>>;
    get(...values: unknown[]): Record<string, unknown> | undefined;
    run(...values: unknown[]): unknown;
  };
}

type DatabaseConstructor = new (path: string, options?: { enableForeignKeyConstraints?: boolean; timeout?: number }) => Database;

const sqliteSpecifier = "node:sqlite";
const dynamicSqlite = async (): Promise<DatabaseConstructor | undefined> => {
  // Explicit opt-out supports hosts that disable native SQLite; JSONL remains
  // a private fallback in that case. FOVEA_NO_CACHE still disables all layers.
  if (process.env.FOVEA_SQLITE_DISABLE === "1") return undefined;
  try {
    const mod = await import(sqliteSpecifier) as { DatabaseSync?: DatabaseConstructor };
    return mod.DatabaseSync;
  } catch {
    return undefined;
  }
};

const text = (value: unknown): string => typeof value === "string" ? value : "";
const cachedText = (value: unknown): string => redactSensitiveValue(text(value));
const number = (value: unknown): number => typeof value === "number" ? value : Number(value ?? 0);
const bool = (value: unknown): boolean => Number(value ?? 0) !== 0;
const parseJson = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(text(value)) as T; } catch { return fallback; }
};

const schemaSql = `
CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY,
  generation INTEGER NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  rules_sha TEXT NOT NULL,
  enrolled_json TEXT NOT NULL,
  head TEXT NOT NULL,
  manifest_sha TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime REAL NOT NULL,
  UNIQUE(snapshot_id, path)
) STRICT;
CREATE INDEX IF NOT EXISTS files_snapshot_path ON files(snapshot_id, path);
CREATE TABLE IF NOT EXISTS file_facts (
  file_id INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  sha1 TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('clean', 'failed', 'unreadable', 'oversized', 'generated')),
  sigs_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  line_approximate INTEGER NOT NULL,
  sig TEXT NOT NULL,
  lang TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS symbols_file_name ON symbols(file_id, name);
CREATE TABLE IF NOT EXISTS imports (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  spec TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS imports_file ON imports(file_id);
CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  callee TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS calls_file_callee ON calls(file_id, callee);
CREATE TABLE IF NOT EXISTS literals (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  line INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS anchors (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  anchor_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  node_key TEXT NOT NULL,
  line INTEGER NOT NULL,
  implicit INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS anchors_file_key ON anchors(file_id, anchor_key);
-- Graph nodes and typed edges are snapshot scoped rather than tied directly
-- to extraction rows: file and route nodes have no one-to-one symbol row.
CREATE TABLE IF NOT EXISTS graph_nodes (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  node_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER NOT NULL,
  line_approximate INTEGER NOT NULL,
  sig TEXT NOT NULL,
  lang TEXT NOT NULL,
  UNIQUE(snapshot_id, node_key)
) STRICT;
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  snapshot_id INTEGER NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
  from_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  to_node_id INTEGER NOT NULL REFERENCES graph_nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  weight REAL NOT NULL,
  UNIQUE(snapshot_id, from_node_id, to_node_id, kind)
) STRICT;
CREATE INDEX IF NOT EXISTS edges_snapshot_from ON edges(snapshot_id, from_node_id, kind);
CREATE INDEX IF NOT EXISTS edges_snapshot_to ON edges(snapshot_id, to_node_id, kind);
-- These cover the lazy query path. Focus starts from a narrow name/anchor/file
-- lookup and then reads only incident edges for a capped frontier.
CREATE INDEX IF NOT EXISTS graph_nodes_seed ON graph_nodes(snapshot_id, name COLLATE NOCASE, kind, file);
CREATE INDEX IF NOT EXISTS graph_nodes_file ON graph_nodes(snapshot_id, file, kind);
CREATE INDEX IF NOT EXISTS literals_text ON literals(text COLLATE NOCASE, file_id);
`;

const meta = (db: Database, key: string): string | undefined => {
  const row = db.prepare("SELECT value FROM metadata WHERE key = ?").get(key);
  return row ? text(row.value) : undefined;
};
const setMeta = (db: Database, key: string, value: string): void => {
  db.prepare("INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

// WAL is unsafe on known network/FUSE filesystems. On platforms where the
// filesystem type cannot be checked we leave SQLite's rollback journal alone.
const safeForWal = async (path: string): Promise<boolean> => {
  if (process.env.FOVEA_SQLITE_WAL === "0" || process.platform !== "linux") return false;
  try {
    const fs = await statfs(path);
    const type = Number(fs.type);
    // NFS, SMB/CIFS, FUSE, and 9P. WAL correctness depends on reliable shared
    // memory and locks, which these mounts cannot universally promise.
    return !new Set([0x6969, 0x517b, 0xff534d42, 0x65735546, 0x01021997]).has(type);
  } catch {
    return false;
  }
};

const configure = async (db: Database, path: string): Promise<void> => {
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250; PRAGMA cache_size = -8192; PRAGMA temp_store = MEMORY; PRAGMA synchronous = NORMAL;");
  if (await safeForWal(path)) {
    const row = db.prepare("PRAGMA journal_mode = WAL").get();
    // A mode other than WAL is not an error: SQLite selected the safest mode.
    void row;
  }
};

const validDatabase = (db: Database, root: string, semanticVersion: number): "empty" | "valid" | "obsolete" | "corrupt" => {
  const hasMetadata = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'metadata'").get();
  if (!hasMetadata) return "empty";
  const check = db.prepare("PRAGMA quick_check").get();
  if (text(check?.quick_check ?? check?.integrity_check) !== "ok") return "corrupt";
  const schema = meta(db, META_SCHEMA);
  if (schema === undefined) return "empty";
  const physical = number(db.prepare("PRAGMA user_version").get()?.user_version);
  return physical === SCHEMA_VERSION
    && schema === String(SCHEMA_VERSION)
    && meta(db, META_SEMANTIC) === String(semanticVersion)
    && meta(db, META_ROOT) === root
    ? "valid"
    : "obsolete";
};

const initialize = (db: Database, root: string, semanticVersion: number): void => {
  db.exec(schemaSql);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  setMeta(db, META_SCHEMA, String(SCHEMA_VERSION));
  setMeta(db, META_SEMANTIC, String(semanticVersion));
  setMeta(db, META_ROOT, root);
};

const rotateBroken = async (path: string): Promise<void> => {
  const rotated = `${path}.recovered-${Date.now()}-${randomUUID()}`;
  await rename(path, rotated).catch(async () => { await rm(path, { force: true }); });
};

/** Version-mismatched facts may predate cache redaction, so never preserve them. */
const discardObsolete = async (path: string): Promise<void> => {
  await Promise.all([path, `${path}-wal`, `${path}-shm`, `${path}-journal`].map((candidate) => rm(candidate, { force: true })));
};

interface Opened { db: Database; path: string; }

const corruption = (error: unknown): boolean => /not a database|malformed|disk image|encrypted/i.test(String(error));

/** Open/create after validation. Corrupt or obsolete databases are rotated. */
const open = async (root: string, semanticVersion: number): Promise<Opened | undefined> => {
  const Ctor = await dynamicSqlite();
  if (!Ctor) return undefined;
  let cache: Awaited<ReturnType<typeof ensureWorktreeCache>>;
  try { cache = await ensureWorktreeCache(root); } catch { return undefined; }
  for (let attempt = 0; attempt < 2; attempt++) {
    let db: Database | undefined;
    try {
      db = new Ctor(cache.databasePath, { enableForeignKeyConstraints: true, timeout: SQLITE_TIMEOUT_MS });
      await configure(db, cache.databasePath);
      const status = validDatabase(db, root, semanticVersion);
      if (status === "valid") return { db, path: cache.databasePath };
      if (status === "empty") {
        initialize(db, root, semanticVersion);
        return { db, path: cache.databasePath };
      }
      db.close();
      db = undefined;
      if (status === "obsolete") await discardObsolete(cache.databasePath);
      else await rotateBroken(cache.databasePath);
    } catch (error) {
      try { db?.close(); } catch { /* fail soft */ }
      // Never rotate on a transient lock, permissions, or I/O error: JSONL
      // handles those cases. Only a recognizably damaged file is replaced.
      if (attempt === 0 && corruption(error)) {
        await rotateBroken(cache.databasePath).catch(() => undefined);
        continue;
      }
      return undefined;
    }
  }
  return undefined;
};

const close = (db: Database): void => { try { db.close(); } catch { /* fail soft */ } };

export interface SqliteSnapshotResult {
  /** The database opened and its read transaction completed successfully. */
  available: boolean;
  snapshot?: SqliteSnapshot;
}

/**
 * Read a snapshot while distinguishing an empty working SQLite store from an
 * unavailable or failed SQLite operation. JSONL fallback is permitted only in
 * the latter case.
 */
export const loadSqliteSnapshotResult = async (root: string, semanticVersion: number): Promise<SqliteSnapshotResult> => {
  const opened = await open(root, semanticVersion);
  if (!opened) return { available: false };
  const { db } = opened;
  try {
    const current = meta(db, META_CURRENT);
    if (!current) return { available: true };
    const snapshot = db.prepare("SELECT id, generation, rules_sha, enrolled_json FROM snapshots WHERE id = ?").get(Number(current));
    if (!snapshot) return { available: true };
    const snapshotId = number(snapshot.id);
    const facts = new Map<string, SqliteFileFacts>();
    const fileIds = new Map<number, string>();
    const fileRows = db.prepare(`SELECT f.id, f.path, f.size, f.mtime, ff.sha1, ff.state, ff.sigs_json
      FROM files f JOIN file_facts ff ON ff.file_id = f.id WHERE f.snapshot_id = ? ORDER BY f.path`).all(snapshotId);
    const out: SqliteSnapshot = {
      root,
      rulesSha: text(snapshot.rules_sha),
      enrolled: parseJson<string[]>(snapshot.enrolled_json, []).filter((v): v is string => typeof v === "string"),
      facts,
      meta: new Map(),
      tainted: new Set(),
      failedSha: new Map(),
      unreadable: new Set(),
      oversized: new Set(),
      generated: new Set(),
      generation: number(snapshot.generation),
    };
    for (const row of fileRows) {
      const file = text(row.path);
      const id = number(row.id);
      fileIds.set(id, file);
      out.meta.set(file, { size: number(row.size), mtime: number(row.mtime) });
      const state = text(row.state);
      if (state === "failed") { out.tainted.add(file); out.failedSha.set(file, text(row.sha1)); continue; }
      if (state === "unreadable") { out.unreadable.add(file); continue; }
      if (state === "oversized") { out.oversized.add(file); continue; }
      if (state === "generated") out.generated.add(file);
      facts.set(file, { sha1: text(row.sha1), symbols: [], imports: [], calls: [], literals: [], anchors: [], sigs: redactSensitiveCacheValue(parseJson(row.sigs_json, undefined)) });
    }
    const add = <T>(sql: string, into: (fact: SqliteFileFacts) => T[], make: (row: Record<string, unknown>, file: string) => T): void => {
      for (const row of db.prepare(sql).all(snapshotId)) {
        const fact = facts.get(fileIds.get(number(row.file_id)) ?? "");
        if (fact) into(fact).push(make(row, fileIds.get(number(row.file_id))!));
      }
    };
    add<SymbolRec>("SELECT s.file_id, s.name, s.kind, s.line, s.line_approximate, s.sig, s.lang FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.snapshot_id = ?", (f) => f.symbols, (r, file) => ({ name: cachedText(r.name), kind: text(r.kind) as SymbolRec["kind"], file, line: number(r.line), lineApproximate: bool(r.line_approximate) || undefined, sig: cachedText(r.sig), lang: text(r.lang) }));
    add<ImportSite>("SELECT i.file_id, i.spec, i.line FROM imports i JOIN files f ON f.id = i.file_id WHERE f.snapshot_id = ?", (f) => f.imports, (r, file) => ({ file, spec: cachedText(r.spec), line: number(r.line) }));
    add<CallSite>("SELECT c.file_id, c.callee, c.line FROM calls c JOIN files f ON f.id = c.file_id WHERE f.snapshot_id = ?", (f) => f.calls, (r, file) => ({ file, callee: cachedText(r.callee), line: number(r.line) }));
    add<LiteralSite>("SELECT l.file_id, l.text, l.line FROM literals l JOIN files f ON f.id = l.file_id WHERE f.snapshot_id = ?", (f) => f.literals, (r, file) => ({ file, text: cachedText(r.text), line: number(r.line) }));
    add<AnchorDraft>("SELECT a.file_id, a.anchor_key, a.kind, a.label, a.node_key, a.line, a.implicit FROM anchors a JOIN files f ON f.id = a.file_id WHERE f.snapshot_id = ?", (f) => f.anchors, (r, file) => ({ id: cachedText(r.anchor_key), kind: text(r.kind), label: cachedText(r.label), nodeId: cachedText(r.node_key), file, line: number(r.line), implicit: bool(r.implicit) || undefined }));
    return { available: true, snapshot: out };
  } catch {
    return { available: false };
  } finally {
    close(db);
  }
};

export const loadSqliteSnapshot = async (root: string, semanticVersion: number): Promise<SqliteSnapshot | undefined> =>
  (await loadSqliteSnapshotResult(root, semanticVersion)).snapshot;

const manifestHash = (meta: ReadonlyMap<string, { size: number; mtime: number }>): string =>
  createHash("sha256")
    .update([...meta.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, info]) => `${path}\0${info.size}\0${info.mtime}\n`)
      .join(""))
    .digest("hex");

// Git porcelain includes every untracked editor artifact, while the graph
// snapshot only represents files accepted by the supported-file/rule filter.
// Keep unknown directories conservative: porcelain collapses their contents,
// so they may contain supported files that have not been enumerated yet.
const supportedDirtyWorktree = async (root: string, probe: GitProbe | undefined): Promise<boolean> => {
  if (!probe || probe.relist) return !!probe?.relist;
  if (!probe.changes.length) return false;
  if (probe.changes.some((change) => change.path.endsWith("/"))) return true;
  // Reuse the graph builder's complete code/config/route convention filter;
  // this includes repository-defined file-route extensions rather than baking
  // a separate extension list into SQLite freshness checks.
  const [{ filterSupported }, { loadRepoRules }] = await Promise.all([
    import("./build.js"), import("./anchors.js"),
  ]);
  const { fileRoutes } = await loadRepoRules(root);
  const routeRes = fileRoutes.map((route) => new RegExp(route.re));
  if (filterSupported(probe.changes.map((change) => change.path), routeRes).length) return true;
  // Gitlinks and embedded repositories are reported as a directory path
  // without a trailing slash. Their inner changes cannot be classified here.
  const directories = await Promise.all(probe.changes.map(async (change) =>
    (await stat(`${root}/${change.path}`).catch(() => undefined))?.isDirectory() ?? false,
  ));
  return directories.some(Boolean);
};

const currentFreshness = async (root: string, enrolled: string[]): Promise<{ head: string; manifest: string } | undefined> => {
  const probe = await gitProbe(root);
  // Only dirty paths the graph could index (or an unclassifiable collapsed
  // directory) invalidate a bounded snapshot; unrelated editor artifacts do
  // not alter the manifest and remain eligible for a lazy read.
  if (await supportedDirtyWorktree(root, probe)) return undefined;
  // Keep the walker authoritative for both plain roots and configured source
  // types. Dynamic imports avoid a build <-> SQLite initialization cycle.
  const [{ listFiles }, { loadRepoRules }] = await Promise.all([
    import("./build.js"), import("./anchors.js"),
  ]);
  const { fileRoutes } = await loadRepoRules(root);
  const files = await listFiles(root, fileRoutes.map((route) => new RegExp(route.re)), new Set(enrolled));
  const entries = await Promise.all(files.map(async (file) => {
    const info = await stat(`${root}/${file}`).catch(() => undefined);
    return [file, info?.isFile() ? { size: info.size, mtime: info.mtimeMs } : { size: 0, mtime: 0 }] as const;
  }));
  return { head: probe?.head ?? "", manifest: manifestHash(new Map(entries)) };
};

const graphNode = (db: Database, snapshotId: number, node: NodeRec): number => {
  const safe = redactSensitiveCacheValue(node);
  db.prepare(`INSERT INTO graph_nodes(snapshot_id, node_key, name, kind, file, line, line_approximate, sig, lang)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(snapshotId, safe.id, safe.name, safe.kind, safe.file, safe.line, safe.lineApproximate ? 1 : 0, safe.sig, safe.lang);
  return number(db.prepare("SELECT id FROM graph_nodes WHERE snapshot_id = ? AND node_key = ?").get(snapshotId, safe.id)?.id);
};

/**
 * Publish the live store atomically. Facts are normalized per file and only
 * rows whose content/state changed are replaced; stat-only touches retain
 * their existing extraction rows. Graph joins are global, so their derived
 * rows are regenerated inside the same transaction.
 */
export const saveSqliteSnapshot = async (store: SqliteFactStore, graph: Graph, semanticVersion: number): Promise<boolean> => {
  const opened = await open(store.root, semanticVersion);
  if (!opened) return false;
  const { db } = opened;
  try {
    const freshness = await currentFreshness(store.root, [...store.enrolled]);
    // Persistence is allowed for a dirty worktree, but lazy reads will reject
    // it until clean. Its manifest remains a precise witness for plain roots.
    const snapshotHead = freshness?.head ?? "";
    const snapshotManifest = manifestHash(store.meta);
    db.exec("BEGIN IMMEDIATE");
    let snapshotId = number(meta(db, META_CURRENT));
    let oldRules = "";
    if (snapshotId) oldRules = text(db.prepare("SELECT rules_sha FROM snapshots WHERE id = ?").get(snapshotId)?.rules_sha);
    if (!snapshotId || !oldRules) {
      const generation = number(db.prepare("SELECT COALESCE(MAX(generation), 0) + 1 AS generation FROM snapshots").get()?.generation);
      db.prepare("INSERT INTO snapshots(generation, created_at, rules_sha, enrolled_json, head, manifest_sha) VALUES (?, ?, ?, ?, ?, ?)")
        .run(generation, Date.now(), store.rulesSha, JSON.stringify([...store.enrolled].sort()), snapshotHead, snapshotManifest);
      snapshotId = number(db.prepare("SELECT id FROM snapshots WHERE generation = ?").get(generation)?.id);
      setMeta(db, META_CURRENT, String(snapshotId));
    } else {
      db.prepare("UPDATE snapshots SET created_at = ?, rules_sha = ?, enrolled_json = ?, head = ?, manifest_sha = ? WHERE id = ?")
        .run(Date.now(), store.rulesSha, JSON.stringify([...store.enrolled].sort()), snapshotHead, snapshotManifest, snapshotId);
    }
    const rulesChanged = oldRules !== "" && oldRules !== store.rulesSha;
    const existing = new Map<string, Record<string, unknown>>();
    for (const row of db.prepare(`SELECT f.id, f.path, f.size, f.mtime, ff.sha1, ff.state, ff.sigs_json
      FROM files f JOIN file_facts ff ON ff.file_id = f.id WHERE f.snapshot_id = ?`).all(snapshotId)) existing.set(text(row.path), row);
    const paths = new Set([...store.meta.keys(), ...store.facts.keys(), ...store.failedSha.keys(), ...store.unreadable, ...store.oversized, ...store.generated]);
    const removeFile = db.prepare("DELETE FROM files WHERE id = ?");
    for (const [path, row] of existing) if (!paths.has(path)) removeFile.run(number(row.id));

    const insertFile = db.prepare("INSERT INTO files(snapshot_id, path, size, mtime) VALUES (?, ?, ?, ?)");
    const updateFile = db.prepare("UPDATE files SET size = ?, mtime = ? WHERE id = ?");
    const insertFact = db.prepare("INSERT INTO file_facts(file_id, sha1, state, sigs_json) VALUES (?, ?, ?, ?)");
    const updateFact = db.prepare("UPDATE file_facts SET sha1 = ?, state = ?, sigs_json = ? WHERE file_id = ?");
    const deleteSymbols = db.prepare("DELETE FROM symbols WHERE file_id = ?");
    const deleteImports = db.prepare("DELETE FROM imports WHERE file_id = ?");
    const deleteCalls = db.prepare("DELETE FROM calls WHERE file_id = ?");
    const deleteLiterals = db.prepare("DELETE FROM literals WHERE file_id = ?");
    const deleteAnchors = db.prepare("DELETE FROM anchors WHERE file_id = ?");
    const symbol = db.prepare("INSERT INTO symbols(file_id, name, kind, line, line_approximate, sig, lang) VALUES (?, ?, ?, ?, ?, ?, ?)");
    const imported = db.prepare("INSERT INTO imports(file_id, spec, line) VALUES (?, ?, ?)");
    const called = db.prepare("INSERT INTO calls(file_id, callee, line) VALUES (?, ?, ?)");
    const literal = db.prepare("INSERT INTO literals(file_id, text, line) VALUES (?, ?, ?)");
    const anchor = db.prepare("INSERT INTO anchors(file_id, anchor_key, kind, label, node_key, line, implicit) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const path of [...paths].sort()) {
      const metaRow = store.meta.get(path);
      if (!metaRow) continue;
      const facts = store.facts.get(path);
      const state = store.tainted.has(path) ? "failed"
        : store.unreadable.has(path) ? "unreadable"
          : store.oversized.has(path) ? "oversized"
            : store.generated.has(path) ? "generated" : "clean";
      const sha1 = store.failedSha.get(path) ?? facts?.sha1 ?? "";
      const sigs = facts?.sigs ? JSON.stringify(redactSensitiveCacheValue(facts.sigs)) : null;
      let row = existing.get(path);
      if (!row) {
        insertFile.run(snapshotId, path, metaRow.size, metaRow.mtime);
        row = db.prepare("SELECT id FROM files WHERE snapshot_id = ? AND path = ?").get(snapshotId, path);
      } else if (number(row.size) !== metaRow.size || number(row.mtime) !== metaRow.mtime) {
        updateFile.run(metaRow.size, metaRow.mtime, number(row.id));
      }
      const fileId = number(row?.id);
      const factChanged = !existing.has(path) || rulesChanged || text(row?.sha1) !== sha1 || text(row?.state) !== state || text(row?.sigs_json) !== (sigs ?? "");
      if (!factChanged) continue;
      if (existing.has(path)) updateFact.run(sha1, state, sigs, fileId);
      else insertFact.run(fileId, sha1, state, sigs);
      deleteSymbols.run(fileId); deleteImports.run(fileId); deleteCalls.run(fileId); deleteLiterals.run(fileId); deleteAnchors.run(fileId);
      if (!facts || state === "failed" || state === "unreadable" || state === "oversized") continue;
      for (const item of facts.symbols) symbol.run(fileId, redactSensitiveValue(item.name), item.kind, item.line, item.lineApproximate ? 1 : 0, redactSensitiveValue(item.sig), item.lang);
      for (const item of facts.imports) imported.run(fileId, redactSensitiveValue(item.spec), item.line);
      for (const item of facts.calls) called.run(fileId, redactSensitiveValue(item.callee), item.line);
      for (const item of facts.literals) literal.run(fileId, redactSensitiveValue(item.text), item.line);
      for (const item of facts.anchors) anchor.run(fileId, redactSensitiveValue(item.id), item.kind, redactSensitiveValue(item.label), redactSensitiveValue(item.nodeId), item.line, item.implicit ? 1 : 0);
    }
    db.prepare("DELETE FROM graph_nodes WHERE snapshot_id = ?").run(snapshotId);
    const nodeIds = new Map<string, number>();
    for (const node of graph.nodes) nodeIds.set(node.id, graphNode(db, snapshotId, node));
    const edge = db.prepare("INSERT OR IGNORE INTO edges(snapshot_id, from_node_id, to_node_id, kind, weight) VALUES (?, ?, ?, ?, ?)");
    for (const item of graph.edges) {
      const a = graph.nodes[item.a]?.id;
      const b = graph.nodes[item.b]?.id;
      const from = a ? nodeIds.get(a) : undefined;
      const to = b ? nodeIds.get(b) : undefined;
      if (from && to) edge.run(snapshotId, from, to, item.kind, item.w);
    }
    db.exec("COMMIT");
    return true;
  } catch {
    try { db.exec("ROLLBACK"); } catch { /* no active transaction */ }
    return false;
  } finally {
    close(db);
  }
};

/** Used by tests and future lazy query callers without exposing a tool name. */
export const sqliteAvailability = async (): Promise<boolean> => !!await dynamicSqlite();

/**
 * Dirty supported files and unclassifiable collapsed directories are never
 * read through a durable bounded snapshot. Unsupported editor artifacts do
 * not participate in the graph manifest, so they leave lazy reads available.
 */
export const sqliteLazyReadBlockedByDirtyWorktree = async (root: string): Promise<boolean> =>
  supportedDirtyWorktree(root, await gitProbe(root));

// Lazy graph reads deliberately bypass loadSqliteSnapshot(): that warm-start
// API reconstructs every fact row, while focus needs only its seeds and a
// capped relationship frontier.
export interface SqliteQueryScope { path?: string; language?: string; kind?: NodeRec["kind"]; }
interface SqliteSeedSuggestion {
  id: string; name: string; file: string; line: number; lineApproximate?: boolean; sig: string; score: number;
}
export interface SqliteSeedResult {
  seeds: string[]; note: string; suggestions: SqliteSeedSuggestion[]; generation: number; files: number;
  extraction: { failed: string[]; unreadable: string[]; oversized: string[]; generated: string[] };
}
export interface SqliteNeighborhood {
  graph: Graph; seeds: number[]; field: Float64Array; generation: number; files: number;
  extraction: SqliteSeedResult["extraction"]; uncertain: true;
}

const nodeFromRow = (row: Record<string, unknown>): NodeRec => ({
  id: cachedText(row.node_key), name: cachedText(row.name), kind: text(row.kind) as NodeRec["kind"],
  file: cachedText(row.file), line: number(row.line), lineApproximate: bool(row.line_approximate) || undefined,
  sig: cachedText(row.sig), lang: text(row.lang),
});
const scopeAllows = (node: NodeRec, scope: SqliteQueryScope): boolean => {
  const path = scope.path?.replace(/^@/, "").replace(/^\.\//, "").replace(/\/$/, "");
  return (!path || node.file === path || node.file.startsWith(`${path}/`))
    && (!scope.language || node.lang.toLowerCase() === scope.language.toLowerCase())
    && (!scope.kind || node.kind === scope.kind);
};
const querySnapshot = (db: Database): { id: number; generation: number; head: string; manifest: string; enrolled: string[] } | undefined => {
  const current = number(meta(db, META_CURRENT));
  if (!current) return undefined;
  const row = db.prepare("SELECT id, generation, head, manifest_sha, enrolled_json FROM snapshots WHERE id = ?").get(current);
  return row ? {
    id: number(row.id), generation: number(row.generation), head: text(row.head), manifest: text(row.manifest_sha),
    enrolled: parseJson<string[]>(row.enrolled_json, []).filter((value): value is string => typeof value === "string"),
  } : undefined;
};

const freshQuerySnapshot = async (db: Database, root: string): Promise<ReturnType<typeof querySnapshot>> => {
  const snapshot = querySnapshot(db);
  if (!snapshot || !snapshot.manifest) return undefined;
  const current = await currentFreshness(root, snapshot.enrolled);
  return current && current.head === snapshot.head && current.manifest === snapshot.manifest ? snapshot : undefined;
};
const placeholders = (n: number): string => Array.from({ length: n }, () => "?").join(",");
const chunks = <T>(items: readonly T[], n = 96): T[][] => {
  const out: T[][] = []; for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n)); return out;
};
const queryExtraction = (db: Database, snapshotId: number): SqliteSeedResult["extraction"] => {
  const out = { failed: [] as string[], unreadable: [] as string[], oversized: [] as string[], generated: [] as string[] };
  for (const row of db.prepare(`SELECT f.path, ff.state FROM files f JOIN file_facts ff ON ff.file_id = f.id
    WHERE f.snapshot_id = ? AND ff.state != 'clean' ORDER BY f.path`).all(snapshotId)) {
    const state = text(row.state) as keyof typeof out; if (state in out) out[state].push(text(row.path));
  }
  return out;
};
const identifierParts = (value: string): string[] => value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 1);
const dice = (a: string, b: string): number => {
  if (a === b) return 1; if (a.length < 2 || b.length < 2) return 0;
  const counts = new Map<string, number>();
  for (let i = 0; i < a.length - 1; i++) { const key = a.slice(i, i + 2); counts.set(key, (counts.get(key) ?? 0) + 1); }
  let common = 0;
  for (let i = 0; i < b.length - 1; i++) { const key = b.slice(i, i + 2); const n = counts.get(key) ?? 0; if (n) { common++; counts.set(key, n - 1); } }
  return (2 * common) / (a.length + b.length - 2);
};
const similarity = (query: string, name: string): number => {
  const a = identifierParts(query); const b = identifierParts(name.slice(name.lastIndexOf(".") + 1));
  return Math.max(a.length ? a.filter((x) => b.includes(x)).length / a.length : 0, dice(a.join(""), b.join("")));
};

/** Indexed seed lookup; it never materializes FileFacts or a global Graph. */
export const querySqliteSeeds = async (root: string, semanticVersion: number, query: string, scope: SqliteQueryScope = {}): Promise<SqliteSeedResult | undefined> => {
  const opened = await open(root, semanticVersion); if (!opened) return undefined;
  const { db } = opened;
  try {
    const snapshot = await freshQuerySnapshot(db, root); if (!snapshot) return undefined;
    const q = query.trim(); const lower = q.toLowerCase(); const rows = new Map<string, Record<string, unknown>>();
    const add = (found: Array<Record<string, unknown>>): void => { for (const row of found) rows.set(text(row.node_key), row); };
    const base = "id, node_key, name, kind, file, line, line_approximate, sig, lang";
    add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND name = ? COLLATE NOCASE ORDER BY file, line, node_key LIMIT 24`).all(snapshot.id, q));
    add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND node_key = ? ORDER BY node_key LIMIT 8`).all(snapshot.id, `file:${q}`));
    add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND node_key LIKE ? ORDER BY node_key LIMIT 16`).all(snapshot.id, `file:%/${q}`));
    // Exact literals cover env keys and cross-language bridge tokens as well
    // as routes; their carrier file is a safe bounded seed when no anchor is
    // present. Prefix route matching below additionally supports mount paths.
    const exactLiteralFiles = db.prepare(`SELECT DISTINCT f.path FROM literals l JOIN files f ON f.id = l.file_id WHERE f.snapshot_id = ? AND l.text = ? COLLATE NOCASE ORDER BY f.path LIMIT 24`).all(snapshot.id, q);
    for (const literal of exactLiteralFiles) add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND node_key = ?`).all(snapshot.id, `file:${text(literal.path)}`));
    if (q.startsWith("/")) {
      add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND kind = 'anchor' AND name LIKE ? COLLATE NOCASE ORDER BY name, file, line LIMIT 24`).all(snapshot.id, `%${q}%`));
      const literalFiles = db.prepare(`SELECT DISTINCT f.path FROM literals l JOIN files f ON f.id = l.file_id WHERE f.snapshot_id = ? AND l.text LIKE ? COLLATE NOCASE ORDER BY f.path LIMIT 24`).all(snapshot.id, `%${q}%`);
      for (const literal of literalFiles) add(db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND node_key = ?`).all(snapshot.id, `file:${text(literal.path)}`));
    }
    const candidates = [...rows.values()].map(nodeFromRow).filter((node) => scopeAllows(node, scope));
    const ranked = candidates.map((node) => ({ node, score: node.name.toLowerCase() === lower || node.id === `file:${q}` ? 1 : 0.9 }))
      .sort((a, b) => b.score - a.score || a.node.file.localeCompare(b.node.file) || a.node.line - b.node.line || a.node.id.localeCompare(b.node.id)).slice(0, 16);
    let suggestions: SqliteSeedSuggestion[] = [];
    if (!ranked.length) {
      const term = identifierParts(q).sort((a, b) => b.length - a.length)[0] ?? lower;
      const fuzzy = db.prepare(`SELECT ${base} FROM graph_nodes WHERE snapshot_id = ? AND kind NOT IN ('file', 'anchor') AND name LIKE ? COLLATE NOCASE ORDER BY name, file, line LIMIT 96`).all(snapshot.id, `%${term}%`);
      suggestions = fuzzy.map(nodeFromRow).filter((node) => scopeAllows(node, scope)).map((node) => ({ id: node.id, name: node.name, file: node.file, line: node.line, lineApproximate: node.lineApproximate, sig: node.sig, score: similarity(q, node.name) }))
        .filter((item) => item.score >= 0.34).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name) || a.file.localeCompare(b.file) || a.line - b.line).slice(0, 5);
    }
    const files = number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE snapshot_id = ?").get(snapshot.id)?.n);
    const note = ranked.length ? `${ranked.length} match${ranked.length === 1 ? "" : "es"}: ${ranked.slice(0, 4).map(({ node, score }) => `${node.name}${score < 1 ? " (approximate)" : ""}`).join(", ")}${ranked.length > 4 ? ", …" : ""}` : "no graph match";
    return { seeds: ranked.map(({ node }) => node.id), note, suggestions, generation: snapshot.generation, files, extraction: queryExtraction(db, snapshot.id) };
  } catch { return undefined; } finally { close(db); }
};

/**
 * Capped weighted BFS. Each level reads indexed incident edges for only the
 * current frontier; no query scans graph_nodes or edges wholesale.
 */
export const querySqliteNeighborhood = async (root: string, semanticVersion: number, seedKeys: readonly string[], options: { depth?: number; cap?: number } = {}): Promise<SqliteNeighborhood | undefined> => {
  if (!seedKeys.length) return undefined;
  const opened = await open(root, semanticVersion); if (!opened) return undefined;
  const { db } = opened;
  try {
    const snapshot = await freshQuerySnapshot(db, root); if (!snapshot) return undefined;
    const cap = Math.max(16, Math.min(1024, options.cap ?? 384)); const depth = Math.max(1, Math.min(8, options.depth ?? 2));
    const seedRows = db.prepare(`SELECT id, node_key FROM graph_nodes WHERE snapshot_id = ? AND node_key IN (${placeholders(seedKeys.length)}) ORDER BY node_key`).all(snapshot.id, ...seedKeys);
    if (!seedRows.length) return undefined;
    const visited = new Set<number>(seedRows.map((row) => number(row.id))); const score = new Map<number, number>(seedRows.map((row) => [number(row.id), 1]));
    // The selected nodes are capped above; retain a proportional edge ceiling
    // too, so a high-degree frontier cannot turn a focused RAM query into an
    // accidental full adjacency hydration.
    const edgeCap = cap * 12;
    let frontier = [...visited]; const edgeRows = new Map<string, { a: number; b: number; kind: string; w: number }>();
    for (let level = 0; level < depth && frontier.length && visited.size < cap; level++) {
      const found: Array<{ a: number; b: number; kind: string; w: number }> = [];
      for (const part of chunks(frontier)) {
        const ids = placeholders(part.length);
        for (const row of db.prepare(`SELECT from_node_id AS a, to_node_id AS b, kind, weight AS w FROM edges WHERE snapshot_id = ? AND (from_node_id IN (${ids}) OR to_node_id IN (${ids})) ORDER BY weight DESC, kind ASC, from_node_id ASC, to_node_id ASC LIMIT ?`).all(snapshot.id, ...part, ...part, cap * 3)) found.push({ a: number(row.a), b: number(row.b), kind: text(row.kind), w: number(row.w) });
      }
      found.sort((x, y) => y.w - x.w || x.kind.localeCompare(y.kind) || x.a - y.a || x.b - y.b);
      const next: number[] = [];
      for (const edge of found) {
        const edgeKey = `${edge.a}|${edge.b}|${edge.kind}`;
        if (!edgeRows.has(edgeKey) && edgeRows.size >= edgeCap) continue;
        edgeRows.set(edgeKey, edge);
        const from = visited.has(edge.a) ? edge.a : edge.b; const to = from === edge.a ? edge.b : edge.a;
        if (!visited.has(to) && visited.size < cap) { visited.add(to); next.push(to); score.set(to, (score.get(from) ?? 1) * (0.25 + 0.75 * Math.min(1, Math.max(0, edge.w)))); }
      }
      frontier = next;
    }
    const rows: Array<Record<string, unknown>> = [];
    for (const part of chunks([...visited])) rows.push(...db.prepare(`SELECT id, node_key, name, kind, file, line, line_approximate, sig, lang FROM graph_nodes WHERE id IN (${placeholders(part.length)})`).all(...part));
    const physical = new Map<number, NodeRec>(); for (const row of rows) physical.set(number(row.id), nodeFromRow(row));
    const ordered = [...physical.entries()].sort((a, b) => a[1].id.localeCompare(b[1].id)); const index = new Map<number, number>();
    const nodes = ordered.map(([id, node], i) => { index.set(id, i); return node; }); const edges: Graph["edges"] = [];
    for (const edge of edgeRows.values()) { const a = index.get(edge.a); const b = index.get(edge.b); if (a !== undefined && b !== undefined && a !== b) edges.push({ a, b, kind: edge.kind as Graph["edges"][number]["kind"], w: edge.w }); }
    edges.sort((a, b) => a.a - b.a || a.b - b.b || a.kind.localeCompare(b.kind) || b.w - a.w);
    const byName = new Map<string, number[]>(); const byFile = new Map<string, number[]>();
    for (const [i, node] of nodes.entries()) {
      if (node.kind !== "file" && node.kind !== "anchor") for (const key of new Set([node.name.toLowerCase(), node.name.slice(node.name.indexOf(".") + 1).toLowerCase()])) (byName.get(key) ?? byName.set(key, []).get(key)!).push(i);
      (byFile.get(node.file) ?? byFile.set(node.file, []).get(node.file)!).push(i);
    }
    for (const values of byFile.values()) values.sort((a, b) => nodes[a]!.line - nodes[b]!.line || nodes[a]!.id.localeCompare(nodes[b]!.id));
    const seedSet = new Set(seedRows.map((row) => number(row.id))); const seeds = ordered.flatMap(([id], i) => seedSet.has(id) ? [i] : []);
    const files = number(db.prepare("SELECT COUNT(*) AS n FROM files WHERE snapshot_id = ?").get(snapshot.id)?.n);
    return { graph: { nodes, edges, byName, byFile, anchors: [], files: [...byFile.keys()].sort() }, seeds, field: Float64Array.from(ordered.map(([id]) => score.get(id) ?? 0)), generation: snapshot.generation, files, extraction: queryExtraction(db, snapshot.id), uncertain: true };
  } catch { return undefined; } finally { close(db); }
};
