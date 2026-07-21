#!/usr/bin/env node
// diagrammo — turn the mermaid blocks in a Markdown file into good-looking SVGs.
//
//   npx ahm-diagrammo README.md
//   npx ahm-diagrammo docs/health.md -o diagrams -t midnight --verbose
//
// Health-model flowcharts (flowchart BT + blue/green/amber/red/purple classes) become Azure-portal
// style swimlane figures; every other mermaid block is rendered through mermaid-cli with the same
// theme. Blocks can override anything locally — see README "Tags & YAML".

import { readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { extractBlocks, reserveSlug } from "../src/extract.mjs";
import { renderSwimlane, looksLikeHealthModel } from "../src/swimlane.mjs";
import { getTheme, THEME_NAMES } from "../src/themes.mjs";
import { galleryHtml } from "../src/gallery.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { syncMarkdown, svgHref, preferredIdentities, decodeManagedSpans, assertBlocksEncodable } from "../src/markdown-sync.mjs";

const HELP = `diagrammo — mermaid blocks in Markdown → themed SVGs

Usage:
  npx ahm-diagrammo <file.md> [more.md ...] [options]

Options:
  -o, --out <dir>        output directory                    (default: ./diagrams)
  -t, --theme <name>     ${THEME_NAMES.join(" | ")}   (default: portal)
  -r, --renderer <name>  auto | swimlane | mermaid           (default: auto)
  -l, --list             list detected blocks and options, render nothing
  -v, --verbose          log every parsed node/edge/fold decision
      --strict           any warning fails the run (exit 1)
      --no-gallery       don't write gallery.html
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

Keys: renderer, theme, title, subtitle, name (file name), lanes, legend.
Signal rows may carry their own value and state:  P95 latency = 230 ms (degraded)
`;

function parseArgs(argv) {
  const a = { files: [], out: "diagrams", theme: "portal", renderer: "auto", gallery: true, list: false, verbose: false, strict: false, syncMarkdown: false, imageFormat: "commonmark" };
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
    else if (v === "--no-gallery") a.gallery = false;
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

function pickRenderer(block, cliRenderer) {
  const r = String(block.options.renderer || cliRenderer || "auto").toLowerCase();
  if (r !== "auto") return r;
  return looksLikeHealthModel(block.code) ? "swimlane" : "mermaid";
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
const manifest = [], failures = [], galleryEntries = [];
const usedSlugs = new Map();

// --sync-markdown: preflight every input file's existing managed markers *before* any block in
// the complete input set is rendered or a new slug is derived. Decodes each file's hidden-source
// comments up front (mdCache always holds the decoded view, never raw/escaped text — the render
// loop below and syncMarkdown() must never see an escaped fence as if it were real Mermaid) and
// asserts every block's fence is still safely re-encodable — a fence whose raw text already
// contains the reserved "--&gt;" token would decode ambiguously later, so it is rejected right
// here, before block 1's SVG is ever written. Reserves every already-managed slug up front so a
// plain/unmanaged block can never collide into a managed identity, and resolves each managed
// fence's stable slug by its exact open line so the render loop below names its SVG correctly the
// first time — never guessing, never renaming. A malformed marker, an unencodable fence, or a
// managed slug duplicated across two input files targeting this same output directory fails
// loudly right here, before any SVG/manifest/gallery/Markdown write happens.
const mdCache = new Map();
const rawCache = new Map(); // file -> original on-disk bytes, for the write-skip comparison below
const preferredByFile = new Map();
if (args.syncMarkdown && !args.list) {
  const slugOwner = new Map(); // slug -> file that first claimed it in this invocation
  let preflightFailed = false;
  for (const file of args.files) {
    let raw;
    try { raw = readFileSync(file, "utf8"); }
    catch (e) { console.error(`error: cannot read ${file}: ${e.message}`); process.exitCode = 1; preflightFailed = true; continue; }
    let md;
    try { md = decodeManagedSpans(raw); }
    catch (e) { console.error(`error: cannot sync ${file}: ${e.message}`); process.exitCode = 1; preflightFailed = true; continue; }
    let identities;
    try { identities = preferredIdentities(md); }
    catch (e) { console.error(`error: cannot sync ${file}: ${e.message}`); process.exitCode = 1; preflightFailed = true; continue; }
    try {
      assertBlocksEncodable(md, extractBlocks(md, THEME_NAMES, new Map()));
    } catch (e) {
      console.error(`error: cannot sync ${file}: ${e.message}`); process.exitCode = 1; preflightFailed = true; continue;
    }
    rawCache.set(file, raw);
    mdCache.set(file, md);
    preferredByFile.set(file, identities);
    for (const slug of identities.slugs) {
      const owner = slugOwner.get(slug);
      if (owner) {
        console.error(`error: cannot sync ${file}: managed slug "${slug}" is already used by ${owner} — duplicate managed identity targeting the same output directory (${outDir})`);
        process.exitCode = 1; preflightFailed = true;
      } else {
        slugOwner.set(slug, file);
      }
    }
  }
  if (preflightFailed) process.exit(process.exitCode || 1);
  for (const identities of preferredByFile.values()) {
    for (const slug of identities.slugs) reserveSlug(usedSlugs, slug);
  }
}

for (const file of args.files) {
  let md = mdCache.get(file);
  if (md === undefined) {
    let raw;
    try { raw = readFileSync(file, "utf8"); }
    catch (e) { console.error(`error: cannot read ${file}: ${e.message}`); process.exitCode = 1; continue; }
    rawCache.set(file, raw);
    // Always render from a decoded view — even outside --sync-markdown — so a file carrying an
    // existing hidden-source comment (from a prior sync) is parsed as real Mermaid, never as the
    // escaped text it's stored as on disk. A no-op for bare fences and old <details>-shape blocks.
    try { md = decodeManagedSpans(raw); }
    catch (e) { console.error(`error: cannot read ${file}: ${e.message}`); process.exitCode = 1; continue; }
  }
  const preferred = args.syncMarkdown ? preferredByFile.get(file)?.byOpenLine ?? null : null;
  const blocks = extractBlocks(md, THEME_NAMES, usedSlugs, preferred);
  console.log(`${file}: ${blocks.length} mermaid block${blocks.length === 1 ? "" : "s"}`);
  total += blocks.length;
  const syncSpecs = [];
  let fileRenderFailed = false;

  for (const b of blocks) {
    const renderer = pickRenderer(b, args.renderer);
    const themeName = b.options.theme || args.theme;
    const title = b.options.title ?? b.heading;
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
          subtitle: b.options.subtitle,
          lanes: b.options.lanes,
          legend: b.options.legend,
          diag, baseLine: b.codeLine - 1,
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
      manifest.push({ slug: b.slug, svg: outName, source: file, line: b.line, renderer, theme: themeName, title, ...meta });
      galleryEntries.push({ svg: outName, title, renderer, theme: themeName, nodes: meta.nodes });
      ok++;
      console.log(`  ok   ${file}:${b.line}  ${outName}  [${renderer} · ${themeName}]${meta.nodes ? `  (${meta.nodes} nodes, ${meta.lanes} lanes, ${meta.w}×${meta.h})` : ""}`);
      if (args.syncMarkdown) {
        syncSpecs.push({ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title, href: svgHref(file, join(outDir, outName), args.imageFormat) });
      }
    } catch (e) {
      failures.push({ slug: b.slug, source: file, line: b.line, error: e.message });
      console.error(`  FAIL ${file}:${b.line}  ${b.slug}: ${e.message}`);
      fileRenderFailed = true;
    }
    for (const line of diag.format({ verbose: args.verbose, indent: "       " })) console.error(line);
    warnCount += diag.warnings.length;
  }

  // Mutate the Markdown only once every block in this file has rendered with no failures — a
  // render failure leaves the file untouched, matching the default command's own guarantee.
  // Malformed pre-existing markers are a separate, transform-level failure: reported loudly,
  // never guessed/repaired, and — since the write only happens after syncMarkdown returns — the
  // file is never partially mutated either way. Compared against the *original on-disk bytes*
  // (rawCache), not the decoded view `md`: those two always differ whenever any hidden-source
  // comment exists (decoded is unescaped, `synced` is freshly re-encoded), so comparing against
  // `md` would report a "change" — and rewrite the file — on every single idempotent rerun.
  if (args.syncMarkdown && !args.list && blocks.length > 0 && !fileRenderFailed) {
    try {
      const synced = syncMarkdown(md, syncSpecs, { imageFormat: args.imageFormat });
      if (synced !== rawCache.get(file)) {
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
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  if (args.gallery && galleryEntries.length) {
    const source = args.files.map((f) => basename(f)).join(", ");
    writeFileSync(join(outDir, "gallery.html"), galleryHtml(galleryEntries, { source }));
  }
  const warnNote = warnCount ? `, ${warnCount} warning${warnCount === 1 ? "" : "s"}` : "";
  console.log(`\nRendered ${ok}/${total} diagrams into ${outDir}${warnNote}${args.gallery && galleryEntries.length ? " (open gallery.html to browse)" : ""}`);
} else if (args.list && warnCount) {
  console.error(`\n${warnCount} warning${warnCount === 1 ? "" : "s"}`);
}
if (failures.length || (args.strict && warnCount > 0)) process.exit(1);
