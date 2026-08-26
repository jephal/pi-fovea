import { existsSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { manageCache } from "../src/core/cache-lifecycle.js";
import { ensureWorktreeCache } from "../src/core/worktree-cache.js";

const DAY = 86_400_000;

describe("cache lifecycle", () => {
  it("dry-runs stale worktree cleanup but protects live leases and SQLite sidecars", async () => {
    const home = mkdtempSync(join(tmpdir(), "fovea-cache-life-home-"));
    const live = mkdtempSync(join(tmpdir(), "fovea-cache-life-live-"));
    const stale = mkdtempSync(join(tmpdir(), "fovea-cache-life-stale-"));
    try {
      const liveCache = await ensureWorktreeCache(live, { cacheHome: home });
      const staleCache = await ensureWorktreeCache(stale, { cacheHome: home });
      // A fresh lease with this process PID protects a cache even after its
      // worktree disappears (the conservative cross-process race case).
      rmSync(live, { recursive: true, force: true });
      utimesSync(liveCache.dir, new Date(Date.now() - 90 * DAY), new Date(Date.now() - 90 * DAY));
      const protectedRun = await manageCache({ cacheHome: home, dryRun: true, now: Date.now(), ttlDays: 1 });
      expect(protectedRun.skipped.some((item) => item.dir === liveCache.dir && item.reason.includes("live lease"))).toBe(true);

      rmSync(stale, { recursive: true, force: true });
      writeFileSync(join(staleCache.dir, "lease.json"), JSON.stringify({ pid: 999999, touchedAt: 0 }));
      writeFileSync(`${staleCache.databasePath}-wal`, "open");
      const walRun = await manageCache({ cacheHome: home, dryRun: true, now: Date.now(), ttlDays: 1 });
      expect(walRun.skipped.some((item) => item.dir === staleCache.dir && item.reason.includes("WAL/SHM"))).toBe(true);
      rmSync(`${staleCache.databasePath}-wal`);
      const dry = await manageCache({ cacheHome: home, dryRun: true, now: Date.now(), ttlDays: 1 });
      expect(dry.candidates).toContain(staleCache.dir);
      expect(existsSync(staleCache.dir)).toBe(true);

      const deleted = await manageCache({ cacheHome: home, now: Date.now(), ttlDays: 1 });
      expect(deleted.deleted).toContain(staleCache.dir);
      expect(existsSync(staleCache.dir)).toBe(false);
      expect(existsSync(liveCache.dir)).toBe(true);
    } finally {
      rmSync(live, { recursive: true, force: true });
      rmSync(stale, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports disabled without creating a durable cache when FOVEA_NO_CACHE is set", async () => {
    const previous = process.env.FOVEA_NO_CACHE;
    const root = mkdtempSync(join(tmpdir(), "fovea-cache-off-root-"));
    try {
      process.env.FOVEA_NO_CACHE = "1";
      expect((await manageCache()).enabled).toBe(false);
      await expect(ensureWorktreeCache(root)).rejects.toThrow("FOVEA_NO_CACHE");
    } finally {
      if (previous === undefined) delete process.env.FOVEA_NO_CACHE;
      else process.env.FOVEA_NO_CACHE = previous;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("purges only an explicitly selected inactive worktree cache", async () => {
    const home = mkdtempSync(join(tmpdir(), "fovea-cache-purge-home-"));
    const root = mkdtempSync(join(tmpdir(), "fovea-cache-purge-root-"));
    try {
      const cache = await ensureWorktreeCache(root, { cacheHome: home });
      writeFileSync(join(cache.dir, "lease.json"), JSON.stringify({ pid: 999999, touchedAt: 0 }));
      const result = await manageCache({ cacheHome: home, purge: true, root });
      expect(result.deleted).toContain(cache.dir);
      expect(existsSync(cache.dir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
