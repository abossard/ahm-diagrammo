#!/usr/bin/env node
// diagrammo — turn the mermaid blocks in a Markdown file into good-looking SVGs.
//
//   node bin/diagrammo.mjs README.md
//   node bin/diagrammo.mjs docs/health.md -o diagrams -t midnight --verbose
//
// Health-model flowcharts (flowchart BT + blue/green/amber/red/purple classes) become Azure-portal
// style swimlane figures; every other mermaid block is rendered through mermaid-cli with the same
// theme. Blocks can override anything locally — see README "Tags & YAML".

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { prepareDocuments } from "../src/document.mjs";
import { renderSwimlane } from "../src/swimlane.mjs";
import { getTheme, THEME_NAMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { syncMarkdown, svgHref } from "../src/markdown-sync.mjs";

const HELP = `diagrammo — mermaid blocks in Markdown → themed SVGs

Usage:
  diagrammo <file.md> [more.md ...] [options]

Options:
  -o, --out <dir>        output directory                    (default: ./diagrams)
  -t, --theme <name>     ${THEME_NAMES.join(" | ")}   (default: portal)
  -r, --renderer <name>  auto | swimlane | mermaid           (default: auto)
  -l, --list             list detected blocks and options, render nothing
  -v, --verbose          log every parsed node/edge/fold decision
      --strict           any warning fails the run (exit 1)
      --sync-markdown    rewrite each file's fences into a visible <img> + fully hidden, still-editable
                         Mermaid source; leaves the file untouched if any of its blocks fails
      --image-format <fmt>  visible embed for --sync-markdown: commonmark | learn   (default: commonmark)
                            commonmark → ![alt](href); learn → Microsoft Learn :::image:::  directive
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

Keys: renderer, theme, title, subtitle, name (file name), lanes, legend,
      laneLabels (default true — set false to hide lane label text and reclaim its gutter width).
Signal rows may carry their own value and state:  P95 latency = 230 ms (degraded)
`;

function parseArgs(argv) {
  const a = { files: [], out: "diagrams", theme: "portal", renderer: "auto", list: false, verbose: false, strict: false, syncMarkdown: false, imageFormat: "commonmark" };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "-h" || v === "--help") a.help = true;
    else if (v === "-V" || v === "--version") a.version = true;
    else if (v === "-o" || v === "--out" || v === "-t" || v === "--theme" || v === "-r" || v === "--renderer" || v === "--image-format") {
      const value = argv[i + 1];
      if (value == null || value.startsWith("-")) {
        console.error(`error: option ${v} requires a value`);
        a.help = true; a.bad = true;
      } else {
        if (v === "-o" || v === "--out") a.out = value;
        else if (v === "-t" || v === "--theme") a.theme = value;
        else if (v === "-r" || v === "--renderer") a.renderer = value;
        else a.imageFormat = value;
        i++;
      }
    }
    else if (v === "-l" || v === "--list") a.list = true;
    else if (v === "-v" || v === "--verbose") a.verbose = true;
    else if (v === "--strict") a.strict = true;
    else if (v === "--sync-markdown") a.syncMarkdown = true;
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
try { getTheme(args.theme); } catch (e) { console.error(`error: ${e.message}`); process.exit(1); }
if (!["auto", "swimlane", "mermaid"].includes(args.renderer)) {
  console.error(`error: unknown renderer "${args.renderer}" (use auto, swimlane, or mermaid)`); process.exit(1);
}
if (!["commonmark", "learn"].includes(args.imageFormat)) {
  console.error(`error: unknown image format "${args.imageFormat}" (use commonmark or learn)`); process.exit(1);
}

// Same-directory temp file + rename: POSIX rename(2) is atomic on the same filesystem. The temp
// name includes this process's pid plus a random suffix so two concurrent invocations (even ones
// syncing the exact same target file) never share a temp path and race each other's
// rename/cleanup. Cleans up the temp file on any failure so a failed sync never leaves stray
// files or a partial write.
function atomicWriteFileSync(path, content) {
  const target = resolve(path);
  const unique = `${process.pid}-${randomBytes(6).toString("hex")}`;
  const tmp = join(dirname(target), `.${basename(target)}.${unique}.diagrammo-sync.tmp`);
  writeFileSync(tmp, content, "utf8");
  try {
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort cleanup */ }
    throw e;
  }
}

