// Private, lazy storage for the future SQLite cache. JSON fact caches remain
// where they are in this phase; this module only establishes a verified,
// per-worktree home outside the repository.

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { gitOut } from "./git.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CACHE_TAG = "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by pi-fovea.\n# For information about cache directory tags, see:\n#\thttp://www.brynosaurus.com/cachedir/\n";
const IDENTITY_VERSION = 2;

export interface WorktreeIdentity {
  /** Canonical physical root requested by the caller (not Git's top level). */
  root: string;
  /** Canonical Git top-level which contains root; absent for a non-Git root. */
  gitRoot?: string;
  /** Canonical per-worktree Git directory; absent for a non-Git root. */
  gitDir?: string;
  /** Canonical shared Git directory; absent for a non-Git root. */
  commonGitDir?: string;
}

export interface WorktreeCache {
  identity: WorktreeIdentity;
  /** Private directory, outside the active worktree. */
  dir: string;
  /** Reserved SQLite path. An empty file is a valid first-use SQLite database. */
  databasePath: string;
}

export interface WorktreeCacheOptions {
  /** Test/embedder override. The default follows FOVEA_CACHE_DIR, XDG, or ~/.cache. */
  cacheHome?: string;
}

/** Disable every durable cache layer (SQLite, JSONL, and co-change). */
export const cacheDisabled = (): boolean => {
  const value = process.env.FOVEA_NO_CACHE?.trim().toLowerCase();
  return value !== undefined && value !== "" && !["0", "false", "no", "off"].includes(value);
};

const isInside = (child: string, parent: string): boolean => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
};

const ownedByCurrentUser = (uid: number): boolean =>
  typeof process.getuid !== "function" || uid === process.getuid();

const privateDirectory = async (path: string): Promise<void> => {
  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) {
    throw new Error(`fovea: private cache path is not a current-user directory: ${path}`);
  }
  await chmod(path, DIRECTORY_MODE);
};

/** Resolve only a current-user owned directory, never following its final symlink. */
const secureCacheHome = async (path: string, create: boolean): Promise<string> => {
  if (create) await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) {
    throw new Error(`fovea: cache home is not a current-user directory: ${path}`);
  }
  return realpath(path);
};

const privateFile = async (path: string, contents?: string): Promise<void> => {
  try {
    const handle = await open(path, "wx", FILE_MODE);
    try {
      if (contents !== undefined) await handle.writeFile(contents, "utf8");
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`fovea: private cache path is not a regular file: ${path}`);
  }
  await chmod(path, FILE_MODE);
};

const gitIdentity = async (root: string): Promise<WorktreeIdentity | undefined> => {
  // --path-format makes every value independently canonicalizable. gitDir is
  // intentionally part of the key: linked worktrees share commonGitDir but
  // each has a distinct worktree metadata directory.
  const out = await gitOut(root, [
    "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir",
  ]);
  if (!out) return undefined;
  const [top, gitDir, commonGitDir, ...extra] = out.trim().split("\n");
  if (!top || !gitDir || !commonGitDir || extra.length) return undefined;
  try {
    const [physicalRoot, physicalGitDir, physicalCommonGitDir] = await Promise.all([
      realpath(top), realpath(gitDir), realpath(commonGitDir),
    ]);
    // `git -C root` must resolve to a worktree which contains the active
    // root. This catches contaminated Git environment or a surprising Git
    // response before we create a cache under its identity.
    if (!isInside(root, physicalRoot)) return undefined;
    // The cache is scoped to the caller's physical root. Git's top-level is
    // retained as metadata for validation, but must never collapse distinct
    // subdirectory roots into one worktree cache entry.
    return { root, gitRoot: physicalRoot, gitDir: physicalGitDir, commonGitDir: physicalCommonGitDir };
  } catch {
    return undefined;
  }
};

/** Resolve a physical root plus worktree-specific Git metadata when present. */
export const resolveWorktreeIdentity = async (root: string): Promise<WorktreeIdentity> => {
  const physicalRequestedRoot = await realpath(root);
  const git = await gitIdentity(physicalRequestedRoot);
  return git ?? { root: physicalRequestedRoot };
};

const cacheHomeFor = (override?: string): string => {
  // FOVEA_CACHE_DIR is intentionally a cache *home*, not an in-repository
  // path: pi-fovea still appends its private pi-fovea/worktrees namespace.
  const configured = override ?? process.env.FOVEA_CACHE_DIR ?? process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  // XDG_CACHE_HOME is required to be absolute. Treat an invalid override as
  // absent rather than accidentally putting a private cache below cwd/repo.
  return isAbsolute(configured) ? resolve(configured) : join(tmpdir(), "pi-fovea-cache");
};

