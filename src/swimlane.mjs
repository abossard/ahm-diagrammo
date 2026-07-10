// swimlane.mjs — auto-layout swimlane SVG renderer for health-model `flowchart BT` blocks.
// Parses the block into a graph, folds signal nodes into their entity as a status table, layers
// the graph into lanes (longest path to the root), orders columns by barycenter, and renders a
// technical-documentation figure with roll-up connectors, pill edge labels, and a legend.
// Native SVG text only (renders inside <img> on Microsoft Learn).

import { splitFrontmatter } from "./extract.mjs";
import { getTheme } from "./themes.mjs";

const STATE_LABEL = { healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unknown: "Unknown", alt: "Standby" };
const CLASS_STATE = { blue: "signal", green: "healthy", amber: "degraded", red: "unhealthy", purple: "alt" };

// ---------- icons (24x24, stroke) ----------
function icon(name, stroke) {
  const s = `fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const P = {
    root: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" ${s}/>`,
    flow: `<circle cx="5.5" cy="6" r="2" ${s}/><circle cx="5.5" cy="18" r="2" ${s}/><circle cx="18.5" cy="12" r="2" ${s}/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" ${s}/>`,
    web: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" ${s}/>`,
    app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" ${s}/><rect x="4" y="13.5" width="16" height="6" rx="1.2" ${s}/><path d="M7.2 7.5h.01M7.2 16.5h.01" ${s}/>`,
    db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" ${s}/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" ${s}/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" ${s}/>`,
    queue: `<rect x="4" y="5" width="16" height="3" rx="1" ${s}/><rect x="4" y="10.5" width="16" height="3" rx="1" ${s}/><rect x="4" y="16" width="10" height="3" rx="1" ${s}/>`,
    ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${s}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${s}/>`,
    analytics: `<path d="M4 20h16" ${s}/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" ${s}/>`,
    signal: `<path d="M3.2 16.5l4.4-5.4 3.4 3.4 4.4-7 3.4 4.2" ${s}/>`,
    bolt: `<path d="M13 2.5 5.5 13.5H11l-1 8 8.5-12H12z" ${s}/>`,
    cache: `<rect x="3.5" y="4" width="17" height="16" rx="2" ${s}/><path d="M8 4v16M3.5 9.5h4M3.5 14.5h4" ${s}/>`,
    shield: `<path d="M12 3l7 2.6v5.2c0 4.6-3 7.9-7 9.2-4-1.3-7-4.6-7-9.2V5.6z" ${s}/><path d="M8.8 12.2l2.2 2.2 4-4.6" ${s}/>`,
    cube: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${s}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${s}/>`,
  };
  return P[name] || P.cube;
}

// relationship label as a rounded pill sitting on the connector
function edgeLabelPill(T, label, cx, cy) {
  const fs = 10.5, padX = 10, h = 20, tw = label.length * fs * 0.56, w = tw + padX * 2;
  return `<g stroke="none">`
    + `<rect x="${(cx - w / 2).toFixed(1)}" y="${(cy - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="${h / 2}" fill="${T.pillFill}" stroke="${T.pillStroke}" stroke-width="1"/>`
    + `<text x="${cx.toFixed(1)}" y="${(cy + fs * 0.34).toFixed(1)}" font-size="${fs}" font-weight="600" fill="${T.ink}" text-anchor="middle">${esc(label)}</text>`
    + `</g>`;
}
// small metric bar-chart glyph for signal-table rows
function metricIcon(T, x, y, size = 14) {
  const s = size / 16, [a, b, c] = T.metricBars;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <rect x="1.5" y="8" width="2.6" height="6" rx="0.6" fill="${a}"/>
    <rect x="5.7" y="4.5" width="2.6" height="9.5" rx="0.6" fill="${b}"/>
    <rect x="9.9" y="6.5" width="2.6" height="7.5" rx="0.6" fill="${c}"/>
  </g>`;
}
// status symbol: healthy = disc + check; others = filled disc in state color
function statusDot(T, state, cx, cy) {
  const st = T.state[state] || T.state.unknown;
  if (state === "healthy") {
    return `<circle cx="${cx}" cy="${cy}" r="6" fill="${st.dot}"/><path d="M${cx - 2.7} ${cy} l1.9 1.9 l3.4 -3.9" fill="none" stroke="${T.bg}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<circle cx="${cx}" cy="${cy}" r="6" fill="${st.dot}"/>`;
}
function pickIcon(label) {
  const t = label.toLowerCase();
  const has = (...w) => w.some((x) => t.includes(x));
  if (has("root")) return "root";
  if (has("front door", "frontend", "web ", "website", "cdn", "web app")) return "web";
  if (has("api", "function", "serverless", "endpoint")) return "bolt";
  if (has("event", "grid")) return "bolt";
  if (has("cache", "redis")) return "cache";
  if (has("database", "sql", "cosmos", "db", "store", "storage")) return "db";
  if (has("queue", "message", "dead-letter", "service bus", "event hub", "hub")) return "queue";
  if (has("ship", "carrier", "logistics", "delivery", "sink")) return "ship";
  if (has("analytics", "report", "pipeline", "ingest", "index", "search", "batch", "scheduler")) return "analytics";
  if (has("security", "defender", "firewall", "waf", "auth", "identity", "entra", "key vault", "secret", "safety")) return "shield";
  if (has("kubernetes", "container", "aks", "pod", "cluster")) return "cube";
  if (has("model", "nested")) return "cube";
  if (has("app", "hosting", "compute", "vm", "worker", "processor", "agent", "tool")) return "app";
  if (has("shop", "commerce", "checkout", "catalog", "order", "payment", "fraud", "flow", "gateway")) return "flow";
  return "cube";
}

