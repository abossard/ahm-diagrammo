// layout.mjs — pure layout algorithms for the swimlane engine (no rendering, unit-testable).
//
// The engine follows the classic Sugiyama pipeline for layered drawings:
//   1. layering       — longest path to a root (in swimlane.mjs)
//   2. ordering       — barycenter sweeps (in swimlane.mjs)
//   3. coordinates    — HERE: iterative 1-D constrained projection with variable node widths
//   4. edge routing   — HERE: channel tracks (interval coloring) + corridors between cards
//
// Guarantees the routines provide:
//   • projectPositions: within a lane, |x_i − x_j| respects each pair's minimum separation
//     (no card overlap by construction), while nodes sit as close as possible to the mean of
//     their neighbors (parents centered over children).
//   • assignTracks: horizontal segments in one channel that overlap in x never share a track.
//   • corridors: a vertical path through a lane always runs in a gap between cards.

// ---------- 1-D constrained projection (cluster-merge / "priority" method) ----------
// Given nodes in fixed order with desired positions and pairwise minimum separations
// (sep[i] = min distance between center i and center i+1), find positions that keep the order,
// respect every separation, and minimize squared distance to the desired positions.
// Classic optimal algorithm: scan left to right; each node starts as its own cluster at its
// desired position; while the last two clusters violate their separation, merge them and place
// the merged cluster at the average of (desired − internal offset) of its members.
export function projectPositions(desired, sep) {
  const n = desired.length;
  if (n === 0) return [];
  const clusters = []; // { sum, count, off0, offs:[...], first, last }
  for (let i = 0; i < n; i++) {
    let cur = { sum: desired[i], count: 1, offs: [0], first: i, last: i };
    while (clusters.length) {
      const prev = clusters[clusters.length - 1];
      const need = sep[cur.first - 1]; // min distance between prev.last and cur.first
      const prevPos = prev.sum / prev.count, curPos = cur.sum / cur.count;
      const prevLastX = prevPos + prev.offs[prev.offs.length - 1];
      const curFirstX = curPos + cur.offs[0];
      if (curFirstX - prevLastX >= need - 1e-9) break;
      // merge cur into prev: cur's offsets continue after prev's last offset + need
      const base = prev.offs[prev.offs.length - 1] + need - cur.offs[0];
      for (let k = 0; k < cur.offs.length; k++) {
        const off = cur.offs[k] + base;
        prev.offs.push(off);
        // member's desired contributes (desired − its offset) to the cluster position estimate
        prev.sum += desired[cur.first + k] - off;
        prev.count++;
      }
      prev.last = cur.last;
      cur = clusters.pop();
      // after popping, `cur` is the merged prev; loop re-checks against the one before it
    }
    clusters.push(cur);
  }
  const out = new Array(n);
  for (const c of clusters) {
    const pos = c.sum / c.count;
    for (let k = 0; k < c.offs.length; k++) out[c.first + k] = pos + c.offs[k];
  }
  return out;
}

// Iteratively align every lane to the mean of its neighbors, projecting after each sweep.
// laneNodes: array of lanes, each an ordered array of node ids
// widths: Map id -> width; neighbors: Map id -> [ids] (both directions); gap: min gap between cards
export function relaxCoordinates(laneNodes, widths, neighbors, gap, { iterations = 40 } = {}) {
  const x = new Map();
  // init: sequential packing per lane
  for (const lane of laneNodes) {
    let cursor = 0;
    lane.forEach((id, i) => {
      if (i > 0) cursor += widths.get(lane[i - 1]) / 2 + widths.get(id) / 2 + gap;
      x.set(id, cursor);
    });
  }
  const seps = laneNodes.map((lane) => lane.slice(0, -1).map((id, i) =>
    widths.get(id) / 2 + widths.get(lane[i + 1]) / 2 + gap));

  for (let it = 0; it < iterations; it++) {
    // alternate sweep direction for faster settling
    const order = it % 2 === 0 ? laneNodes.map((_, i) => i) : laneNodes.map((_, i) => laneNodes.length - 1 - i);
    for (const li of order) {
      const lane = laneNodes[li];
      if (!lane.length) continue;
      const desired = lane.map((id) => {
        const ns = neighbors.get(id) || [];
        if (!ns.length) return x.get(id);
        return ns.reduce((a, n) => a + x.get(n), 0) / ns.length;
      });
      const proj = projectPositions(desired, seps[li]);
      lane.forEach((id, i) => x.set(id, proj[i]));
    }
  }
  // normalize to start at 0 (by left card edge)
  let minEdge = Infinity;
  for (const lane of laneNodes) for (const id of lane) minEdge = Math.min(minEdge, x.get(id) - widths.get(id) / 2);
  if (isFinite(minEdge)) for (const id of x.keys()) x.set(id, x.get(id) - minEdge);
  return x;
}

