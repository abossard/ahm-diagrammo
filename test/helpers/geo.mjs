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
export function verifyGeometry(result, { checkTexts = true, maxWidth } = {}) {
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

  // 5. horizontal segments of different edges never overlap collinearly (share a y and an x-range)
  //    — UNLESS both segments carry the same non-null `trunk` tag: a deliberate, intentional
  //    shared-bundle coincidence (see C24/C29 — a group of edges sharing a target rides one
  //    genuinely-coincident trunk, tagged with the target's id). A different (or absent) trunk
  //    tag on either side is still flagged exactly as before; this is a narrow, tag-gated
  //    exception, not a general loosening of the anti-accidental-overlap guarantee.
  const sameTrunk = (a, b) => a.trunk != null && a.trunk === b.trunk;
  const hs = debug.segs.filter((s) => s.kind === "h");
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i], b = hs[j];
      if (a.edge === b.edge || sameTrunk(a, b)) continue;
      if (Math.abs(a.y1 - b.y1) < 1.5 && a.x1 + 1 < b.x2 && b.x1 + 1 < a.x2)
        problems.push(`collinear horizontal overlap between ${a.edge} and ${b.edge} at y≈${a.y1.toFixed(0)}`);
    }

  // 6. vertical segments of different edges never overlap collinearly (same trunk-tag exception)
  const vs = debug.segs.filter((s) => s.kind === "v");
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i], b = vs[j];
      if (a.edge === b.edge || sameTrunk(a, b)) continue;
      if (Math.abs(a.x1 - b.x1) < 1.5 && a.y1 + 1 < b.y2 && b.y1 + 1 < a.y2)
        problems.push(`collinear vertical overlap between ${a.edge} and ${b.edge} at x≈${a.x1.toFixed(0)}`);
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
export function countCrossings(debug) {
  const EPS = 1e-6;
  const vs = debug.segs.filter((s) => s.kind === "v");
  const hs = debug.segs.filter((s) => s.kind === "h");
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
