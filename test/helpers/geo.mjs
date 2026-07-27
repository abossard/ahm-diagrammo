// geo.mjs — geometric verification of the swimlane renderer's debug output.
// The renderer emits its full geometry model (cards, pills, segments, texts, lanes);
// these checks turn "nothing overlaps, nothing is hidden" into hard assertions.

const EPS = 0.5;
export function rectsOverlap(a, b, eps = EPS) {
  return a.x + eps < b.x + b.w && b.x + eps < a.x + a.w &&
         a.y + eps < b.y + b.h && b.y + eps < a.y + a.h;
}

function fmtRect(r) {
  const tag = r.id ?? r.label ?? r.text ?? "";
  return `${tag ? `"${tag}" ` : ""}[x=${r.x.toFixed(1)} y=${r.y.toFixed(1)} w=${r.w.toFixed(1)} h=${r.h.toFixed(1)}]`;
}

// Every violation found across all checks, as human-readable strings.
// `maxWidth` is opt-in (default undefined = today's exact behavior for every existing caller):
// when set, flags any physical lane row whose packed card content exceeds it — a defense-in-depth
// secondary check to the primary `result.W <= maxWidth` bound — unless that row holds exactly one
// card (the "a single node/group too wide to split gets its own oversized row" exception).
export function verifyGeometry(result, { checkTexts = true, maxWidth, minRouteTrack } = {}) {
  const { debug, W, H } = result;
  const problems = [];

  // 1. cards never overlap each other
  for (let i = 0; i < debug.cards.length; i++)
    for (let j = i + 1; j < debug.cards.length; j++)
      if (rectsOverlap(debug.cards[i], debug.cards[j]))
        problems.push(`cards overlap: ${fmtRect(debug.cards[i])} ∩ ${fmtRect(debug.cards[j])}`);

  // 2. every card sits inside its lane band and inside the canvas
  for (const c of debug.cards) {
    const lane = debug.lanes[c.lane];
    if (!lane) { problems.push(`card ${c.id} has no lane ${c.lane}`); continue; }
    if (c.y < lane.top - EPS || c.y + c.h > lane.top + lane.h + EPS)
      problems.push(`card ${fmtRect(c)} leaves its lane band [${lane.top.toFixed(1)}..${(lane.top + lane.h).toFixed(1)}]`);
    if (c.x < -EPS || c.x + c.w > W + EPS || c.y < -EPS || c.y + c.h > H + EPS)
      problems.push(`card ${fmtRect(c)} leaves the canvas ${W}×${H}`);
  }

  // 2b. (opt-in) no physical row's packed card content exceeds maxWidth, unless it's the sole
  // occupant of that row (an unavoidable single node/group wider than the budget, per C4).
  if (Number.isFinite(maxWidth)) {
    const byRow = new Map();
    for (const c of debug.cards) {
      if (!byRow.has(c.lane)) byRow.set(c.lane, []);
      byRow.get(c.lane).push(c);
    }
    for (const [rowIdx, cards] of byRow) {
      if (cards.length < 2) continue; // sole occupant: the C4 exception, never flagged
      const lo = Math.min(...cards.map((c) => c.x)), hi = Math.max(...cards.map((c) => c.x + c.w));
      const span = hi - lo;
      if (span > maxWidth + EPS)
        problems.push(`row ${rowIdx} packed content ${span.toFixed(1)}px exceeds maxWidth ${maxWidth}px (${cards.length} cards: ${cards.map((c) => c.id).join(", ")})`);
    }
  }

  // 3. pills: inside canvas, disjoint from each other, from every card, and from every
  //    connector segment that isn't their own edge
  for (let i = 0; i < debug.pills.length; i++) {
    const p = debug.pills[i];
    if (p.x < -EPS || p.x + p.w > W + EPS || p.y < -EPS || p.y + p.h > H + EPS)
      problems.push(`pill ${fmtRect(p)} leaves the canvas`);
    for (let j = i + 1; j < debug.pills.length; j++)
      if (rectsOverlap(p, debug.pills[j]))
        problems.push(`pills overlap: ${fmtRect(p)} ∩ ${fmtRect(debug.pills[j])}`);
    for (const c of debug.cards)
      if (rectsOverlap(p, c))
        problems.push(`pill ${fmtRect(p)} overlaps card ${fmtRect(c)}`);
    for (const s of debug.segs) {
      if (s.edge === p.edge) continue;
      const segRect = { x: s.x1, y: s.y1, w: Math.max(s.x2 - s.x1, 0.1), h: Math.max(s.y2 - s.y1, 0.1) };
      if (rectsOverlap(p, segRect, 1.5))
        problems.push(`pill ${fmtRect(p)} is crossed by connector ${s.edge} (${s.kind} seg ${s.x1.toFixed(0)},${s.y1.toFixed(0)}→${s.x2.toFixed(0)},${s.y2.toFixed(0)})`);
    }
  }

  // 4. connector segments never pass through a card's interior. Verticals may touch a card at
  //    its top/bottom edge (that's how they connect); shrink each card by the connection slack.
  for (const s of debug.segs) {
    for (const c of debug.cards) {
      const inner = { x: c.x + 2, y: c.y + 2, w: c.w - 4, h: c.h - 4 };
      const segRect = { x: s.x1, y: s.y1, w: Math.max(s.x2 - s.x1, 0.1), h: Math.max(s.y2 - s.y1, 0.1) };
      if (rectsOverlap(inner, segRect))
        problems.push(`connector ${s.edge} passes through card ${fmtRect(c)} (${s.kind} seg ${s.x1.toFixed(0)},${s.y1.toFixed(0)}→${s.x2.toFixed(0)},${s.y2.toFixed(0)})`);
    }
  }

  // 5. horizontal segments of different edges never overlap collinearly. Shared-bundle
  //    coincidence is allowed only when both segments have the same trunk tag AND canonical,
  //    byte-for-byte-equivalent endpoints. Partial same-tag overlap is ambiguous because the
  //    visible junction cannot be attributed to a specific source.
  const sameTrunk = (a, b) => a.trunk != null && a.trunk === b.trunk;
  const sameSegment = (a, b) =>
    a.kind === b.kind &&
    Math.abs(a.x1 - b.x1) < 0.01 && Math.abs(a.y1 - b.y1) < 0.01 &&
    Math.abs(a.x2 - b.x2) < 0.01 && Math.abs(a.y2 - b.y2) < 0.01;
  const rangesOverlap = (a1, a2, b1, b2) => Math.min(a2, b2) - Math.max(a1, b1) > 1;
  const hs = debug.segs.filter((s) => s.kind === "h");
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i], b = hs[j];
      if (a.edge === b.edge) continue;
      if (Math.abs(a.y1 - b.y1) < 1.5 && rangesOverlap(a.x1, a.x2, b.x1, b.x2)) {
        if (sameTrunk(a, b) && sameSegment(a, b)) continue;
        if (sameTrunk(a, b))
          problems.push(`non-canonical shared horizontal trunk ${a.trunk}: ${a.edge} [${a.x1.toFixed(0)},${a.x2.toFixed(0)}] vs ${b.edge} [${b.x1.toFixed(0)},${b.x2.toFixed(0)}] at y≈${a.y1.toFixed(0)}`);
        else
          problems.push(`collinear horizontal overlap between ${a.edge} and ${b.edge} at y≈${a.y1.toFixed(0)}`);
      }
    }

  // 6. vertical segments use the same canonical shared-trunk rule.
  const vs = debug.segs.filter((s) => s.kind === "v");
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i], b = vs[j];
      if (a.edge === b.edge) continue;
      if (Math.abs(a.x1 - b.x1) < 1.5 && rangesOverlap(a.y1, a.y2, b.y1, b.y2)) {
        if (sameTrunk(a, b) && sameSegment(a, b)) continue;
        if (sameTrunk(a, b))
          problems.push(`non-canonical shared vertical trunk ${a.trunk}: ${a.edge} [${a.y1.toFixed(0)},${a.y2.toFixed(0)}] vs ${b.edge} [${b.y1.toFixed(0)},${b.y2.toFixed(0)}] at x≈${a.x1.toFixed(0)}`);
        else
          problems.push(`collinear vertical overlap between ${a.edge} and ${b.edge} at x≈${a.x1.toFixed(0)}`);
      }
    }

  // 6b. A trunk tag means genuinely shared ink, never a neutral singleton span. Every canonical
  //     tagged segment must be used by at least two independently keyed relationships.
  const trunkUsers = new Map();
  for (const s of debug.segs.filter((seg) => seg.trunk != null)) {
    const key = `${s.trunk}|${s.kind}|${s.x1.toFixed(2)},${s.y1.toFixed(2)}→${s.x2.toFixed(2)},${s.y2.toFixed(2)}`;
    if (!trunkUsers.has(key)) trunkUsers.set(key, new Set());
    trunkUsers.get(key).add(s.edge);
  }
  for (const [key, edges] of trunkUsers)
    if (edges.size < 2) problems.push(`unshared trunk segment ${key} belongs only to ${[...edges].join(", ")}`);

  // 6c. Every relationship must remain attributable to its source before joining shared ink.
  //     A trunk-using edge needs an untagged branch that touches its source card. Branch/trunk
  //     intersections are legal only where both segments end at the same junction.
  const pointEq = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
  const endpoints = (s) => [{ x: s.x1, y: s.y1 }, { x: s.x2, y: s.y2 }];
  const touchesCard = (s, c) => endpoints(s).some((p) => {
    const onVertical = (Math.abs(p.x - c.x) < EPS || Math.abs(p.x - (c.x + c.w)) < EPS) &&
      p.y >= c.y - EPS && p.y <= c.y + c.h + EPS;
    const onHorizontal = (Math.abs(p.y - c.y) < EPS || Math.abs(p.y - (c.y + c.h)) < EPS) &&
      p.x >= c.x - EPS && p.x <= c.x + c.w + EPS;
    return onVertical || onHorizontal;
  });
  const intersectsAwayFromSharedEndpoint = (a, b) => {
    const sharedEndpoint = endpoints(a).some((pa) => endpoints(b).some((pb) => pointEq(pa, pb)));
    if (a.kind === b.kind) {
      const collinear = a.kind === "h" ? Math.abs(a.y1 - b.y1) < 0.01 : Math.abs(a.x1 - b.x1) < 0.01;
      const overlap = a.kind === "h"
        ? Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1)
        : Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1);
      if (!collinear || overlap < -0.01) return false;
      return overlap > 0.01 || !sharedEndpoint;
    }
    const h = a.kind === "h" ? a : b, v = a.kind === "v" ? a : b;
    const crosses = v.x1 >= h.x1 - 0.01 && v.x1 <= h.x2 + 0.01 &&
      h.y1 >= v.y1 - 0.01 && h.y1 <= v.y2 + 0.01;
    if (!crosses) return false;
    const p = { x: v.x1, y: h.y1 };
    return !endpoints(a).some((pa) => pointEq(pa, p)) || !endpoints(b).some((pb) => pointEq(pb, p));
  };
  const trunkEdges = new Set(debug.segs.filter((s) => s.trunk != null).map((s) => s.edge));
  for (const edge of trunkEdges) {
    const sourceId = edge.split("->", 1)[0];
    const source = debug.cards.find((c) => c.id === sourceId);
    const branches = debug.segs.filter((s) => s.edge === edge && s.trunk == null);
    const trunks = debug.segs.filter((s) => s.edge === edge && s.trunk != null);
    if (!source || !branches.some((s) => touchesCard(s, source)))
      problems.push(`branchless shared route ${edge}: no source-owned branch reaches card "${sourceId}"`);
    for (const branch of branches)
      for (const trunk of trunks)
        if (intersectsAwayFromSharedEndpoint(branch, trunk))
          problems.push(`branch ${edge} joins shared trunk ${trunk.trunk} away from a canonical endpoint`);
  }

  // 6d. Where a caller asks for a visual track contract, distinct parallel ink with overlapping
  //     spans needs that full separation. Canonical shared segments are the only exception.
  if (Number.isFinite(minRouteTrack) && minRouteTrack > 0)
    for (let i = 0; i < debug.segs.length; i++)
      for (let j = i + 1; j < debug.segs.length; j++) {
        const a = debug.segs[i], b = debug.segs[j];
        if (a.edge === b.edge || a.kind !== b.kind) continue;
        const overlap = a.kind === "h"
          ? rangesOverlap(a.x1, a.x2, b.x1, b.x2)
          : rangesOverlap(a.y1, a.y2, b.y1, b.y2);
        if (!overlap || (sameTrunk(a, b) && sameSegment(a, b))) continue;
        const gap = a.kind === "h" ? Math.abs(a.y1 - b.y1) : Math.abs(a.x1 - b.x1);
        if (gap + 0.01 < minRouteTrack)
          problems.push(`near-parallel ${a.kind === "h" ? "horizontal" : "vertical"} routes ${a.edge} and ${b.edge} are ${gap.toFixed(1)}px apart (minimum ${minRouteTrack}px)`);
      }

  // 7. every text box stays inside the canvas and inside its declared container
  if (checkTexts) {
    for (const t of debug.texts) {
      if (t.x < -EPS || t.x + t.w > W + EPS || t.y < -EPS || t.y + t.h > H + EPS)
        problems.push(`text ${fmtRect(t)} leaves the canvas ${W}×${H}`);
      if (t.container) {
        const c = t.container;
        if (t.x < c.x - EPS || t.x + t.w > c.x + c.w + EPS || t.y < c.y - EPS || t.y + t.h > c.y + c.h + EPS)
          problems.push(`text ${fmtRect(t)} overflows its container ${fmtRect(c)}`);
      }
    }
  }

  // 8. a status pill never overlaps the header text of its own card. The card is sized to
  //    reserve the pill's horizontal band next to the title/subtitle; this guards that reservation.
  if (checkTexts && debug.statusPills) {
    const sameContainer = (a, b) => a && b && Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;
    for (const pill of debug.statusPills) {
      if (pill.x < -EPS || pill.x + pill.w > W + EPS || pill.y < -EPS || pill.y + pill.h > H + EPS)
        problems.push(`status pill ${fmtRect(pill)} leaves the canvas ${W}×${H}`);
      for (const t of debug.texts) {
        if (!sameContainer(t.container, pill.container)) continue;
        if (t.x >= pill.x) continue; // the pill's own centered label sits inside it — only left-aligned header text can intrude
        if (rectsOverlap(pill, t))
          problems.push(`status pill ${fmtRect(pill)} overlaps header text ${fmtRect(t)}`);
      }
    }
  }

  return problems;
}

