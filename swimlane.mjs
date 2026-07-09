#!/usr/bin/env node
// swimlane.mjs — high-fidelity, technical-documentation health-model diagram as native SVG.
// Horizontal swimlanes (root / flows / components / signals), per-entity icons, signal chips with
// state dots, roll-up edges colored by child state, and a legend. True SVG with native <text>,
// so it renders inside <img> on Microsoft Learn.
//
// Palette from AHM-CloudHealth-Portal Styles/variables.module.scss + _graph-view-blade.scss.
// Icons are original monochrome glyphs (not official Azure service icons) to stay license-clean.

import { writeFileSync } from "node:fs";

// ---- palette ---------------------------------------------------------------
const INK = "#242424";
const MUTED = "#605e5c";
const LANE_LABEL = "#323130";
const HAIR = "#e6e4e2";
const BG = "#ffffff";
const BAND = "#faf9f8";
const AZURE = "#0078D4";

const STATE = {
  healthy:   { border: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a" },
  degraded:  { border: "#db7500", fill: "#fbf2e7", dot: "#c26a00" },
  unhealthy: { border: "#ba0d16", fill: "#faeceb", dot: "#c50f18" },
  unknown:   { border: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", dash: "4 3" },
  signal:    { border: "#0078D4", fill: "#eff6fc", dot: "#0078D4" },
};
const STATE_LABEL = { healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy", unknown: "Unknown" };

// ---- icons (24x24, stroke-based) ------------------------------------------
const icon = (name, stroke = MUTED) => {
  const s = `fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"`;
  const paths = {
    root: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M4.2 12h3l2-3.6 2.8 7.2 1.8-3.6h4" ${s}/>`,
    flow: `<circle cx="5.5" cy="6" r="2" ${s}/><circle cx="5.5" cy="18" r="2" ${s}/><circle cx="18.5" cy="12" r="2" ${s}/><path d="M7.5 6h3a4 4 0 0 1 4 4M7.5 18h3a4 4 0 0 0 4-4" ${s}/>`,
    web: `<circle cx="12" cy="12" r="8.4" ${s}/><path d="M3.6 12h16.8M12 3.6c3 3 3 13.8 0 16.8M12 3.6c-3 3-3 13.8 0 16.8" ${s}/>`,
    app: `<rect x="4" y="4.5" width="16" height="6" rx="1.2" ${s}/><rect x="4" y="13.5" width="16" height="6" rx="1.2" ${s}/><path d="M7.2 7.5h.01M7.2 16.5h.01" ${s}/>`,
    db: `<ellipse cx="12" cy="6" rx="7" ry="2.8" ${s}/><path d="M5 6v12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8V6" ${s}/><path d="M5 12c0 1.55 3.13 2.8 7 2.8s7-1.25 7-2.8" ${s}/>`,
    queue: `<rect x="4" y="5" width="16" height="3" rx="1" ${s}/><rect x="4" y="10.5" width="16" height="3" rx="1" ${s}/><rect x="4" y="16" width="10" height="3" rx="1" ${s}/>`,
    ship: `<path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z" ${s}/><path d="M4.6 7.8l7.4 4.3 7.4-4.3M12 12.1v8.6" ${s}/>`,
    analytics: `<path d="M4 20h16" ${s}/><path d="M6.5 20v-6M12 20V6.5M17.5 20v-9" ${s}/>`,
    signal: `<path d="M3.2 16.5l4.4-5.4 3.4 3.4 4.4-7 3.4 4.2" ${s}/>`,
  };
  return paths[name] || paths.root;
};

// ---- model (hero: shop workload) ------------------------------------------
const lanes = [
  { key: "root",       label: "Workload root",          h: 96 },
  { key: "flows",      label: "Business & user flows",  h: 96 },
  { key: "components", label: "Application components",  h: 96 },
  { key: "signals",    label: "Signals",                h: 112 },
];

// column centers for the 6-wide signal/component grid
const COL = [130, 305, 480, 655, 830, 1005];

const nodes = [
  { id: "root", lane: "root", x: 567, label: "Workload root", icon: "root", state: "degraded" },

  { id: "shop",      lane: "flows", x: 305, label: "Shop and commerce", icon: "flow", state: "healthy" },
  { id: "reporting", lane: "flows", x: 620, label: "Reporting",         icon: "flow", state: "healthy" },
  { id: "logistics", lane: "flows", x: 917, label: "Logistics",         icon: "flow", state: "degraded" },

  { id: "web",       lane: "components", x: COL[0], label: "Web frontend",     icon: "web",       state: "healthy" },
  { id: "app",       lane: "components", x: COL[1], label: "App hosting",      icon: "app",       state: "healthy" },
  { id: "db",        lane: "components", x: COL[2], label: "Database",         icon: "db",        state: "healthy" },
  { id: "analytics", lane: "components", x: COL[3], label: "Analytics store",  icon: "analytics", state: "healthy" },
  { id: "queue",     lane: "components", x: COL[4], label: "Order queue",      icon: "queue",     state: "degraded" },
  { id: "ship",      lane: "components", x: COL[5], label: "Shipping service", icon: "ship",       state: "healthy" },

  { id: "webSig",   lane: "signals", x: COL[0], icon: "signal", state: "healthy",  metrics: ["Web latency", "HTTP 5xx rate", "Request rate"] },
  { id: "appSig",   lane: "signals", x: COL[1], icon: "signal", state: "healthy",  metrics: ["CPU", "Memory", "Restart count"] },
  { id: "dbSig",    lane: "signals", x: COL[2], icon: "signal", state: "healthy",  metrics: ["Connection", "DTU utilization", "Failed connections"] },
  { id: "anaSig",   lane: "signals", x: COL[3], icon: "signal", state: "healthy",  metrics: ["Pipeline lag", "Ingestion errors", "Data freshness"] },
  { id: "queueSig", lane: "signals", x: COL[4], icon: "signal", state: "degraded", metrics: ["Queue depth", "Oldest message age", "Dead-letter count"] },
  { id: "shipSig",  lane: "signals", x: COL[5], icon: "signal", state: "healthy",  metrics: ["Carrier API availability", "Carrier API latency", "Error rate"] },
];

const edges = [
  ["webSig", "web"], ["appSig", "app"], ["dbSig", "db"], ["anaSig", "analytics"], ["queueSig", "queue"], ["shipSig", "ship"],
  ["web", "shop"], ["app", "shop"], ["db", "shop"],
  ["db", "reporting"], ["analytics", "reporting"],
  ["queue", "logistics"], ["ship", "logistics"],
  ["shop", "root"], ["reporting", "root"], ["logistics", "root"],
];

// ---- layout ----------------------------------------------------------------
const M = { top: 74, left: 40, right: 40, labelGutter: 200 };
const CONTENT_W = 1100;
const W = M.left + CONTENT_W + M.labelGutter;
let y = M.top;
const laneY = {};
for (const ln of lanes) { laneY[ln.key] = { top: y, h: ln.h, mid: y + ln.h / 2 }; y += ln.h; }
const H = y + 20;

const CARD_W = 160, CARD_H = 56, SIG_H = 72;
const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
function box(n) {
  const isSig = n.lane === "signals";
  const h = isSig ? SIG_H : CARD_H;
  const cy = laneY[n.lane].mid;
  return { x: n.x - CARD_W / 2, y: cy - h / 2, w: CARD_W, h, cx: n.x, cy, top: cy - h / 2, bottom: cy + h / 2 };
}

// ---- svg helpers -----------------------------------------------------------
const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function card(n) {
  const b = box(n);
  const st = STATE[n.state] || STATE.unknown;
  const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : "";
  const parts = [];
  parts.push(`<g filter="url(#cardShadow)">`);
  parts.push(`<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.border}" stroke-width="2"${dash}/>`);
  parts.push(`</g>`);
  // header: icon + label
  const iconX = b.x + 12, iconY = b.y + 11;
  parts.push(`<g transform="translate(${iconX},${iconY}) scale(0.83)">${icon(n.icon, MUTED)}</g>`);
  parts.push(`<text x="${b.x + 40}" y="${b.y + 25}" font-size="12.5" font-weight="600" fill="${INK}">${esc(n.label)}</text>`);
  // footer: divider + dot + status
  const fy = b.y + b.h - 20;
  parts.push(`<line x1="${b.x + 1}" y1="${fy}" x2="${b.x + b.w - 1}" y2="${fy}" stroke="${HAIR}"/>`);
  parts.push(`<circle cx="${b.x + 14}" cy="${fy + 11}" r="4.2" fill="${st.dot}"/>`);
  parts.push(`<text x="${b.x + 24}" y="${fy + 15}" font-size="11" fill="${LANE_LABEL}">${STATE_LABEL[n.state]}</text>`);
  return parts.join("");
}

function signalCard(n) {
  const b = box(n);
  const st = STATE.signal;
  const parts = [];
  parts.push(`<g filter="url(#cardShadow)"><rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" fill="${st.fill}" stroke="${st.border}" stroke-width="1.6"/></g>`);
  parts.push(`<g transform="translate(${b.x + 12},${b.y + 9}) scale(0.66)">${icon("signal", AZURE)}</g>`);
  // per-signal state dot (top-right)
  const sdot = STATE[n.state]?.dot || MUTED;
  parts.push(`<circle cx="${b.x + b.w - 13}" cy="${b.y + 15}" r="4" fill="${sdot}"/>`);
  n.metrics.forEach((m, i) => {
    parts.push(`<text x="${b.x + 13}" y="${b.y + 34 + i * 13}" font-size="10" fill="${LANE_LABEL}">${esc(m)}</text>`);
  });
  return parts.join("");
}

function edge([fromId, toId]) {
  const a = box(byId[fromId]);   // child (lower)
  const b = box(byId[toId]);     // parent (upper)
  const st = STATE[byId[fromId].state] || STATE.unknown;
  const x1 = a.cx, y1 = a.top;
  const x2 = b.cx, y2 = b.bottom;
  const my = (y1 + y2) / 2;
  const dash = st.dash ? ` stroke-dasharray="5 4"` : "";
  return `<path d="M${x1} ${y1} C ${x1} ${my}, ${x2} ${my}, ${x2} ${y2}" fill="none" stroke="${st.border}" stroke-width="1.7"${dash} marker-end="url(#arrow-${byId[fromId].state})"/>`;
}

function wrapLaneLabel(label) {
  if (label.length <= 15) return [label];
  const words = label.split(" ");
  const half = Math.ceil(words.length / 2);
  return [words.slice(0, half).join(" "), words.slice(half).join(" ")];
}

function lane(ln) {
  const l = laneY[ln.key];
  const idx = lanes.indexOf(ln);
  const bg = idx % 2 === 1 ? BAND : BG;
  const parts = [];
  parts.push(`<rect x="0" y="${l.top}" width="${W}" height="${l.h}" fill="${bg}"/>`);
  parts.push(`<line x1="0" y1="${l.top}" x2="${W}" y2="${l.top}" stroke="${HAIR}"/>`);
  // right-side lane label (wrapped for long names)
  const lx = M.left + CONTENT_W + 24;
  const lines = wrapLaneLabel(ln.label);
  if (lines.length === 1) {
    parts.push(`<text x="${lx}" y="${l.mid + 5}" font-size="13" font-weight="700" fill="${LANE_LABEL}">${esc(lines[0])}</text>`);
  } else {
    parts.push(`<text x="${lx}" y="${l.mid - 2}" font-size="13" font-weight="700" fill="${LANE_LABEL}">${esc(lines[0])}</text>`);
    parts.push(`<text x="${lx}" y="${l.mid + 15}" font-size="13" font-weight="700" fill="${LANE_LABEL}">${esc(lines[1])}</text>`);
  }
  return parts.join("");
}

function arrowMarkers() {
  return Object.entries(STATE).map(([k, v]) =>
    `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${v.border}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>`
  ).join("");
}

function legend() {
  const items = [
    ["Healthy", STATE.healthy.dot], ["Degraded", STATE.degraded.dot],
    ["Unhealthy", STATE.unhealthy.dot], ["Unknown", STATE.unknown.dot], ["Signal", AZURE],
  ];
  let x = W - M.right - 470;
  const yy = 44;
  const parts = [`<text x="${x - 12}" y="${yy + 4}" font-size="11.5" font-weight="600" fill="${MUTED}" text-anchor="end">Legend</text>`];
  for (const [label, color] of items) {
    parts.push(`<circle cx="${x + 6}" cy="${yy}" r="4.5" fill="${color}"/>`);
    parts.push(`<text x="${x + 16}" y="${yy + 4}" font-size="11.5" fill="${LANE_LABEL}">${label}</text>`);
    x += 30 + label.length * 6.6;
  }
  return parts.join("");
}

// ---- assemble --------------------------------------------------------------
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif">
<defs>
  <filter id="cardShadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.4" flood-color="#000000" flood-opacity="0.10"/></filter>
  ${arrowMarkers()}
</defs>
<rect width="${W}" height="${H}" fill="${BG}"/>
${lanes.map(lane).join("\n")}
<line x1="0" y1="${H - 0.5}" x2="${W}" y2="${H - 0.5}" stroke="${HAIR}"/>
<text x="${M.left}" y="34" font-size="18" font-weight="700" fill="${INK}">Shop workload health model</text>
<text x="${M.left}" y="52" font-size="12" fill="${MUTED}">Health rolls up from signals through components and business flows to the workload root.</text>
${legend()}
<g stroke-linecap="round">${edges.map(edge).join("\n")}</g>
${nodes.filter((n) => n.lane !== "signals").map(card).join("\n")}
${nodes.filter((n) => n.lane === "signals").map(signalCard).join("\n")}
</svg>`;

const out = process.argv[2] || "out/swimlane-hero.svg";
writeFileSync(out, svg, "utf8");
console.log(`wrote ${out} (${W}x${H})`);
