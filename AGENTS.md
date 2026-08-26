# AGENTS.md

## Golden rule: check when done

```sh
pnpm run check
```

Runs typecheck + the full vitest suite + `lint:dead` (knip gate for unused
files/exports, mirroring ../pi-fabric). There is **no build step**: pi loads
the extension from `src/` via jiti, so a green check means the change is live.

## Cache invalidation

Three durable cache layers exist: private per-worktree SQLite snapshots under
`$FOVEA_CACHE_DIR/pi-fovea/worktrees` (or XDG/`~/.cache`), compatibility
per-file JSONL facts (`$TMPDIR/pi-fovea-*.json`, keyed by content sha1 +
`CACHE_VERSION` + rules hash), and co-change pairs
(`$TMPDIR/pi-fovea-cochange-*.json`, keyed by HEAD + tracked-file set).

SQLite lifecycle cleanup lives in `src/core/cache-lifecycle.ts`: it is
throttled, protects active leases and WAL/SHM sidecars, and treats bad identity
metadata as keep-not-delete. Preserve those properties when changing it. Test
both dry-run and mutation paths. `FOVEA_NO_CACHE` disables every durable layer;
`FOVEA_CACHE_DIR` is a cache *home*, never a repo-relative output path.

Facts (symbols/imports/calls/literals per file) are content-hash cached. If you
change *extractor semantics* (what a parser emits for unchanged file content),
bump `CACHE_VERSION` in `src/core/build.ts` or stale test facts linger.

## Conventions

- Vitest covers: diffusion core vs an independent scaled-Taylor reference
  (never compare Chebyshev to raw Taylor at large t — catastrophic
  cancellation; that's why the reference scales-and-squares), extractors and
  joins on `tests/fixtures/mini` (cross-language monorepo: Go server + TS
  client + OpenAPI + Python worker), budget conformance, delta contract.
- Budget assertions use `tokens <= B` exactly; the renderer's prefix-fit loop
  must stay monotonic in the candidate prefix.
- Conventional commits: `feat(scope): ...`, `fix(scope): ...`.
- Keep runtime deps at `typebox` only (pi provides it at extension load);
  heavy deps belong in devDependencies.
- Overflow artifacts must remain private (`0700` parent, `0600` file,
  no-follow writes) and model-facing render text must retain defense-in-depth
  secret redaction. Sensitive filenames are still excluded at extraction.
- The published `fovea` bin is a bundle: `prepack` → `pnpm run build:cli`
  (esbuild → `dist/cli.mjs`), so `npm i -g pi-fovea` needs neither tsx nor
  runtime deps. `check` never touches `dist/` — dev stays buildless. Release
  validation also runs `npm pack --dry-run` (pnpm does not expose that flag)
  and probes `dist/cli.mjs` directly.
