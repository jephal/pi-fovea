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
| `cochange` git commute | see below |

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
| sketch | anchors ∪ basins (cap 64) | $16$ |
| focus | resolved symbols / literal sites | $2$ |
| dwell | same source re-seeded | $\times 2$ each call |
| impact | changed files | $4$ |

The renderer then reads the field $v(t)$ and normalizes by the peak $v_{\max}$. A node above $0.3 v_{\max}$ prints its full signature; a node above $0.02 v_{\max}$ prints as a one-liner; the remainder collapses to per-file glow counts. Typed one-hop neighbors of the focus are presented before anonymous thermal periphery, and unrelated warm nodes are capped per file so a large class cannot consume the view. A binary search over the resulting fixed candidate order still produces a monotonic prefix that never passes the $budget$ in tokens.

`dwell` carries a `disclosed` set across the session, so repeat calls return the delta alone.

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

## Co-change

File-to-file conductance from recent git history adds a channel the parser never sees. Files $a$ and $b$ that commute together earn an edge weight from a Jaccard-tilted coincidence count, capped per file and cached by HEAD until the working tree drifts.

## Basins

Where a repo has no anchors, the silhouette uses inferred features instead. Seeds are nodes with conductance and local triangle density $\tau$ above thresholds; a seed's score is

$$
\mathrm{score}(i) = c_i \left(0.25 + 0.75 \tau_i\right) + 0.02 \deg_i
$$

with $c_i$ the conductance. Regions grow by greedily absorbing the boundary node with the highest ratio

$$
\frac{\sum_{j \text{ in basin}} W_{ij}}{\sum_{j \in V} W_{ij}}
$$

of its incident weight, with a cut-domination stop rule. The result is a handful of cohesive clusters, capped at $12$ basins of up to $64$ nodes. Anchors outrank basins when both exist: anchors declare intent, basins infer it.

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
