// Rate–distortion bench and scale smoke test.
//
//   pnpm run bench [root]            (default: ../pi-fabric)
//
// Arms per budget B on a fixed query set:
//   fovea   : union of nodes fovea_focus reveals at B, scored against the ideal
//             unbounded top-mass set of the same field (recall@B).
//   naive   : same tokens spent on the alphabetically-ordered outline; an ideal
//             node counts if its name appears in the truncated text.
//
// Also reports build timings (cold vs cache-warm) and per-op latency.

import { performance } from "node:perf_hooks";
import { existsSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { cachePathFor } from "../src/core/build.js";
import { manageCache } from "../src/core/cache-lifecycle.js";
import { ensureState, evictState, focus } from "../src/core/ops.js";
import { resetSessions } from "../src/core/session.js";

const root = resolve(process.argv[2] ?? join(import.meta.dirname, "..", "..", "pi-fabric"));
if (!existsSync(root)) {
  console.error(`bench root not found: ${root}`);
  process.exit(1);
}

const memory = (): string => {
  const usage = process.memoryUsage();
  return `rss ${(usage.rss / 1024 / 1024).toFixed(1)}MB, heap ${(usage.heapUsed / 1024 / 1024).toFixed(1)}MB`;
};

// Cold build. Purge only this root's inactive persistent cache, then remove
// the JSONL compatibility mirror. This keeps cold/warm measurements honest.
await manageCache({ purge: true, root });
try { unlinkSync(cachePathFor(root)); } catch {}
let t0 = performance.now();
let state = await ensureState(root);
const coldMs = performance.now() - t0;

// Warm build in a fresh resident state (disk-cached facts).
evictState(root);
t0 = performance.now();
state = await ensureState(root);
const warmMs = performance.now() - t0;

const g = state.graph;
console.log(`root: ${root}`);
console.log(`graph: ${g.files.length} files, ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.anchors.length} anchors`);
console.log(`build: cold ${coldMs.toFixed(0)}ms, warm ${warmMs.toFixed(0)}ms · ${memory()}`);

// Steady-state probe (warm state): the path every hook takes per turn.
t0 = performance.now();
await ensureState(root);
const probeMs = performance.now() - t0;
console.log(`idle probe: ${probeMs.toFixed(1)}ms · ${memory()}`);

// Fixed query set: most-connected symbol names + all anchor paths.
const conductance = state.csr.deg;
const symbolIdx = g.nodes
  .map((n, i) => [conductance[i]!, n] as const)
  .filter(([, n]) => n.kind !== "file" && n.kind !== "anchor")
  .sort((a, b) => b[0] - a[0]);
const queries: string[] = [];
const seenNames = new Set<string>();
for (const [, n] of symbolIdx) {
  if (queries.length >= 12) break;
  if (seenNames.has(n.name)) continue;
  seenNames.add(n.name);
  queries.push(n.name);
}

// Naive arm text: concatenated outline, alphabetical by file.
const fileSigs = new Map<string, string[]>();
for (const n of g.nodes) {
  if (n.kind === "file" || n.kind === "anchor") continue;
  (fileSigs.get(n.file) ?? fileSigs.set(n.file, []).get(n.file)!).push(`${n.sig}`);
}
const outlineText = [...fileSigs.keys()].sort().flatMap((f) => [f, ...(fileSigs.get(f) ?? [])]).join("\n");
const outlineTokens = Math.ceil(outlineText.length / 4);
console.log(`full outline baseline: ${outlineTokens} tokens`);

const budgets = [500, 1000, 2000, 4000];
const header = ["budget", "fovea recall", "naive recall", "fovea ms", "max tok", ""].join("\t");
console.log(header);
for (const B of budgets) {
  let foveaHits = 0;
  let naiveHits = 0;
  let total = 0;
  let latTotal = 0;
  let maxTokens = 0;
  const naiveText = outlineText.slice(0, B * 4);
  for (const q of queries) {
    resetSessions();
    const t1 = performance.now();
    const r = await focus(root, q, B);
    latTotal += performance.now() - t1;
    maxTokens = Math.max(maxTokens, r.tokens);
    if (r.tokens > B) throw new Error(`budget violation: ${q} used ${r.tokens} > ${B}`);
    // Ideal set: the unbounded (32k-token) reveal of the same field.
    resetSessions();
    const ideal = (await focus(root, q, 16000)).text;
    const idealNames = new Set([...ideal.matchAll(/^\s*· (\S+) \(/gm)].map((m) => m[1]!)
      .concat([...ideal.matchAll(/^▲ \S+?:\d+\s+(.*)$/gm)].map((m) => m[2]!)));
    const gotText = r.text;
    for (const name of idealNames) {
      total++;
      if (name && gotText.includes(name)) foveaHits++;
      if (name && naiveText.includes(name)) naiveHits++;
    }
  }
  const recall = total ? (foveaHits / total).toFixed(3) : "-";
  const nrecall = total ? (naiveHits / total).toFixed(3) : "-";
  console.log(`${B}\t${recall}\t${nrecall}\t${(latTotal / queries.length).toFixed(1)}\t${maxTokens}`);
}
// Evict the resident graph and probe the SQLite-index path separately. This
// captures the intended RAM/latency release benefit without conflating it
// with full graph construction above.
if (queries.length) {
  evictState(root);
  resetSessions();
  const before = process.memoryUsage().heapUsed;
  const t = performance.now();
  const lazy = await focus(root, queries[0]!, 512);
  const elapsed = performance.now() - t;
  const heapDelta = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
  console.log(`evicted focus: ${elapsed.toFixed(1)}ms, ${lazy.tokens} tok, ${String(lazy.details.queryMode ?? "eager")}, heap Δ ${heapDelta.toFixed(1)}MB`);
}
console.log(`\nqueries: ${queries.join(", ")}`);
