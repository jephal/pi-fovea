// Extraction honesty: a failed ast-grep stage must be reported (per-file)
// instead of silently thinning the graph — and a healthy pass reports zero.
// The failing runs point FOVEA_AST_GREP at a wrapper that answers --version
// but exits 1 for everything else, so ensureState proceeds into genuinely
// broken extraction.

import { chmodSync, cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hasAstGrep } from "../src/core/astgrep.js";
import { cachePathFor, listFiles, loadFacts } from "../src/core/build.js";
import { sketch } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";

const SRC = new URL("./fixtures/mini", import.meta.url).pathname;

// Separate temp roots per test: a broken-extraction fact pass writes an empty
// cache keyed by root, which must never leak a poisoned graph into other runs.
const copyFixture = (): { root: string; cleanup: () => void } => {
  const root = mkdtempSync(join(tmpdir(), "fovea-report-"));
  cpSync(SRC, root, { recursive: true });
  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(cachePathFor(root), { force: true });
    },
  };
};

const fakeAstGrep = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "fovea-fake-sg-"));
  const bin = join(dir, "sg-fail");
  // stderr text matters: grep-family CLIs exit 1 silently on zero matches,
  // so genuine failures are told apart by having something to say.
  writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "sg-fail 0.0.0"; exit 0; fi\necho "sg-fail: synthetic failure" >&2\nexit 1\n');
  chmodSync(bin, 0o755);
  return bin;
};

afterEach(() => vi.unstubAllEnvs());

describe("extraction failure reporting", () => {
  it("names the implicated files when every ast-grep invocation fails", () => {
    const { root, cleanup } = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      const files = listFiles(root);
      const { facts, report } = loadFacts(root, files);
      expect(report.unreadable).toEqual([]);
      expect(report.failed.length).toBeGreaterThan(0);
      expect(report.failed).toContain("server/main.go");
      expect(facts["server/main.go"]?.symbols).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("sketch renders the failure banner and exposes the failure details", () => {
    const { root, cleanup } = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      resetSessions();
      const r = sketch(root, 900);
      expect(Number(r.details.extractionFailures)).toBeGreaterThan(0);
      expect((r.details.extractionFailedFiles as string[]).length).toBeGreaterThan(0);
      expect(r.text).toContain("failed extraction");
    } finally {
      cleanup();
    }
  });
});

describe.skipIf(!hasAstGrep())("healthy extraction", () => {
  it("reports zero failures and drains a previous run's ledger", () => {
    const bad = copyFixture();
    const good = copyFixture();
    try {
      vi.stubEnv("FOVEA_AST_GREP", fakeAstGrep());
      loadFacts(bad.root, listFiles(bad.root)); // poison the ledger, then drain
      vi.unstubAllEnvs();
      const { report } = loadFacts(good.root, listFiles(good.root));
      expect(report.failed).toEqual([]);
      expect(report.unreadable).toEqual([]);
      resetSessions();
      const r = sketch(good.root, 900);
      expect(Number(r.details.extractionFailures)).toBe(0);
      expect(r.text).not.toContain("failed extraction");
    } finally {
      bad.cleanup();
      good.cleanup();
    }
  });
});
