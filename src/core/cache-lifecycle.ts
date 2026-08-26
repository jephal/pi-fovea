// Conservative lifecycle management for private per-worktree caches. Cleanup is
// deliberately best-effort: uncertainty (a lease, SQLite sidecar, malformed
// identity, or an unreadable directory) means keep the entry and report why.

import { existsSync } from "node:fs";
import { lstat, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { envInt } from "./asyncutil.js";
import { cacheDisabled, cacheWorktreesDir, type WorktreeIdentity } from "./worktree-cache.js";

const DAY = 86_400_000;
const DEFAULT_TTL_DAYS = envInt("FOVEA_CACHE_TTL_DAYS", 30, 1, 3650);
const DEFAULT_MAX_BYTES = envInt("FOVEA_CACHE_MAX_BYTES", 512 * 1024 * 1024, 8 * 1024 * 1024, 64 * 1024 * 1024 * 1024);
const CLEANUP_GAP_MS = envInt("FOVEA_CACHE_CLEANUP_GAP_MS", 6 * 60 * 60 * 1000, 60_000, 7 * DAY);
const LEASE_FRESH_MS = 5 * 60_000;

interface CacheEntryDiagnostic {
  dir: string;
  identity?: WorktreeIdentity;
  bytes: number;
  accessedAt: number;
  stale: boolean;
  protected: string[];
}

export interface CacheDiagnostics {
  enabled: boolean;
  base?: string;
  ttlDays: number;
  maxBytes: number;
  totalBytes: number;
  entries: CacheEntryDiagnostic[];
  candidates: string[];
  deleted: string[];
  skipped: Array<{ dir: string; reason: string }>;
  throttled?: boolean;
}

export interface CacheCleanupOptions {
  cacheHome?: string;
  dryRun?: boolean;
  purge?: boolean;
  /** Delete one entry only; used by `fovea cache purge <root>`. */
  root?: string;
  now?: number;
  ttlDays?: number;
  maxBytes?: number;
}

const isPidAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};

const recursiveBytes = async (path: string): Promise<number> => {
  let info;
  try { info = await lstat(path); } catch { return 0; }
  if (info.isSymbolicLink()) return 0;
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  try {
    for (const child of await readdir(path)) total += await recursiveBytes(join(path, child));
  } catch { return total; }
  return total;
};

const readIdentity = async (dir: string): Promise<WorktreeIdentity | undefined> => {
  try {
    const parsed = JSON.parse(await readFile(join(dir, "identity.json"), "utf8")) as { v?: unknown; root?: unknown; gitDir?: unknown; commonGitDir?: unknown };
    if (parsed.v !== 1 || typeof parsed.root !== "string") return undefined;
    return {
      root: parsed.root,
      ...(typeof parsed.gitDir === "string" ? { gitDir: parsed.gitDir } : {}),
      ...(typeof parsed.commonGitDir === "string" ? { commonGitDir: parsed.commonGitDir } : {}),
    };
  } catch { return undefined; }
};

const missingWorktree = async (identity: WorktreeIdentity | undefined): Promise<boolean> => {
  if (!identity) return false; // malformed identity is protected, never guessed stale.
  const paths = [identity.root, identity.gitDir, identity.commonGitDir].filter((p): p is string => !!p);
  const checks = await Promise.all(paths.map((path) => lstat(path).then(() => true, () => false)));
  return checks.some((exists) => !exists);
};

const leaseProtection = async (dir: string, now: number): Promise<string | undefined> => {
  const lease = join(dir, "lease.json");
  try {
    const raw = JSON.parse(await readFile(lease, "utf8")) as { pid?: unknown; touchedAt?: unknown };
    const pid = Number(raw.pid); const touchedAt = Number(raw.touchedAt);
    if (Number.isFinite(touchedAt) && now - touchedAt < LEASE_FRESH_MS && (isPidAlive(pid) || pid === process.pid)) return "live lease";
  } catch { /* absent, stale, or malformed leases never authorize deletion by themselves */ }
  return undefined;
};

