// Swimlane engine tests: parsing diagnostics, folding semantics, and — the heart of it —
// geometric verification of every torture fixture: no overlaps, nothing hidden, nothing clipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSwimlane, parseGraph, foldSignals, looksLikeHealthModel } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FIX, f), "utf8");

// ---------- parsing diagnostics ----------
test("parseGraph: classifies lines and reports unrecognized ones with line numbers", () => {
  const diag = new Diagnostics();
  const g = parseGraph("flowchart BT\na[One] --> b[Two]\nthis is garbage\nclass a green;", { diag, lineOffset: 10 });
  assert.equal(g.nodes.size, 2);
  assert.equal(g.edges.length, 1);
  const warn = diag.warnings.find((w) => w.message.includes("unrecognized"));
  assert.ok(warn, "expected an unrecognized-line warning");
  assert.equal(warn.line, 13); // lineOffset 10 + 3rd line
});

test("parseGraph: edge-like garbage gets the edge-syntax hint", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart BT\na ==> b", { diag });
  const warn = diag.warnings.find((w) => w.message.includes("unrecognized"));
  assert.match(warn.hint, /supported forms/);
});

test("parseGraph: warns on non-BT direction and unknown classes", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart LR\na --> b\nclass a sparkly;", { diag });
  assert.ok(diag.warnings.some((w) => w.message.includes('direction "LR"')));
  assert.ok(diag.warnings.some((w) => w.message.includes('class "sparkly"')));
});

test("parseGraph: subgraph and friends are reported as ignored", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart BT\nsubgraph cluster\na --> b\nend", { diag });
  assert.ok(diag.warnings.some((w) => w.message.includes('ignored "subgraph"')));
});

test("foldSignals: explicit results and states survive; orphans are reported", () => {
  const diag = new Diagnostics();
  const g = parseGraph([
    "flowchart BT",
    's["P95 = 230 ms (degraded)<br/>Errors = 0.4%"] --> e[Entity]',
    'lonely["No target"]',
    "class s,lonely blue;",
    "class e amber;",
  ].join("\n"), { diag });
  foldSignals(g, diag);
  const rows = g.nodes.get("e").signals;
  assert.equal(rows[0].name, "P95");
  assert.equal(rows[0].result, "230 ms");
  assert.equal(rows[0].state, "degraded");
  assert.equal(rows[1].result, "0.4%");
  assert.equal(rows[1].state, "healthy");
  assert.ok(diag.warnings.some((w) => w.message.includes('"lonely"')));
});

test("renderSwimlane: zero-node block throws a useful error", () => {
  const diag = new Diagnostics();
  assert.throws(
    () => renderSwimlane("flowchart BT\ntotal --- garbage === here", { diag, baseLine: 100 }),
    /no nodes parsed.*unrecognized line/s
  );
});

test("looksLikeHealthModel detects health flowcharts only", () => {
  assert.equal(looksLikeHealthModel("flowchart BT\na-->b\nclass a green;"), true);
  assert.equal(looksLikeHealthModel("flowchart LR\na-->b\nclass a green;"), false);
  assert.equal(looksLikeHealthModel("sequenceDiagram\nA->>B: hi"), false);
});

// ---------- geometric verification of every fixture, in every theme for the worst one ----------
const fixtureFiles = readdirSync(FIX).filter((f) => f.startsWith("torture-"));
assert.ok(fixtureFiles.length >= 5, "expected torture fixtures");

for (const file of fixtureFiles) {
  const blocks = extractBlocks(read(file), THEME_NAMES);
  blocks.forEach((b, bi) => {
    test(`geometry: ${file} block ${bi + 1} (${b.slug})`, () => {
      const diag = new Diagnostics({ file });
      const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag, baseLine: b.codeLine - 1 });
      const geo = verifyGeometry(r);
      assert.deepEqual(geo, [], `geometry violations:\n  ${geo.join("\n  ")}`);
      const sv = verifySvgString(r.svg);
      assert.deepEqual(sv, [], `svg violations:\n  ${sv.join("\n  ")}`);
      // nothing may be silently hidden: any clipped text must carry a tooltip AND a warning
      const clippedWarns = diag.warnings.filter((w) => w.message.includes("clipped"));
      const tooltips = (r.svg.match(/<title>/g) || []).length;
      assert.ok(tooltips >= clippedWarns.length, "every clipped text needs a tooltip");
    });
  });
}