// ---------- parse one flowchart BT block into a graph ----------
function cleanLabel(raw) {
  return raw.replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "")
    .replace(/^["']|["']$/g, "").split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean);
}
const NODE = "([A-Za-z][\\w]*)(?:\\[([^\\]]*)\\])?";
export function parseGraph(code) {
  const nodes = new Map(); // id -> { id, lines:[], order }
  const edges = [];        // { from, to, dashed, label }
  const nodeClass = new Map();
  let order = 0;
  const ensure = (id) => { if (!nodes.has(id)) nodes.set(id, { id, lines: [id], order: order++ }); return nodes.get(id); };
  const setLabel = (id, br) => { const n = ensure(id); if (br != null) { const l = cleanLabel(br); if (l.length) n.lines = l; } };

  for (let line of code.split("\n")) {
    line = line.replace(/%%.*$/, "").trim();
    if (!line) continue;
    if (/^classDef\b/.test(line)) continue;
    const cm = line.match(/^class\s+([^;]+?)\s+(\w+)\s*;?$/);
    if (cm) { cm[1].split(",").forEach((id) => nodeClass.set(id.trim(), cm[2])); continue; }
    // edge: NODE (op) NODE   op in { -->, -->|label|, -- label -->, -. label .-> }
    const em = line.match(new RegExp(`^${NODE}\\s*(-->\\s*\\|[^|]*\\||--\\s*"[^"]*"\\s*-->|-->|-\\.\\s*(?:"[^"]*"|[\\w ]+?)?\\s*\\.->)\\s*${NODE}`));
    if (em) {
      const [, fromId, fromBr, op, toId, toBr] = em;
      setLabel(fromId, fromBr); setLabel(toId, toBr); ensure(fromId); ensure(toId);
      const dashed = op.startsWith("-.");
      let label = null;
      const lm = op.match(/-\.\s*(?:"([^"]*)"|([\w ]+?))\s*\.->/)      // dashed label
        || op.match(/-->\s*\|([^|]*)\|/)                              // solid |label|
        || op.match(/--\s*"([^"]*)"\s*-->/);                          // solid "label"
      if (lm) label = cleanLabel(lm[1] ?? lm[2] ?? "").join(" ");
      edges.push({ from: fromId, to: toId, dashed, label: label || null });
      continue;
    }
    // standalone node def
    const nm = line.match(new RegExp(`^${NODE}\\s*;?$`));
    if (nm && nm[2] != null) setLabel(nm[1], nm[2]);
  }
  // resolve state per node
  for (const n of nodes.values()) n.state = CLASS_STATE[nodeClass.get(n.id)] || "unknown";
  return { nodes, edges };
}

