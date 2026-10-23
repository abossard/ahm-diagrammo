// swimlane.mjs — auto-layout swimlane SVG renderer for health-model `flowchart BT` blocks.
//
// Pipeline (Sugiyama-style layered drawing):
//   parse     → graph + diagnostics (every line classified; unrecognized lines get warnings)
//   fold      → signal nodes become status-table rows inside their owning entity
//   layer     → longest path to a root; barycenter ordering to reduce crossings
//   measure   → every text is measured (src/text.mjs); cards size to content, wrap before
//               they truncate, and anything clipped gets a tooltip + diagnostic
//   position  → 1-D constrained projection per lane (src/layout.mjs) — cards never overlap,
//               parents center over children
//   route     → channels between lanes hold a bus strip (tight per-parent bundles) plus
//               reserved tracks (interval coloring) for labeled/dashed/lane-skipping edges;
//               lane-skipping edges ride corridors between cards; label pills slide away
//               from crossing connectors
//   render    → native-SVG-text figure + a debug geometry model tests can verify
//
// Native SVG text only (renders inside <img> on Microsoft Learn).

import { splitFrontmatter } from "./extract.mjs";
import { getTheme } from "./themes.mjs";
import { textWidth, wrapText } from "./text.mjs";
import { Diagnostics } from "./diag.mjs";
import { relaxCoordinates } from "./layout.mjs";
import { planRoutes } from "./swimlane-route.mjs";

const STATE_LABEL = { healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unknown: "Unknown", alt: "Standby" };
const CLASS_STATE = { blue: "signal", green: "healthy", amber: "degraded", red: "unhealthy", purple: "alt" };
const STATE_WORDS = new Set(["healthy", "degraded", "unhealthy", "standby", "unavailable", "unknown", "stuck"]);

