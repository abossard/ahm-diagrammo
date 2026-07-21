// examples.test.mjs — proves examples/sync-markdown/ is a genuine, already-synced specimen of
// `--sync-markdown`: one canonical managed block, a real SVG the current CLI actually produced
// from the embedded fence (never hand-crafted/copied), and a byte-identical, idempotent rerun of
// the exact documented command. Own helper set (tmp()/run()), matching test/cli.test.mjs and
// test/build-pages.test.mjs's per-file convention rather than a shared helper module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFileSync, writeFileSync, mkdtempSync, mkdirSync, cpSync, existsSync, rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { validateManagedSpans, decodeManagedSpans } from "../src/markdown-sync.mjs";
import { parseGraph, foldSignals, looksLikeHealthModel } from "../src/swimlane.mjs";
import { verifySvgString } from "./helpers/geo.mjs";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "diagrammo.mjs");
const EXAMPLE_DIR = join(ROOT, "examples", "sync-markdown");
const README = () => readFileSync(join(ROOT, "README.md"), "utf8");

// Cleanup registry: a single process "exit" listener (registered once, at module load) removes
// every temp dir any tmp() call has created — instead of one new listener per call, which trips
// Node's MaxListenersExceededWarning (matches test/cli.test.mjs's tmp() convention).
const cleanupDirs = [];
process.on("exit", () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "diagrammo-examples-test-"));
  cleanupDirs.push(d);
  return d;
}
// run the real CLI subprocess in a chosen cwd; never throw on nonzero exit
async function runIn(cwd, ...argv) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [CLI, ...argv], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("root README links to the checked-in examples/sync-markdown/ example", () => {
  assert.match(README(), /\]\(examples\/sync-markdown\/\)/, "README omits a link to examples/sync-markdown/");
});

test("examples/sync-markdown/README.md holds exactly one canonical managed block around a real, non-trivial fence", () => {
  const mdPath = join(EXAMPLE_DIR, "README.md");
  const md = readFileSync(mdPath, "utf8");

  // exactly one canonical <!-- diagrammo:sync SLUG --> / <!-- /diagrammo:sync SLUG --> span
  const spans = validateManagedSpans(md);
  assert.equal(spans.length, 1, `expected exactly one managed span, found ${spans.length}`);
  const slug = spans[0].slug;

  // the fence's real Mermaid source lives escaped inside a hidden-source comment on disk —
  // extractBlocks() must always see the *decoded* view, never the raw/escaped text
  assert.match(md, /--&gt;/, "sanity: the committed fence is stored escaped on disk");
  const decoded = decodeManagedSpans(md);
  const blocks = extractBlocks(decoded, THEME_NAMES);
  assert.equal(blocks.length, 1, "expected exactly one mermaid fence");
  assert.equal(blocks[0].slug, slug);
  assert.match(blocks[0].code, /^flowchart BT/m);

  // image href resolves to a real, committed SVG
  const hrefMatch = md.match(/!\[[^\]]*\]\(([^)]+)\)/);
  assert.ok(hrefMatch, "no Markdown image found");
  const svgPath = join(EXAMPLE_DIR, hrefMatch[1]);
  assert.ok(existsSync(svgPath), `image href does not resolve to a real file: ${hrefMatch[1]}`);
  assert.match(hrefMatch[1], new RegExp(`^assets/${slug}\\.svg$`));

  // the Mermaid source is fully hidden (not merely collapsed): no <details>/<summary> disclosure
  // widget, no leaked fence content, and the <img> is the only visible/renderable element (marked
  // structural check, same technique as test/markdown-sync.test.mjs)
  const html = marked.parse(md);
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.doesNotMatch(html, /<pre><code class="language-mermaid">/, "the mermaid fence itself must never render as visible code");
  const imgIdx = html.indexOf(`<img src="${hrefMatch[1]}"`);
  assert.ok(imgIdx >= 0, "expected a visible <img>");

  // non-trivial diagram: verified via the project's own parser, not brittle line counts
  assert.equal(looksLikeHealthModel(blocks[0].code), true);
  const g = foldSignals(parseGraph(blocks[0].code));
  const states = new Set([...g.nodes.values()].map((n) => n.state));
  for (const s of ["healthy", "degraded", "unhealthy", "unknown", "alt"]) {
    assert.ok(states.has(s), `diagram is missing state "${s}"`);
  }
  assert.ok(g.nodes.size >= 5, `expected >=5 state-bearing entities, found ${g.nodes.size}`);
  const multiRow = [...g.nodes.values()].some((n) => (n.signals || []).length >= 2);
  assert.ok(multiRow, "expected at least one multi-row signal table");
  const limitedPropagation = g.edges.some((e) => e.dashed && /limited/i.test(e.label || ""));
  assert.ok(limitedPropagation, "expected a dashed, labeled limited-propagation edge");
  assert.match(blocks[0].code, /\(worstOf\)/);
});

test("the committed SVG is native, foreignObject-free, and geometrically valid", () => {
  const md = readFileSync(join(EXAMPLE_DIR, "README.md"), "utf8");
  const [href] = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const svg = readFileSync(join(EXAMPLE_DIR, href), "utf8");
  assert.equal((svg.match(/foreignObject/g) || []).length, 0, "example SVG must not use foreignObject");
  assert.match(svg, /<text/, "example SVG must carry native <text>");
  assert.deepEqual(verifySvgString(svg), []);
});

test("running the documented command against a tmp copy reproduces byte-identical, idempotent output (no Chrome)", async () => {
  const committedMd = readFileSync(join(EXAMPLE_DIR, "README.md"), "utf8");
  const [href] = [...committedMd.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  const committedSvg = readFileSync(join(EXAMPLE_DIR, href), "utf8");

  const dir = tmp();
  mkdirSync(join(dir, "assets"), { recursive: true });
  cpSync(join(EXAMPLE_DIR, "README.md"), join(dir, "README.md"));
  cpSync(join(EXAMPLE_DIR, "assets", ".gitignore"), join(dir, "assets", ".gitignore"));
  cpSync(join(EXAMPLE_DIR, href), join(dir, href));

  // exact documented args (README.md -o assets --sync-markdown --no-gallery), only the bin's own
  // absolute path differs so the subprocess can be spawned from a tmp cwd
  const r1 = await runIn(dir, "README.md", "-o", "assets", "--sync-markdown", "--no-gallery");
  assert.equal(r1.code, 0, r1.stderr || r1.stdout);
  assert.match(r1.stdout, /swimlane/, "expected the Chrome-free swimlane renderer, not mermaid-cli");
  const mdAfterFirst = readFileSync(join(dir, "README.md"), "utf8");
  const svgAfterFirst = readFileSync(join(dir, href), "utf8");
  assert.equal(mdAfterFirst, committedMd, "regenerated Markdown drifted from the committed file");
  assert.equal(svgAfterFirst, committedSvg, "regenerated SVG drifted from the committed file");
  assert.ok(existsSync(join(dir, "assets", "manifest.json")), "manifest.json is always written");
  assert.ok(!existsSync(join(dir, "assets", "gallery.html")), "--no-gallery must skip gallery.html");

  // rerun: byte-identical again (idempotent)
  const r2 = await runIn(dir, "README.md", "-o", "assets", "--sync-markdown", "--no-gallery");
  assert.equal(r2.code, 0, r2.stderr || r2.stdout);
  const mdAfterSecond = readFileSync(join(dir, "README.md"), "utf8");
  const svgAfterSecond = readFileSync(join(dir, href), "utf8");
  assert.equal(mdAfterSecond, mdAfterFirst);
  assert.equal(svgAfterSecond, svgAfterFirst);
});
