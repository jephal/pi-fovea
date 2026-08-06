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

pi-fovea hands the model a map of your repo on every prompt. The repo compiles once into a code graph across languages, where symbols, files, and route anchors join into one network. Each question becomes an interest vector that diffuses over the graph as heat. The renderer converts the field into a token-capped view: full signatures near your task, one-liners a hop away, a skeleton of the rest.

After each assistant turn the map re-syncs incrementally. Detection reads content hashes instead of tool events, so edits made by pi's edit/write tools, a fabric_exec inner `pi.edit`, a bash heredoc, a subagent, or an editor save outside the session all land identically. A clean turn stays silent. A turn that moves route anchors or warms files you have not looked at says so.

## What the model gets

| Command | Ask | Answer |
|---|---|---|
| `fovea_sketch` | where is everything? | the repo as a silhouette, with feature anchors and inferred regions ranked by mass |
| `fovea_focus` | what is this? | centered on a symbol, route path, or env key: hot nodes as signatures, neighbors as one-liners |
| `fovea_dwell` | what else? | diffuses the field one step further and returns the delta |
| `fovea_impact` | what does this touch? | warms everything a file, symbol, or PR base reaches across languages |
| `grep` *(default override)* | where does this concept lead? | the same graph-backed focus through grep's familiar `pattern/path/glob/...` signature |

The **Replace grep** toggle makes Fovea own Pi's `grep` tool slot. It is on by default. Familiar calls such as `grep({ pattern: "CreateUser", path: "src" })` navigate the code graph first; use `bash` with `rg` only when you need exact matching lines. Disable the toggle to restore the previous grep implementation. Changing the toggle reloads extensions so pi-fabric captures the same override and `pi.grep(...)` follows it inside `fabric_exec`.

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

Two slash commands on top:

- `/fovea status` for graph stats and sync state
- `/fovea settings` for an overlay in your TUI, styled after pi-fabric's `/fabric settings`

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

Turn sync is on by default. After every assistant turn the graph is re-synced against your edits: unchanged files cost nothing because every parsed fact sits behind its content hash. The verdict is **green** or **red**:

- **green**: silence in the model's context. A clean-toast shows only if you enable `sync.ackClean`.
- **red**: a capped custom message naming route anchors that appeared or disappeared, plus files warmed by the edit cascade that the model has not focused on yet.

The first sync seeds the baseline. The first drift after it calibrates the warm neighborhood, so a steady feature cone stays quiet. Sub sequent drift turns red.

Turn it off per repo or globally: `/fovea settings` → Turn sync, or

```sh
FOVEA_TURN_SYNC=off pi
```

## Configuration

Global settings live in `~/.pi/agent/fovea.json`. A trusted repo-level override sits in `<repo>/.pi/fovea.json`. Two scopes, the same model pi-fabric uses with `fabric.json`.

| Key | Default | Meaning |
| --- | :-----: | ------- |
| `sync.enabled` | `true` | the turn-sync loop |
| `sync.budget` | `1024` | token cap for the red report seen by the model |
| `sync.ackClean` | `false` | toast after clean structural turns |
| `sync.warmFileThreshold` | `2` | warmed files unseen by the model that justify turning red |
| `tools.defaultBudget` | `2000` | fallback maxTokens for the fovea_* tools |
| `tools.replaceGrep` | `true` | replace Pi's grep slot with graph-backed Fovea navigation |

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

The four tools are the same operator at four timescales: sketch at $t=16$ with hub and anchor seeds, focus at $t=4$ with your query as seed, dwell doubling $t$ per call with a disclosed-set delta, and impact using the changed files as seed.

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

Lineage: spectral-graph wavelets evaluated by shared Chebyshev recurrence, progressive image coding where the budget is a bitrate over significance-ordered coefficients, and foveated rendering. Aider's PageRank repo map is the fixed-timescale special case of this field. The full walkthrough of conductance tiers, specificity bridges, hub gravity, and basins lives in [docs/heat-diffusion.md](docs/heat-diffusion.md).

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

[MIT](LICENSE).