// ---------- fold signals INTO their owning entity ----------
// In the product, signals are contained in an entity, not separate related nodes. Mermaid can only
// express containment as a child node + edge, so we fold every `class blue` signal node into the
// entity it points to, attach its metric lines as signal rows, then drop the node and edge.
//
// A metric line can carry its own result and state:  "P95 latency = 230 ms (degraded)"
const SIGNAL_WORDS = new Set(["signal", "signals"]);
const ROW_RE = /^(.*?)(?:\s*=\s*([^()]+?))?\s*(?:\((healthy|degraded|unhealthy|unknown)\))?$/;
export function foldSignals(g) {
  const remove = new Set();
  const isSig = (id) => g.nodes.get(id)?.state === "signal";
  const targetsOf = new Map();
  for (const e of g.edges) {
    if (isSig(e.from)) {
      if (!targetsOf.has(e.from)) targetsOf.set(e.from, []);
      targetsOf.get(e.from).push(e.to);
    }
  }
  for (const [sigId, targets] of targetsOf) {
    const s = g.nodes.get(sigId);
    const metrics = s.lines.filter((l) => !SIGNAL_WORDS.has(l.toLowerCase()));
    const owners = targets.filter((t) => !isSig(t));
    if (owners.length === 0) continue; // orphan/edge to another signal — leave as-is
    for (const t of owners) {
      const owner = g.nodes.get(t);
      owner.signals = owner.signals || [];
      for (const m of metrics) {
        const [, name, result, state] = m.match(ROW_RE);
        owner.signals.push({ name: name.trim(), state: state || "healthy", result: result?.trim() || null });
      }
    }
    remove.add(sigId);
  }
  g.edges = g.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to));
  for (const id of remove) g.nodes.delete(id);

  // synthesize per-row state: a non-healthy entity's primary signal takes that state (unless the
  // author already marked a row), plus a plausible deterministic Result for rows without one
  for (const n of g.nodes.values()) {
    if (!n.signals || !n.signals.length) continue;
    const anyMarked = n.signals.some((r) => r.state !== "healthy");
    if (!anyMarked && (n.state === "degraded" || n.state === "unhealthy")) n.signals[0].state = n.state;
    for (const row of n.signals) if (row.result == null) row.result = synthResult(row.name, row.state);
  }
  return g;
}
function synthResult(name, state) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  if (state === "healthy") return String(h % 3);            // 0..2
  if (state === "degraded") return String(5 + (h % 15));    // 5..19
  return String(30 + (h % 90));                             // 30..119 (unhealthy)
}

