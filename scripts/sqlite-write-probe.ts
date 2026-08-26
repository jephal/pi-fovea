// Run under scripts/file-syscall-probe.c + strace. The root and its source
// file are prepared before tracing, so this process only writes cache/overflow.
import { statSync } from "node:fs";
import { join } from "node:path";
import { cachePathFor, persistFacts } from "../src/core/build.js";
import { privateOverflowPath, writePrivateArtifact } from "../src/core/privacy.js";
import type { Graph } from "../src/core/types.js";

const root = process.argv[2];
if (!root) throw new Error("usage: tsx scripts/sqlite-write-probe.ts ROOT");
const file = "probe.ts";
const info = statSync(join(root, file));
const graph: Graph = {
  nodes: [
    { id: "file:probe.ts", name: file, kind: "file", file, line: 0, sig: file, lang: "TypeScript" },
    { id: "probe@probe.ts", name: "probe", kind: "function", file, line: 1, sig: "export function probe()", lang: "TypeScript" },
  ],
  edges: [{ a: 0, b: 1, kind: "contains", w: 1 }],
  byName: new Map([["probe", [1]]]),
  byFile: new Map([[file, [0, 1]]]),
  anchors: [],
  files: [file],
};
const store = {
  root,
  facts: new Map([[file, {
    sha1: "a".repeat(40),
    symbols: [{ name: "probe", kind: "function" as const, file, line: 1, sig: "export function probe()", lang: "TypeScript" }],
    imports: [], calls: [], literals: [], anchors: [],
  }]]),
  meta: new Map([[file, { size: info.size, mtime: info.mtimeMs }]]),
  tainted: new Set<string>(), failedSha: new Map<string, string>(), unreadable: new Set<string>(),
  oversized: new Set<string>(), generated: new Set<string>(), rulesSha: "probe", enrolled: new Set<string>(), savedAt: 0,
};
await persistFacts(store, graph);
const fallback = await cachePathFor(root);
if (await import("node:fs").then(({ existsSync }) => existsSync(fallback))) throw new Error("successful SQLite persistence wrote a JSONL fallback");
const overflow = privateOverflowPath(`sqlite-write-probe-${process.pid}.txt`);
writePrivateArtifact(overflow, "probe");
console.log(JSON.stringify({ fallback, overflow }));
