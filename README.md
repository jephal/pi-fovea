<div align="center">

# 👁️ pi-fovea

**A foveated repo-mapping extension for [Pi](https://github.com/earendil-works/pi-coding-agent)**

_See the whole repo on every prompt, sharp where you work and cheap everywhere else._

<p>
  <img src="https://raw.githubusercontent.com/monotykamary/pi-fovea/main/media/cover.svg" alt="pi-fovea: a code graph seen through a fovea, hot at the center and collapsed at the rim" width="1100">
</p>

[![npm version](https://img.shields.io/npm/v/pi-fovea?style=for-the-badge&logo=npm&color=cb3837)](https://www.npmjs.com/package/pi-fovea)
[![checks](https://img.shields.io/github/actions/workflow/status/monotykamary/pi-fovea/test.yml?branch=main&style=for-the-badge&label=checks)](https://github.com/monotykamary/pi-fovea/actions/workflows/test.yml)
[![pi extension](https://img.shields.io/badge/pi-extension-8b5cf6?style=for-the-badge)](https://github.com/earendil-works/pi-coding-agent)
[![license](https://img.shields.io/badge/license-MIT-f4c430?style=for-the-badge)](LICENSE)

</div>

pi-fovea hands the model a map of your repo on every prompt. The repo compiles once into a code graph across languages, where symbols, files, and route anchors join into one network. Each question becomes an interest vector that diffuses over the graph as heat. The renderer converts the field into a token-capped view: exact source locations and full signatures near your task, typed one-hop relationships next, and a skeleton of the rest.

At agent start Fovea establishes or checks its semantic baseline, so out-of-band edits made while Pi was idle enter context before the first model call. After each assistant turn it re-syncs again. Detection does not trust tool events: edits made by Pi tools, fabric_exec, bash, subagents, or an editor land identically, while comment- and formatting-only drift stays silent. A meaningful post-turn change is delivered as a **steer**, and Fovea triggers the continuation itself if the agent would otherwise wait.

## When not to reach for fovea

A map costs more than the territory when the territory is small: on repos of a
few dozen files, reading the files directly beats sketching them. Fovea pays
for itself when the working set exceeds context — cross-language monorepos,
unfamiliar long-lived codebases, routes woven through config and client code.
It narrows **what** you read to the suggested windows; it does not replace
reading them, the project's own format/lint/typecheck/test commands, or CI as
the final verification layer.

## What the model gets

| Command | Ask | Answer |
|---|---|---|
| `fovea_sketch` | where is everything? | production-first silhouette; test and fixture architecture stays collapsed |
| `fovea_focus` | what is this? | exact matches, typed relationships, suggested reads, optional source scopes, and deterministic `fresh` views |
| `fovea_dwell` | what else? | widens the current focus and returns newly relevant neighbors |
| `fovea_impact` | what does this touch? | warms everything a file, symbol, or PR base reaches across languages |
| `grep` *(default hybrid)* | graph or text? | bare identifiers, qualified symbols, repo paths, and routes use Fovea; search options and obvious regex retain native grep |

Focus normalizes camelCase and common inflections, so an approximate name such as `switchServer` can resolve `switchingServers`. If a query is still uncertain, Fovea returns nearby symbols with locations instead of a dead miss. Direct graph edges are labeled (caller, callee, route, shared literal, co-change), while unrelated same-file siblings remain collapsed.

The **Hybrid grep** toggle is on by default. `grep({ pattern: "CreateUser" })`, `grep({ pattern: "Controller.create" })`, and route paths can navigate the graph. Calls with text-search options and obvious regexes delegate to Pi's native grep unchanged; a graph miss falls back to native text, and a graph error (for example a broken ast-grep) degrades the same way with a one-line note marking the result as native. Disable the toggle for a purely native slot. Changing it reloads extensions so Pi and pi-fabric capture the same behavior.

### pi-fabric

Captured extension tools live under Fabric's `extensions` provider. Use the direct proxy when the action is known:

```ts
const result = await extensions.fovea_focus({ query: "CreateUserHandler", maxTokens: 2000 });
return result.text;
```

For dynamic discovery, pass an object to `tools.search` and keep the returned namespaced ref:

```ts
const [action] = await tools.search({ query: "fovea_focus", limit: 5 });
if (!action) return "Fovea is not captured";
return tools.call({ ref: action.ref, args: { query: "CreateUserHandler" } });
```

The stable explicit ref is `extensions.fovea_focus`, not bare `fovea_focus` or `fovea.fovea_focus`.

Runtime slash controls:

- `/fovea status` for loaded versions, graph coverage, and active modes
- `/fovea settings` for a TUI configuration overlay
- `/fovea reset` for a fresh focus and sync baseline
- `/fovea reload` to activate updated extension source

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

There is also a package for any agent shell or CI:

```sh
fovea sketch /path/to/repo 900
fovea focus /path/to/repo "/v1/messages" 800
fovea impact /path/to/repo --base main 1200
fovea rules /path/to/repo
fovea status /path/to/repo
```

`fovea` runs `cli.ts` via `tsx`. Install `tsx` globally, or use `pnpm fovea` from a checkout.

## Turn sync

Continuous sync is on by default. Before an agent starts, Fovea establishes its baseline or injects any out-of-band drift before the first model call. After every assistant turn it compares extracted symbols, calls, imports, literals, and anchors again. Content hashes keep the unchanged fast path cheap, while comment- and formatting-only edits do not wake the model.

A meaningful change found before agent start is injected directly into that run. A post-turn route or dependency change is sent with `deliverAs: "steer"`; if the agent would otherwise settle, `triggerTurn` starts the continuation automatically. The compact update names directly changed files, route deltas, newly relevant files, causal channels such as calls, imports, shared literals, tests, or co-change history, and a suggested next focus probe so the update continues graph navigation. Clean turns remain silent unless `sync.ackClean` is enabled.

Runtime controls:

- `/fovea status` — loaded package/ast-grep versions, indexed coverage, anchor scopes, sync and grep modes.
- `/fovea reset` — clear focus disclosure/depth and establish a fresh sync baseline.
- `/fovea reload` — hot-reload extensions and activate newly installed source.
- `/fovea settings` — configure sync, budgets, and hybrid grep.

Turn sync off per repo or globally through settings, or with:

```sh
FOVEA_TURN_SYNC=off pi
```

## Configuration

Global settings live in `~/.pi/agent/fovea.json`. A trusted repo-level override sits in `<repo>/.pi/fovea.json`. Two scopes, the same model pi-fabric uses with `fabric.json`.

| Key | Default | Meaning |
| --- | :-----: | ------- |
| `sync.enabled` | `true` | pre-agent and post-turn continuous sync |
| `sync.budget` | `1024` | token cap for proactive steering context |
| `sync.ackClean` | `false` | toast after clean structural turns |
| `sync.warmFileThreshold` | `2` | newly relevant files that justify proactive model steering |
| `tools.defaultBudget` | `2000` | fallback maxTokens for the fovea_* tools |
| `tools.replaceGrep` | `true` | install hybrid native-text / bare-query graph grep |

## How routes are found

Route anchors come from port shapes, and five shapes cover almost the whole ecosystem:

| Port shape | Examples |
|---|---|
| `recv.verb("path", handlers…)` | express, koa, fastify, hono, gin, echo, chi, net/http |
| annotation + optional class prefix | NestJS `@Controller + @Get`, Flask and FastAPI decorators, Spring `@RequestMapping + @GetMapping` |
| verb embedded in the path | Go 1.22 `mux.HandleFunc("GET /x", h)` |
| verb as first string argument | chi `r.Method("GET", path, h)`, aiohttp `router.add_route("GET", path, h)` |
| receiver-less DSL macros | Rails `routes.rb`, Phoenix `router.ex`, Django `path()`, Ktor `routing { get("/x") {} }` |

File-convention routers declare paths nowhere in code. Next.js App Router, Pages Router, SvelteKit, Nuxt, and Astro anchors therefore derive from file paths, with the verb read off exported handler names or filename suffixes.

### Discovery mode

When a repo writes routes in a shape fovea has never seen, the literal pass harvests every call shape and promotes statistically solid ones into implicit rules. Discovered anchors carry half the conductance of declared ones and appear with a `△` sigil. Turn sync reports their churn without letting an unconfirmed hypothesis turn the verdict red. A hub upgrades to first-class the moment a known rule matches any of its sites.

```sh
fovea anchors <root> --discovered   # the △ hypothesis hubs only
fovea rules <root>                  # promoted rules with evidence
fovea rules <root> --sigs           # every path-touching signature, by precision
fovea rules <root> --adopt          # persist promotions into .fovea/rules.json
```

`.fovea/rules.json` pins community or project rules in the repo:

```json
{
  "rules": [
    { "id": "fiber", "langs": ["Go"], "pattern": "$R.$M(\"$P\", $$H)", "methods": "^(get|post)$", "kind": "route" }
  ]
}
```

A rule may declare `prefixPattern` so a class-level prefix like `@Controller('api/airports')` composes with per-method paths. Changing the rules file invalidates the anchor extraction cache alone; parsed facts above it carry over.

**Blind spots**, logged in `src/core/anchors.ts`: Rust proc-macro attributes (actix `#[get("/x")]`), constructor-assigned prefixes (Flask Blueprint, FastAPI `APIRouter(prefix=…)`, chi `Mount`, Express `Router` mounts), `scope` and `namespace` nesting in Phoenix, Rails, or Django `include()`, and tRPC/GraphQL/gRPC (no path token exists to anchor on).

## How it works

The repo compiles to a typed graph. Your question is a source vector $s$ over its nodes, and the field the model receives is the heat kernel at time $t$ over the Laplacian $L$:

$$
v(t) = e^{-tL} \cdot s \quad \text{with} \quad L = I - D^{-1/2} W D^{-1/2}
$$

The four tools are the same operator at four timescales: sketch at $t=16$ with production hub and anchor seeds, focus at $t=2$ with your query as seed, dwell doubling $t$ within that focus, and impact using changed files as seeds. Changing focus resets to the sharp timescale and its own disclosure scope.

The kernel is evaluated with a Chebyshev expansion. Rescale $M = L - I$ so the spectrum sits in $[-1,1]$; then with $T_k$ the Chebyshev polynomials and $I_k$ the modified Bessel functions:

$$
e^{-tL} = e^{-t} \left[ I_0(t) T_0(M) + 2 \sum_{k\ge 1} (-1)^k I_k(t) T_k(M) \right]
$$

The vectors $T_k(M) s$ are cached in the session. A new timescale costs coefficient recombination, never a second graph walk.

Discovery asks how often the argument at one slot of one call shape carries a route path, and promotes the shape past a Jeffreys-smoothed posterior:

$$
\hat{p} = \frac{\mathrm{pathN} + \frac{1}{2}}{\mathrm{n} + 1} \ge 0.55 \quad \text{with} \quad \mathrm{n} \ge 4 \text{ sites and} \ge 2 \text{ files}
$$

Measured against eight cloned projects, corpus junk sits below $\hat{p} \approx 0.27$ and real route shapes above $\hat{p} \approx 0.75$. The cutoff stays mid-cliff regardless of repo size.

Lineage: spectral-graph wavelets evaluated by shared Chebyshev recurrence, progressive image coding where the budget is a bitrate over significance-ordered coefficients, and foveated rendering. Aider's PageRank repo map is the fixed-timescale special case of this field. The full walkthrough of conductance tiers, specificity bridges, hub gravity, and inferred regions lives in [docs/heat-diffusion.md](docs/heat-diffusion.md).

## Languages

Full symbol and call extraction: **TypeScript, TSX, JavaScript, Python, Go, and Rust**.
Outline-based symbols: **Elixir, Ruby, C, C++, Java, Kotlin, Lua, PHP, Swift, Scala, Haskell, and Bash**.
Config joins through literals: **YAML, JSON, TOML, env, Markdown, and OpenAPI**.

## Development

```sh
pnpm install
pnpm run check        # typecheck + full vitest suite
pnpm run bench        # rate–distortion bench against ../pi-fabric
```

pi loads the extension straight from `src/` via jiti; there is no build step. Per-repo caches live in `$TMPDIR` behind per-file content sha1 hashes, and only dirty files re-run ast-grep. Bump `CACHE_VERSION` in `src/core/build.ts` whenever extractor semantics change.

## Acknowledgments

Thanks to [Alp](https://www.patreon.com/cw/alpderps), the original user whose request for a better LSP extension started this project.

[MIT](LICENSE).
