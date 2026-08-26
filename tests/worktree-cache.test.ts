import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { safeGitArgs, safeGitEnv } from "../src/core/git.js";
import { ensureState, evictState } from "../src/core/ops.js";
import { ensureWorktreeCache, resolveWorktreeIdentity } from "../src/core/worktree-cache.js";

const mode = (path: string): number => statSync(path).mode & 0o777;
const git = (cwd: string, args: string[]): void => {
  execFileSync("git", args, { cwd, stdio: "ignore" });
};

const gitRepo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-repo-"));
  writeFileSync(join(root, "a.ts"), "export const a = 1;\n");
  git(root, ["init", "-qb", "main"]);
  git(root, ["add", "."]);
  git(root, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return root;
};

describe("private worktree cache", () => {
  it("uses physical roots and Git worktree metadata to isolate linked worktrees", async () => {
    const root = gitRepo();
    const cacheHome = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-home-"));
    const linked = join(dirname(root), "linked");
    try {
      git(root, ["worktree", "add", "-qb", "linked", linked]);
      const [mainIdentity, linkedIdentity] = await Promise.all([
        resolveWorktreeIdentity(root),
        resolveWorktreeIdentity(linked),
      ]);
      expect(mainIdentity.root).toBe(root);
      expect(linkedIdentity.root).toBe(linked);
      expect(mainIdentity.commonGitDir).toBe(linkedIdentity.commonGitDir);
      expect(mainIdentity.gitDir).not.toBe(linkedIdentity.gitDir);

      const [main, child] = await Promise.all([
        ensureWorktreeCache(root, { cacheHome }),
        ensureWorktreeCache(linked, { cacheHome }),
      ]);
      expect(main.dir).not.toBe(child.dir);
      expect(main.databasePath).not.toBe(child.databasePath);
      expect(main.dir.startsWith(root)).toBe(false);
      expect(child.dir.startsWith(linked)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(linked, { recursive: true, force: true });
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it("creates and verifies a private, tagged cache on first use", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-root-"));
    const cacheHome = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-home-"));
    try {
      const cache = await ensureWorktreeCache(root, { cacheHome });
      expect(cache.identity).toEqual({ root });
      expect(existsSync(cache.databasePath)).toBe(true);
      expect(readFileSync(join(cache.dir, "CACHEDIR.TAG"), "utf8"))
        .toMatch(/^Signature: 8a477f597d28d172789f06886806bc55\n/);
      expect(mode(join(cacheHome, "pi-fovea"))).toBe(0o700);
      expect(mode(join(cacheHome, "pi-fovea", "worktrees"))).toBe(0o700);
      expect(mode(cache.dir)).toBe(0o700);
      expect(mode(join(cache.dir, "CACHEDIR.TAG"))).toBe(0o600);
      expect(mode(join(cache.dir, "identity.json"))).toBe(0o600);
      expect(mode(cache.databasePath)).toBe(0o600);

      writeFileSync(join(cache.dir, "identity.json"), "{}\n", { mode: 0o600 });
      await expect(ensureWorktreeCache(root, { cacheHome }))
        .rejects.toThrow("cache identity does not match active root");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });

  it("sets up private storage automatically on the first active-root build", async () => {
    const root = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-auto-root-"));
    const cacheHome = mkdtempSync(join(tmpdir(), "fovea-worktree-cache-auto-home-"));
    const previous = process.env.XDG_CACHE_HOME;
    try {
      process.env.XDG_CACHE_HOME = cacheHome;
      // Cache setup precedes the optional ast-grep availability check, so this
      // validates first use on every test host without a separate init command.
      await ensureState(root).catch(() => undefined);
      const worktrees = join(cacheHome, "pi-fovea", "worktrees");
      expect(readdirSync(worktrees)).toHaveLength(1);
    } finally {
      if (previous === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = previous;
      evictState(root);
      rmSync(root, { recursive: true, force: true });
      rmSync(cacheHome, { recursive: true, force: true });
    }
  });
});

describe("safe Git environment", () => {
  it("forces lock-free inspection and removes Git redirection/helper variables", () => {
    const original = {
      GIT_OPTIONAL_LOCKS: process.env.GIT_OPTIONAL_LOCKS,
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF,
      GIT_CONFIG_KEY_0: process.env.GIT_CONFIG_KEY_0,
      GIT_CONFIG_VALUE_0: process.env.GIT_CONFIG_VALUE_0,
      GIT_CONFIG_PARAMETERS: process.env.GIT_CONFIG_PARAMETERS,
    };
    try {
      process.env.GIT_OPTIONAL_LOCKS = "1";
      process.env.GIT_DIR = "/untrusted/gitdir";
      process.env.GIT_WORK_TREE = "/untrusted/worktree";
      process.env.GIT_EXTERNAL_DIFF = "/untrusted/diff";
      process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
      process.env.GIT_CONFIG_VALUE_0 = "untrusted";
      process.env.GIT_CONFIG_PARAMETERS = "'core.fsmonitor=untrusted'";
      const env = safeGitEnv();
      expect(env.GIT_OPTIONAL_LOCKS).toBe("0");
      expect(env.GIT_DIR).toBeUndefined();
      expect(env.GIT_WORK_TREE).toBeUndefined();
      expect(env.GIT_EXTERNAL_DIFF).toBeUndefined();
      expect(env.GIT_CONFIG_KEY_0).toBeUndefined();
      expect(env.GIT_CONFIG_VALUE_0).toBeUndefined();
      expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined();
      expect(safeGitArgs(["diff", "--name-only"])).toEqual(["diff", "--no-ext-diff", "--no-textconv", "--name-only"]);
      expect(safeGitArgs(["status", "--porcelain"])).toEqual(["status", "--porcelain"]);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