// ---------- channel track assignment (interval-graph coloring) ----------
// items: [{ id, xL, xR, pill:boolean, order }] — intervals of horizontal segments in one channel.
// Returns Map id -> level. Same level ⇒ x-disjoint intervals.
//
// Row order matters for occlusion: within a channel, an edge's riser (child side) crosses every
// row BELOW the edge's own row and its trunk (parent side) crosses every row ABOVE it. Trunks
// cluster inside the parent's footprint; risers spread out at the children. Label pills anchor
// near the children, so pill rows go at the BOTTOM of the channel (below all plain rows), where
// only spread-out risers cross them. Pills are packed by `order` (caller passes descending span,
// so cramped short-segment pills sink to the lowest rows, which the fewest trunks cross).
export function assignTracks(items) {
  const levelOf = new Map();
  const levels = []; // each: { occ: [[xL,xR]...], pill:boolean }
  const place = (it, wantPill) => {
    for (let lvl = 0; ; lvl++) {
      if (!levels[lvl]) levels[lvl] = { occ: [], pill: wantPill };
      const L = levels[lvl];
      if (L.pill !== wantPill) continue;
      if (L.occ.every(([a, b]) => it.xR < a - 1e-9 || it.xL > b + 1e-9)) {
        L.occ.push([it.xL, it.xR]);
        levelOf.set(it.id, lvl);
        return;
      }
    }
  };
  const sorted = [...items].sort((a, b) =>
    (a.pill ? 1 : 0) - (b.pill ? 1 : 0) || (a.order ?? a.xL) - (b.order ?? b.xL) || a.xL - b.xL);
  for (const it of sorted) place(it, !!it.pill);
  // renumber levels: plain rows first (top of channel), pill rows after (bottom)
  const used = [...new Set([...levelOf.values()])].sort((a, b) => {
    const pa = levels[a].pill ? 1 : 0, pb = levels[b].pill ? 1 : 0;
    return pa - pb || a - b;
  });
  const renum = new Map(used.map((lvl, i) => [lvl, i]));
  const out = new Map();
  for (const [id, lvl] of levelOf) out.set(id, renum.get(lvl));
  const pillLevels = used.filter((l) => levels[l].pill).length;
  return { levelOf: out, count: used.length, pillLevels, plainLevels: used.length - pillLevels };
}

// ---------- corridors ----------
// Cards of one lane (sorted by x): the usable vertical corridors are the gaps between adjacent
// cards plus the open space on both flanks. margin keeps risers off card borders.
export function corridorsOf(cards, { margin = 10, flank = 60 } = {}) {
  const sorted = [...cards].sort((a, b) => a.x - b.x);
  const out = [];
  let cursor = -Infinity;
  for (const c of sorted) {
    const lo = cursor === -Infinity ? c.x - flank - margin : cursor;
    const hi = c.x - margin;
    if (hi - lo >= 8) out.push([lo, hi]);
    cursor = Math.max(cursor, c.x + c.w + margin);
  }
  out.push([cursor === -Infinity ? -flank : cursor, cursor === -Infinity ? flank : cursor + flank]);
  return out;
}

// Pick an x for a vertical riser through a lane: nearest usable point to `want` among the
// corridors, avoiding already-taken xs (min spacing). taken: array of xs already used.
export function pickCorridorX(corridors, want, taken = [], { spacing = 7 } = {}) {
  const free = (x) => taken.every((t) => Math.abs(t - x) >= spacing - 1e-9);
  let best = null, bestCost = Infinity;
  for (const [lo, hi] of corridors) {
    // candidates: the clamped wish, plus one slot beside every taken position
    const cands = [Math.min(hi, Math.max(lo, want))];
    for (const t of taken) cands.push(t + spacing, t - spacing);
    cands.push(lo, hi);
    for (const c of cands) {
      if (c < lo - 1e-9 || c > hi + 1e-9 || !free(c)) continue;
      const cost = Math.abs(c - want);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
  }
  return best; // null ⇒ no corridor slot available (caller falls back / verifier flags)
}
