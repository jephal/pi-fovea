// Per-repo, per-conversation state. Disclosure belongs to one focus key:
// repeated focus preserves its seed/direct nucleus and suppresses seen
// periphery, while a new seed/scope resets to sharp context. Cached Chebyshev
// vectors keep dwell cheap across wider timescales within that focus.

import type { NodeKind } from "./types.js";

export interface FocusScope {
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
  if (hit) return hit;
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
  return s;
};

// `/new` and friends: same repo, fresh eyes.
export const resetSessions = (): void => {
  for (const s of sessions.values()) {
    s.t = FOCUS_T0;
    s.seeds = [];
    s.seedNote = "";
    s.focusKey = "";
    s.scope = {};
    s.disclosed.clear();
    s.tk = [];
    s.tkKey = "";
  }
};
