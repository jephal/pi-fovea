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
    expect(drift.details.semanticChangedFiles).toEqual([]);

    writeFileSync(main, `\n${readFileSync(main, "utf8")}`);
    const shifted = sync(root, { files: [], budget: 512, warmFileThreshold: 2 });
    expect(shifted.red).toBe(false);
    expect(shifted.details.semanticChangedFiles).toEqual([]);
    execSync("git checkout -- server/main.go", { cwd: root });
  });


  it("steers on the first semantic cascade with causal context", () => {
    resetSyncBaselines();
    resetSessions();
    sync(root, { files: [], budget: 512, warmFileThreshold: 1 });
    const users = join(root, "server/users.go");
    const src = readFileSync(users, "utf8");
    writeFileSync(users, src.replace("return LoadUser(id)", "return SaveUser(id)"));
    const outcome = sync(root, { files: ["server/users.go"], budget: 512, warmFileThreshold: 1 });
    expect(outcome.red).toBe(true);
    expect(outcome.tokens).toBeLessThanOrEqual(512);
    expect(outcome.text).toContain("Fovea continuous update");
    expect(outcome.text).toContain("Changed: server/users.go");
    expect(outcome.text).toContain("Newly relevant files:");
    expect(outcome.text).toContain("Steer: account for this update");
    expect(outcome.text).toContain('Next: fovea_focus "server/users.go" to see what it now connects to.');
    expect(outcome.text).not.toContain("undisclosed");
    expect(outcome.text).not.toMatch(/ · v [a-f0-9]+/);
    expect(outcome.details.semanticChangedFiles).toContain("server/users.go");
    expect(outcome.details.warmReasons).toBeTruthy();
    execSync("git checkout -- server/users.go", { cwd: root });
    resetSyncBaselines();
    sync(root, { files: [], budget: 512, warmFileThreshold: 1 });
  });

  it("anchor shift escalates to red with the added route", () => {
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
    expect(outcome.text).toContain('Next: fovea_focus "/api/users/{*}/restore"');
    execSync("git checkout -- server/main.go", { cwd: root });
    // Post-restore sync re-baselines; the restored repo is the new normal.
    sync(root, { files: ["server/main.go"], budget: 512, warmFileThreshold: 2 });
  });

  it("hintless drift is detected identically (fabric_exec / bash mutation path)", () => {
    // Raw filesystem write with NO tool-event hints: the sha diff against the
    // baseline's content hashes is the source of truth, so a fabric_exec inner
    // pi.edit, a bash heredoc, or an out-of-band editor save all escalate the
    // same way a pi edit/write tool call does.
    const main = join(root, "server/main.go");
    const src = readFileSync(main, "utf8");
    writeFileSync(main, src.replace(
      'r.POST("/api/users", server.CreateUserHandler)',
      'r.POST("/api/users", server.CreateUserHandler)\n\tr.GET("/api/users/:id/audit", server.GetUserHandler)',
    ));
    const outcome = sync(root, { files: [], budget: 512, warmFileThreshold: 2 });
    expect(outcome.structural).toBe(true);
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("GET /api/users/{*}/audit");
    execSync("git checkout -- server/main.go", { cwd: root });
    sync(root, { files: [], budget: 512, warmFileThreshold: 2 });
  });


  it("steers when a production file disappears", () => {
    resetSyncBaselines();
    sync(root, { files: [], budget: 512, warmFileThreshold: 16 });
    rmSync(join(root, "web/types.ts"));
    const outcome = sync(root, { files: [], budget: 512, warmFileThreshold: 16 });
    expect(outcome.red).toBe(true);
    expect(outcome.text).toContain("1 deleted file");
    expect(outcome.details.deletedFiles).toContain("web/types.ts");
    execSync("git checkout -- web/types.ts", { cwd: root });
    resetSyncBaselines();
    sync(root, { files: [], budget: 512, warmFileThreshold: 16 });
  });

  it("hintless drift in a non-git workspace still detects content change", () => {
    const plain = mkdtempSync(join(tmpdir(), "fovea-sync-nogit-"));
    cpSync(SRC, plain, { recursive: true }); // deliberately no git init
    try {
      const base = sync(plain, { files: [], budget: 512, warmFileThreshold: 2 });
      expect(base.structural).toBe(true);
      expect(base.red).toBe(false);
      const main = join(plain, "server/main.go");
      const src = readFileSync(main, "utf8");
      writeFileSync(main, src.replace(
        'r.GET("/api/users/:id", server.GetUserHandler)',
        'r.GET("/api/users/:id", server.GetUserHandler)\n\tr.DELETE("/api/users/:id", server.GetUserHandler)',
      ));
      const outcome = sync(plain, { files: [], budget: 512, warmFileThreshold: 2 });
      expect(outcome.structural).toBe(true);
      expect(outcome.red).toBe(true);
      expect(outcome.text).toContain("DELETE /api/users/{*}");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