// ---------- layer + order ----------
const STATE_WORDS = new Set(["healthy", "degraded", "unhealthy", "standby", "unavailable", "unknown", "stuck"]);
export function layout(g) {
  const ids = [...g.nodes.keys()];
  const parents = new Map(ids.map((i) => [i, []]));  // outgoing targets (upper)
  const children = new Map(ids.map((i) => [i, []])); // incoming sources (lower)
  for (const e of g.edges) { parents.get(e.from).push(e.to); children.get(e.to).push(e.from); }

  // depth = longest path to a root (node with no parents). root depth 0.
  const depth = new Map();
  const calc = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0; seen.add(id);
    const ps = parents.get(id);
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => calc(p, seen)));
    depth.set(id, d); return d;
  };
  ids.forEach((i) => calc(i));

  // populated depths -> lane index
  const present = [...new Set(ids.map((i) => depth.get(i)))].sort((a, b) => a - b);
  const laneOf = new Map(present.map((d, idx) => [d, idx]));
  const L = present.length;
  const laneNodes = Array.from({ length: L }, () => []);
  for (const id of ids) laneNodes[laneOf.get(depth.get(id))].push(id);
  laneNodes.forEach((arr) => arr.sort((a, b) => g.nodes.get(a).order - g.nodes.get(b).order));

  // barycenter ordering sweeps
  const posIn = (arr) => new Map(arr.map((id, i) => [id, i]));
  for (let it = 0; it < 6; it++) {
    for (let i = 1; i < L; i++) {
      const up = posIn(laneNodes[i - 1]);
      laneNodes[i] = stableBy(laneNodes[i], (id) => bary(parents.get(id), up));
    }
    for (let i = L - 2; i >= 0; i--) {
      const dn = posIn(laneNodes[i + 1]);
      laneNodes[i] = stableBy(laneNodes[i], (id) => bary(children.get(id), dn));
    }
  }
  return { depth, laneOf, laneNodes, L, parents, children };
}
function bary(neigh, posMap) {
  const xs = neigh.map((n) => posMap.get(n)).filter((v) => v != null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function stableBy(arr, keyFn) {
  return arr.map((id, i) => ({ id, i, k: keyFn(id) }))
    .sort((a, b) => (a.k == null ? a.i : a.k) - (b.k == null ? b.i : b.k) || a.i - b.i)
    .map((o) => o.id);
}

// ---------- lane labels (no Signals lane — signals live inside entities) ----------
function laneLabels(L, custom) {
  if (Array.isArray(custom) && custom.length) {
    const out = custom.slice(0, L).map(String);
    while (out.length < L) out.push(`Layer ${out.length}`);
    return out;
  }
  if (L === 1) return ["Workload root"];
  if (L === 2) return ["Workload root", "Application components"];
  if (L === 3) return ["Workload root", "Business & user flows", "Application components"];
  const middle = ["Business & user flows", "Application components", "Dependencies", "Subsystems"];
  const out = ["Workload root"];
  for (let i = 0; i < L - 1; i++) out.push(middle[i] || `Layer ${i + 1}`);
  return out.slice(0, L);
}

// ---------- render ----------
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function wrapLabel(label) {
  if (label.length <= 15) return [label];
  const w = label.split(" "), h = Math.ceil(w.length / 2);
  return [w.slice(0, h).join(" "), w.slice(h).join(" ")];
}

// rounded orthogonal polyline through points (portal-style elbow connectors)
function roundedOrtho(pts, r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const d1 = Math.hypot(p.x - a.x, p.y - a.y), d2 = Math.hypot(b.x - p.x, b.y - p.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const u1x = (p.x - a.x) / (d1 || 1), u1y = (p.y - a.y) / (d1 || 1);
    const u2x = (b.x - p.x) / (d2 || 1), u2y = (b.y - p.y) / (d2 || 1);
    d += ` L${(p.x - u1x * rr).toFixed(1)} ${(p.y - u1y * rr).toFixed(1)} Q${p.x} ${p.y} ${(p.x + u2x * rr).toFixed(1)} ${(p.y + u2y * rr).toFixed(1)}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}

function render(g, lay, opts) {
  const T = opts.theme;
  const { laneNodes, L } = lay;
  const GAP = 30, HEADER_H = 34, ROW_H = 18, TABLE_PAD = 8, COMPACT_H = 58;
  const hasSignals = (id) => (g.nodes.get(id).signals || []).length > 0;
  const anySignals = [...g.nodes.keys()].some(hasSignals);
  const CARD_W = anySignals ? 246 : 168;
  const cardH = (id) => {
    const sigs = g.nodes.get(id).signals || [];
    if (!sigs.length) return COMPACT_H;
    return HEADER_H + 5 + sigs.length * ROW_H + TABLE_PAD;
  };
  const maxK = Math.max(...laneNodes.map((a) => a.length), 1);
  const contentW = Math.max(1040, maxK * (CARD_W + GAP));
  const M = { top: 78, left: 40, gutter: 200 };
  const PILL_H = 20, PITCH_V = PILL_H + 6, TOPPAD = 18, BASE_GAP = 44;
  const stateRank = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3 };

  // node x positions (needed before lane heights so we can pre-compute label levels)
  const pos = new Map();
  laneNodes.forEach((arr, li) => {
    const k = arr.length, span = contentW / k;
    arr.forEach((id, j) => pos.set(id, { x: M.left + span * (j + 0.5), lane: li }));
  });
  const nodeX = (id) => pos.get(id).x;
  const pillW = (label) => label.length * 10.5 * 0.56 + 20;

  // Pre-pass: every labeled edge gets a pill; greedily assign vertical "levels" per parent lane so
  // pills whose padded x-ranges overlap land on different levels (no pill/line overlaps).
  const labeledEdges = g.edges.filter((e) => e.label);
  const labByPLane = new Map();
  for (const e of labeledEdges) { const ln = pos.get(e.to).lane; (labByPLane.get(ln) || labByPLane.set(ln, []).get(ln)).push(e); }
  const labelLevels = laneNodes.map(() => 0);
  const edgeLevel = new Map();
  for (const [ln, es] of labByPLane) {
    const items = es.map((e) => {
      const cx = nodeX(e.from), px = nodeX(e.to), pad = Math.max(30, pillW(e.label) / 2);
      return { e, midX: cx, xL: Math.min(cx, px) - pad, xR: Math.max(cx, px) + pad };
    }).sort((a, b) => a.xL - b.xL);
    const levels = [];
    for (const it of items) {
      let lvl = 0;
      for (; ; lvl++) { const occ = levels[lvl] || (levels[lvl] = []); if (occ.every(([a, b]) => it.xR < a || it.xL > b)) { occ.push([it.xL, it.xR]); break; } }
      edgeLevel.set(it.e, lvl);
    }
    labelLevels[ln] = levels.length;
  }

  // lane height = toppad + tallest card + base gap + reserved label rows
  const laneMaxH = laneNodes.map((arr) => Math.max(COMPACT_H, ...arr.map(cardH)));
  const laneH = laneMaxH.map((mh, i) => TOPPAD + mh + BASE_GAP + labelLevels[i] * PITCH_V);
  const W = M.left + contentW + M.gutter;
  let y = M.top;
  const laneY = laneH.map((h) => { const o = { top: y, h, mid: y + h / 2 }; y += h; return o; });
  const H = y + 18;
  const labels = laneLabels(L, opts.lanes);

  // cards top-aligned near the lane top (headers line up); label rows live in the gap below
  const laneTop = laneY.map((l) => l.top + TOPPAD);
  const boxCache = new Map();
  const boxOf = (id) => {
    if (boxCache.has(id)) return boxCache.get(id);
    const p = pos.get(id), h = cardH(id), top = laneTop[p.lane];
    const b = { x: p.x - CARD_W / 2, y: top, w: CARD_W, h, cx: p.x, cy: top + h / 2, top, bottom: top + h };
    boxCache.set(id, b); return b;
  };

  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif">`);
  out.push(`<defs><filter id="cs" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.3" flood-color="#000" flood-opacity="${T.shadowOpacity}"/></filter>`);
  out.push(Object.entries(T.state).map(([k, v]) => `<marker id="ar-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${v.border}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`).join(""));
  out.push(`</defs><rect width="${W}" height="${H}" fill="${T.bg}"/>`);

  // lane bands + labels
  laneY.forEach((l, i) => {
    out.push(`<rect x="0" y="${l.top}" width="${W}" height="${l.h}" fill="${i % 2 ? T.band : T.bg}"/>`);
    out.push(`<line x1="0" y1="${l.top}" x2="${W}" y2="${l.top}" stroke="${T.hair}"/>`);
    const lx = M.left + contentW + 24, lines = wrapLabel(labels[i] || "");
    if (lines.length === 1) out.push(`<text x="${lx}" y="${l.mid + 5}" font-size="13" font-weight="700" fill="${T.laneLabel}">${esc(lines[0])}</text>`);
    else { out.push(`<text x="${lx}" y="${l.mid - 2}" font-size="13" font-weight="700" fill="${T.laneLabel}">${esc(lines[0])}</text>`); out.push(`<text x="${lx}" y="${l.mid + 15}" font-size="13" font-weight="700" fill="${T.laneLabel}">${esc(lines[1])}</text>`); }
  });
  out.push(`<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="${T.hair}"/>`);

  // title + subtitle + legend
  if (opts.title) out.push(`<text x="${M.left}" y="34" font-size="18" font-weight="700" fill="${T.ink}">${esc(opts.title)}</text>`);
  const subtitle = opts.subtitle ?? "Signals live inside each entity; health rolls up to the workload root.";
  if (subtitle) out.push(`<text x="${M.left}" y="52" font-size="12" fill="${T.muted}">${esc(subtitle)}</text>`);
  if (opts.legend !== false) out.push(legend(T, W));

  // edges — portal-style orthogonal connectors. Unlabeled solid edges bundle by parent; unlabeled
  // dashed edges are individual elbows; labeled edges route individually with their pill on the
  // edge's own reserved horizontal level. Stubs take the child's state color.
  const solidByParent = new Map();
  const dashedPlain = [];
  for (const e of g.edges) {
    if (e.label) continue;
    if (e.dashed) dashedPlain.push(e);
    else (solidByParent.get(e.to) || solidByParent.set(e.to, []).get(e.to)).push(e);
  }
  out.push(`<g fill="none" stroke-linecap="butt" stroke-linejoin="round">`);
  for (const [parentId, es] of solidByParent) {
    const pb = boxOf(parentId);
    const kids = es.map((e) => ({ e, cb: boxOf(e.from), st: T.state[g.nodes.get(e.from).state] || T.state.unknown, rank: stateRank[g.nodes.get(e.from).state] })).sort((a, b) => a.cb.cx - b.cb.cx);
    const minChildTop = Math.min(...kids.map((k) => k.cb.top));
    const childLaneTop = Math.min(...kids.map((k) => laneY[pos.get(k.e.from).lane].top));
    const gapTop = Math.max(pb.bottom + 8, childLaneTop + 6);
    const gapBot = Math.max(gapTop + 2, minChildTop - 8);
    const pitch = 3;
    for (const k of kids) {
      k.oMin = Math.max(k.cb.x + 10, pb.x + 12);
      k.oMax = Math.min(k.cb.x + k.cb.w - 10, pb.x + pb.w - 12);
      k.straight = k.oMin <= k.oMax;
    }
    const straights = kids.filter((k) => k.straight);
    straights.forEach((k, j) => { const centered = pb.cx - ((straights.length - 1) * pitch) / 2 + j * pitch; k.x = Math.min(k.oMax, Math.max(k.oMin, centered)); });
    const sides = kids.filter((k) => !k.straight);
    sides.map((k) => k).sort((a, b) => Math.abs(b.cb.cx - pb.cx) - Math.abs(a.cb.cx - pb.cx)).forEach((k, rank) => { k.busY = Math.min(gapBot, gapTop + rank * pitch); });
    sides.forEach((k, j) => { const side = k.cb.cx < pb.cx ? -1 : 1; k.entryX = pb.cx + side * (pb.w / 2 - 14) - side * j * pitch; });
    for (const k of [...kids].sort((a, b) => a.rank - b.rank)) {
      const d = k.straight ? `M${k.x.toFixed(1)} ${k.cb.top} V${pb.bottom}` : roundedOrtho([{ x: k.cb.cx, y: k.cb.top }, { x: k.cb.cx, y: k.busY }, { x: k.entryX, y: k.busY }, { x: k.entryX, y: pb.bottom }], 7);
      out.push(`<path d="${d}" stroke="${k.st.border}" stroke-width="1.7"/>`);
    }
  }
  // unlabeled dashed
  for (const e of dashedPlain) {
    const cb = boxOf(e.from), pb = boxOf(e.to), st = T.state[g.nodes.get(e.from).state] || T.state.unknown;
    let busY = pb.bottom + (cb.top - pb.bottom) * 0.5;
    busY = Math.max(pb.bottom + 16, Math.min(cb.top - 16, busY));
    out.push(`<path d="${roundedOrtho([{ x: cb.cx, y: cb.top }, { x: cb.cx, y: busY }, { x: pb.cx, y: busY }, { x: pb.cx, y: pb.bottom }], 8)}" stroke="${st.border}" stroke-width="1.6" stroke-dasharray="5 4"/>`);
  }
  // labeled edges: individual routing, horizontal at this edge's reserved level, pill on that line
  const labelPills = [];
  for (const [ln, es] of labByPLane) {
    const laneBottom = laneY[ln].top + TOPPAD + laneMaxH[ln];
    for (const e of es.sort((a, b) => stateRank[g.nodes.get(a.from).state] - stateRank[g.nodes.get(b.from).state])) {
      const cb = boxOf(e.from), pb = boxOf(e.to), st = T.state[g.nodes.get(e.from).state] || T.state.unknown;
      const level = edgeLevel.get(e) || 0;
      const labelY = laneBottom + 16 + level * PITCH_V;
      const dash = e.dashed ? ` stroke-dasharray="5 4"` : "";
      const straight = Math.abs(cb.cx - pb.cx) < 1.5;
      const d = straight
        ? `M${cb.cx} ${cb.top} V${pb.bottom}`
        : roundedOrtho([{ x: cb.cx, y: cb.top }, { x: cb.cx, y: labelY }, { x: pb.cx, y: labelY }, { x: pb.cx, y: pb.bottom }], 7);
      out.push(`<path d="${d}" stroke="${st.border}" stroke-width="${e.dashed ? 1.6 : 1.7}"${dash}/>`);
      labelPills.push({ label: e.label, x: cb.cx, y: labelY });
    }
  }
  for (const lp of labelPills) out.push(edgeLabelPill(T, lp.label, lp.x, lp.y));
  out.push(`</g>`);

  // cards
  for (const id of g.nodes.keys()) out.push(entityCard(T, g.nodes.get(id), boxOf(id), HEADER_H, ROW_H));
  out.push(`</svg>`);
  return { svg: out.join("\n"), W, H };
}

// entity card: header (icon + name + state pill), plus an attached 4-column signal table
function entityCard(T, n, b, HEADER_H, ROW_H) {
  const st = T.state[n.state] || T.state.unknown;
  const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : "";
  const lines = n.lines.filter((l) => !STATE_WORDS.has(l.toLowerCase()));
  const name = lines[0] || n.lines[0] || n.id;
  const qualifier = lines.slice(1).find((l) => /\(|worst|min|at least|active|standby|single|region/i.test(l));
  const sigs = n.signals || [];
  const p = [];
  p.push(`<g filter="url(#cs)"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.border}" stroke-width="2"${dash}/></g>`);
  const headerMid = sigs.length ? b.y + HEADER_H / 2 : b.y + b.h / 2;
  const iconScale = 0.82;
  p.push(`<g transform="translate(${b.x + 6},${(headerMid - 12 * iconScale).toFixed(2)}) scale(${iconScale})">${icon(pickIcon(name), T.muted)}</g>`);
  const pillW = (STATE_LABEL[n.state] || "Unknown").length * 6.2 + 24, px = b.x + b.w - pillW - 8;
  const nameX = b.x + 34, avail = px - nameX - 8;
  let nsize = 12.5;
  for (const s of [12.5, 11.5, 10.5, 9.5]) { if (name.length * s * 0.56 <= avail) { nsize = s; break; } nsize = s; }
  let ntext = name;
  if (name.length * nsize * 0.56 > avail) { const max = Math.max(4, Math.floor(avail / (nsize * 0.56))); ntext = name.slice(0, max - 1) + "…"; }
  if (qualifier) {
    p.push(`<text x="${nameX}" y="${(headerMid - 5 + nsize * 0.34).toFixed(2)}" font-size="${nsize}" font-weight="600" fill="${T.ink}">${esc(ntext)}</text>`);
    p.push(`<text x="${nameX}" y="${(headerMid + 7 + 9 * 0.34).toFixed(2)}" font-size="9" fill="${T.muted}">${esc(qualifier.replace(/[()]/g, ""))}</text>`);
  } else {
    p.push(`<text x="${nameX}" y="${(headerMid + nsize * 0.34).toFixed(2)}" font-size="${nsize}" font-weight="600" fill="${T.ink}">${esc(ntext)}</text>`);
  }
  const py = headerMid - 9;
  p.push(`<rect x="${px}" y="${py.toFixed(2)}" width="${pillW}" height="18" rx="9" fill="${T.pillFill}" stroke="${st.border}" stroke-width="1"/>`);
  p.push(statusDot(T, n.state, px + 11, headerMid));
  p.push(`<text x="${px + 20}" y="${(headerMid + 10.5 * 0.34).toFixed(2)}" font-size="10.5" fill="${T.laneLabel}">${STATE_LABEL[n.state] || "Unknown"}</text>`);

  if (sigs.length) {
    const tY = b.y + HEADER_H + 3;
    p.push(`<line x1="${b.x + 1}" y1="${tY}" x2="${b.x + b.w - 1}" y2="${tY}" stroke="${T.hair}"/>`);
    const iconX = b.x + 32, nameX2 = b.x + 52, resX = b.x + b.w - 12;
    sigs.forEach((s, i) => {
      const ry = tY + 6 + i * ROW_H + ROW_H / 2;
      if (i > 0) p.push(`<line x1="${b.x + 10}" y1="${ry - ROW_H / 2}" x2="${b.x + b.w - 10}" y2="${ry - ROW_H / 2}" stroke="${T.hair}" stroke-opacity="0.7"/>`);
      p.push(statusDot(T, s.state, b.x + 16, ry));
      p.push(metricIcon(T, iconX, ry - 7, 14));
      const maxName = 26, nm = s.name.length > maxName ? s.name.slice(0, maxName - 1) + "…" : s.name;
      p.push(`<text x="${nameX2}" y="${ry + 3.5}" font-size="10.5" fill="${T.ink}">${esc(nm)}</text>`);
      const rs = T.state[s.state] || T.state.healthy;
      p.push(`<text x="${resX}" y="${ry + 3.5}" font-size="10.5" font-weight="${s.state === "healthy" ? 400 : 600}" fill="${s.state === "healthy" ? T.muted : rs.dot}" text-anchor="end">${esc(s.result ?? "")}</text>`);
    });
  }
  return p.join("");
}

function legend(T, W) {
  const items = [["Healthy", T.state.healthy.dot], ["Degraded", T.state.degraded.dot], ["Unhealthy", T.state.unhealthy.dot], ["Unknown", T.state.unknown.dot]];
  let total = 0;
  for (const [label] of items) total += 26 + label.length * 6.4;
  total += 22 + "Metric".length * 6.4;
  let x = W - 40 - total, yy = 44;
  const p = [`<text x="${x - 12}" y="${yy + 4}" font-size="11.5" font-weight="600" fill="${T.muted}" text-anchor="end">Legend</text>`];
  for (const [label, color] of items) { p.push(`<circle cx="${x + 6}" cy="${yy}" r="4.5" fill="${color}"/>`); p.push(`<text x="${x + 16}" y="${yy + 4}" font-size="11.5" fill="${T.laneLabel}">${label}</text>`); x += 26 + label.length * 6.4; }
  p.push(metricIcon(T, x, yy - 7, 14)); p.push(`<text x="${x + 18}" y="${yy + 4}" font-size="11.5" fill="${T.laneLabel}">Metric</text>`);
  return p.join("");
}

// Heuristic used by the CLI's auto renderer selection: a `flowchart BT` whose classes bind to the
// health palette (green/amber/red/blue/purple) is a health model.
export function looksLikeHealthModel(code) {
  const { body } = splitFrontmatter(code);
  if (!/^\s*(flowchart|graph)\s+BT\b/m.test(body)) return false;
  return /^\s*class\s+[^;]+\s+(blue|green|amber|red|purple)\s*;?\s*$/m.test(body);
}

// ---------- public API ----------
// opts: { theme: name|object, title, subtitle, lanes: [..], legend: bool }
export function renderSwimlane(code, opts = {}) {
  const { body } = splitFrontmatter(code);
  const theme = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  const g = parseGraph(body);
  if (g.nodes.size === 0) throw new Error("no nodes parsed");
  foldSignals(g);
  const lay = layout(g);
  const { svg, W, H } = render(g, lay, { ...opts, theme });
  if (!svg.includes("</svg>")) throw new Error("incomplete svg");
  return { svg, W, H, nodes: g.nodes.size, lanes: lay.L };
}
