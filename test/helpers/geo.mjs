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
export function verifyGeometry(result, { checkTexts = true } = {}) {
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

  // 3. error panels remain inside their entity cards and the canvas
  for (const panel of debug.errorPanels ?? []) {
    const owner = debug.cards.find((card) =>
      panel.x >= card.x - EPS && panel.x + panel.w <= card.x + card.w + EPS &&
      panel.y >= card.y - EPS && panel.y + panel.h <= card.y + card.h + EPS);
    if (!owner) problems.push(`error panel ${fmtRect(panel)} leaves its entity card`);
    if (panel.x < -EPS || panel.x + panel.w > W + EPS || panel.y < -EPS || panel.y + panel.h > H + EPS)
      problems.push(`error panel ${fmtRect(panel)} leaves the canvas ${W}×${H}`);
  }

  // 4. pills: inside canvas, disjoint from each other, from every card, and from every
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

  // 5. connector segments never pass through a card's interior. Verticals may touch a card at
  //    its top/bottom edge (that's how they connect); shrink each card by the connection slack.
  for (const s of debug.segs) {
    for (const c of debug.cards) {
      const inner = { x: c.x + 2, y: c.y + 2, w: c.w - 4, h: c.h - 4 };
      const segRect = { x: s.x1, y: s.y1, w: Math.max(s.x2 - s.x1, 0.1), h: Math.max(s.y2 - s.y1, 0.1) };
      if (rectsOverlap(inner, segRect))
        problems.push(`connector ${s.edge} passes through card ${fmtRect(c)} (${s.kind} seg ${s.x1.toFixed(0)},${s.y1.toFixed(0)}→${s.x2.toFixed(0)},${s.y2.toFixed(0)})`);
    }
  }

  // 6. horizontal segments of different edges never overlap collinearly (share a y and an x-range)
  const hs = debug.segs.filter((s) => s.kind === "h");
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i], b = hs[j];
      if (a.edge === b.edge) continue;
      if (Math.abs(a.y1 - b.y1) < 1.5 && a.x1 + 1 < b.x2 && b.x1 + 1 < a.x2)
        problems.push(`collinear horizontal overlap between ${a.edge} and ${b.edge} at y≈${a.y1.toFixed(0)}`);
    }

  // 7. vertical segments of different edges never overlap collinearly
  const vs = debug.segs.filter((s) => s.kind === "v");
  for (let i = 0; i < vs.length; i++)
    for (let j = i + 1; j < vs.length; j++) {
      const a = vs[i], b = vs[j];
      if (a.edge === b.edge) continue;
      if (Math.abs(a.x1 - b.x1) < 1.5 && a.y1 + 1 < b.y2 && b.y1 + 1 < a.y2)
        problems.push(`collinear vertical overlap between ${a.edge} and ${b.edge} at x≈${a.x1.toFixed(0)}`);
    }

  // 8. every text box stays inside the canvas and inside its declared container
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

    const cardContainers = [...debug.cards, ...(debug.errorPanels ?? [])];
    const containerIndex = (container) => cardContainers.findIndex((candidate) =>
      Math.abs(container.x - candidate.x) < EPS &&
      Math.abs(container.y - candidate.y) < EPS &&
      Math.abs(container.w - candidate.w) < EPS &&
      Math.abs(container.h - candidate.h) < EPS);
    for (let left = 0; left < debug.texts.length; left++) {
      const a = debug.texts[left];
      if (!a.container) continue;
      const owner = containerIndex(a.container);
      if (owner < 0) continue;
      for (let right = left + 1; right < debug.texts.length; right++) {
        const b = debug.texts[right];
        if (!b.container || containerIndex(b.container) !== owner) continue;
        if (rectsOverlap(a, b))
          problems.push(`texts overlap in one container: ${fmtRect(a)} ∩ ${fmtRect(b)}`);
      }
    }
  }

  return problems;
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
