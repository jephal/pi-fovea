# Heat diffusion and the design behind it

This document walks the full machinery: the graph that gets built, the kernel that diffuses over it, the rendering tier map, and the statistical layer that discovers routes in unfamiliar workspaces. Implementation references point at `src/core/`.

## The graph

The repo compiles to one typed undirected graph $G = (V, E)$ with files, symbols, and anchors as nodes. Every edge carries a conductance $W_{ij} > 0$. Edge kinds and weights:

| Edge kind | Weight |
|---|:--|
| `contains` file → symbol | $1$ |
| `inherits` class → parent | $0.9$ |
| `tests` test file → subject | $0.6$ |
| `invokes` caller → callee | see below |
| `imports` file → file | $0.3$ |
| `anchors` anchor hub → handler | $c / \sqrt{S}$
| `anchors` hub → member file | $0.35 / \sqrt{|F|}$ |
| `join` literal bridge | see below |

Call edges are specificity-tiered so a call to a rare symbol beats one to a common symbol. Language builtins and log/test entry points are warded off: a `console.log` call connects nothing. The anchor hub weight decays with the number of sites $S$ bound to it, so a multi-site route does not become a gravity well. The file-member weight decays with $|F|$, the file count of the feature hood.

Anchor labels are normalized so that one route shows up once: every placeholder syntax (`{id}`, `:id`, `${id}`, `$code`) becomes `{*}` before hub assignment. Ktor's `${code}` shorthand and the Rails `:id` form therefore land in one cluster.

## The heat kernel

Build the symmetric normalized Laplacian

$$
L = I - D^{-1/2} W D^{-1/2}
$$

where $W$ is the max-conductance adjacency and $D$ the diagonal degree matrix with $D_{ii} = \sum_j W_{ij}$. The spectrum of $L$ sits in $[0,2]$. For an interest vector $s \in \mathbb{R}^{|V|}$ and diffusion time $t$:

$$
v(t) = e^{-tL} \cdot s
$$

Heat in $v(t)$ answers "near to $s$ along low-resistance paths." Small $t$ keeps heat near the seeds; large $t$ lets it follow the whole skeleton.

Evaluation uses a Chebyshev expansion. Let $M = L - I$ so eigenvalues live in $[-1,1]$, and let $T_k$ be the Chebyshev polynomials. Then

$$
e^{-tL} = e^{-t} \left[ I_0(t) T_0(M) + 2 \sum_{k=1}^{\infty} (-1)^k I_k(t) T_k(M) \right]
$$

with $I_k$ the modified Bessel function. The vectors $T_k(M) s$ follow the recurrence

$$
T_0(M)s = s, \qquad T_k(M)s = 2 M \left(T_{k-1}(M)s\right) - T_{k-2}(M)s \quad (k \ge 2)
$$

and are cached per session. A new timescale recombines coefficients for $O(K \cdot n)$ work instead of a second walk; the order $K$ grows with $\lceil 2.2 t \rceil + 16$, capped at 90. Measured error against a scaling-and-squaring Taylor reference lands at $\sim 6 \times 10^{-9}$.

No Jackson damping window is applied. The SGWT wavelet frame applies windows because its compactly supported bumps ring at the support edge; $e^{-t(1+\mu)}$ is smooth on $[-1,1]$ and truncation decays superalgebraically. A Jackson window here reduces pointwise accuracy. `src/core/heat.ts` carries the check.

## The four tools

All four tools call the same kernel at different timescales with different seeds:

| Tool | Seeds | $t$ |
|---|---|:--:|
| sketch | production anchors ∪ production regions (cap 64) | $16$ |
| focus | resolved symbols / literal sites | $2$ |
| dwell | same source re-seeded | $\times 2$ each call |
| impact | changed files | $4$ |

The renderer reads $v(t)$ and normalizes by $v_{\max}$. A node above $0.3 v_{\max}$ prints its signature; a node above $0.02 v_{\max}$ prints as a one-liner; the remainder collapses to per-file counts. Typed one-hop neighbors lead anonymous thermal periphery, unrelated warm nodes are capped per file, and sketch applies a presentation-only demotion to test/fixture scopes. The graph and heat field remain unchanged. A binary search over the fixed candidate order still produces a monotonic prefix that never exceeds the token budget.

Disclosure is scoped to the current seed set. Repeated focus keeps the seed/direct nucleus visible and suppresses seen periphery; dwell returns newly relevant neighbors. Changing focus resets to $t=2$ and clears that disclosure scope. `fresh` does the same explicitly for reproducibility.

## Literal bridges

Strong cross-language coupling exists wherever a string literal repeats: route paths, env names, long identifiers. Each literal class carries a base weight

