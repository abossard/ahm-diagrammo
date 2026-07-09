// azure-arch.mjs — declarative, code-based SVG engine for Azure architecture diagrams.
// Renders a scene {containers, nodes, edges} into a single native-text SVG (Learn-safe).
// Icons are pluggable: an `icons/<key>.svg` file on disk overrides the built-in original glyph,
// so the official Microsoft Azure architecture icons can be dropped in for exact branding.
//
// Usage: import { renderScene } from "./azure-arch.mjs"; writeFileSync(out, renderScene(scene))

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { iconSvg } from "./icons.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT = "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";

// palette
const INK = "#242424", MUTED = "#605e5c", EDGE = "#3b3a39";
const VNET_STROKE = "#7fb2e8", VNET_FILL = "#eaf2fb", VNET_HDR = "#cfe2f7";
const SUBNET_STROKE = "#a9c9ee", SUBNET_FILL = "#f4f8fd";
const GROUP_STROKE = "#d6d4d2", GROUP_FILL = "#faf9f8";
const REGION_STROKE = "#bdbdbd", REGION_FILL = "#f3f2f1";
const ZONE_STROKE = "#f2c14e", ZONE_FILL = "#fffdf6";
const TILE_STROKE = "#e1dfdd", HAIR = "#edebe9";

const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- icon inlining (disk override -> built-in) ----
let __iconInstance = 0;
function iconMarkup(key, size, cx, cy) {
  const file = join(__dirname, "icons", `${key}.svg`);
  let inner, vb = 48;
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    const m = raw.match(/viewBox="([\d.\s-]+)"/);
    if (m) vb = parseFloat(m[1].trim().split(/\s+/)[2]) || 48;
    inner = raw.replace(/^[\s\S]*?<svg[^>]*>/i, "").replace(/<\/svg>\s*$/i, "");
    // namespace all ids so repeated icons don't collide on gradient/filter/clip ids
    const ns = `i${__iconInstance++}_`;
    const ids = new Set();
    inner.replace(/\bid="([^"]+)"/g, (_, id) => { ids.add(id); return _; });
    for (const id of ids) {
      const re = new RegExp(`(["'#(])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(["')])`, "g");
      inner = inner
        .replace(new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"), `id="${ns}${id}"`)
        .replace(new RegExp(`url\\(#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "g"), `url(#${ns}${id})`)
        .replace(new RegExp(`(xlink:href|href)="#${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`, "g"), `$1="#${ns}${id}"`);
    }
  } else {
    inner = iconSvg(key);
  }
  const s = size / vb;
  return `<g transform="translate(${cx - size / 2},${cy - size / 2}) scale(${s.toFixed(4)})">${inner}</g>`;
}

// ---- geometry registry ----
function makeRegistry() {
  const box = new Map(); // id -> {cx,cy,w,h}
  return {
    add: (id, cx, cy, w, h) => box.set(id, { cx, cy, w, h }),
    anchor(ref) {
      const b = box.get(ref.id);
      if (!b) throw new Error(`unknown anchor id: ${ref.id}`);
      const { cx, cy, w, h } = b, s = ref.side || "bottom";
      const off = ref.off || 0; // offset along the edge (px), for multiple lines on one side
      if (s === "top") return { x: cx + off, y: cy - h / 2, dir: [0, -1] };
      if (s === "bottom") return { x: cx + off, y: cy + h / 2, dir: [0, 1] };
      if (s === "left") return { x: cx - w / 2, y: cy + off, dir: [-1, 0] };
      return { x: cx + w / 2, y: cy + off, dir: [1, 0] }; // right
    },
  };
}

// rounded orthogonal polyline
function roundedPath(pts, r = 8) {
  if (pts.length < 2) return "";
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i], a = pts[i - 1], b = pts[i + 1];
    const v1 = norm(p.x - a.x, p.y - a.y), v2 = norm(b.x - p.x, b.y - p.y);
    const r1 = Math.min(r, dist(a, p) / 2), r2 = Math.min(r, dist(p, b) / 2), rr = Math.min(r1, r2);
    const c1 = { x: p.x - v1.x * rr, y: p.y - v1.y * rr };
    const c2 = { x: p.x + v2.x * rr, y: p.y + v2.y * rr };
    d += ` L${c1.x} ${c1.y} Q${p.x} ${p.y} ${c2.x} ${c2.y}`;
  }
  const last = pts[pts.length - 1];
  d += ` L${last.x} ${last.y}`;
  return d;
}
const norm = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// ---- container ----
function drawContainer(c, reg) {
  reg.add(c.id, c.x + c.w / 2, c.y + c.h / 2, c.w, c.h);
  const kind = c.kind || "group";
  const style = {
    vnet:   { stroke: VNET_STROKE, fill: "none", sw: 2.5, dash: "", r: 4 },
    subnet: { stroke: SUBNET_STROKE, fill: SUBNET_FILL, sw: 1.6, dash: "5 4", r: 4 },
    region: { stroke: REGION_STROKE, fill: REGION_FILL, sw: 1.4, dash: "", r: 3 },
    zone:   { stroke: ZONE_STROKE, fill: ZONE_FILL, sw: 1.8, dash: "", r: 10 },
    group:  { stroke: GROUP_STROKE, fill: GROUP_FILL, sw: 1.4, dash: "", r: 3 },
  }[kind];
  const p = [];
  p.push(`<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="${style.r}" fill="${style.fill === "none" ? "none" : style.fill}" stroke="${style.stroke}" stroke-width="${style.sw}"${style.dash ? ` stroke-dasharray="${style.dash}"` : ""}/>`);
  if (kind === "vnet") p.splice(0, 1, `<rect x="${c.x}" y="${c.y}" width="${c.w}" height="${c.h}" rx="4" fill="${VNET_FILL}" fill-opacity="0.35" stroke="${VNET_STROKE}" stroke-width="2.5"/>`);
  // header label (top-left) with small network icon
  if (c.label) {
    const lx = c.x + 12, ly = c.y + 22;
    if (c.icon) p.push(iconMarkup(c.icon, 18, lx + 9, ly - 4));
    const tx = c.icon ? lx + 24 : lx;
    const weight = kind === "zone" ? 700 : 600;
    const lines = Array.isArray(c.label) ? c.label : [c.label];
    lines.forEach((ln, i) => p.push(`<text x="${tx}" y="${ly + i * 15}" font-size="13" font-weight="${weight}" fill="${INK}">${esc(ln)}</text>`));
  }
  // zone label centered at bottom
  if (kind === "zone" && c.footer) p.push(`<text x="${c.x + c.w / 2}" y="${c.y + c.h - 8}" font-size="12" font-weight="700" fill="${INK}" text-anchor="middle">${esc(c.footer)}</text>`);
  // shield badge (top-right corner, straddling the border)
  if (c.badge === "shield") p.push(iconMarkup("shield", 26, c.x + c.w - 6, c.y + 6));
  return p.join("\n");
}

