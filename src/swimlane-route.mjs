// swimlane-route.mjs — edge routing for the swimlane renderer (layered channel routing).
//
// Card positions are fixed. Every edge runs from its lower card up to its upper card, with one
// horizontal per channel it crosses, and passes intermediate lanes through gaps between cards.
// Inside one channel this is VLSI channel routing, solved the way ELK Layered does it (Sander,
// "Layout of directed hypergraphs with orthogonal hyperedges", GD 2003):
//   ports     → each edge owns one port per card side, never shared ink. Ports are ordered by
//               where the edge goes (so siblings nest instead of crossing), spread across the
//               side and at least PITCH apart; an edge whose cards overlap keeps a straight drop
//   corridors → a lane-skipping edge picks a gap between cards in every lane it passes: dynamic
//               programming over the lanes against the current ports, then rip-up and reroute
//               re-scores its best few chains of gaps on the fully routed channels
//   rows      → every pair of overlapping horizontals gets a "who sits higher" dependency
//               weighted by the crossings the other order would cost; cycles are broken greedily
//               (Eades–Lin–Smyth) and nets are packed into rows in that order, PITCH apart
//   pills     → a labeled edge's row in the channel nearest its child is as tall as its pill, the
//               row order keeps verticals off the pill, and the pill slides along its horizontal
//               away from any vertical that still crosses it
// Why this beat a generic orthogonal router (libavoid) is measured in docs/ROUTING.md.
//
// Two phases, because channel heights decide where the lanes sit and routes need final ys:
//   planRoutes → classify edges, plan every x and row, report each channel's height
//   realize    → given the stacked geometry, place label pills and emit one polyline per edge
// Channel g is the horizontal strip below lane g (g = -1 is the strip above lane 0).

import { textWidth, wrapText } from "./text.mjs";
import { projectPositions, corridorsOf, pickCorridorX } from "./layout.mjs";

const PILL_FS = 10.5;
const PITCH = 10;      // minimum distance between two parallel lines of different edges
const PORT_INSET = 12; // ports keep clear of a card's rounded corners
const ROW_PAD = 6;     // channel padding above the first row and below the last
const CRITICAL = 1000; // dependency weight of an order that would make two verticals collinear
const PILL_HIT = 4;    // dependency weight of a vertical that would run through a label pill
const STRAIGHT_WEIGHT = 50; // a port that keeps its edge straight yields this much less to its neighbours
const GAP_CROSS = 3, GAP_BEND = 1, GAP_LEN = 0.002; // corridor search: cost of a crossing, a bend, a px of travel
const GAP_ROUNDS = 2;       // corridor search rounds, the ports re-aim after each
const GAP_ALTERNATIVES = 6; // chains of gaps per lane-skipping edge that rip-up and reroute re-scores

const stateRank = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3, alt: 1, signal: 1 };

// Positions for n ordered ports in [lo, hi]: as close to `desired` as possible (heavier ports move
// less), keeping the order and at least `pitch` apart (narrow sides shrink the pitch rather than
// leave the card).
function spreadPorts(desired, lo, hi, pitch = PITCH, weights = null) {
  const n = desired.length;
  if (n === 0) return [];
  if (n === 1) return [Math.min(hi, Math.max(lo, desired[0]))];
  const p = Math.min(pitch, (hi - lo) / (n - 1));
  const clamped = desired.map((x, i) => Math.min(hi - (n - 1 - i) * p, Math.max(lo + i * p, x)));
  return projectPositions(clamped, new Array(n - 1).fill(p), weights);
}