const inspect = async (base: string, now: number): Promise<CacheEntryDiagnostic[]> => {
  let names: string[] = [];
  try { names = await readdir(base); } catch { return []; }
  const entries: CacheEntryDiagnostic[] = [];
  for (const name of names.sort()) {
    const dir = join(base, name);
    let info;
    try { info = await lstat(dir); } catch { continue; }
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    const identity = await readIdentity(dir);
    const protectedReasons: string[] = [];
    if (!identity) protectedReasons.push("invalid identity");
    const lease = await leaseProtection(dir, now);
    if (lease) protectedReasons.push(lease);
    if (existsSync(join(dir, "fovea.sqlite-wal")) || existsSync(join(dir, "fovea.sqlite-shm"))) protectedReasons.push("SQLite WAL/SHM present");
    const accessedAt = Math.max(info.mtimeMs, await stat(join(dir, "lease.json")).then((s) => s.mtimeMs, () => 0));
    entries.push({ dir, identity, bytes: await recursiveBytes(dir), accessedAt, stale: await missingWorktree(identity), protected: protectedReasons });
  }
  return entries;
};

// Keep lifecycle bookkeeping beside (not inside) worktree entries so every
// worktree child remains an identity directory and older callers can enumerate
// it without special cases.
const markerPath = (base: string): string => join(dirname(base), "cleanup.json");
const lastCleanup = async (base: string): Promise<number> => {
  try { return Number((JSON.parse(await readFile(markerPath(base), "utf8")) as { at?: unknown }).at) || 0; } catch { return 0; }
};
const markCleanup = async (base: string, now: number): Promise<void> => {
  await writeFile(markerPath(base), JSON.stringify({ at: now }) + "\n", { mode: 0o600 }).catch(() => undefined);
};

/** Inspect, dry-run, purge, or perform throttled stale/size cleanup. */
export const manageCache = async (options: CacheCleanupOptions = {}): Promise<CacheDiagnostics> => {
  const ttlDays = options.ttlDays ?? DEFAULT_TTL_DAYS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const now = options.now ?? Date.now();
  if (cacheDisabled()) return { enabled: false, ttlDays, maxBytes, totalBytes: 0, entries: [], candidates: [], deleted: [], skipped: [] };
  const base = await cacheWorktreesDir({ cacheHome: options.cacheHome, create: false });
  if (!base) return { enabled: true, base: undefined, ttlDays, maxBytes, totalBytes: 0, entries: [], candidates: [], deleted: [], skipped: [] };
  const entries = await inspect(base, now);
  const totalBytes = entries.reduce((sum, item) => sum + item.bytes, 0);
  const cutoff = now - ttlDays * DAY;
  let targetRoot: string | undefined;
  const requestedRoot = options.root;
  if (requestedRoot) {
    const normalized = resolve(requestedRoot);
    targetRoot = await realpath(normalized).catch(() => normalized);
  }
  const candidates: CacheEntryDiagnostic[] = [];
  const skipped: CacheDiagnostics["skipped"] = [];
  let projected = totalBytes;
  const ordered = [...entries].sort((a, b) => a.accessedAt - b.accessedAt || a.dir.localeCompare(b.dir));
  for (const entry of ordered) {
    const targetMatches = !targetRoot || entry.identity?.root === targetRoot;
    const eligible = options.purge ? targetMatches : (entry.stale || entry.accessedAt < cutoff || projected > maxBytes);
    if (!eligible) continue;
    if (entry.protected.length) { skipped.push({ dir: entry.dir, reason: entry.protected.join(", ") }); continue; }
    if (!entry.identity) { skipped.push({ dir: entry.dir, reason: "invalid identity" }); continue; }
    candidates.push(entry);
    projected -= entry.bytes;
  }
  const out: CacheDiagnostics = {
    enabled: true, base, ttlDays, maxBytes, totalBytes, entries,
    candidates: candidates.map((entry) => entry.dir), deleted: [], skipped,
  };
  if (options.dryRun) return out;
  if (!options.purge && now - await lastCleanup(base) < CLEANUP_GAP_MS) return { ...out, throttled: true };
  for (const entry of candidates) {
    // Re-check the directory and SQLite sidecars immediately before mutation.
    const fresh = (await inspect(base, now)).find((item) => item.dir === entry.dir);
    if (!fresh || fresh.protected.length || !fresh.identity) {
      out.skipped.push({ dir: entry.dir, reason: fresh?.protected.join(", ") || "entry changed during cleanup" });
      continue;
    }
    await rm(entry.dir, { recursive: true, force: false }).then(() => out.deleted.push(entry.dir), () => out.skipped.push({ dir: entry.dir, reason: "delete failed" }));
  }
  if (!options.purge) await markCleanup(base, now);
  return out;
};