// ---- node (icon tile + caption below) ----
const TILE = { w: 96, h: 74, icon: 42 };
function drawNode(n, reg) {
  const style = n.style || "tile";
  const w = n.w || TILE.w, h = n.h || TILE.h, iconSize = n.iconSize || TILE.icon;
  reg.add(n.id, n.x, n.y, w, h);
  const p = [];
  const iconCy = style === "bare" ? n.y : n.y;
  if (style !== "bare") {
    const fill = style === "tile-gray" ? "#f3f2f1" : "#ffffff";
    p.push(`<rect x="${n.x - w / 2}" y="${n.y - h / 2}" width="${w}" height="${h}" rx="6" fill="${fill}" stroke="${TILE_STROKE}" stroke-width="1.2" filter="url(#tileShadow)"/>`);
  }
  p.push(iconMarkup(n.icon, iconSize, n.x, iconCy - (style === "bare" ? 6 : 2)));
  // caption below the tile
  const lines = Array.isArray(n.label) ? n.label : (n.label ? [n.label] : []);
  const capY = n.y + h / 2 + 15;
  lines.forEach((ln, i) => p.push(`<text x="${n.x}" y="${capY + i * 14}" font-size="12.5" fill="${INK}" text-anchor="middle" font-weight="${n.bold ? 600 : 400}">${esc(ln)}</text>`));
  // optional group label (muted, below the caption) e.g. "Data", "Certificates"
  if (n.groupLabel) {
    const gl = Array.isArray(n.groupLabel) ? n.groupLabel : [n.groupLabel];
    gl.forEach((g, i) => p.push(`<text x="${n.x}" y="${capY + lines.length * 14 + 4 + i * 14}" font-size="12" fill="${MUTED}" text-anchor="middle">${esc(g)}</text>`));
  }
  // optional small label above the tile (e.g. "Managed identity")
  if (n.topLabel) p.push(`<text x="${n.x}" y="${n.y - h / 2 - 8}" font-size="11.5" fill="${MUTED}" text-anchor="middle">${esc(n.topLabel)}</text>`);
  return p.join("\n");
}

