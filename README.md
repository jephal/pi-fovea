# pi-fovea

**Token-budgeted repo mapping for agent sessions — foveated heat diffusion over a cross-language code graph.**

Sharp where you look, whole-picture-but-cheap in the periphery. A pi extension that turns a repository into a field you can survey, focus, and deepen — instead of a list of files you grep.

## The idea

The repo is extracted into a typed graph (symbols, files, route anchors) whose edges carry *conductance*: imports are weak bridges, calls solid, and shared literals — route paths, env keys — are the cross-language bridges, weighted by specificity (a path seen in 2 files conducts well; seen in 30 it's noise). Your interest is a heat source `s`; the map you receive is the heat equation run for time `t` over the graph Laplacian:

```
v(t) = e^{−tL} · s
```

- **sketch** — large `t`, hub+anchor seeds: a blurry but valid silhouette of the whole repo (feature anchors and directory regions ranked by mass).
- **focus** — point the fovea at a symbol, route path, env key, or file. Hot nodes render with full signatures, warm nodes as one-liners, the periphery collapses to per-file counts.
- **dwell** — let the current field diffuse longer (`t` grows ×2 per call) and receive **only the newly-luminous nodes**. Every answer is a delta: already-shown nodes stay suppressed, and the cached Chebyshev vectors make a new `t` nearly free (coefficient recombination, no re-walk).
- **impact** — seed from changed files (uncommitted by default) and read what warms up: the predicted review/co-change cascade, across languages, ordered by warmth.

Budget conformance is a monotonic prefix fit — the renderer binary-searches the candidate prefix until the text fits `maxTokens`, so the token spend is never exceeded.

Lineage: spectral graph wavelets (heat kernel as multi-scale structure, evaluated by shared Chebyshev recurrence), progressive image coding (budget as bitrate over significance-thresholded coefficients), foveated rendering. Personalization-PageRank repo maps (aider) are the fixed-timescale special case.

## Requirements

- [`pi`](https://github.com/earendil-works/pi-coding-agent)
- `ast-grep` on PATH (or set `FOVEA_AST_GREP=/path/to/sg`)

## Install

```sh
pi install /path/to/pi-fovea          # local path
# or once published:
pi install npm:pi-fovea
```

Then, in any repo session: `/fovea-status` shows graph stats; the model gets the four `fovea_*` tools.

### CLI

The same ops as a shell command (stateless, pipe-friendly):

```sh
pnpm fovea sketch /path/to/repo 900
pnpm fovea focus /path/to/repo "/v1/messages" 800
pnpm fovea impact /path/to/repo --base main 1200
```

### Repo rule packs

Drop `.fovea/rules.json` in a repo to extend route/anchor detection beyond the built-ins (express/orval-style chains, NestJS decorators, Flask/FastAPI decorators, Go chi/mux, axum):

```json
{ "rules": [{ "id": "fiber", "langs": ["Go"], "pattern": "$R.$M(\"$P\", $$H)", "methods": "^(get|post)$", "kind": "route" }] }
```

Changing the rules file invalidates only the anchor extraction cache.

Supported today: TypeScript/JavaScript/Python/Go/Rust with full symbol+call extraction; Elixir, Ruby, C, C++, Java, Kotlin, Lua, PHP, Swift, Scala, Haskell, Bash via outline-based symbols with heuristic naming. Config files (YAML/JSON/TOML/env/Markdown/OpenAPI specs) join through literals.

## How the agent uses it

```
fovea_sketch  { }                                    # silhouette, ~1.4k tok
fovea_focus   { "query": "/api/users/{id}" }         # route → handler+client+spec
fovea_dwell   { }                                    # deepen: t 2→4, deltas only
fovea_impact  { "files": ["server/users.go"] }       # what this edit touches
fovea_impact  { "base": "main" }                        # PR cascade (git diff main…HEAD)
```

Cursor lines tell the model what remains (`… 37 lit below threshold — call fovea_dwell`), so progressive disclosure is tool-driven, not one-shot.

## Feature hubs and basins

Route declarations and every client call of the same normalized path collapse to ONE feature node — `POST /auth/login` in an express router and in axios clients are occurrences of the same thing, and the anchor hub is where they meet. Where no routes exist at all (CLIs, libraries, kernels), `sketch` infers **basins**: greedy conductance-cut regions around triangle-dense seeds — implicit features that hold together under diffusion.

## How the graph is joined

- imports, outline contains/inherits, tests, call edges (specificity-tiered; language builtins and log/test entry points are warded off)
- literal joins across languages (route paths, env keys, distinguishing strings) — document-frequency-gated cliques so rare literals bridge strongly and ubiquitous ones don't become gravity wells; `focus` can still seed from any literal
- co-change edges mined from recent git history (Jaccard-tilted, per-file capped, cached by HEAD) — files that commute together warm each other even without a static edge

## Development

```sh
pnpm install
pnpm run check        # typecheck + full test suite
pnpm run bench        # rate–distortion bench against ../pi-fabric
```

The extension is loaded by pi via jiti straight from `src/` — there is no build step. Tests (`vitest`) cover the diffusion core against an independent scaled-Taylor reference, the extractors against a cross-language fixture monorepo, budget conformance, and the session delta contract.

Cache: per-repo content-hash cache in `$TMPDIR` (sha1 per file; only dirty files re-run ast-grep). Bump `CACHE_VERSION` in `src/core/build.ts` when extractor semantics change.

MIT.
