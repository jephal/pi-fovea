// Per-repo, per-conversation state. The disclosed set makes every answer a
// delta (nodes already shown are excluded), and the cached Chebyshev vectors
// make dwell nearly free: a new diffusion time recombines the cached T_k(M)s
// vectors instead of re-walking the graph.

export interface FoveaSession {
  root: string;
  t: number;
  seeds: number[];
  seedNote: string;
  disclosed: Set<string>;
  tk: Float64Array[];
  tkKey: string;
}

const T0 = 2;
export const TK_ORDER = 80; // covers dwell up to t ~ 33 with full accuracy

const sessions = new Map<string, FoveaSession>();

export const getSession = (root: string): FoveaSession => {
  const hit = sessions.get(root);
  if (hit) return hit;
  const s: FoveaSession = {
    root,
    t: T0,
    seeds: [],
    seedNote: "",
    disclosed: new Set<string>(),
    tk: [],
    tkKey: "",
  };
  sessions.set(root, s);
  return s;
};

// `/new` and friends: same repo, fresh eyes.
export const resetSessions = (): void => {
  for (const s of sessions.values()) {
    s.t = T0;
    s.seeds = [];
    s.seedNote = "";
    s.disclosed.clear();
    s.tk = [];
    s.tkKey = "";
  }
};
