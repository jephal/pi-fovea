// Turn-sync verdicts. Copies the fixture into a temp git repo, establishes
// the baseline, then drives drifts the way the turn_end hook would.

import { execSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { resetSyncBaselines, sync } from "../src/core/sync.js";
import { resetSessions } from "../src/core/session.js";

const SRC = new URL("./fixtures/mini", import.meta.url).pathname;
let root = "";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "fovea-sync-"));
  cpSync(SRC, root, { recursive: true });
  execSync("git init -qb main && git add -A", { cwd: root });
  execSync('git -c user.name=t -c user.email=t@t commit -qm init', { cwd: root });
});
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe.skipIf(!hasAstGrep())("turn sync", () => {
  it("baseline establishes silently, then clean edits stay silent", () => {
    resetSyncBaselines();
    resetSessions();
    const first = sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
    expect(first.structural).toBe(true);
    expect(first.red).toBe(false);       // baseline: never red on first contact
    expect(first.text).toBeUndefined();

    // Same content again: version unchanged -> not structural.
    const same = sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
    expect(same.structural).toBe(false);

    // A comment-only edit drifts the file but must stay green.
    const main = join(root, "server/main.go");
    writeFileSync(main, readFileSync(main, "utf8") + "\n// touched\n");
    const drift = sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
    expect(drift.structural).toBe(true);
    expect(drift.red).toBe(false);
    execSync("git checkout -- server/main.go", { cwd: root });
  });

  it("anchor shift escalates to red with the added route", () => {
    // Calibration: this suite's earlier drift syncs recorded the warm set.
    const main = join(root, "server/main.go");
    const src = readFileSync(main, "utf8");
    writeFileSync(main, src.replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/restore", server.GetUserHandler)',
    ));
    const outcome = sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("GET /api/users/{*}/restore");
    expect(outcome.details.added).toContain("GET /api/users/{*}/restore");
    execSync("git checkout -- server/main.go", { cwd: root });
    // Post-restore sync re-baselines; the restored repo is the new normal.
    sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
  });
});
