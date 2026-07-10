#!/usr/bin/env node
// convert.mjs — legacy entry point, kept for existing workflows: portal-themed Mermaid -> SVG
// for every ```mermaid``` block via mermaid-cli. The implementation lives in src/mermaid.mjs;
// the general CLI is bin/diagrammo.mjs (npx ahm-diagrammo <file.md>).
//
// Usage: node convert.mjs <article.md> <outDir>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { extractBlocks } from "./src/extract.mjs";
import { renderMermaid } from "./src/mermaid.mjs";
import { THEME_NAMES } from "./src/themes.mjs";

const [, , articlePath, outDirArg] = process.argv;
if (!articlePath || !outDirArg) {
  console.error("Usage: node convert.mjs <article.md> <outDir>");
  process.exit(1);
}
const outDir = outDirArg;
mkdirSync(outDir, { recursive: true });

const md = readFileSync(articlePath, "utf8");
const blocks = extractBlocks(md, THEME_NAMES);
console.log(`Found ${blocks.length} mermaid blocks.`);

let ok = 0;
const manifest = [];
const failures = [];
for (const b of blocks) {
  try {
    const { svg } = renderMermaid(b.code, { theme: b.options.theme || "portal" });
    writeFileSync(join(outDir, b.slug + ".svg"), svg, "utf8");
    manifest.push({ slug: b.slug, svg: b.slug + ".svg" });
    ok++;
    console.log("  ok  " + b.slug + ".svg");
  } catch (e) {
    failures.push({ slug: b.slug, error: e.message });
    console.error("  FAIL " + b.slug + ": " + e.message);
  }
}
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`Rendered ${ok}/${blocks.length} SVGs into ${outDir}`);
if (failures.length > 0) {
  console.error(`ERROR: ${failures.length} diagram(s) failed: ${failures.map((f) => f.slug).join(", ")}`);
  process.exit(1);
}