const privateCacheBase = async (identity: WorktreeIdentity, options: WorktreeCacheOptions): Promise<string> => {
  let home = await secureCacheHome(cacheHomeFor(options.cacheHome), true);
  const activeRoots = [identity.root, identity.gitRoot].filter((path): path is string => !!path);
  if (activeRoots.some((root) => isInside(home, root))) {
    home = await secureCacheHome(resolve(tmpdir(), "pi-fovea-cache"), true);
  }
  if (activeRoots.some((root) => isInside(home, root))) {
    throw new Error("fovea: no safe cache location exists outside the active root");
  }
  const app = join(home, "pi-fovea");
  const worktrees = join(app, "worktrees");
  await privateDirectory(app);
  await privateDirectory(worktrees);
  return worktrees;
};

/** Private worktree directory used by lifecycle diagnostics without a root. */
export const cacheWorktreesDir = async (options: WorktreeCacheOptions & { create?: boolean } = {}): Promise<string | undefined> => {
  if (cacheDisabled()) return undefined;
  let home = cacheHomeFor(options.cacheHome);
  try {
    home = await secureCacheHome(home, !!options.create);
    const app = join(home, "pi-fovea");
    const worktrees = join(app, "worktrees");
    if (options.create) {
      await privateDirectory(app);
      await privateDirectory(worktrees);
    }
    return worktrees;
  } catch { return undefined; }
};

const leased = new Map<string, Set<string>>();
const releaseLeases = (): void => {
  // Node does not await asynchronous work from an `exit` handler. A real
  // cleanup must be synchronous so a dead process cannot leave a fresh lease.
  for (const paths of leased.values()) for (const path of paths) {
    try { unlinkSync(path); } catch { /* already removed or inaccessible */ }
  }
  leased.clear();
};
process.once("exit", releaseLeases);
const touchLease = async (root: string, dir: string): Promise<void> => {
  const path = join(dir, "lease.json");
  // Verify an existing lease before writing it: writeFile otherwise follows a
  // symlink, even inside a directory we created earlier in this process.
  await privateFile(path);
  // Cache dirs are private and verified above. The lease is still mode 0600
  // because it names a worktree indirectly and lifecycle treats malformed
  // records as protection rather than a deletion authorization.
  await writeFile(path, JSON.stringify({ pid: process.pid, touchedAt: Date.now() }) + "\n", { mode: FILE_MODE });
  await chmod(path, FILE_MODE);
  let paths = leased.get(root);
  if (!paths) {
    paths = new Set();
    leased.set(root, paths);
  }
  paths.add(path);
};

/** Release an idle resident root's lease; SQLite handles are always short-lived. */
export const releaseWorktreeLease = async (root: string): Promise<void> => {
  const paths = leased.get(root);
  if (!paths) return;
  leased.delete(root);
  await Promise.all([...paths].map((path) => unlink(path).catch(() => undefined)));
};

const identityKey = (identity: WorktreeIdentity): string =>
  createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 32);

const verifyIdentity = async (path: string, identity: WorktreeIdentity): Promise<void> => {
  const expected = JSON.stringify({ v: IDENTITY_VERSION, ...identity }) + "\n";
  await privateFile(path, expected);
  let saved: unknown;
  try {
    saved = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    throw new Error(`fovea: invalid cache identity record: ${path}`);
  }
  if (JSON.stringify(saved) !== JSON.stringify({ v: IDENTITY_VERSION, ...identity })) {
    throw new Error(`fovea: cache identity does not match active root: ${path}`);
  }
};

/**
 * Lazily establish private cache/database storage for a root. The call is
 * idempotent and intentionally performs no JSON-cache migration in phase one.
 */
/**
 * Return a named file path inside the verified private worktree cache.
 * Existing files are re-verified and chmodded because `mode` only affects
 * creation; callers create absent files with exclusive/no-follow-safe writes.
 */
export const worktreeCacheFilePath = async (root: string, name: string): Promise<string> => {
  if (name !== "facts.jsonl") throw new Error("fovea: unsupported private cache file");
  const cache = await ensureWorktreeCache(root);
  const path = join(cache.dir, name);
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || !ownedByCurrentUser(info.uid)) {
      throw new Error(`fovea: private cache path is not a current-user regular file: ${path}`);
    }
    await chmod(path, FILE_MODE);
  } catch (error: unknown) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  return path;
};

export const ensureWorktreeCache = async (
  root: string,
  options: WorktreeCacheOptions = {},
): Promise<WorktreeCache> => {
  if (cacheDisabled()) throw new Error("fovea: persistent cache disabled by FOVEA_NO_CACHE");
  const identity = await resolveWorktreeIdentity(root);
  const base = await privateCacheBase(identity, options);
  const dir = join(base, identityKey(identity));
  await privateDirectory(dir);
  await privateFile(join(dir, "CACHEDIR.TAG"), CACHE_TAG);
  const tag = await readFile(join(dir, "CACHEDIR.TAG"), "utf8");
  if (!tag.startsWith("Signature: 8a477f597d28d172789f06886806bc55\n")) {
    throw new Error(`fovea: invalid cache directory tag: ${dir}`);
  }
  await verifyIdentity(join(dir, "identity.json"), identity);
  await touchLease(identity.root, dir);
  const databasePath = join(dir, "fovea.sqlite");
  await privateFile(databasePath);
  return { identity, dir, databasePath };
};