// Cost of net a's horizontal sitting above net b's: a's drops to the channel bottom pass b's row,
// b's risers from the channel top pass a's row. Each crossing costs 1, each vertical through the
// spot where a label pill wants to sit costs PILL_HIT, a drop running alongside a riser CRITICAL.
function costAbove(a, b) {
  const inside = (x, n) => x > n.lo + 0.5 && x < n.hi - 0.5;
  const onPill = (x, n) => n.pill && Math.abs(x - n.xBelow) < n.r.pillW / 2 + 3;
  let c = 0;
  for (const p of a.pins) if (p.side === "bottom") c += (inside(p.x, b) ? 1 : 0) + (onPill(p.x, b) ? PILL_HIT : 0);
  for (const p of b.pins) if (p.side === "top") c += (inside(p.x, a) ? 1 : 0) + (onPill(p.x, a) ? PILL_HIT : 0);
  for (const p of a.pins) for (const q of b.pins)
    if (p.side === "bottom" && q.side === "top" && Math.abs(p.x - q.x) < PITCH) c += CRITICAL;
  return c;
}
const overlaps = (a, b) => a.pL < b.pR && b.pL < a.pR;

// Total cost of a channel as routed: every overlapping pair in its row order, plus every straight
// vertical through another net's horizontal.
function channelCost(c) {
  let cost = 0;
  for (const a of c.nets) for (const b of c.nets) {
    if (a === b) continue;
    if (a.row != null && b.row != null && a.row < b.row && overlaps(a, b)) cost += costAbove(a, b);
    if (a.straight && !a.pill && b.row != null && a.lo > b.lo + 0.5 && a.lo < b.hi - 0.5) cost++;
  }
  return cost;
}

// Linear order of nets that violates as little dependency weight as possible (Eades–Lin–Smyth
// greedy feedback-arc-set heuristic): peel sinks to the back, sources to the front, otherwise
// the node with the largest out-minus-in weight.
function feedbackOrder(nodes, deps) {
  const out = new Map(nodes.map((n) => [n, new Map()]));
  const inn = new Map(nodes.map((n) => [n, new Map()]));
  for (const { from, to, w } of deps) { out.get(from).set(to, w); inn.get(to).set(from, w); }
  const left = new Set(nodes), front = [], back = [];
  const drop = (n) => { left.delete(n); for (const m of out.get(n).keys()) inn.get(m).delete(n); for (const m of inn.get(n).keys()) out.get(m).delete(n); };
  while (left.size) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of [...left]) if (out.get(n).size === 0) { back.unshift(n); drop(n); changed = true; }
      for (const n of [...left]) if (inn.get(n).size === 0) { front.push(n); drop(n); changed = true; }
    }
    if (!left.size) break;
    let best = null, bestD = -Infinity;
    for (const n of left) {
      let d = 0;
      for (const w of out.get(n).values()) d += w;
      for (const w of inn.get(n).values()) d -= w;
      if (d > bestD) { best = n; bestD = d; }
    }
    front.push(best); drop(best);
  }
  return [...front, ...back];
}

// Row of every net (0 = top of the group). Overlapping nets never share a row; a net sits below
// every net its kept dependencies put above it.
function assignRows(nets) {
  const deps = [];
  for (let i = 0; i < nets.length; i++)
    for (let j = i + 1; j < nets.length; j++) {
      const a = nets[i], b = nets[j];
      if (!overlaps(a, b)) continue;
      const ab = costAbove(a, b), ba = costAbove(b, a);
      if (ab < ba) deps.push({ from: a, to: b, w: ba - ab });
      else if (ba < ab) deps.push({ from: b, to: a, w: ab - ba });
    }
  const order = feedbackOrder(nets, deps);
  const rank = new Map(order.map((n, i) => [n, i]));
  const preds = new Map(nets.map((n) => [n, []]));
  for (const d of deps) if (rank.get(d.from) < rank.get(d.to)) preds.get(d.to).push(d.from);
  const rows = [];
  for (const n of order) {
    let r = Math.max(0, ...preds.get(n).map((p) => p.row + 1));
    while (rows[r] && rows[r].some((m) => overlaps(m, n))) r++;
    (rows[r] ||= []).push(n);
    n.row = r;
  }
  return rows.length;
}

