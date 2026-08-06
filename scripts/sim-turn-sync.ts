// Replay of the exact pi turn wiring (src/index.ts turn_end -> sync()) against
// SANDBOX copies of sibling repos — originals are never touched. For each
// scenario the script prints the user-visible trace: tool outputs and the
// per-turn model-visible (or silent) sync verdicts.
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { focus, type OpResult } from "../src/core/ops";
import { resetSyncBaselines, sync, type SyncOutcome } from "../src/core/sync";
import { resetSessions } from "../src/core/session";

const SATELLITE = "/Users/monotykamary/VCS/working-remote/open-source";
const SIM = join(tmpdir(), "pi-fovea-sim");

const banner = (s: string) => console.log(`\n\x1b[1m== ${s} ==\x1b[0m`);
const turn = (s: string) => console.log(`\n\x1b[2m- turn: ${s}\x1b[0m`);
const msg = (label: string, s: string) => console.log(`\x1b[33m[${label}]\x1b[0m\n${s}\n`);
const toolOut = (r: OpResult, cap = 1400) => {
  const body = r.text.length > cap ? r.text.slice(0, cap) + "\n...(truncated for this demo)" : r.text;
  console.log(`\x1b[36m[tool result ~${r.tokens} tok]\x1b[0m\n${body}\n`);
};

const sandbox = (src: string, name: string): string => {
  const dest = join(SIM, name);
  rmSync(dest, { recursive: true, force: true });
  try {
    execFileSync("sh", ["-c", `mkdir -p "${dest}" && git archive HEAD | tar -x -C "${dest}"`], { cwd: src, stdio: "pipe" });
  } catch {
    cpSync(src, dest, { recursive: true, filter: (p) => !/node_modules|dist|\.git|_build/.test(p) });
  }
  return dest;
};

// Mirror of src/index.ts turn_end (ackClean on so green verdicts are visible).
const simulateTurnEnd = (root: string, touched: string[]): SyncOutcome => {
  const outcome = sync(root, { files: touched, budget: 1024, warmFileThreshold: 2 });
  if (!outcome.structural) {
    console.log(`\x1b[32m(sync: no structural drift — nothing emitted)\x1b[0m`);
  } else if (outcome.red && outcome.text) {
    msg(`sendMessage customType=pi-fovea-sync ~${outcome.tokens} tok -> MODEL CONTEXT`, outcome.text);
  } else {
    console.log(`\x1b[32m(sync: green — silent to model · toast "fovea sync clean · v ${String(outcome.details.version)}")\x1b[0m`);
  }
  return outcome;
};

const newSessionAt = (root: string) => {
  resetSessions();
  resetSyncBaselines();
  turn("session start — first sync establishes baseline (no edits yet)");
  const out = simulateTurnEnd(root, []);
  console.log(`\x1b[32m   details: ${JSON.stringify(out.details)}\x1b[0m`);
};

const scenarioMochi = () => {
  const root = sandbox(join(SATELLITE, "mochi"), "mochi");
  banner("SCENARIO 1 · mochi (Go workflow engine) — same-cone edits stay silent");
  newSessionAt(root);

  toolOut(focus(root, "RunModel", 700));

  turn("model comments tools/db/default.go (inside the cone it just focused)");
  const db = join(root, "tools/db/default.go");
  writeFileSync(db, readFileSync(db, "utf8") + "\n// doc: table list is canonical here\n");
  simulateTurnEnd(root, ["tools/db/default.go"]);

  turn("model touches tools/db/mochi_store.go — still the same warm cone");
  const st = join(root, "tools/db/mochi_store.go");
  writeFileSync(st, readFileSync(st, "utf8") + "\n// doc: CreatedAt is UTC\n");
  simulateTurnEnd(root, ["tools/db/mochi_store.go"]);
};

const scenarioOpenmux = () => {
  const root = sandbox(join(SATELLITE, "openmux"), "openmux");
  banner("SCENARIO 2 · openmux (TS CLI) — blast radius beyond the cone escalates");
  newSessionAt(root);

  toolOut(focus(root, "src/cli/help.ts", 700));

  turn("model renames an export in src/cli/parse.ts (imported widely, focused by none)");
  const p = join(root, "src/cli/parse.ts");
  const src = readFileSync(p, "utf8");
  const fn = src.match(/export (?:function|const) (\w+)/)?.[1];
  if (!fn) { console.log("(no exported symbol matched — scenario skipped)"); return; }
  const renamed = src
    .replace(`export function ${fn}`, `export function ${fn}V2`)
    .replace(`export const ${fn} =`, `export const ${fn}V2 =`);
  writeFileSync(p, renamed);
  simulateTurnEnd(root, ["src/cli/parse.ts"]);
};

const scenarioQuickbeam = () => {
  const root = sandbox(join(SATELLITE, "quickbeam-js"), "quickbeam-js");
  banner("SCENARIO 3 · quickbeam-js (JS supervisor lib) — internal edits, no churn");
  newSessionAt(root);

  const p = join(root, "src/pool.ts");
  if (!existsSync(p)) { console.log("(src/pool.ts missing — scenario skipped)"); return; }
  turn("model edits src/pool.ts internals twice");
  writeFileSync(p, readFileSync(p, "utf8") + "\n// note: children supervised under Pool\n");
  simulateTurnEnd(root, ["src/pool.ts"]);
  writeFileSync(p, readFileSync(p, "utf8") + "// note: backpressure on checkout\n");
  simulateTurnEnd(root, ["src/pool.ts"]);
};

const scenarioNOMAD = () => {
  const root = sandbox(join(SATELLITE, "NOMAD"), "NOMAD");
  banner("SCENARIO 4 · NOMAD (NestJS routes) — adding a route flips anchors: RED");
  newSessionAt(root);

  toolOut(focus(root, "/api/airports", 800), 2000);

  turn("model adds @Get('health') to airports.controller.ts");
  const c = join(root, "server/src/nest/airports/airports.controller.ts");
  const orig = readFileSync(c, "utf8");
  writeFileSync(c, orig.replace(
    "  @Get('search')",
    "  @Get('health')\n  health(): { ok: true } {\n    return { ok: true };\n  }\n\n  @Get('search')",
  ));
  simulateTurnEnd(root, ["server/src/nest/airports/airports.controller.ts"]);

  turn("model reverts it");
  writeFileSync(c, orig);
  simulateTurnEnd(root, ["server/src/nest/airports/airports.controller.ts"]);
};

rmSync(SIM, { recursive: true, force: true });
const t0 = Date.now();
try {
  scenarioMochi();
  scenarioQuickbeam();
  scenarioOpenmux();
  scenarioNOMAD();
} finally {
  console.log(`\n\x1b[2m(sandboxes kept at ${SIM} · ran in ${((Date.now() - t0) / 1000).toFixed(1)}s)\x1b[0m`);
}