test("geometry: pill flood stays clean in every theme", () => {
  const [b] = extractBlocks(read("torture-pills.md"), THEME_NAMES);
  for (const theme of Object.keys(THEMES)) {
    const r = renderSwimlane(b.code, { theme, title: b.heading });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `theme ${theme}:\n  ${geo.join("\n  ")}`);
  }
});

test("torture-text: long content wraps instead of vanishing", () => {
  const [b] = extractBlocks(read("torture-text.md"), THEME_NAMES);
  const diag = new Diagnostics();
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag });
  // the 2350 ms measurement and the unicode row must be present in the SVG text
  assert.match(r.svg, /2350 ms/);
  assert.match(r.svg, /99\.9%/);
  assert.match(r.svg, /日本語サービス/);
  // XML-special characters must be escaped, not dropped
  assert.match(r.svg, /&lt;entities&gt;/);
  assert.doesNotMatch(r.svg, /<entities>/);
});

test("entity titles remain complete beyond the card width cap", () => {
  const multiWord = "Payment gateway with a very long descriptive name that remains visible across every wrapped line in the entity header";
  const singleToken = "QueueProcessorWithoutBreaks".repeat(8);
  const diag = new Diagnostics();
  const r = renderSwimlane([
    "flowchart BT",
    `a["${multiWord}"] --> root[Root]`,
    `b["${singleToken}"] --> root`,
    "class a,b,root green;",
  ].join("\n"), { theme: "portal", title: "Long entity titles", diag });

  const visibleText = [...r.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/\s/g, "");

  assert.ok(visibleText.includes(multiWord.replace(/\s/g, "")));
  assert.ok(visibleText.includes(singleToken));
  assert.doesNotMatch(r.svg, /…/);
  assert.ok(!diag.warnings.some((w) => w.message.includes("entity name")));
  assert.deepEqual(verifyGeometry(r), []);
  assert.deepEqual(verifySvgString(r.svg), []);
});

test("torture-weird: cycles, self-loops, orphan signals render with warnings, verify clean", () => {
  const blocks = extractBlocks(read("torture-weird.md"), THEME_NAMES);
  assert.equal(blocks.length, 4);
  for (const b of blocks) {
    const diag = new Diagnostics();
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `${b.slug}:\n  ${geo.join("\n  ")}`);
  }
  // the cycle block specifically warns
  const cyc = blocks.find((b) => b.slug.includes("cycle"));
  const diag = new Diagnostics();
  renderSwimlane(cyc.code, { theme: "portal", diag });
  assert.ok(diag.warnings.some((w) => w.message.includes("cycle")), "cycle warning expected");
  assert.ok(diag.warnings.some((w) => w.message.includes("self-loop")), "self-loop warning expected");
});

test("custom lanes and legend-off are honored", () => {
  const code = "flowchart BT\na[Child] --> b[Parent]\nclass a green;\nclass b amber;\nclassDef green x;\nclassDef amber x;";
  const r = renderSwimlane(code, { theme: "portal", lanes: ["Top", "Bottom"], legend: false, title: "t" });
  assert.match(r.svg, />Top</);
  assert.match(r.svg, />Bottom</);
  assert.doesNotMatch(r.svg, />Legend</);
  const geo = verifyGeometry(r);
  assert.deepEqual(geo, []);
});

// determinism: same input, same output
test("rendering is deterministic", () => {
  const [b] = extractBlocks(read("torture-dense.md"), THEME_NAMES);
  const a = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  const c = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  assert.equal(a, c);
});