// ---------- routing-readability metrics (C26-C28) ----------
// A true visual "crossing" in this axis-aligned geometry model: a vertical segment and a
// horizontal segment, belonging to different edges, where the vertical's x falls STRICTLY
// inside the horizontal's x-range and the horizontal's y falls STRICTLY inside the vertical's
// y-range. Strict inequality is what naturally excludes both an intentional collinear shared
// trunk (a v×v/h×h overlap — a different shape entirely, already governed by checks #5/#6 and
// their trunk-tag exception above) and an endpoint touch/T-junction (a branch stub ending
// exactly at a trunk: the join point sits ON the trunk's boundary, not strictly inside it).
// Canonical shared spans are visible once even though each semantic relationship emits its own
// hooked path, so exact same-trunk segment duplicates are collapsed before counting.
export function countCrossings(debug) {
  const EPS = 1e-6;
  const visible = (kind) => {
    const keyed = new Map();
    for (const s of debug.segs.filter((seg) => seg.kind === kind)) {
      const identity = s.trunk == null ? s.edge : `trunk:${s.trunk}`;
      const key = `${identity}|${s.x1.toFixed(4)},${s.y1.toFixed(4)}→${s.x2.toFixed(4)},${s.y2.toFixed(4)}`;
      if (!keyed.has(key)) keyed.set(key, s);
    }
    return [...keyed.values()];
  };
  const vs = visible("v");
  const hs = visible("h");
  let count = 0;
  for (const v of vs) {
    const vx = v.x1; // x1 === x2 on a vertical segment
    for (const h of hs) {
      if (v.edge === h.edge) continue;
      const hy = h.y1; // y1 === y2 on a horizontal segment
      if (vx > h.x1 + EPS && vx < h.x2 - EPS && hy > v.y1 + EPS && hy < v.y2 - EPS) count++;
    }
  }
  return count;
}

