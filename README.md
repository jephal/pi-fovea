<div align="center">

# 👁️ pi-fovea

**A foveated repo-mapping extension for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_Survey, focus, dwell, impact — a budget-capped field of view instead of a folder dump._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fovea/main/media/cover.svg" alt="pi-fovea: a code graph seen through a fovea — hot at the center, collapsed at the rim" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fovea?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fovea)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fovea/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fovea/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

---

Large models have small context. pi-fovea turns a repository into a **heat field** over a cross-language code graph — symbols, files, route anchors — and hands the model exactly `maxTokens` of it at a time, sharp where you look and whole-picture-but-cheap everywhere else. After every edit it silently re-syncs, and only speaks up when the change didn't stay local.

## Why Fovea?

|     | Capability | What it unlocks |
| :-: | ---------- | --------------- |
| 🔭 | **Survey** | `fovea_sketch` renders the whole repo as a low-acuity silhouette — feature anchors and basins by mass, never raw file lists. |
| 🎯 | **Focus** | `fovea_focus` centers on a symbol, route, or env key: hot nodes as signatures, warm nodes as one-liners, periphery collapsed. |
| ⏱️ | **Dwell** | `fovea_dwell` diffuses longer and returns only the delta. Chebyshev vectors are cached — a new timescale is coefficient recombination, not a re-walk. |
| 🌡️ | **Impact** | `fovea_impact` predicts the co-change cascade across languages — what a file, symbol, or PR base warms up. |
| 🩸 | **Turn sync** | After every edit turn the graph re-syncs for free. Anchor shifts and unwatched warmings surface as red flags; stable turns stay silent. |
| 🪙 | **Token truth** | Budgets are hard caps, not hopes: the renderer fits a monotonic prefix and never exceeds `maxTokens`. |

## How it works

The repo compiles to a typed graph whose edges carry **conductance**: imports are bridges, calls are solid, and shared literals — route paths, env keys — are the cross-language welds, weighted by specificity. Your interest is a heat source `s`; the map the model receives is the heat kernel run for time `t` over the graph Laplacian:

```text
v(t) = e^{−tL} · s
```

- **sketch** — large `t`, hub + anchor seeds: the whole repo in one blurry-but-valid silhouette.
- **focus** — small `t`, your query as the seed: the fovea on exactly that feature.
- **dwell** — `t` ×2 per call; only newly-luminous nodes are returned.
- **impact** — changed files as the seed; warmth = predicted blast radius.

Lineage: spectral-graph heat kernels (SGWT evaluated by shared Chebyshev recurrence), progressive image coding (budget as bitrate over significance-sorted coefficients), foveated rendering. Nanobridge: aider's PageRank repo map is the fixed-timescale special case.

## Install

