import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeChanges,
  captureMutation,
  finishMutation,
  provenancePathFor,
} from "../src/core/provenance.js";

const hash = (text: string): string => createHash("sha1").update(text).digest("hex");
const roots: string[] = [];
const journals: string[] = [];

const rootWithFile = (content = "one\n"): { root: string; file: string } => {
  const root = mkdtempSync(join(tmpdir(), "pi-fovea-provenance-test-"));
  const file = join(root, "file.ts");
  writeFileSync(file, content);
  roots.push(root);
  return { root, file };
};

const mutate = async (root: string, file: string, sessionId: string, next: string, toolCallId: string): Promise<void> => {
  const capture = await captureMutation(root, file);
  expect(capture).toBeDefined();
  writeFileSync(file, next);
  expect(await finishMutation(capture!, sessionId, toolCallId)).toBe(true);
  journals.push(provenancePathFor(root, sessionId));
};

afterEach(() => {
  for (const path of new Set(journals.splice(0))) {
    try { unlinkSync(path); } catch {}
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sync provenance", () => {
  it("attributes an exact content transition to the current or another session", async () => {
    const { root, file } = rootWithFile();
    await mutate(root, file, "session-a", "two\n", "tool-a");

    const change = [{ file: "file.ts", beforeSha: hash("one\n"), afterSha: hash("two\n") }];
    await expect(attributeChanges(root, "session-a", 0, change)).resolves.toEqual({
      kind: "current-session",
      files: { "file.ts": "current-session" },
    });
    await expect(attributeChanges(root, "session-b", 0, change)).resolves.toEqual({
      kind: "other-session",
      files: { "file.ts": "other-session" },
    });
  });

  it("reports a transition chain owned by multiple sessions as mixed", async () => {
    const { root, file } = rootWithFile();
    await mutate(root, file, "session-a", "two\n", "tool-a");
    await mutate(root, file, "session-b", "three\n", "tool-b");

    const result = await attributeChanges(root, "session-a", 0, [{
      file: "file.ts",
      beforeSha: hash("one\n"),
      afterSha: hash(readFileSync(file, "utf8")),
    }]);
    expect(result).toEqual({ kind: "mixed", files: { "file.ts": "mixed" } });
  });

  it("leaves uninstrumented writes unattributed", async () => {
    const { root, file } = rootWithFile();
    writeFileSync(file, "external\n");
    await expect(attributeChanges(root, "session-a", 0, [{
      file: "file.ts",
      beforeSha: hash("one\n"),
      afterSha: hash("external\n"),
    }])).resolves.toEqual({
      kind: "unattributed",
      files: { "file.ts": "unattributed" },
    });
  });
});