// ---------- unowned T-junction detector (C-R4) ----------
// A "T-junction" is a different shape from both existing checks above: a `#5`/`#6` collinear
// overlap needs a same-kind (h×h or v×v) segment pair with a genuine *range* overlap, and
// `countCrossings` above needs a perpendicular pair with a *strictly interior* touch on both
// axes. A T-junction is what's left in between — one edge's *parent-facing terminus* (the
// physical end of its own polyline nearest its own target/parent card) lands within EPS=0.5px of
// a different edge's segment, on either axis combination (h endpoint on v, v endpoint on h, or a
// short stub's terminus landing on a longer collinear segment it doesn't fully overlap by
// verifyGeometry's >1px-range rule). EPS=0.5 is an intentional detection band (sub-pixel float
// noise from the relaxation/corridor solvers must still register as the same coincident point),
// not a claim that only bit-exact matches count — call sites should say "within EPS" rather than
// "exact" for this reason. Only each edge's own terminus is checked, not every intermediate bend
// — a shared bundle's internal peel/jog geometry legitimately coincides well before the parent
// boundary and is not the "unowned merge at a parent boundary" this detects, and an edge's own
// *child-facing* end (the opposite terminus, whichever physical direction that is for this edge)
// is never checked either, for the same reason. Which physical end (min-y or max-y) is
// "parent-facing" is direction-aware, not a universal min-y assumption (fixed 2026-07-27, C3-R2):
// normally the target (`to`) card sits above the source (`from`) card in this bottom-to-top
// layout, so the *min-y* end faces the parent, but a cycle-breaking back edge (e.g.
// `cycle-and-self-loop`'s `b->a`) can lay its `to` card out BELOW its `from` card, in which case
// the parent-facing end is the *max-y* one instead. `debug.cards` (looked up by each edge's own
// `from`/`to` ids, parsed from its `${from}->${to}` key) tells us which; a self-loop, a same-lane
// tie, or missing/unresolvable card data all fall back to the historical min-y default, since
// there is no defined up/down to reason about (and the direct-unit-coverage tests below construct
// `debug` objects with no `cards` at all, relying on exactly this fallback for their still-valid,
// still-passing legacy assertions). An edge that is itself a member of the same canonically-tagged
// trunk, AT THE SPECIFIC SEGMENT(S) MEETING ITS OWN TERMINUS, as the segment it lands on is
// deliberate shared ink (verifyGeometry checks #5/#6's own exception), never "unowned" — excluded
// here the same way. A trunk id an edge carries only on some OTHER, disconnected part of its own
// path (a different shared span nearer a different parent) must not suppress a check at THIS
// terminus — ownership is scoped to the terminus itself, not to the edge as a whole (fixed
// 2026-07-26, C2-R3: the previous whole-edge-trunk-set version could wrongly suppress a genuinely
// foreign touch when an edge's terminus segment carried no trunk but a later segment on the same
// edge happened to reuse a trunk id a foreign segment also carried).
export function findUnownedJunctions(debug) {
  const EPS = 0.5;
  const onSeg = (x, y, s) =>
    s.kind === "h"
      ? Math.abs(y - s.y1) < EPS && x > Math.min(s.x1, s.x2) - EPS && x < Math.max(s.x1, s.x2) + EPS
      : Math.abs(x - s.x1) < EPS && y > Math.min(s.y1, s.y2) - EPS && y < Math.max(s.y1, s.y2) + EPS;
  const byEdge = new Map();
  for (const s of debug.segs) {
    if (!byEdge.has(s.edge)) byEdge.set(s.edge, []);
    byEdge.get(s.edge).push(s);
  }
  const cardY = new Map((debug.cards || []).map((c) => [c.id, c.y]));
  const termini = new Map();
  for (const [edge, segs] of byEdge) {
    const arrow = edge.indexOf("->");
    const fromY = arrow < 0 ? undefined : cardY.get(edge.slice(0, arrow));
    const toY = arrow < 0 ? undefined : cardY.get(edge.slice(arrow + 2));
    const wantMin = !(fromY != null && toY != null && toY > fromY);
    let best = null;
    for (const s of segs) {
      for (const [x, y] of [[s.x1, s.y1], [s.x2, s.y2]]) {
        if (!best || (wantMin ? y < best.y : y > best.y)) best = { x, y };
      }
    }
    termini.set(edge, best);
  }
  const problems = [];
  for (const [edgeA, { x: ax, y: ay }] of termini) {
    const segsA = byEdge.get(edgeA);
    // Ownership at this specific terminus is established only by the segment(s) of A's own path
    // that actually meet AT this point (an exact endpoint match) — not by any trunk id A happens
    // to carry elsewhere on a disconnected part of its own route.
    const ownTrunksHere = new Set(
      segsA
        .filter((s) => (s.x1 === ax && s.y1 === ay) || (s.x2 === ax && s.y2 === ay))
        .map((s) => s.trunk)
        .filter((t) => t != null)
    );
    for (const [edgeB, segsB] of byEdge) {
      if (edgeA === edgeB) continue;
      const hit = segsB.find((b) => !(b.trunk != null && ownTrunksHere.has(b.trunk)) && onSeg(ax, ay, b));
      if (hit) problems.push(`unowned T-junction: ${edgeA}'s parent-facing terminus (${ax.toFixed(1)},${ay.toFixed(1)}) lands on ${edgeB}'s segment`);
    }
  }
  return problems;
}

// Total Manhattan (taxicab) length of every drawn connector segment, summed across all edges —
// including duplicated shared-trunk portions (every edge keeps its own complete polyline, per
// C29), so this is the true rendered ink length, not a de-duplicated topological length.
export function manhattanLength(debug) {
  return debug.segs.reduce((sum, s) => sum + (s.x2 - s.x1) + (s.y2 - s.y1), 0);
}

// sanity checks on the SVG string itself
export function verifySvgString(svg) {
  const problems = [];
  if (!svg.startsWith("<svg")) problems.push("svg does not start with <svg");
  if (!svg.includes("</svg>")) problems.push("svg is not closed");
  const bad = svg.match(/NaN|Infinity|undefined|null/);
  if (bad) problems.push(`svg contains "${bad[0]}"`);
  // every opened tag closes (cheap structural check)
  for (const tag of ["g", "text", "defs", "svg"]) {
    const open = (svg.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const close = (svg.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (open !== close) problems.push(`unbalanced <${tag}>: ${open} open, ${close} close`);
  }
  return problems;
}