Requires Node.js 20+ and [ast-grep](https://ast-grep.github.io/) on PATH (`brew install ast-grep`, `npm i -g @ast-grep/cli`, or set `FOVEA_AST_GREP=/path/to/sg`).

```sh
pi install npm:pi-fovea
```

<details>
<summary>Other install methods</summary>

From GitHub:

```sh
pi install git:github.com/monotykamary/pi-fovea
```

From a local checkout:

```sh
pnpm install
pi install /absolute/path/to/pi-fovea
```

</details>

Then, in any repo session, the model gets the four `fovea_*` tools; you get:

- `/fovea status` — graph stats, sync on/off
- `/fovea settings` — an overlay built from the same SettingsList idiom as pi-fabric's `/fabric settings`

### CLI

The same ops, stateless and pipe-friendly — for agent shells, CI, and `llmc`-style uses:

```sh
fovea sketch /path/to/repo 900
fovea focus /path/to/repo "/v1/messages" 800
fovea impact /path/to/repo --base main 1200
fovea status /path/to/repo
```

(`fovea` bins to `cli.ts` via `tsx`; install `tsx` globally or use `pnpm fovea` from a checkout.)

## Turn-sync (default on)

After every assistant turn, fovea re-syncs the graph — guaranteed incremental by content hash — no edits means zero work. The verdict:

- **green** → silent in the model's context (a UI toast only if `sync.ackClean` is on).
- **red** → a capped custom message: route anchors that appeared/disappeared, plus files the edit cascade warmed that the model hasn't focused yet.

The first sync establishes the baseline; the first drift after it calibrates the warm neighborhood rather than alarming, so a steady feature cone doesn't page the model every edit.

Opt out per-repo or globally: `/fovea settings` → "Turn sync → false", or

```sh
FOVEA_TURN_SYNC=off pi
```

## Configuration

Global `~/.pi/agent/fovea.json`; project override `<repo>/.pi/fovea.json` when trusted — the same two-scope model as pi-fabric's `fabric.json`.

| Key | Default | Meaning |
| --- | :-----: | ------- |
| `sync.enabled` | `true` | the turn-sync loop |
| `sync.budget` | `1024` | tokens for the red model-visible report |
| `sync.ackClean` | `false` | toast on clean structural turns (no model tokens either way) |
| `sync.warmFileThreshold` | `2` | newly-warm undisclosed files that justify red |
| `tools.defaultBudget` | `2000` | fallback maxTokens for fovea_* tool calls |

## Repo rule packs

The built-in pack catches route declarations by **port shape**, not framework name — five shapes cover almost the whole ecosystem:

| Port shape | Examples |
|---|---|
| `recv.verb("path", handlers…)` | express, koa, fastify, hono, gin, echo, chi, net/http (any quotes, incl. TS template literals and Python f-strings) |
| verb-annotation + optional class prefix | NestJS `@Controller + @Get`, Flask/FastAPI decorators, Spring `@RequestMapping + @GetMapping` |
| verb embedded in the path | Go 1.22 `mux.HandleFunc("GET /x", h)` |
| verb as first string argument | chi `r.Method("GET", path, h)`, aiohttp `router.add_route("GET", path, h)` |
| receiver-less DSL macros | Rails `routes.rb`, Phoenix `router.ex`, Django `path()`, Ktor `routing { get("/x") {} }` |

File-convention routers never write a route string at all — those anchors are derived from **file paths** (Next.js App Router `app/**/route.ts` + `page.tsx`, Pages Router `pages/api/**`, SvelteKit `+server.ts` / `+page.svelte`, Nuxt `server/api/**.get.ts`, Astro endpoints), with verbs pulled from exported handler names or file-name suffixes.

**Known blind spots** (deliberate, logged in `src/core/anchors.ts`): Rust proc-macro attribute routers (actix `#[get("/x")]`, rocket) — ast-grep patterns can't parameterize attribute paths; frameworks with constructor-assigned prefixes (Flask Blueprint, FastAPI `APIRouter(prefix=…)`, chi `Mount`, Express `Router` mounts) — variable binding tracking is out of band; `scope`/`namespace` nesting in Phoenix/Rails/Django `include()` — prefixes across blocks aren't composed; tRPC/GraphQL/gRPC — no path token exists to anchor on.

Drop `.fovea/rules.json` in a repo to extend anchor detection beyond the built-ins:

```json
{
  "rules": [
    { "id": "fiber", "langs": ["Go"], "pattern": "$R.$M(\"$P\", $$H)", "methods": "^(get|post)$", "kind": "route" }
  ]
}
```

Changing the rules file invalidates **only** the anchor extraction cache — green-node reuse one level up.

A rule may additionally declare `prefixPattern` (e.g. NestJS `@Controller('api/airports')`) so per-method paths like `@Get('search')` compose into the full router-visible anchor `GET /api/airports/search` — see `ts-http-decorator*` in `src/core/anchors.ts`.

## How the graph is joined

- **imports / contains / inherits / tests** — outline-derived; call edges specificity-tiered, with language builtins and log/test entry points warded off
- **literal joins** — route paths, env keys, OpenAPI operation paths; document-frequency-gated cliques so rare literals bridge strongly and ubiquitous ones don't become gravity wells
- **co-change** — mined from recent git history (Jaccard-tilted, per-file capped, cached by HEAD), so files that commute together warm each other even without a static edge
- **feature hubs** — route declarations and every client call of the same normalized path collapse to ONE anchor node: where client, server, and spec meet
- **basins** — where there are no routes at all (CLIs, kernels), sketch infers implicit features as conductance-cut regions around triangle-dense seeds

## Language matrix

Full symbol + call extraction: **TypeScript/TSX · JavaScript · Python · Go · Rust**.
Outline-based symbols with heuristic naming: **Elixir · Ruby · C · C++ · Java · Kotlin · Lua · PHP · Swift · Scala · Haskell · Bash**.
Config joins through literals: **YAML · JSON · TOML · env · Markdown · OpenAPI**.

## Development

```sh
pnpm install
pnpm run check        # typecheck + full vitest suite
pnpm run bench        # rate–distortion bench against ../pi-fabric
```

pi loads the extension straight from `src/` via jiti — **there is no build step**. Per-repo caches live in `$TMPDIR` (content sha1 per file; only dirty files re-run ast-grep). Bump `CACHE_VERSION` in `src/core/build.ts` when extractor semantics change.

[MIT](LICENSE).