// ---- edge ----
function drawEdge(e, reg) {
  const a = reg.anchor(e.from), b = reg.anchor(e.to);
  const pts = [{ x: a.x, y: a.y }];
  (e.via || []).forEach(([x, y]) => pts.push({ x, y }));
  pts.push({ x: b.x, y: b.y });
  const dash = e.dash ? ` stroke-dasharray="${e.dash}"` : "";
  const marker = e.arrow === false ? "" : ` marker-end="url(#arrowhead)"`;
  const p = [`<path d="${roundedPath(pts, e.r ?? 9)}" fill="none" stroke="${e.color || EDGE}" stroke-width="${e.sw || 1.6}"${dash}${marker} stroke-linecap="round"/>`];
  if (e.label) {
    const mid = pts[Math.floor(pts.length / 2) - (pts.length % 2 === 0 ? 1 : 0)] || pts[0];
    const lx = e.labelAt ? e.labelAt[0] : mid.x, ly = e.labelAt ? e.labelAt[1] : mid.y - 6;
    const tw = e.label.length * 6.2 + 10;
    p.push(`<rect x="${lx - tw / 2}" y="${ly - 10}" width="${tw}" height="15" rx="3" fill="#ffffff" opacity="0.95"/>`);
    p.push(`<text x="${lx}" y="${ly + 2}" font-size="11" fill="${MUTED}" text-anchor="middle">${esc(e.label)}</text>`);
  }
  return p.join("\n");
}

// ---- Microsoft Azure logo (original 4-square mark + wordmark) ----
function azureLogo(x, y) {
  return `<g transform="translate(${x},${y})">
    <rect x="0" y="0" width="11" height="11" fill="#f25022"/>
    <rect x="13" y="0" width="11" height="11" fill="#7fba00"/>
    <rect x="0" y="13" width="11" height="11" fill="#00a4ef"/>
    <rect x="13" y="13" width="11" height="11" fill="#ffb900"/>
    <text x="32" y="11" font-family="${FONT}" font-size="15" font-weight="600" fill="#5e5e5e">Microsoft</text>
    <text x="32" y="26" font-family="${FONT}" font-size="15" font-weight="400" fill="#5e5e5e">Azure</text>
  </g>`;
}

// ---- main ----
export function renderScene(scene) {
  const reg = makeRegistry();
  const W = scene.width, H = scene.height;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<defs>
    <filter id="tileShadow" x="-15%" y="-15%" width="130%" height="130%"><feDropShadow dx="0" dy="1" stdDeviation="1.1" flood-color="#000" flood-opacity="0.10"/></filter>
    <marker id="arrowhead" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse"><path d="M1 1 L9 5 L1 9" fill="none" stroke="${EDGE}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></marker>
  </defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  if (scene.title) out.push(`<text x="40" y="40" font-size="20" font-weight="700" fill="${INK}">${esc(scene.title)}</text>`);
  if (scene.subtitle) out.push(`<text x="40" y="62" font-size="13" fill="${MUTED}">${esc(scene.subtitle)}</text>`);

  // z-order: containers (outer first) -> edges -> nodes -> badges already in containers
  const containers = scene.containers || [];
  // register + draw containers back-to-front (outer to inner by area, largest first)
  const ordered = [...containers].sort((a, b) => b.w * b.h - a.w * a.h);
  for (const c of ordered) out.push(drawContainer(c, reg));
  // register nodes (so edges can anchor) then draw edges beneath nodes
  for (const n of scene.nodes || []) reg.add(n.id, n.x, n.y, n.w || TILE.w, n.h || TILE.h);
  for (const e of scene.edges || []) out.push(drawEdge(e, reg));
  for (const n of scene.nodes || []) out.push(drawNode(n, reg));

  if (scene.logo) out.push(azureLogo(40, H - 46));
  for (const t of scene.texts || []) out.push(`<text x="${t.x}" y="${t.y}" font-size="${t.size || 12}" font-weight="${t.weight || 400}" fill="${t.color || INK}" text-anchor="${t.anchor || "start"}">${esc(t.text)}</text>`);
  out.push(`</svg>`);
  return out.join("\n");
}