// SVG path through orthogonal points with every corner rounded to radius r (smaller where a leg is short)
export function roundedOrtho(pts, r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const d1 = Math.hypot(p.x - a.x, p.y - a.y), d2 = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const u1x = (p.x - a.x) / (d1 || 1), u1y = (p.y - a.y) / (d1 || 1);
    const u2x = (b.x - p.x) / (d2 || 1), u2y = (b.y - p.y) / (d2 || 1);
    d += ` L${(p.x - u1x * rr).toFixed(1)} ${(p.y - u1y * rr).toFixed(1)} Q${p.x.toFixed(1)} ${p.y.toFixed(1)} ${(p.x + u2x * rr).toFixed(1)} ${(p.y + u2y * rr).toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x.toFixed(1)} ${last.y.toFixed(1)}`;
  return d;
}

// ctx: { g, lane, laneNodes, X, size, diag, pillSize? }. pillSize(e) → { w, h } replaces the
// swimlane pill measurement for callers that draw their own labels.
// Returns { chanH(g), realize({ chanTop, box }) }.
// realize returns { routes: [{ e, pts }] in draw order, pills: [{ e, x, y, w, h, lines, clipped }] }.
export function planRoutes({ g, lane, laneNodes, X, size, diag, pillSize = null }) {
  const span = (id) => [X.get(id) - size.get(id).w / 2 + PORT_INSET, X.get(id) + size.get(id).w / 2 - PORT_INSET];

  // ----- classify: every drawable edge becomes a route from a lower card `lo` to an upper `up` -----
  const routes = [];
  for (const e of g.edges) {
    if (e.from === e.to) { diag.warn(`self-loop on "${e.from}" is not drawn`, { line: e.line }); continue; }
    const lu = lane.get(e.to), ll = lane.get(e.from);
    if (lu === ll) {
      diag.warn(`edge ${e.from} → ${e.to} connects nodes in the same lane — routed over the top of the lane`, { line: e.line });
      routes.push({ e, lo: e.from, up: e.to, u: lu, l: ll, sameLane: true });
    } else if (lu > ll) {
      diag.warn(`edge ${e.from} → ${e.to} points downward (child sits above its parent) — drawn bottom-up`, { line: e.line });
      routes.push({ e, lo: e.to, up: e.from, u: ll, l: lu });
    } else routes.push({ e, lo: e.from, up: e.to, u: lu, l: ll });
  }

  // ----- label pills (measured here: their size shapes the channel) -----
  for (const r of routes) {
    if (!r.e.label) continue;
    if (pillSize) {
      ({ w: r.pillW, h: r.pillH } = pillSize(r.e));
      r.pillLines = [r.e.label];
      r.pillClipped = false;
      continue;
    }
    // long labels wrap to two lines: a 300px pill can never dodge risers ~200px apart,
    // a 160px one can — and the full text stays visible
    let wrap = wrapText(r.e.label, 170, PILL_FS, { weight: 600, maxLines: 2 });
    if (wrap.clipped) wrap = wrapText(r.e.label, 280, PILL_FS, { weight: 600, maxLines: 2 });
    if (wrap.clipped) diag.warn(`edge label "${r.e.label.slice(0, 40)}…" is too long even wrapped — clipped (full text kept as tooltip)`);
    r.pillLines = wrap.lines;
    r.pillClipped = wrap.clipped;
    r.pillW = Math.max(...wrap.lines.map((l) => textWidth(l, PILL_FS, 600))) + 20;
    r.pillH = wrap.lines.length === 1 ? 20 : 33;
  }

  // ----- corridors through intermediate lanes: a first guess on the straight line between the cards -----
  const corridors = new Map(), taken = new Map();
  for (const r of routes) {
    r.corr = {};
    if (r.sameLane) continue;
    const ux = X.get(r.up), lx = X.get(r.lo);
    for (let j = r.l - 1; j > r.u; j--) {
      if (!corridors.has(j)) {
        corridors.set(j, corridorsOf(laneNodes[j].map((id) => ({ x: X.get(id) - size.get(id).w / 2, w: size.get(id).w }))));
        taken.set(j, []);
      }
      const want = lx + (ux - lx) * ((r.l - j) / (r.l - r.u));
      const x = pickCorridorX(corridors.get(j), want, taken.get(j), { spacing: PITCH });
      if (x != null) taken.get(j).push(x);
      r.corr[j] = x ?? want; // no corridor: fall back (the geometry verifier flags it)
    }
  }

  // ----- ports: parents' bottom sides first, then children's top sides aim at them -----
  const sides = new Map(); // "id|top" / "id|bottom" -> [{ r, end }]
  const addPort = (id, side, r, end) => {
    const k = `${id}|${side}`;
    if (!sides.has(k)) sides.set(k, []);
    sides.get(k).push({ r, end });
  };
  for (const r of routes) {
    addPort(r.lo, "top", r, "lo");
    addPort(r.up, r.sameLane ? "top" : "bottom", r, "up");
  }
  const portOf = (r, end) => (end === "lo" ? r.pLo : r.pUp);
  const setPort = (r, end, x) => { if (end === "lo") r.pLo = x; else r.pUp = x; };
  const farX = ({ r, end }) => {
    if (r.sameLane) return X.get(end === "lo" ? r.up : r.lo);
    if (end === "up") return r.l - r.u > 1 ? r.corr[r.u + 1] : X.get(r.lo);
    return r.l - r.u > 1 ? r.corr[r.l - 1] : r.pUp;
  };
  const placeSide = (id, list, wantOf) => {
    const [lo, hi] = span(id);
    list.forEach((p, i) => { p.far = farX(p); p.i = i; });
    list.sort((a, b) => a.far - b.far || a.i - b.i);
    const slot = (i) => lo + ((i + 0.5) * (hi - lo)) / list.length;
    const wants = list.map((p, i) => wantOf(p, slot(i), lo, hi));
    const xs = spreadPorts(wants.map((w) => w.x), lo, hi, PITCH, wants.map((w) => w.w));
    list.forEach((p, i) => setPort(p.r, p.end, xs[i]));
  };
  const placePorts = () => {
    for (const [k, list] of sides) {
      const [id, side] = k.split("|");
      if (side !== "bottom") continue;
      placeSide(id, list, ({ r }, slot) => {
        if (r.l - r.u > 1) return { x: slot, w: 1 };
        const [a, b] = span(r.lo), [c, d] = span(r.up);
        const sLo = Math.max(a, c), sHi = Math.min(b, d);
        return sLo <= sHi ? { x: Math.min(sHi, Math.max(sLo, slot)), w: STRAIGHT_WEIGHT } : { x: slot, w: 1 }; // keep a straight drop possible
      });
    }
    for (const [k, list] of sides) {
      const [id, side] = k.split("|");
      if (side !== "top") continue;
      placeSide(id, list, (p, slot, lo, hi) => (p.far >= lo - 0.5 && p.far <= hi + 0.5 ? { x: p.far, w: STRAIGHT_WEIGHT } : { x: slot, w: 1 }));
    }
  };
  placePorts();
  const portXsFacing = (j, side, except = null) => {
    const xs = [];
    for (const id of laneNodes[j] || []) for (const p of sides.get(`${id}|${side}`) || []) if (p.r !== except) xs.push(portOf(p.r, p.end));
    return xs;
  };

  // ----- negotiate corridors: every lane-skipping edge re-picks its chain of gaps by dynamic
  // programming over the lanes it passes, against the current ports and the other edges' risers
  // (estimated crossings, then bends, then travel); the ports re-aim after every round -----
  const netsIn = (gph, except) => { // [bottom x, top x] of every other route's net in channel gph
    const out = [];
    for (const r of routes) {
      if (r === except) continue;
      if (r.sameLane) { if (r.u - 1 === gph) out.push([r.pLo, r.pUp]); continue; }
      if (gph < r.u || gph >= r.l) continue;
      out.push([gph === r.l - 1 ? r.pLo : r.corr[gph + 1], gph === r.u ? r.pUp : r.corr[gph]]);
    }
    return out;
  };
  const between = (x, a, b) => x > Math.min(a, b) + 0.5 && x < Math.max(a, b) - 0.5;
  const segCost = (others, x1, x2) => {
    if (Math.abs(x1 - x2) < 0.5) return GAP_CROSS * others.filter(([a, b]) => between(x1, a, b)).length;
    let c = 2 * GAP_BEND + GAP_LEN * Math.abs(x1 - x2);
    for (const [a, b] of others) {
      c += GAP_CROSS * ((between(a, x1, x2) ? 1 : 0) + (between(b, x1, x2) ? 1 : 0));
      c += (GAP_CROSS / 2) * ((between(x1, a, b) ? 1 : 0) + (between(x2, a, b) ? 1 : 0));
    }
    return c;
  };
  const skippers = routes.filter((r) => !r.sameLane && r.l - r.u > 1).sort((a, b) => (b.l - b.u) - (a.l - a.u));
  for (let round = 0; round < GAP_ROUNDS && skippers.length; round++) {
    for (const r of skippers) {
      const lanes = [];
      for (let j = r.l - 1; j > r.u; j--) lanes.push(j);
      const [loA, loB] = span(r.lo), [upA, upB] = span(r.up);
      const cands = lanes.map((j) => {
        const others = skippers.filter((o) => o !== r && o.corr[j] != null).map((o) => o.corr[j]);
        const blocked = [...others, ...portXsFacing(j + 1, "top", r), ...portXsFacing(j - 1, "bottom", r)];
        const xs = [];
        for (const [a, b] of corridors.get(j))
          for (const w of [a, b, (a + b) / 2, r.corr[j], r.pLo, r.pUp, X.get(r.lo), X.get(r.up)]) xs.push(Math.min(b, Math.max(a, w)));
        const free = xs.filter((x) => blocked.every((t) => Math.abs(t - x) >= PITCH));
        return [...new Set(free.length ? free : [r.corr[j]])];
      });
      // channel cost from the child (bottom) up to the first gap, gap to gap, last gap to the parent
      const fromLo = (x) => (x >= loA && x <= loB ? 0 : segCost(netsIn(r.l - 1, r), r.pLo, x));
      const toUp = (x) => (x >= upA && x <= upB ? 0 : segCost(netsIn(r.u, r), x, r.pUp));
      let best = cands[0].map((x) => ({ cost: fromLo(x), path: [x] }));
      for (let k = 1; k < lanes.length; k++) {
        const others = netsIn(lanes[k], r);
        best = cands[k].map((x) => {
          let pick = null;
          for (const b of best) {
            const c = b.cost + segCost(others, b.path[b.path.length - 1], x);
            if (!pick || c < pick.cost) pick = { cost: c, path: [...b.path, x] };
          }
          return pick;
        });
      }
      const done = best.map((b) => ({ ...b, cost: b.cost + toUp(b.path[b.path.length - 1]) })).sort((a, b) => a.cost - b.cost);
      lanes.forEach((j, k) => { r.corr[j] = done[0].path[k]; });
      r.chains = done.slice(0, GAP_ALTERNATIVES).map((d) => d.path);
      r.lanes = lanes;
    }
    for (const j of taken.keys()) taken.set(j, skippers.filter((o) => o.corr[j] != null).map((o) => o.corr[j]));
    placePorts();
  }

  // ----- channel nets: one horizontal per route per channel, bottom pins at the child side -----
  const buildChannels = () => {
    const chans = new Map(); // g -> { nets, rows: [{ h }], h }
    const addNet = (r, gph, pins, xBelow, xAbove) => {
      if (!chans.has(gph)) chans.set(gph, { nets: [] });
      const xs = pins.map((p) => p.x);
      const net = { r, g: gph, pins, xBelow, xAbove, lo: Math.min(...xs), hi: Math.max(...xs) };
      net.straight = net.hi - net.lo < 0.5;
      net.pill = !!r.e.label && gph === (r.sameLane ? r.u - 1 : r.l - 1);
      const pad = net.pill ? Math.max(16, r.pillW - 6) : PITCH / 2; // pills slide past the segment ends
      net.pL = net.lo - pad; net.pR = net.hi + pad;
      chans.get(gph).nets.push(net);
      return net;
    };
    for (const r of routes) {
      r.nets = [];
      if (r.sameLane) {
        r.nets.push(addNet(r, r.u - 1, [{ x: r.pLo, side: "bottom" }, { x: r.pUp, side: "bottom" }], r.pLo, r.pUp));
        continue;
      }
      for (let gph = r.l - 1; gph >= r.u; gph--) {
        const xBelow = gph === r.l - 1 ? r.pLo : r.corr[gph + 1];
        const xAbove = gph === r.u ? r.pUp : r.corr[gph];
        r.nets.push(addNet(r, gph, [{ x: xBelow, side: "bottom" }, { x: xAbove, side: "top" }], xBelow, xAbove));
      }
    }
    for (const c of chans.values()) {
      const rowed = c.nets.filter((n) => !n.straight || n.pill);
      const count = assignRows(rowed);
      c.rows = Array.from({ length: count }, (_, i) => {
        const pills = rowed.filter((n) => n.row === i && n.pill);
        return { h: pills.length ? Math.max(20, ...pills.map((n) => n.r.pillH)) + 7 : PITCH };
      });
      c.h = c.rows.length ? ROW_PAD * 2 + c.rows.reduce((a, row) => a + row.h, 0) : 0;
    }
    return chans;
  };

  // rip-up and reroute: each lane-skipping edge tries its best few chains of gaps and keeps the
  // one whose fully routed channels cost least (crossings first, then bends)
  const totalCost = () => {
    const chans = buildChannels();
    let cost = 0, bends = 0;
    for (const c of chans.values()) {
      cost += channelCost(c);
      bends += c.nets.filter((n) => n.row != null && !n.straight).length;
    }
    return cost * 1000 + bends;
  };
  if (skippers.length) {
    let current = totalCost();
    for (const r of skippers) {
      const keep = { ...r.corr };
      for (const chain of r.chains) {
        if (r.lanes.every((j, k) => chain[k] === keep[j])) continue;
        const clash = r.lanes.some((j, k) => skippers.some((o) => o !== r && o.corr[j] != null && Math.abs(o.corr[j] - chain[k]) < PITCH));
        if (clash) continue;
        r.lanes.forEach((j, k) => { r.corr[j] = chain[k]; });
        placePorts();
        const cost = totalCost();
        if (cost < current) { current = cost; Object.assign(keep, r.corr); }
        else Object.assign(r.corr, keep);
      }
      Object.assign(r.corr, keep);
      placePorts();
    }
    for (const j of taken.keys()) taken.set(j, skippers.filter((o) => o.corr[j] != null).map((o) => o.corr[j]));
  }

  // a corridor riser that lands within PITCH of a port it passes moves along its gap, then the
  // ports re-aim at the moved risers
  let moved = false;
  for (const r of routes) {
    for (const j of Object.keys(r.corr).map(Number)) {
      const near = [...portXsFacing(j + 1, "top"), ...portXsFacing(j - 1, "bottom")];
      if (!near.some((x) => Math.abs(x - r.corr[j]) < PITCH)) continue;
      const others = taken.get(j).filter((x) => x !== r.corr[j]);
      const x = pickCorridorX(corridors.get(j), r.corr[j], [...others, ...near], { spacing: PITCH });
      if (x == null) continue;
      taken.set(j, [...others, x]);
      r.corr[j] = x;
      moved = true;
    }
  }
  if (moved) placePorts();
  // a near-aligned adjacent pair snaps straight when the moved port keeps its neighbours PITCH away
  const sideOf = (r, end) => sides.get(`${end === "lo" ? r.lo : r.up}|${end === "lo" || r.sameLane ? "top" : "bottom"}`);
  const trySnap = (r, end, x) => {
    const id = end === "lo" ? r.lo : r.up;
    const [lo, hi] = span(id);
    if (x < lo || x > hi) return false;
    if (sideOf(r, end).some((p) => p.r !== r && Math.abs(portOf(p.r, p.end) - x) < PITCH)) return false;
    setPort(r, end, x);
    return true;
  };
  for (const r of routes) {
    if (r.sameLane || r.l - r.u > 1 || r.pLo === r.pUp || Math.abs(r.pLo - r.pUp) >= PITCH) continue;
    if (!trySnap(r, "lo", r.pUp)) trySnap(r, "up", r.pLo);
  }

  const chans = buildChannels();
  const chanH = (gph) => chans.get(gph)?.h || 0;

  function realize({ chanTop, box }) {
    const rowY = (net) => {
      const c = chans.get(net.g);
      let y = chanTop(net.g) + ROW_PAD;
      for (let i = 0; i < net.row; i++) y += c.rows[i].h;
      return y + c.rows[net.row].h / 2;
    };

    // ----- polylines -----
    for (const r of routes) {
      const cLo = box.get(r.lo), cU = box.get(r.up);
      let pts;
      if (r.sameLane) {
        const y = rowY(r.nets[0]);
        pts = [{ x: r.pLo, y: cLo.top }, { x: r.pLo, y }, { x: r.pUp, y }, { x: r.pUp, y: cU.top }];
      } else {
        pts = [{ x: r.pLo, y: cLo.top }];
        for (const n of r.nets) {
          if (n.row == null) continue; // straight through this channel
          const y = rowY(n);
          pts.push({ x: n.xBelow, y }, { x: n.xAbove, y });
        }
        pts.push({ x: r.pUp, y: cU.bottom });
      }
      // drop repeated and collinear interior points
      pts = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
      r.pts = pts.filter((p, i) => i === 0 || i === pts.length - 1 ||
        !((p.x === pts[i - 1].x && p.x === pts[i + 1].x) || (p.y === pts[i - 1].y && p.y === pts[i + 1].y)));
    }

    // ----- pills slide along their horizontal to the spot crossed by the fewest other verticals -----
    const verticals = [];
    for (const r of routes)
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1], b = r.pts[i];
        if (a.x === b.x) verticals.push({ x: a.x, y1: Math.min(a.y, b.y), y2: Math.max(a.y, b.y), r });
      }
    const pills = [];
    for (const r of routes) {
      if (!r.e.label) continue;
      const net = r.nets.find((n) => n.pill);
      const y = rowY(net), pw = r.pillW, halfH = r.pillH / 2;
      const near = verticals.filter((v) => v.r !== r && v.y1 < y + halfH && v.y2 > y - halfH);
      const anchor = net.xBelow;
      const overhang = Math.max(0, pw / 2 - 10);
      const domLo = net.lo - overhang, domHi = net.hi + overhang;
      const conflicts = (x) => near.reduce((k, v) => k + (Math.abs(v.x - x) < pw / 2 + 3 ? 1 : 0), 0);
      let bestX = Math.min(domHi, Math.max(domLo, anchor)), bestC = conflicts(bestX), bestD = 0;
      if (bestC > 0) {
        const cands = [domLo, domHi];
        for (let x = domLo; x < domHi; x += 4) cands.push(x);
        for (const v of near) cands.push(v.x + pw / 2 + 3.5, v.x - pw / 2 - 3.5); // just past each crosser
        bestD = Infinity;
        for (const c of cands) {
          if (c < domLo - 1e-9 || c > domHi + 1e-9) continue;
          const k = conflicts(c), d = Math.abs(c - anchor);
          if (k < bestC || (k === bestC && d < bestD)) { bestX = c; bestC = k; bestD = d; }
        }
      }
      if (bestC > 0) diag.warn(`label pill "${r.e.label}" could not fully avoid crossing connectors — it may sit on one`);
      pills.push({ e: r.e, x: bestX, y, w: pw, h: r.pillH, lines: r.pillLines, clipped: r.pillClipped });
    }

    // draw order: more severe sources last, so their lines sit on top
    const routesOut = routes
      .map((r, i) => ({ r, i }))
      .sort((a, b) => stateRank[g.nodes.get(a.r.e.from).state] - stateRank[g.nodes.get(b.r.e.from).state] || a.i - b.i)
      .map(({ r }) => ({ e: r.e, pts: r.pts }));
    return { routes: routesOut, pills };
  }

  return { chanH, realize };
}