$$
B = \begin{cases} 1.0 & \text{path} \\ 0.8 & \text{env} \\ 0.55 & \text{word} \end{cases}
$$

A literal occurring in $\mathrm{df}$ files earns specificity

$$
\mathrm{spec} = \min \left( 1, \frac{\log \left(\mathrm{total} / \max(\mathrm{df}, 1)\right)}{\max_{\ell'} \log \left(\mathrm{total} / \mathrm{df}_{\ell'}\right)} \right)
$$

Bridge edges form a clique over the files carrying that literal. The clique only builds when $2 \le \mathrm{df} \le 48$. Inside the band each edge weighs

$$
w = \frac{B \cdot (0.25 + 0.75 \cdot \mathrm{spec})}{\max(1, \mathrm{df} / 6)}
$$

The denominator stops a popular literal from turning into an uncapped hub. Repetition inside one file also cannot inflate $\mathrm{df}$, or a lockfile would dominate every bridge.

## Co-change history is heat, not structure

Joint git history is the *software development over time* signal — the affinity diffusion cannot see by construction. Files $a$ and $b$ that keep moving together in the same commits carry a history bond the parser never encodes. Under the all-in heat model that bond is a **seeded field**, not a permanent graph edge:

- `cochange.ts` mines the last 400 commits, records each pair's joint-commit count and the committer time of its **most recent** joint commit, and caches those raw facts by HEAD + tracked-file set. The static graph carries **no** co-change edge: focus and sketch read the operator and stay pure structure.
- When `impact` seeds a change, it re-seeds the change site's history partners into the *same* diffusion at

  $$w = w_0(\text{count}, \text{jaccard}) \cdot 2^{-\text{ageDays} / \tau}, \qquad \tau = 30 \text{ days}$$

  where $w_0$ is the old Jaccard-tilted base conductance and age is wall-clock since the pair last co-committed, $(\text{age} = \max(0, \text{now} - \text{lastTs}))$.
- Linearity is what makes this heat: seeding partner files at weight $w$ and diffusing once is exactly $e^{-tL}(s_{\text{change}} + w \, s_{\text{partner}})$. Fresh joint work is hot; a pair that last moved months ago contributes almost nothing; a session that goes idle cools the affinity like every other heat source. Even a cached hit cools, because recency is applied at **use** time, not baked into the cache.
- Partner files surface with the `co-change history` reason, so turn-sync still weighs them at $c_v = 0.5$ — unchanged — and the per-node sync ledger $\mu$ governs how often that channel can refire (see Turn sync below).

`FOVEA_COCHANGE_HALF_LIFE_DAYS` (default 30) sets the wall-clock half-life.

## Inferred regions (basins)

Where a repo has no anchors, the silhouette uses inferred features instead. Seeds are nodes with conductance and local triangle density $\tau$ above thresholds; a seed's score is

$$
\mathrm{score}(i) = c_i \left(0.25 + 0.75 \tau_i\right) + 0.02 \deg_i
$$

with $c_i$ the conductance. Regions grow by greedily absorbing the boundary node with the highest ratio

$$
\frac{\sum_{j \text{ in basin}} W_{ij}}{\sum_{j \in V} W_{ij}}
$$

of its incident weight, with a cut-domination stop rule. The result is a handful of cohesive clusters, capped at $12$ regions of up to $64$ nodes. Production anchors outrank inferred regions when both exist; test and fixture anchors stay in the graph but collapse in the opening sketch.

## Discovery mode

Unknown route DSLs are the main coverage gap in a static pack. Discovery repairs it with three moves.

**Harvest.** During the literal pass, every call site contributes a signature $(\mathrm{lang}, \mathrm{shape}, \mathrm{callee}, \mathrm{argIdx})$. The shape is one of receiver-less, method-call, decorator, or bare-call, and $\mathrm{argIdx}$ is the zero-based position of the first string literal argument. Because harvesting runs inside the same pass, scanning a file once is enough.

**Promotion.** For each signature we estimate how often argument $\mathrm{argIdx}$ carries a route path. The Jeffreys posterior over the binomial rate is

$$
\hat{p} = \frac{\mathrm{pathN} + \frac{1}{2}}{\mathrm{n} + 1}
$$

and a shape promotes into a synthesized ast-grep rule when $\hat{p} \ge 0.55$, $\mathrm{n} \ge 4$, and its sites cover at least two files. The pack-coverage filter blocks shapes the static pack already knows. Empirical calibration across nine cloned projects puts corpus junk below $\hat{p} \approx 0.27$ and real route shapes above $\hat{p} \approx 0.75$, so the line sits mid-cliff regardless of repo size.

