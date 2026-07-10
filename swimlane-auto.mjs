#!/usr/bin/env node
// swimlane-auto.mjs — legacy entry point, kept for existing workflows.
// The implementation lives in src/swimlane.mjs; the general CLI is bin/diagrammo.mjs
// (npx ahm-diagrammo <file.md>), which adds themes, per-block options, and a gallery.
//
// Usage: node swimlane-auto.mjs <article.md> <outDir>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { extractBlocks } from "./src/extract.mjs";
import { renderSwimlane } from "./src/swimlane.mjs";
import { THEME_NAMES } from "./src/themes.mjs";

const [, , articlePath, outDirArg] = process.argv;
if (!articlePath) {
  console.error("Usage: node swimlane-auto.mjs <article.md> <outDir>");
  process.exit(1);
}
const outDir = outDirArg || "out-swimlane";
mkdirSync(outDir, { recursive: true });

function titleFor(heading) {
  const t = heading.replace(/[`*]/g, "").trim();
  return t.length > 62 ? t.slice(0, 60) + "…" : t;
}

const md = readFileSync(articlePath, "utf8");
const blocks = extractBlocks(md, THEME_NAMES);
console.log(`Found ${blocks.length} mermaid blocks.`);
let ok = 0; const manifest = [], fails = [];
for (const blk of blocks) {
  try {
    const { svg, W, H, nodes, lanes } = renderSwimlane(blk.code, {
      theme: blk.options.theme || "portal",
      title: blk.options.title ?? titleFor(blk.heading),
      subtitle: blk.options.subtitle,
      lanes: blk.options.lanes,
      legend: blk.options.legend,
    });
    writeFileSync(`${outDir}/${blk.slug}.svg`, svg, "utf8");
    manifest.push({ slug: blk.slug, svg: blk.slug + ".svg", nodes, lanes, w: W, h: H });
    ok++; console.log(`  ok  ${blk.slug}.svg  (${nodes} nodes, ${lanes} lanes, ${W}x${H})`);
  } catch (e) { fails.push({ slug: blk.slug, error: e.message }); console.error(`  FAIL ${blk.slug}: ${e.message}`); }
}
writeFileSync(`${outDir}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`Rendered ${ok}/${blocks.length} swimlane SVGs into ${outDir}`);
if (fails.length) process.exit(1);
