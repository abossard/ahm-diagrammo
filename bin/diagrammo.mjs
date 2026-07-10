#!/usr/bin/env node
// diagrammo — turn the mermaid blocks in a Markdown file into good-looking SVGs.
//
//   npx ahm-diagrammo README.md
//   npx ahm-diagrammo docs/health.md -o diagrams -t midnight
//
// Health-model flowcharts (flowchart BT + blue/green/amber/red/purple classes) become Azure-portal
// style swimlane figures; every other mermaid block is rendered through mermaid-cli with the same
// theme. Blocks can override anything locally — see README "Tags & YAML".

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { extractBlocks } from "../src/extract.mjs";
import { renderSwimlane, looksLikeHealthModel } from "../src/swimlane.mjs";
import { getTheme, THEME_NAMES } from "../src/themes.mjs";
import { galleryHtml } from "../src/gallery.mjs";

const HELP = `diagrammo — mermaid blocks in Markdown → themed SVGs

Usage:
  npx ahm-diagrammo <file.md> [more.md ...] [options]

Options:
  -o, --out <dir>        output directory                    (default: ./diagrams)
  -t, --theme <name>     ${THEME_NAMES.join(" | ")}   (default: portal)
  -r, --renderer <name>  auto | swimlane | mermaid           (default: auto)
  -l, --list             list detected blocks and options, render nothing
      --no-gallery       don't write gallery.html
  -h, --help             this help
  -V, --version          print version

Per-block options (all optional, all invisible to GitHub's mermaid preview):
  fence info      \`\`\`mermaid swimlane midnight title="Checkout"
  directives      %%| theme: candy          %%| lanes: [Root, Flows, Services]
  frontmatter     ---
                  title: Checkout flow
                  diagrammo:
                    renderer: swimlane
                    theme: slate
                    legend: false
                  ---

Keys: renderer, theme, title, subtitle, name (file name), lanes, legend.
Signal rows may carry their own value and state:  P95 latency = 230 ms (degraded)
`;

function parseArgs(argv) {
  const a = { files: [], out: "diagrams", theme: "portal", renderer: "auto", gallery: true, list: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "-h" || v === "--help") { a.help = true; }
    else if (v === "-V" || v === "--version") { a.version = true; }
    else if (v === "-o" || v === "--out") a.out = argv[++i];
    else if (v === "-t" || v === "--theme") a.theme = argv[++i];
    else if (v === "-r" || v === "--renderer") a.renderer = argv[++i];
    else if (v === "-l" || v === "--list") a.list = true;
    else if (v === "--no-gallery") a.gallery = false;
    else if (v.startsWith("-")) { console.error(`unknown option ${v}\n`); a.help = true; a.bad = true; }
    else a.files.push(v);
  }
  return a;
}

const args = parseArgs(process.argv.slice(2));
if (args.version) {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(pkg.version); process.exit(0);
}
if (args.help || args.files.length === 0) {
  console.log(HELP); process.exit(args.bad || args.files.length === 0 ? 1 : 0);
}
getTheme(args.theme); // fail fast on typos

function pickRenderer(block, cliRenderer) {
  const r = String(block.options.renderer || cliRenderer || "auto").toLowerCase();
  if (r !== "auto") return r;
  return looksLikeHealthModel(block.code) ? "swimlane" : "mermaid";
}

const outDir = resolve(args.out);
let ok = 0, total = 0;
const manifest = [], failures = [], galleryEntries = [];

for (const file of args.files) {
  const md = readFileSync(file, "utf8");
  const blocks = extractBlocks(md, THEME_NAMES);
  console.log(`${basename(file)}: ${blocks.length} mermaid block${blocks.length === 1 ? "" : "s"}`);
  total += blocks.length;

  if (args.list) {
    for (const b of blocks) {
      const opts = Object.entries(b.options).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      console.log(`  ${b.slug}  →  ${pickRenderer(b, args.renderer)}${opts ? `  (${opts})` : ""}`);
    }
    continue;
  }
  mkdirSync(outDir, { recursive: true });

  for (const b of blocks) {
    const renderer = pickRenderer(b, args.renderer);
    const themeName = b.options.theme || args.theme;
    const title = b.options.title ?? b.heading;
    try {
      const theme = getTheme(themeName);
      let svg, meta = {};
      if (renderer === "swimlane") {
        const r = renderSwimlane(b.code, {
          theme, title,
          subtitle: b.options.subtitle,
          lanes: b.options.lanes,
          legend: b.options.legend,
        });
        svg = r.svg; meta = { nodes: r.nodes, lanes: r.lanes, w: r.W, h: r.H };
      } else if (renderer === "mermaid") {
        const { renderMermaid } = await import("../src/mermaid.mjs"); // lazy: only load mmdc path when needed
        svg = renderMermaid(b.code, { theme, background: b.options.background }).svg;
      } else {
        throw new Error(`unknown renderer "${renderer}"`);
      }
      const outName = `${b.slug}.svg`;
      writeFileSync(join(outDir, outName), svg, "utf8");
      manifest.push({ slug: b.slug, svg: outName, source: file, renderer, theme: themeName, title, ...meta });
      galleryEntries.push({ svg: outName, title, renderer, theme: themeName, nodes: meta.nodes });
      ok++;
      console.log(`  ok   ${outName}  [${renderer} · ${themeName}]${meta.nodes ? `  (${meta.nodes} nodes, ${meta.lanes} lanes)` : ""}`);
    } catch (e) {
      failures.push({ slug: b.slug, source: file, error: e.message });
      console.error(`  FAIL ${b.slug}: ${e.message}`);
    }
  }
}

if (!args.list && total > 0) {
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (args.gallery && galleryEntries.length) {
    const source = args.files.map((f) => basename(f)).join(", ");
    writeFileSync(join(outDir, "gallery.html"), galleryHtml(galleryEntries, { source }));
  }
  console.log(`\nRendered ${ok}/${total} diagrams into ${outDir}${args.gallery && galleryEntries.length ? " (open gallery.html to browse)" : ""}`);
}
if (failures.length) process.exit(1);