// ---------- icons (24x24, stroke; %S% stands for the stroke attributes) ----------
const ICON_PATHS = {
  root: `<circle cx="12" cy="12" r="8.4" %S%/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" %S%/>`,
  flow: `<circle cx="5.5" cy="6" r="2" %S%/><circle cx="5.5" cy="18" r="2" %S%/><circle cx="18.5" cy="12" r="2" %S%/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" %S%/>`,
  web: `<circle cx="12" cy="12" r="8.4" %S%/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" %S%/>`,
  app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" %S%/><rect x="4" y="13.5" width="16" height="6" rx="1.2" %S%/><path d="M7.2 7.5h.01M7.2 16.5h.01" %S%/>`,
  db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" %S%/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" %S%/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" %S%/>`,
  queue: `<rect x="4" y="5" width="16" height="3" rx="1" %S%/><rect x="4" y="10.5" width="16" height="3" rx="1" %S%/><rect x="4" y="16" width="10" height="3" rx="1" %S%/>`,
  ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" %S%/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" %S%/>`,
  analytics: `<path d="M4 20h16" %S%/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" %S%/>`,
  bolt: `<path d="M13 2.5 5.5 13.5H11l-1 8 8.5-12H12z" %S%/>`,
  cache: `<rect x="3.5" y="4" width="17" height="16" rx="2" %S%/><path d="M8 4v16M3.5 9.5h4M3.5 14.5h4" %S%/>`,
  shield: `<path d="M12 3l7 2.6v5.2c0 4.6-3 7.9-7 9.2-4-1.3-7-4.6-7-9.2V5.6z" %S%/><path d="M8.8 12.2l2.2 2.2 4-4.6" %S%/>`,
  cube: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" %S%/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" %S%/>`,
};
// first matching keyword list (in this order) picks the header icon; no match → cube
const ICON_KEYWORDS = [
  ["root", ["root"]],
  ["web", ["front door", "frontend", "web ", "website", "cdn", "web app"]],
  ["bolt", ["api", "function", "serverless", "endpoint"]],
  ["bolt", ["event", "grid"]],
  ["cache", ["cache", "redis"]],
  ["db", ["database", "sql", "cosmos", "db", "store", "storage"]],
  ["queue", ["queue", "message", "dead-letter", "service bus", "event hub", "hub"]],
  ["ship", ["ship", "carrier", "logistics", "delivery", "sink"]],
  ["analytics", ["analytics", "report", "pipeline", "ingest", "index", "search", "batch", "scheduler"]],
  ["shield", ["security", "defender", "firewall", "waf", "auth", "identity", "entra", "key vault", "secret", "safety"]],
  ["cube", ["kubernetes", "container", "aks", "pod", "cluster"]],
  ["cube", ["model", "nested"]],
  ["app", ["app", "hosting", "compute", "vm", "worker", "processor", "agent", "tool"]],
  ["flow", ["shop", "commerce", "checkout", "catalog", "order", "payment", "fraud", "flow", "gateway"]],
];

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---------- parse ----------
function cleanLabel(raw) {
  return raw.replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "")
    .replace(/^["']|["']$/g, "").split(/<br\s*\/?>/i).map((s) => s.trim()).filter(Boolean);
}
const NODE = "([A-Za-z][\\w]*)(?:\\[([^\\]]*)\\])?";
const EDGE_RE = new RegExp(`^${NODE}\\s*(-->\\s*\\|[^|]*\\||--\\s*"[^"]*"\\s*-->|-->|-\\.\\s*(?:"[^"]*"|[\\w ]+?)?\\s*\\.->)\\s*${NODE}`);
const NODE_RE = new RegExp(`^${NODE}\\s*;?$`);
const IGNORED = /^(subgraph\b|end\b|direction\b|linkStyle\b|style\b|click\b|accTitle\b|accDescr\b)/;

// parse one flowchart block into { nodes, edges }; every source line is classified and
// unrecognized lines produce warnings with the (absolute, if lineOffset given) line number.
export function parseGraph(code, { diag = new Diagnostics(), lineOffset = 0 } = {}) {
  const nodes = new Map(); // id -> { id, lines:[], order }
  const edges = [];        // { from, to, dashed, label, line }
  const nodeClass = new Map();
  const classDefs = new Set();
  let order = 0, sawHeader = false;
  const ensure = (id) => { if (!nodes.has(id)) nodes.set(id, { id, lines: [id], order: order++ }); return nodes.get(id); };
  const setLabel = (id, br) => { const n = ensure(id); if (br != null) { const l = cleanLabel(br); if (l.length) n.lines = l; } };

  const src = code.split("\n");
  for (let li = 0; li < src.length; li++) {
    const lineNo = lineOffset + li + 1;
    let line = src[li].replace(/%%.*$/, "").trim();
    if (!line) continue;
    const head = line.match(/^(flowchart|graph)\s+(\w+)\s*;?$/);
    if (head) {
      sawHeader = true;
      if (head[2].toUpperCase() !== "BT")
        diag.warn(`flowchart direction "${head[2]}" — the swimlane renderer draws bottom-up (BT); layout may read inverted`, { line: lineNo });
      continue;
    }
    if (IGNORED.test(line)) {
      diag.warn(`ignored "${line.split(/\s/)[0]}" statement (not supported by the swimlane renderer)`, { line: lineNo });
      continue;
    }
    const cd = line.match(/^classDef\s+(\w+)\b/);
    if (cd) {
      classDefs.add(cd[1]);
      if (!CLASS_STATE[cd[1]])
        diag.info(`classDef "${cd[1]}" does not map to a health state (known: ${Object.keys(CLASS_STATE).join(", ")})`, { line: lineNo });
      continue;
    }
    const cm = line.match(/^class\s+([^;]+?)\s+(\w+)\s*;?$/);
    if (cm) {
      if (!CLASS_STATE[cm[2]])
        diag.warn(`class "${cm[2]}" is not a health class — nodes keep state "unknown" (known: ${Object.keys(CLASS_STATE).join(", ")})`, { line: lineNo });
      cm[1].split(",").forEach((id) => nodeClass.set(id.trim(), cm[2]));
      continue;
    }
    const em = line.match(EDGE_RE);
    if (em) {
      const [, fromId, fromBr, op, toId, toBr] = em;
      setLabel(fromId, fromBr); setLabel(toId, toBr); ensure(fromId); ensure(toId);
      const dashed = op.startsWith("-.");
      let label = null;
      const lm = op.match(/-\.\s*(?:"([^"]*)"|([\w ]+?))\s*\.->/)
        || op.match(/-->\s*\|([^|]*)\|/)
        || op.match(/--\s*"([^"]*)"\s*-->/);
      if (lm) label = cleanLabel(lm[1] ?? lm[2] ?? "").join(" ");
      edges.push({ from: fromId, to: toId, dashed, label: label || null, line: lineNo });
      diag.info(`edge ${fromId} → ${toId}${label ? ` |${label}|` : ""}${dashed ? " (dashed)" : ""}`, { line: lineNo });
      continue;
    }
    const nm = line.match(NODE_RE);
    if (nm) {
      if (nm[2] != null) { setLabel(nm[1], nm[2]); diag.info(`node ${nm[1]} "${nm[2].slice(0, 40)}"`, { line: lineNo }); }
      else { ensure(nm[1]); diag.info(`node ${nm[1]}`, { line: lineNo }); }
      continue;
    }
    diag.warn(`unrecognized line: "${line.length > 70 ? line.slice(0, 67) + "..." : line}"`, {
      line: lineNo,
      hint: /--|\.->|==>/.test(line)
        ? 'looks like an edge — supported forms: A --> B, A -->|label| B, A -- "label" --> B, A -. label .-> B (node ids must start with a letter)'
        : "expected a node (id[Label]), an edge, class/classDef, or a comment",
    });
  }
  if (!sawHeader) diag.warn(`no "flowchart BT" header found — parsing lines as flowchart anyway`, { line: lineOffset + 1 });
  for (const n of nodes.values()) n.state = CLASS_STATE[nodeClass.get(n.id)] || "unknown";
  return { nodes, edges };
}

// ---------- fold signals into their owning entity ----------
// A metric line can carry its own result and state: "P95 latency = 230 ms (degraded)"
const SIGNAL_WORDS = new Set(["signal", "signals"]);
const ROW_RE = /^(.*?)(?:\s*=\s*([^()]+?))?\s*(?:\((healthy|degraded|unhealthy|unknown)\))?$/;
export function foldSignals(g, diag = new Diagnostics()) {
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
    if (owners.length === 0) {
      diag.warn(`signal node "${sigId}" only points at other signals — drawn as its own card`);
      continue;
    }
    for (const t of owners) {
      const owner = g.nodes.get(t);
      owner.signals = owner.signals || [];
      for (const m of metrics) {
        const [, name, result, state] = m.match(ROW_RE);
        owner.signals.push({ name: name.trim() || m, state: state || "healthy", result: result?.trim() || null });
      }
    }
    diag.info(`folded signal "${sigId}" (${metrics.length} row${metrics.length === 1 ? "" : "s"}) into ${owners.join(", ")}`);
    remove.add(sigId);
  }
  for (const id of g.nodes.keys()) {
    if (isSig(id) && !targetsOf.has(id))
      diag.warn(`signal node "${id}" has no outgoing edge to an entity — drawn as its own card`);
  }
  g.edges = g.edges.filter((e) => !remove.has(e.from) && !remove.has(e.to));
  for (const id of remove) g.nodes.delete(id);

  for (const n of g.nodes.values()) {
    if (!n.signals || !n.signals.length) continue;
    const anyMarked = n.signals.some((r) => r.state !== "healthy");
    if (!anyMarked && (n.state === "degraded" || n.state === "unhealthy")) n.signals[0].state = n.state;
    for (const row of n.signals) {
      if (row.result != null) continue;
      // deterministic placeholder result derived from the row name, scaled by its state
      let h = 0;
      for (let i = 0; i < row.name.length; i++) h = (h * 31 + row.name.charCodeAt(i)) & 0xffff;
      row.result = row.state === "healthy" ? String(h % 3) : row.state === "degraded" ? String(5 + (h % 15)) : String(30 + (h % 90));
    }
  }
  return g;
}
// ---------- layer + order ----------
export function layout(g, diag = new Diagnostics()) {
  const ids = [...g.nodes.keys()];
  const parents = new Map(ids.map((i) => [i, []]));
  const children = new Map(ids.map((i) => [i, []]));
  for (const e of g.edges) {
    if (e.from === e.to) continue; // self-loop: layering ignores it
    parents.get(e.from).push(e.to);
    children.get(e.to).push(e.from);
  }
  const depth = new Map();
  let cyclic = false;
  const calc = (id, seen = new Set()) => {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) { cyclic = true; return 0; }
    seen.add(id);
    const ps = parents.get(id);
    const d = ps.length === 0 ? 0 : 1 + Math.max(...ps.map((p) => calc(p, seen)));
    depth.set(id, d); return d;
  };
  ids.forEach((i) => calc(i));
  if (cyclic) diag.warn("cycle detected — the roll-up hierarchy is ambiguous; layering broke the cycle arbitrarily");

  const present = [...new Set(ids.map((i) => depth.get(i)))].sort((a, b) => a - b);
  const laneOf = new Map(present.map((d, idx) => [d, idx]));
  const L = present.length;
  const laneNodes = Array.from({ length: L }, () => []);
  for (const id of ids) laneNodes[laneOf.get(depth.get(id))].push(id);
  laneNodes.forEach((arr) => arr.sort((a, b) => g.nodes.get(a).order - g.nodes.get(b).order));

  const posIn = (arr) => new Map(arr.map((id, i) => [id, i]));
  const bary = (neigh, posMap) => {
    const xs = neigh.map((n) => posMap.get(n)).filter((v) => v != null);
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const stableBy = (arr, keyFn) => arr.map((id, i) => ({ id, i, k: keyFn(id) }))
    .sort((a, b) => (a.k == null ? a.i : a.k) - (b.k == null ? b.i : b.k) || a.i - b.i)
    .map((o) => o.id);
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
  const lane = new Map();
  laneNodes.forEach((arr, li) => arr.forEach((id) => lane.set(id, li)));
  return { laneNodes, lane, L, parents, children };
}

// ---------- measure ----------
const CARD_MIN_W = 168, CARD_MAX_W = 480, GAP = 30, TOPPAD = 18;
const NAME_FS = 12.5, QUAL_FS = 9, ROW_FS = 10.5, PILL_FS = 10.5;
export const CENTER_TIE_EPS = 1e-6;
// Header qualifier (subtitle) layout. The subtitle is light-weight text under the bold title
// that shares its header row with the right-aligned status pill. Rather than widening the card
// without bound to fit a long subtitle on one line (which pushes the whole diagram wide and
// crowds the pill), the subtitle is confined to a fixed text column: it wraps at word boundaries
// into as many lines as it needs and the card grows *taller* instead of wider. The title still
// drives the card's minimum (one-line) width.
//   SUBTITLE_MAX_W — the subtitle's text-column width in estimator px. Long subtitles wrap to
//     this column; the title-width path is untouched, so short/no-subtitle cards are unaffected.
//   HEADER_SAFETY — the width estimator lands bold weights accurately but under-measures
//     regular-weight glyphs ~6-9% on real Segoe UI / San Francisco stacks. It no longer grows the
//     card (the column bound does the bounding); it only reserves headroom so the *bounded*
//     column's real render still clears the pill.
const SUBTITLE_MAX_W = 160;
const HEADER_SAFETY = 1.12;


function roundedOrtho(pts, r = 8) {
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
const segsOf = (pts, edge) => {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    out.push({ x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y), kind: a.x === b.x ? "v" : "h", edge });
  }
  return out;
};

// Heuristic used by the CLI's auto renderer selection.
export function looksLikeHealthModel(code) {
  const { body } = splitFrontmatter(code);
  if (!/^\s*(flowchart|graph)\s+BT\b/m.test(body)) return false;
  return /^\s*class\s+[^;]+\s+(blue|green|amber|red|purple)\s*;?\s*$/m.test(body);
}

// ---------- main render ----------
// opts: { theme, title, subtitle, lanes, legend, laneLabels, diag, baseLine, debug }
export function renderSwimlane(code, opts = {}) {
  const diag = opts.diag || new Diagnostics();
  const T = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  const { body, raw } = splitFrontmatter(code);
  const fmLines = raw ? raw.split("\n").length - 1 : 0;
  const g = parseGraph(body, { diag, lineOffset: (opts.baseLine || 0) + fmLines });
  if (g.nodes.size === 0) {
    const bad = diag.warnings.filter((w) => w.message.startsWith("unrecognized"));
    throw new Error(`no nodes parsed${bad.length ? ` — ${bad.length} unrecognized line(s), first at line ${bad[0].line}` : ""}`);
  }
  foldSignals(g, diag);
  const lay = layout(g, diag);
  const { laneNodes, lane, L } = lay;

  // ----- measure cards -----
  const size = new Map();
  for (const [id, n] of g.nodes) {
    const rawLines = n.lines.filter((l) => !STATE_WORDS.has(l.toLowerCase()));
    const name = rawLines[0] || n.lines[0] || n.id;
    const qualifierRaw = rawLines.slice(1).map((l) => l.replace(/[()]/g, "")).join(" · ") || null;
    const statePillW = 20 + textWidth(STATE_LABEL[n.state] || "Unknown", PILL_FS) + 8;
    const sigs = n.signals || [];

    // natural (unwrapped) width demands. The subtitle's width demand is capped at SUBTITLE_MAX_W so
    // a long subtitle wraps (and the card grows taller) instead of widening the card to fit one line.
    const headerFixed = 34 + 8 + statePillW + 8;
    const subCol = qualifierRaw ? Math.min(textWidth(qualifierRaw, QUAL_FS), SUBTITLE_MAX_W) : 0;
    const headerNat = headerFixed + Math.max(textWidth(name, NAME_FS, 600), subCol * HEADER_SAFETY);
    const rowFixed = 52 + 16 + 12;
    let rowsNat = 0;
    for (const r of sigs) rowsNat = Math.max(rowsNat, rowFixed + textWidth(r.name, ROW_FS) + textWidth(r.result ?? "", ROW_FS, 600));
    const w = Math.min(CARD_MAX_W, Math.max(CARD_MIN_W, Math.ceil(Math.max(headerNat, rowsNat))));

    // wrap into the final width
    const nameAvail = w - headerFixed;
    // Entity titles are never truncated. Past the width cap they add header lines, preserving the
    // complete title while keeping the diagram horizontally compact.
    const nameWrap = wrapText(name, nameAvail, NAME_FS, { weight: 600, maxLines: Infinity });
    // Subtitles are never truncated: wrap at word boundaries into the bounded column with no line
    // limit, growing the card taller. Over-long unbroken tokens hard-break inside the column.
    let qualWrap = null;
    if (qualifierRaw) qualWrap = wrapText(qualifierRaw, Math.min(nameAvail, SUBTITLE_MAX_W), QUAL_FS, { maxLines: Infinity });
    const rows = sigs.map((r) => {
      const resultW = textWidth(r.result ?? "", ROW_FS, 600);
      const avail = w - rowFixed - resultW;
      const wrap = wrapText(r.name, avail, ROW_FS, { maxLines: 2 });
      if (wrap.clipped) diag.warn(`signal row "${r.name.slice(0, 40)}…" on "${n.id}" clipped (full text kept as tooltip)`);
      return { ...r, lines: wrap.lines, clipped: wrap.clipped, rowH: 18 + 13 * (wrap.lines.length - 1), resultW };
    });

    const headerContentH = nameWrap.lines.length * 14 + (qualWrap ? qualWrap.lines.length * 11 : 0);
    const headerH = Math.max(34, headerContentH + 14);
    const h = rows.length
      ? headerH + 3 + 6 + rows.reduce((a, r) => a + r.rowH, 0) + 6
      : Math.max(58, headerContentH + 26);
    size.set(id, { w, h, headerH, name, nameWrap, qualWrap, statePillW, rows });
  }
  diag.info(`graph: ${g.nodes.size} nodes, ${g.edges.length} edges, ${L} lanes`);

  // ----- x coordinates (variable widths, no overlap by construction) -----
  const widths = new Map([...size].map(([id, s]) => [id, s.w]));
  const neighbors = new Map();
  for (const id of g.nodes.keys()) neighbors.set(id, []);
  for (const e of g.edges) {
    if (e.from === e.to) continue;
    neighbors.get(e.from).push(e.to);
    neighbors.get(e.to).push(e.from);
  }
  const X = relaxCoordinates(laneNodes, widths, neighbors, GAP);

  // ----- route: plan xs and channel heights; ys come after stacking -----
  const routing = planRoutes({ g, lane, laneNodes, X, size, diag });
  const chanH = routing.chanH;

  // ----- vertical stacking -----
  const M = { left: 40, top: 78 };
  const laneMaxH = laneNodes.map((arr) => Math.max(58, ...arr.map((id) => size.get(id).h)));
  const laneTop = [], laneBandH = [];
  let cursorY = M.top + chanH(-1) + (chanH(-1) ? 6 : 0);
  for (let i = 0; i < L; i++) {
    laneTop.push(cursorY);
    const bodyH = TOPPAD + laneMaxH[i] + 14;
    laneBandH.push(bodyH + chanH(i));
    cursorY += bodyH + chanH(i);
  }
  const totalH = cursorY + 18;
  const chanTop = (gph) => (gph === -1 ? M.top : laneTop[gph] + TOPPAD + laneMaxH[gph] + 14);

  // card boxes
  const box = new Map();
  for (const [id, s] of size) {
    const li = lane.get(id);
    const x = X.get(id) - s.w / 2, y = laneTop[li] + TOPPAD;
    box.set(id, { x, y, w: s.w, h: s.h, cx: X.get(id), top: y, bottom: y + s.h });
  }

  // ----- build paths + geometry from the routes -----
  const { routes, pills } = routing.realize({ chanTop, box });
  const debug = { cards: [], pills: [], statusPills: [], segs: [], texts: [], lanes: [] };
  const paths = routes.map(({ e, pts }) => {
    debug.segs.push(...segsOf(pts, `${e.from}->${e.to}`));
    const st = T.state[g.nodes.get(e.from).state] || T.state.unknown;
    return { d: roundedOrtho(pts, 7), stroke: st.border, width: e.dashed ? 1.6 : 1.7, dash: e.dashed ? "5 4" : null };
  });

  // ----- lane labels / title / legend measurement -----
  // `laneLabels` (default true) is an independent visibility toggle: it only decides whether the
  // right-hand lane-label gutter is reserved and its text drawn. It is applied AFTER card x
  // coordinates are fixed (relaxCoordinates, above), so it can never influence lane packing,
  // routing, edge colors, node order, or height — false merely trims the reclaimed gutter off the
  // right edge (W shrinks by exactly gutterW) and skips the label <text>. Bands/hairlines remain.
  const showLabels = opts.laneLabels !== false;
  // lane names top to bottom: custom `lanes` (padded with "Layer n"), else defaults by depth
  let labels;
  if (Array.isArray(opts.lanes) && opts.lanes.length) {
    labels = opts.lanes.slice(0, L).map(String);
    while (labels.length < L) labels.push(`Layer ${labels.length}`);
  } else if (L === 1) labels = ["Workload root"];
  else if (L === 2) labels = ["Workload root", "Application components"];
  else if (L === 3) labels = ["Workload root", "Business & user flows", "Application components"];
  else {
    const middle = ["Business & user flows", "Application components", "Dependencies", "Subsystems"];
    labels = ["Workload root"];
    for (let i = 0; i < L - 1; i++) labels.push(middle[i] || `Layer ${i + 1}`);
    labels = labels.slice(0, L);
  }
  const labelWraps = labels.map((l) => wrapText(l, 150, 13, { weight: 600, maxLines: 3 }).lines);
  const gutterW = showLabels
    ? Math.max(120, ...labelWraps.map((ls) => Math.max(...ls.map((s) => textWidth(s, 13, 600))))) + 48
    : 0;
  const title = opts.title ?? "";
  const subtitle = opts.subtitle ?? "Signals live inside each entity; health rolls up to the workload root.";
  const legendOn = opts.legend !== false;
  const legendItems = [["Healthy", T.state.healthy.dot], ["Degraded", T.state.degraded.dot], ["Unhealthy", T.state.unhealthy.dot], ["Unknown", T.state.unknown.dot]];
  let legendW = textWidth("Legend", 11.5, 600) + 12;
  for (const [lbl] of legendItems) legendW += 26 + textWidth(lbl, 11.5);
  legendW += 22 + textWidth("Metric", 11.5);

  // ----- global extents; translate if anything went left of 0 -----
  let minX = 0, maxX = 0;
  const scanX = (x) => { minX = Math.min(minX, x); maxX = Math.max(maxX, x); };
  for (const b of box.values()) { scanX(b.x); scanX(b.x + b.w); }
  for (const s of debug.segs) { scanX(s.x1); scanX(s.x2); }
  for (const p of pills) { scanX(p.x - p.w / 2); scanX(p.x + p.w / 2); }
  const tx = M.left - minX;
  const contentH = totalH;
  // Legend now lives in a dedicated footer row below all content (v3.1.0). It no longer contributes
  // to the header width; instead it adds a width floor (so a narrow diagram can't clip it) and a
  // fixed-height footer strip. Both are gated on legendOn so disabled diagrams keep old dims.
  const legendGap = 20, legendRowH = 28;
  const headW = M.left + textWidth(title, 18, 700) + 24 + 40;
  const W = Math.max(
    maxX + tx + 24 + gutterW,
    headW,
    textWidth(subtitle, 12) + M.left + 40,
    legendOn ? M.left + legendW + 40 : 0
  );
  const H = legendOn ? contentH + legendGap + legendRowH : contentH;

  const shift = (v) => v + tx;
  for (const b of box.values()) b.x = shift(b.x), b.cx = shift(b.cx);
  for (const s of debug.segs) s.x1 = shift(s.x1), s.x2 = shift(s.x2);
  for (const p of pills) p.x = shift(p.x);
  // paths carry absolute coords in their strings — rebuild them shifted instead
  // (cheap: we regenerate the d strings by shifting recorded points is complex; instead we
  //  wrap drawable content in a translate group and keep debug geometry in final coords)

  // ----- emit -----
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(W)}" height="${Math.ceil(H)}" viewBox="0 0 ${Math.ceil(W)} ${Math.ceil(H)}" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif">`);
  out.push(`<defs><filter id="cs" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.3" flood-color="#000" flood-opacity="${T.shadowOpacity}"/></filter></defs>`);
  out.push(`<rect width="${Math.ceil(W)}" height="${Math.ceil(H)}" fill="${T.bg}"/>`);

  // lane bands + labels
  for (let i = 0; i < L; i++) {
    const top = laneTop[i] - (i === 0 ? 0 : 0); // band starts at lane top; channel below belongs to it
    const bh = laneBandH[i];
    out.push(`<rect x="0" y="${top.toFixed(1)}" width="${Math.ceil(W)}" height="${bh.toFixed(1)}" fill="${i % 2 ? T.band : T.bg}"/>`);
    out.push(`<line x1="0" y1="${top.toFixed(1)}" x2="${Math.ceil(W)}" y2="${top.toFixed(1)}" stroke="${T.hair}"/>`);
    if (showLabels) {
      const lx = W - gutterW + 24, mid = top + bh / 2, ls = labelWraps[i];
      ls.forEach((s, k) => {
        const y = mid + (k - (ls.length - 1) / 2) * 17 + 4.5;
        out.push(`<text x="${lx.toFixed(1)}" y="${y.toFixed(1)}" font-size="13" font-weight="700" fill="${T.laneLabel}">${esc(s)}</text>`);
        debug.texts.push({ x: lx, y: y - 11, w: textWidth(s, 13, 600), h: 14, text: s });
      });
    }
    debug.lanes.push({ top, h: bh, label: labels[i] });
  }
  out.push(`<line x1="0" y1="${(contentH - 0.5).toFixed(1)}" x2="${Math.ceil(W)}" y2="${(contentH - 0.5).toFixed(1)}" stroke="${T.hair}"/>`);

  // title + subtitle
  if (title) {
    out.push(`<text x="${M.left}" y="34" font-size="18" font-weight="700" fill="${T.ink}">${esc(title)}</text>`);
    debug.texts.push({ x: M.left, y: 20, w: textWidth(title, 18, 700), h: 20, text: title });
  }
  if (subtitle) {
    out.push(`<text x="${M.left}" y="52" font-size="12" fill="${T.muted}">${esc(subtitle)}</text>`);
    debug.texts.push({ x: M.left, y: 41, w: textWidth(subtitle, 12), h: 13, text: subtitle });
  }
  // legend — dedicated bottom footer row, left-aligned at the title margin, below the content
  // boundary hairline. Order: Legend, Healthy, Degraded, Unhealthy, Unknown, Metric.
  if (legendOn) {
    let x = M.left;
    const yy = contentH + legendGap + legendRowH / 2;
    out.push(`<text x="${x.toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" font-weight="600" fill="${T.muted}">Legend</text>`);
    x += textWidth("Legend", 11.5, 600) + 12;
    for (const [lbl, color] of legendItems) {
      out.push(`<circle cx="${(x + 6).toFixed(1)}" cy="${yy.toFixed(1)}" r="4.5" fill="${color}"/>`);
      out.push(`<text x="${(x + 16).toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" fill="${T.laneLabel}">${lbl}</text>`);
      x += 26 + textWidth(lbl, 11.5);
    }
    out.push(metricIcon(T, x, yy - 7, 14));
    out.push(`<text x="${(x + 18).toFixed(1)}" y="${(yy + 4).toFixed(1)}" font-size="11.5" fill="${T.laneLabel}">Metric</text>`);
  }

  // edges + pills + cards inside the translate group
  out.push(`<g transform="translate(${tx.toFixed(1)},0)">`);
  out.push(`<g fill="none" stroke-linecap="butt" stroke-linejoin="round">`);
  for (const p of paths) out.push(`<path d="${p.d}" stroke="${p.stroke}" stroke-width="${p.width}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ""}/>`);
  out.push(`</g>`);
  for (const p of pills) {
    const pw = p.w, ph = p.h, lines = p.lines, x = p.x - tx; // group is translated; local coords
    const tip = p.clipped ? `<title>${esc(p.e.label)}</title>` : "";
    const rows = lines.map((line, k) => {
      const ly = p.y - (lines.length - 1) * 6.5 + k * 13 + 3.6;
      return `<text x="${x.toFixed(1)}" y="${ly.toFixed(1)}" font-size="${PILL_FS}" font-weight="600" fill="${T.ink}" text-anchor="middle">${esc(line)}${k === 0 ? tip : ""}</text>`;
    }).join("");
    out.push(`<g stroke="none"><rect x="${(x - pw / 2).toFixed(1)}" y="${(p.y - ph / 2).toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="10" fill="${T.pillFill}" stroke="${T.pillStroke}" stroke-width="1"/>${rows}</g>`);
    debug.pills.push({ x: p.x - pw / 2, y: p.y - ph / 2, w: pw, h: ph, label: p.e.label, edge: `${p.e.from}->${p.e.to}` });
    for (const line of lines) {
      const lw = textWidth(line, PILL_FS, 600);
      debug.texts.push({ x: p.x - lw / 2, y: p.y - ph / 2 + 3, w: lw, h: ph - 6, text: line, container: { x: p.x - pw / 2, y: p.y - ph / 2, w: pw, h: ph } });
    }
  }
  for (const [id, n] of g.nodes) {
    // card in the translated group's local coords (b); absB stays in final coords for debug boxes
    const absB = box.get(id), s = size.get(id);
    const b = { ...absB, x: absB.x - tx, cx: absB.cx - tx };
    const st = T.state[n.state] || T.state.unknown;
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : "";
    const p = [];
    const dbgText = (localX, topY, w, h, text) =>
      debug.texts.push({ x: localX + (absB.x - b.x), y: topY, w, h, text, container: { x: absB.x, y: absB.y, w: absB.w, h: absB.h } });

    p.push(`<g filter="url(#cs)"><rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.border}" stroke-width="2"${dash}/></g>`);

    const headerH = s.rows.length ? s.headerH : b.h;
    const headerMid = b.y + headerH / 2;
    const iconScale = 0.82;
    const lowerName = s.name.toLowerCase();
    const iconName = ICON_KEYWORDS.find(([, words]) => words.some((w) => lowerName.includes(w)))?.[0] ?? "cube";
    const iconStroke = `fill="none" stroke="${T.muted}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
    p.push(`<g transform="translate(${(b.x + 6).toFixed(1)},${(headerMid - 12 * iconScale).toFixed(2)}) scale(${iconScale})">${ICON_PATHS[iconName].replaceAll("%S%", iconStroke)}</g>`);

    const px = b.x + b.w - s.statePillW - 8;
    const nameX = b.x + 34;
    const blockH = s.nameWrap.lines.length * 14 + (s.qualWrap ? s.qualWrap.lines.length * 11 : 0);
    let ty = headerMid - blockH / 2 + 10.5;
    const nameTitle = s.nameWrap.clipped ? `<title>${esc(s.name)}</title>` : "";
    s.nameWrap.lines.forEach((line) => {
      p.push(`<text x="${nameX.toFixed(1)}" y="${ty.toFixed(1)}" font-size="${NAME_FS}" font-weight="600" fill="${T.ink}">${esc(line)}${nameTitle && line === s.nameWrap.lines[0] ? nameTitle : ""}</text>`);
      dbgText(nameX, ty - 10.5, textWidth(line, NAME_FS, 600), 14, line);
      ty += 14;
    });
    if (s.qualWrap) {
      s.qualWrap.lines.forEach((line) => {
        p.push(`<text x="${nameX.toFixed(1)}" y="${(ty - 2).toFixed(1)}" font-size="${QUAL_FS}" fill="${T.muted}">${esc(line)}</text>`);
        dbgText(nameX, ty - 2 - 8, textWidth(line, QUAL_FS), 10, line);
        ty += 11;
      });
    }
    p.push(`<rect x="${px.toFixed(1)}" y="${(headerMid - 9).toFixed(2)}" width="${s.statePillW.toFixed(1)}" height="18" rx="9" fill="${T.pillFill}" stroke="${st.border}" stroke-width="1"/>`);
    debug.statusPills.push({ x: px + (absB.x - b.x), y: headerMid - 9, w: s.statePillW, h: 18, id: n.id, container: { x: absB.x, y: absB.y, w: absB.w, h: absB.h } });
    p.push(statusDot(T, n.state, px + 11, headerMid));
    const stLabel = STATE_LABEL[n.state] || "Unknown";
    p.push(`<text x="${(px + 20).toFixed(1)}" y="${(headerMid + PILL_FS * 0.34).toFixed(2)}" font-size="${PILL_FS}" fill="${T.laneLabel}">${stLabel}</text>`);
    dbgText(px + 20, headerMid - 6, textWidth(stLabel, PILL_FS), 12, stLabel);

    if (s.rows.length) {
      const tY = b.y + s.headerH + 3;
      p.push(`<line x1="${(b.x + 1).toFixed(1)}" y1="${tY.toFixed(1)}" x2="${(b.x + b.w - 1).toFixed(1)}" y2="${tY.toFixed(1)}" stroke="${T.hair}"/>`);
      const iconX = b.x + 32, nameX2 = b.x + 52, resX = b.x + b.w - 12;
      let top = tY + 6;
      s.rows.forEach((r, i) => {
        const ry = top + 9; // first-line center
        if (i > 0) p.push(`<line x1="${(b.x + 10).toFixed(1)}" y1="${(top - 0).toFixed(1)}" x2="${(b.x + b.w - 10).toFixed(1)}" y2="${top.toFixed(1)}" stroke="${T.hair}" stroke-opacity="0.7"/>`);
        p.push(statusDot(T, r.state, b.x + 16, ry));
        p.push(metricIcon(T, iconX, ry - 7, 14));
        const rowTitle = r.clipped ? `<title>${esc(r.name)}</title>` : "";
        r.lines.forEach((line, k) => {
          p.push(`<text x="${nameX2.toFixed(1)}" y="${(ry + 3.5 + k * 13).toFixed(1)}" font-size="${ROW_FS}" fill="${T.ink}">${esc(line)}${k === 0 ? rowTitle : ""}</text>`);
          dbgText(nameX2, ry + 3.5 + k * 13 - 9, textWidth(line, ROW_FS), 11, line);
        });
        const rs = T.state[r.state] || T.state.healthy;
        p.push(`<text x="${resX.toFixed(1)}" y="${(ry + 3.5).toFixed(1)}" font-size="${ROW_FS}" font-weight="${r.state === "healthy" ? 400 : 600}" fill="${r.state === "healthy" ? T.muted : rs.dot}" text-anchor="end">${esc(r.result ?? "")}</text>`);
        dbgText(resX - r.resultW, ry - 5.5, r.resultW, 11, r.result ?? "");
        top += r.rowH;
      });
    }
    out.push(p.join(""));
    debug.cards.push({ id, x: absB.x, y: absB.y, w: absB.w, h: absB.h, headerH: s.headerH, qualLines: s.qualWrap ? s.qualWrap.lines.length : 0, lane: lane.get(id) });
  }
  out.push(`</g></svg>`);
  const svg = out.join("\n");
  if (/NaN|Infinity|undefined/.test(svg)) throw new Error("internal: non-finite coordinate in SVG output");
  if (!svg.includes("</svg>")) throw new Error("internal: incomplete SVG");
  return { svg, W: Math.ceil(W), H: Math.ceil(H), nodes: g.nodes.size, lanes: L, debug, diag };
}

// ---------- card + small glyph emitters ----------
function metricIcon(T, x, y, sizePx = 14) {
  const s = sizePx / 16, [a, b, c] = T.metricBars;
  return `<g transform="translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${s})"><rect x="1.5" y="8" width="2.6" height="6" rx="0.6" fill="${a}"/><rect x="5.7" y="4.5" width="2.6" height="9.5" rx="0.6" fill="${b}"/><rect x="9.9" y="6.5" width="2.6" height="7.5" rx="0.6" fill="${c}"/></g>`;
}
function statusDot(T, state, cx, cy) {
  const st = T.state[state] || T.state.unknown;
  if (state === "healthy") {
    return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${st.dot}"/><path d="M${(cx - 2.7).toFixed(1)} ${cy.toFixed(1)} l1.9 1.9 l3.4 -3.9" fill="none" stroke="${T.bg}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="6" fill="${st.dot}"/>`;
}
