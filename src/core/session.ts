// Per-repo, per-conversation state. Disclosure belongs to one focus key:
// repeated focus preserves its seed/direct nucleus and suppresses seen
// periphery, while a new seed/scope resets to sharp context. Cached Chebyshev
// vectors keep dwell cheap across wider timescales within that focus.

import { ROOT_CACHE_LIMIT } from "./asyncutil.js";
import type { NodeKind } from "./types.js";

interface FocusScope {
  path?: string;
  language?: string;
  kind?: NodeKind;
}

export interface FoveaSession {
  root: string;
  t: number;
  seeds: number[];
  seedNote: string;
  focusKey: string;
  scope: FocusScope;
  disclosed: Set<string>;
  tk: Float64Array[];
  tkKey: string;
}

export const FOCUS_T0 = 2;
export const TK_ORDER = 80; // covers dwell up to t ~ 33 with full accuracy

const sessions = new Map<string, FoveaSession>();

export const getSession = (root: string): FoveaSession => {
  const hit = sessions.get(root);
  if (hit) {
    sessions.delete(root);
    sessions.set(root, hit);
    return hit;
  }
  const s: FoveaSession = {
    root,
    t: FOCUS_T0,
    seeds: [],
    seedNote: "",
    focusKey: "",
    scope: {},
    disclosed: new Set<string>(),
    tk: [],
    tkKey: "",
  };
  sessions.set(root, s);
  while (sessions.size > ROOT_CACHE_LIMIT) sessions.delete(sessions.keys().next().value!);
  return s;
};

// `/new` and friends: same repo, fresh eyes.
export const resetSessions = (): void => {
  // A fresh conversation cannot reuse disclosure or Chebyshev vectors; drop
  // the entries outright so large Float64Array stacks become collectible.
  sessions.clear();
};
