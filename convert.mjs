#!/usr/bin/env node
// convert.mjs — Portal-themed Mermaid -> SVG for the Azure Monitor health models service guide.
// Extracts every ```mermaid``` block, remaps the placeholder classDef colors to the exact
// Azure portal health-graph palette, and renders each block to an SVG via mermaid-cli (mmdc).
//
// Palette source of truth (AHM-CloudHealth-Portal):
//   Styles/variables.module.scss  -> healthy #a0d8a0, degraded #db7500, unhealthy #ba0d16, unknown #C8C6C4, azure #0078D4
//   Styles/_graph-view-blade.scss -> node radius 12px, 2px state border, color-mix tinted fill
//
// Usage: node convert.mjs <article.md> <outDir>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const [, , articlePath, outDirArg] = process.argv;
if (!articlePath || !outDirArg) {
  console.error("Usage: node convert.mjs <article.md> <outDir>");
  process.exit(1);
}
const outDir = outDirArg;
mkdirSync(outDir, { recursive: true });

// Portal-palette classDef replacements. Names are kept identical to the article's own
// classDefs (blue/amber/green/red/purple) so every existing `class X green` assignment still binds.
const PORTAL_CLASSDEFS = {
  blue:   "classDef blue fill:#eff6fc,stroke:#0078D4,stroke-width:2px,color:#323232;",   // signal inputs
  green:  "classDef green fill:#f4faf4,stroke:#a0d8a0,stroke-width:2.5px,color:#323232;", // Healthy
  amber:  "classDef amber fill:#fbf1e6,stroke:#db7500,stroke-width:2.5px,color:#323232;", // Degraded
  red:    "classDef red fill:#faecec,stroke:#ba0d16,stroke-width:2.5px,color:#323232;",   // Unhealthy
  purple: "classDef purple fill:#f3eefb,stroke:#8661C5,stroke-width:2px,color:#323232;",  // alternate/standby path
};

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

const md = readFileSync(articlePath, "utf8");
const lines = md.split("\n");

// Walk the file, track the nearest preceding heading, collect mermaid blocks.
const blocks = [];
let currentHeading = "diagram";
let inBlock = false;
let buf = [];
let usedSlugs = new Map();
for (const line of lines) {
  const h = line.match(/^#{2,6}\s+(.*)/);
  if (h && !inBlock) currentHeading = h[1].trim();
  if (line.trim() === "```mermaid") { inBlock = true; buf = []; continue; }
  if (inBlock && line.trim() === "```") {
    inBlock = false;
    let base = slugify(currentHeading) || "diagram";
    const n = (usedSlugs.get(base) || 0) + 1;
    usedSlugs.set(base, n);
    const slug = n === 1 ? base : `${base}-${n}`;
    blocks.push({ slug, code: buf.join("\n") });
    continue;
  }
  if (inBlock) buf.push(line);
}

console.log(`Found ${blocks.length} mermaid blocks.`);

function themeBlock(code) {
  return code
    .split("\n")
    .map((l) => {
      const m = l.match(/^(\s*)classDef\s+(\w+)\s+/);
      if (m && PORTAL_CLASSDEFS[m[2]]) return m[1] + PORTAL_CLASSDEFS[m[2]];
      if (/^\s*%%\s*mermaid\s*$/.test(l)) return null; // drop editor marker comment
      // Native SVG text mode (htmlLabels:false) renders reliably inside <img> on Learn and via librsvg.
      // Strip the HTML <div> wrappers used only for left-align; keep <br/> line breaks (mermaid honors them).
      l = l.replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "");
      return l;
    })
    .filter((l) => l !== null)
    .join("\n");
}

// Post-process mmdc output to match the portal card: rounded corners (radius 12px) + soft drop shadow.
// The portal geometry comes from _graph-view-blade.scss (border-radius: 12px; box-shadow on .react-flow__node).
const SHADOW_DEF =
  '<defs><filter id="ahmShadow" x="-20%" y="-20%" width="140%" height="140%">' +
  '<feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="0.12"/>' +
  "</filter></defs>";
function portalizeSvg(svg) {
  svg = svg.replace(/(<svg\b[^>]*>)/, `$1${SHADOW_DEF}`);
  svg = svg.replace(
    /<rect class="basic label-container"/g,
    '<rect class="basic label-container" rx="12" ry="12" filter="url(#ahmShadow)"'
  );
  return svg;
}

const mmdc = join(__dirname, "node_modules", ".bin", "mmdc");
const cfg = join(__dirname, "mermaid-config.json");
const pcfg = join(__dirname, "puppeteer-config.json");

let ok = 0;
const manifest = [];
const failures = [];
const ATTEMPTS = 3;
for (const b of blocks) {
  const themed = themeBlock(b.code);
  const tmp = join(outDir, b.slug + ".mmd");
  const svg = join(outDir, b.slug + ".svg");
  writeFileSync(tmp, themed, "utf8");
  let rendered = false;
  let lastErr = "";
  for (let attempt = 1; attempt <= ATTEMPTS && !rendered; attempt++) {
    try {
      execFileSync(mmdc, ["-i", tmp, "-o", svg, "-c", cfg, "-p", pcfg, "-b", "transparent"], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      // Guard against a truncated/empty render slipping through (headless-Chrome flakiness).
      const produced = readFileSync(svg, "utf8");
      if (!produced.includes("</svg>")) throw new Error("incomplete SVG output");
      writeFileSync(svg, portalizeSvg(produced), "utf8");
      rendered = true;
    } catch (e) {
      lastErr = (e.stderr?.toString() || e.message || "unknown").split("\n").filter(Boolean).pop() || "unknown";
      if (attempt < ATTEMPTS) console.error(`  retry ${attempt}/${ATTEMPTS - 1} ${b.slug}: ${lastErr}`);
    }
  }
  if (rendered) {
    ok++;
    manifest.push({ slug: b.slug, svg: b.slug + ".svg" });
    console.log("  ok  " + b.slug + ".svg");
  } else {
    failures.push({ slug: b.slug, error: lastErr });
    console.error("  FAIL " + b.slug + ": " + lastErr);
  }
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Rendered ${ok}/${blocks.length} SVGs into ${outDir}`);
if (failures.length > 0) {
  console.error(`ERROR: ${failures.length} diagram(s) failed after ${ATTEMPTS} attempts: ${failures.map((f) => f.slug).join(", ")}`);
  process.exit(1);
}