**Half gravity.** Promoted rules are wired in as implicit hubs. Their anchor edges weigh

$$
w = \frac{0.5}{\sqrt{S}}
$$

versus $1/\sqrt{S}$ for declared routes, where $S$ is the number of sites bound to the hub. Swap rates are symmetric constants that do not depend on the corpus. Turn sync reports churn on discovered hubs (a `△` in the anchors report) with no red escalation, and the moment any site matches a first-class rule the hub graduates.

## Turn sync: surfacing only surprise

The same impact cascade that answers `fovea_impact` also drives turn sync, which runs before agent start and after every assistant turn and decides whether repository drift justifies spending model tokens (`src/core/sync.ts`). The verdict is per graph node: every node $v$ warmed above $10^{-6}$ carries its field mass $m_v$ and the first-encounter channel reasons of its warm path (1-hop edge kinds, BFS paths for deeper nodes, a `co-change history` stamp for history-seeded clusters). Warmth aggregation by file only exists for display; the memory and surprise arithmetic run at node granularity.

Each sync keeps a ledger $\mu$ of charged node masses, keyed by stable node identity `kind|name@file` — hunk-level, so line moves are free and renames simply orphan entries. The evidence channel enters as a prior $c_v$, the strongest reason on that node's path:

| Channel | $c_v$ |
|---|:--:|
| call / import / test / inheritance / shared route | $1$ |
| co-change history | $0.5$ |
| multi-hop graph path | $0.5$ |
| shared literal | $0.35$ |

Surprise is the channel-adjusted mass above the ledger, summed over nodes and grouped back to files for the message:

$$
s_v = \max\!(0,\; c_v \, m_v - \mu_v), \qquad S = \textstyle\sum_v s_v
$$

A sync goes red on structural events (route added or removed **with carrier-file drift evidence**, production file deleted, all subject to the degraded-extraction distrust) or when warmth alone crosses the steer threshold, $S \ge \theta$ with $\theta = 0.15$ by default (`sync.steerThreshold`). Masses are dimensionless: seeding is one heat unit per changed file node, so $S$ reads as "units of evidence-weighted heat landing outside the change that were not already disclosed." Calibration on `tests/fixtures/mini`: a central semantic edit totals $\approx 0.115$ node-adjusted, one strong call/import neighbor on a 350-node repo $\approx 0.19$, a pair of weak literal/co-change warm-ups $\approx 0.01\!-\!0.03$.

Four dynamics fall out of $\mu$:

- **Absorb on disclosure.** Any red sync charges $\mu_v \leftarrow \max(\mu_v, c_v m_v)$ for every warmed node, displayed or not. The disclosed cascade is then *structurally unable to re-fire*: re-editing the same spot re-seeds the same node keys, all charged, and in-session decay is negligible — flip-flopped work stays silent on every revisit indefinitely. The ping-pong dies by construct, not by rate limiting.
- **Wall-clock decay.** Entries age as $\mu_v \leftarrow \mu_v \cdot 2^{-\Delta t / \tau_h}$ with $\tau_h = 48\,$h (`FOVEA_MEMORY_HALF_LIFE_HOURS`), not per sync count. A structurally re-heated neighborhood can earn a fresh verdict on a later day; renamed-symbol orphans cool out on the same schedule. The ledger is bounded (4096 nodes, weakest-mass eviction) and the impact payload tail-capped (2000 nodes).
- **No blanket.** Charged keys suppress only themselves: a novel hunk in a charged cluster (a fresh literal, a stronger coupling) keeps its own surprise and can cross $\theta$ even while the rest stays damped. Quiet verdicts charge nothing, so a trickle of sub-threshold warmth cannot habituate the gate.
- **Hysteresis.** A fire disarms the warmth latch; it re-arms only once $S \le \theta/2$. Cascades hovering near the threshold cannot oscillate.

Anchor deltas obey carrier evidence: a route add/remove escalates and renders only when its carrier file drifted. Content-identical carriers keep content-identical anchors by construction, so carrier-less deltas are extraction artifacts (parallel-load sweeps, extractor-version re-derivation) and stay quiet — annotated as `suspectAnchors` in details — while the baseline adopts the new set immediately and the artifact self-heals. Deletions and route changes with real carrier drift bypass the warmth gate entirely.

The rendered list is sorted by surprise descending, test scopes last within a tie, so the top of the message is always the least-expected warmth. A clean structural turn costs one fingerprint diff; a quiet turn costs the same, because the gate only evaluates when the version fingerprint moved. Switching branches re-baselines silently: a `git checkout` re-materializes the worktree without authored drift, so the baseline follows the ref and the ledger does not cross over.