const outDir = resolve(args.out);
let ok = 0, total = 0, warnCount = 0;
const failures = [];
const inputs = [];
for (const file of args.files) {
  try { inputs.push({ name: file, source: readFileSync(file, "utf8") }); }
  catch (e) { console.error(`error: cannot read ${file}: ${e.message}`); process.exitCode = 1; }
}
const documents = prepareDocuments(inputs, { theme: args.theme, renderer: args.renderer }, { sync: args.syncMarkdown && !args.list });
for (const doc of documents) {
  for (const issue of doc.diagnostics) {
    console.error(`error: cannot ${args.syncMarkdown ? "sync" : "read"} ${doc.name}: ${issue.message}`);
    process.exitCode = 1;
  }
}
// Sync preflight covers the whole batch before any artifact or Markdown write.
if (args.syncMarkdown && !args.list && process.exitCode) process.exit(1);
if (documents.some((doc) => doc.diagnostics.some((issue) => issue.scope === "batch"))) process.exit(1);

for (const { name: file, source: raw, markdown: md, blocks, diagnostics } of documents) {
  if (diagnostics.length) continue;
  console.log(`${file}: ${blocks.length} mermaid block${blocks.length === 1 ? "" : "s"}`);
  total += blocks.length;
  const syncSpecs = [];
  let fileRenderFailed = false;

  for (const b of blocks) {
    const renderer = b.renderer;
    const options = b.effectiveOptions;
    const themeName = options.theme;
    const title = options.title;
    const diag = new Diagnostics({ file });
    for (const iss of b.issues) diag.add(iss.level, iss.message, { line: iss.line });

    if (args.list) {
      const opts = Object.entries(b.options).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ");
      console.log(`  ${file}:${b.line}  ${b.slug}  →  ${renderer} · ${themeName}${opts ? `  (${opts})` : ""}`);
      for (const line of diag.format({ verbose: args.verbose, indent: "    " })) console.error(line);
      warnCount += diag.warnings.length;
      if (diag.hasErrors()) { failures.push({ slug: b.slug, source: file, line: b.line, error: diag.errors[0].message }); }
      continue;
    }
    mkdirSync(outDir, { recursive: true });

    try {
      if (diag.hasErrors()) throw new Error(diag.errors.map((e) => e.message).join("; "));
      const theme = getTheme(themeName);
      let svg, meta = {};
      if (renderer === "swimlane") {
        const r = renderSwimlane(b.code, {
          theme, title,
          subtitle: options.subtitle,
          lanes: options.lanes,
          legend: options.legend,
          laneLabels: options.laneLabels,
          diag, baseLine: b.codeLine - 1,
        });
        svg = r.svg; meta = { nodes: r.nodes, lanes: r.lanes, w: r.W, h: r.H };
      } else if (renderer === "mermaid") {
        const { renderMermaid } = await import("../src/mermaid.mjs"); // lazy: only load mmdc path when needed
        svg = renderMermaid(b.code, { theme, background: options.background }).svg;
      } else {
        throw new Error(`unknown renderer "${renderer}"`);
      }
      const outName = `${b.slug}.svg`;
      writeFileSync(join(outDir, outName), svg, "utf8");
      ok++;
      console.log(`  ok   ${file}:${b.line}  ${outName}  [${renderer} · ${themeName}]${meta.nodes ? `  (${meta.nodes} nodes, ${meta.lanes} lanes, ${meta.w}×${meta.h})` : ""}`);
      if (args.syncMarkdown) {
        syncSpecs.push({ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title, alt: b.options.alt, href: svgHref(file, join(outDir, outName), args.imageFormat) });
      }
    } catch (e) {
      failures.push({ slug: b.slug, source: file, line: b.line, error: e.message });
      console.error(`  FAIL ${file}:${b.line}  ${b.slug}: ${e.message}`);
      fileRenderFailed = true;
    }
    for (const line of diag.format({ verbose: args.verbose, indent: "       " })) console.error(line);
    warnCount += diag.warnings.length;
  }

  // Compare against raw bytes, not the decoded view, to preserve idempotent reruns.
  if (args.syncMarkdown && !args.list && blocks.length > 0 && !fileRenderFailed) {
    try {
      const synced = syncMarkdown(md, syncSpecs, { imageFormat: args.imageFormat });
      if (synced !== raw) {
        atomicWriteFileSync(file, synced);
        console.log(`  synced ${file} (${syncSpecs.length} managed block${syncSpecs.length === 1 ? "" : "s"})`);
      }
    } catch (e) {
      console.error(`error: cannot sync ${file}: ${e.message}`);
      process.exitCode = 1;
    }
  }
}

if (!args.list && total > 0) {
  const warnNote = warnCount ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}` : "";
  console.log(`\nRendered ${ok}/${total} diagrams into ${outDir}${warnNote}`);
} else if (args.list && warnCount) {
  console.error(`\n${warnCount} warning${warnCount === 1 ? "" : "s"}`);
}
if (failures.length || (args.strict && warnCount > 0)) process.exit(1);
