// Swimlane engine tests: parsing diagnostics, folding semantics, and — the heart of it —
// geometric verification of every torture fixture: no overlaps, nothing hidden, nothing clipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSwimlane, parseGraph, foldSignals, looksLikeHealthModel, DEFAULT_MAX_WIDTH } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { verifyGeometry, verifySvgString, countCrossings, manhattanLength } from "./helpers/geo.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(join(FIX, f), "utf8");
const readRoot = (f) => readFileSync(join(ROOT, f), "utf8");

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
  assert.equal(rows[0].sourceId, "s");
  assert.equal(rows[0].id, "signal:s:e:0");
  assert.equal(rows[1].result, "0.4%");
  assert.equal(rows[1].state, "healthy");
  assert.equal(rows[1].sourceId, "s");
  assert.equal(rows[1].id, "signal:s:e:1");
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

// determinism: same input, same output — at the 1024 default and at an explicit override, since
// wrapping introduces new packing decisions that must stay just as deterministic (C11).
test("rendering is deterministic", () => {
  const [b] = extractBlocks(read("torture-dense.md"), THEME_NAMES);
  const a = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  const c = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  assert.equal(a, c);
  const o1 = renderSwimlane(b.code, { theme: "portal", title: "x", maxWidth: 1400 }).svg;
  const o2 = renderSwimlane(b.code, { theme: "portal", title: "x", maxWidth: 1400 }).svg;
  assert.equal(o1, o2, "an explicit maxWidth override must render just as deterministically");
});

test("interactive rendering exposes authored animation semantics without changing default SVG bytes", () => {
  const code = [
    "flowchart BT",
    'sig["P95 = 230 ms (degraded)<br/>Errors = 0.4%"] --> api["API<br/>degraded"]',
    'api -. "limited propagation" .-> flow["Order flow<br/>(worstOf)<br/>degraded"]',
    'flow --> root["Root<br/>degraded"]',
    "class sig blue;",
    "class api,flow,root amber;",
  ].join("\n");

  const byDefault = renderSwimlane(code, { theme: "portal", title: "Replay" });
  const explicitFalse = renderSwimlane(code, { theme: "portal", title: "Replay", interactive: false });
  const wrongType = renderSwimlane(code, { theme: "portal", title: "Replay", interactive: "true" });
  assert.equal(explicitFalse.svg, byDefault.svg);
  assert.equal(wrongType.svg, byDefault.svg);
  assert.equal(byDefault.animation, undefined);
  assert.doesNotMatch(byDefault.svg, /data-ahm-/);

  const interactive = renderSwimlane(code, { theme: "portal", title: "Replay", interactive: true });
  assert.deepEqual(interactive.animation.signals, [
    {
      id: "signal:sig:api:0",
      sourceId: "sig",
      ownerId: "api",
      name: "P95",
      result: "230 ms",
      state: "degraded",
    },
    {
      id: "signal:sig:api:1",
      sourceId: "sig",
      ownerId: "api",
      name: "Errors",
      result: "0.4%",
      state: "healthy",
    },
  ]);
  assert.deepEqual(interactive.animation.entities.map(({ id, state, qualifier }) => ({ id, state, qualifier })), [
    { id: "api", state: "degraded", qualifier: null },
    { id: "flow", state: "degraded", qualifier: "worstOf" },
    { id: "root", state: "degraded", qualifier: null },
  ]);
  assert.deepEqual(interactive.animation.relationships, [
    { id: "relationship:api:flow:0", from: "api", to: "flow", label: "limited propagation" },
    { id: "relationship:flow:root:1", from: "flow", to: "root", label: null },
  ]);
  assert.match(interactive.svg, /data-ahm-signal="signal:sig:api:0"/);
  assert.match(interactive.svg, /data-ahm-part="signal-result"[^>]*data-ahm-final-result="230 ms"/);
  assert.match(interactive.svg, /data-ahm-entity="flow"[^>]*data-ahm-state="degraded"/);
  assert.match(interactive.svg, /data-ahm-qualifier="flow"[^>]*>worstOf</);
  assert.match(interactive.svg, /data-ahm-edge="relationship:api:flow:0"/);
  assert.match(interactive.svg, /data-ahm-edge-label="relationship:api:flow:0"/);
});

// ---------- maxWidth: default-bounded width, graph-aware multi-row wrapping ----------
// Independent, test-owned primary-parent extraction (first-declared edge target per "from" id) —
// mirrors what the renderer is required to use internally (parents.get(id)[0]) without reading its
// internals, so this is a genuine black-box check of the resulting geometry against source edges.
const EDGE_RE = /^\s*([A-Za-z]\w*)(?:\[[^\]]*\])?\s*(?:-->\s*\|[^|]*\||--\s*"[^"]*"\s*-->|-->|-\.\s*(?:"[^"]*"|[\w ]+?)?\s*\.->)\s*([A-Za-z]\w*)/;
function firstParentOf(code) {
  const parent = new Map();
  for (const line of code.split("\n")) {
    const m = line.match(EDGE_RE);
    if (!m) continue;
    const [, from, to] = m;
    if (from !== to && !parent.has(from)) parent.set(from, to);
  }
  return parent;
}
// Consecutive physical rows sharing the same rendered lane label belong to one original logical
// lane's "band" — the public boundary (debug.lanes[].label) that lets a black-box test recover
// which physical rows a wrapped lane produced, without reading laneOrigin internals.
function bands(debugLanes) {
  const out = [];
  let cur = null;
  debugLanes.forEach((lane, i) => {
    if (!cur || cur.label !== lane.label) { cur = { label: lane.label, rows: [] }; out.push(cur); }
    cur.rows.push(i);
  });
  return out;
}
function rowSpan(cards) {
  if (!cards.length) return 0;
  return Math.max(...cards.map((c) => c.x + c.w)) - Math.min(...cards.map((c) => c.x));
}
// The card-to-card gap, derived empirically from any row holding >=2 cards (span = sum(widths) +
// gap*(n-1) for a tightly packed row) rather than importing the internal GAP constant.
function derivedGap(cards) {
  const byRow = new Map();
  for (const c of cards) { if (!byRow.has(c.lane)) byRow.set(c.lane, []); byRow.get(c.lane).push(c); }
  for (const cs of byRow.values()) {
    if (cs.length < 2) continue;
    return (rowSpan(cs) - cs.reduce((a, c) => a + c.w, 0)) / (cs.length - 1);
  }
  return 30; // no multi-card row anywhere: gap is unobservable but also irrelevant
}
// Group-split ratio (C9): every primary-parent group with >=2 members, split across >1 physical
// row, divided by every such group — EXCLUDING a group whose own unsplit width would exceed the
// widest row span actually achieved elsewhere in its own wrapped band (the packer maximizes row
// fill, so that achieved width is a tight, evidence-grounded stand-in for "this group could never
// have fit one row" — the C4/C9 unavoidable-oversized-group exception), since splitting THAT is
// required, not a violation.
function groupSplitRatio(cards) {
  const gap = derivedGap(cards);
  const bandOf = new Map();
  for (const band of bands(cards.__lanes)) for (const ri of band.rows) bandOf.set(ri, band.rows);
  const byParent = new Map();
  for (const c of cards) {
    const p = c.__parent;
    if (p == null) continue;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(c);
  }
  let split = 0, total = 0;
  for (const members of byParent.values()) {
    if (members.length < 2) continue;
    const bandRows = bandOf.get(members[0].lane) || [members[0].lane];
    const widestAchieved = Math.max(...bandRows.map((ri) => rowSpan(cards.filter((c) => c.lane === ri))));
    const groupWidth = members.reduce((a, c) => a + c.w, 0) + gap * (members.length - 1);
    if (groupWidth > widestAchieved + 0.5) continue; // unavoidably oversized: exempt
    total++;
    if (new Set(members.map((c) => c.lane)).size > 1) split++;
  }
  return { ratio: total ? split / total : 0, total, split };
}
// Tags every card with its parent (from the source) and stashes debug.lanes alongside, so
// groupSplitRatio/bands above can work from one plain array — still just derived from the public
// r.debug boundary, never from internal packing state.
function taggedCards(r, code) {
  const parentOf = firstParentOf(code);
  const cards = r.debug.cards.map((c) => ({ ...c, __parent: parentOf.get(c.id) }));
  cards.__lanes = r.debug.lanes;
  return cards;
}

const MAXWIDTH_FIXTURES = [
  {
    read: readRoot, file: "kitchen-sink.md", label: "kitchen-sink.md", title: "Kitchen sink health model",
    mustContain: ["Web frontend", "API service", "Database", "Redis cache", "Order queue",
      "Blob storage", "Identity provider", "Search service", "Shipping service with a long name",
      "Background functions"],
  },
  {
    read, file: "torture-dense.md", label: "torture-dense.md (dense-multi-parent-mesh)", title: "x",
    mustContain: ["Service A", "Service B", "Service C", "Service D", "Service E",
      "Filler one", "Filler two", "Filler three", "Filler four", "Filler five"],
  },
];

for (const { read: readFixture, file, label, title, mustContain } of MAXWIDTH_FIXTURES) {
  test(`maxWidth default (${DEFAULT_MAX_WIDTH}): ${label} wraps to multiple rows while keeping every guarantee`, () => {
    const [b] = extractBlocks(readFixture(file), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title }); // no maxWidth key at all

    // C1 / C16: bounded by default, and the bound is doing real work (more than the original
    // depth-lane count of physical rows appears).
    assert.ok(r.W <= DEFAULT_MAX_WIDTH, `expected r.W <= ${DEFAULT_MAX_WIDTH}, got ${r.W}`);
    assert.ok(r.lanes > 3, `expected wrapping to produce more than 3 physical rows, got ${r.lanes}`);

    // C6: every leaf entity's full name survives wrapping, unchanged.
    for (const needle of mustContain) assert.match(r.svg, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    // C7 / C8: every existing layout guarantee holds for the wrapped output, both via the
    // unconditional checks and via the new opt-in per-row maxWidth check (defense-in-depth).
    assert.deepEqual(verifyGeometry(r), []);
    assert.deepEqual(verifyGeometry(r, { maxWidth: DEFAULT_MAX_WIDTH }), []);
    assert.deepEqual(verifySvgString(r.svg), []);

    // C9: atomic sibling groups (by primary parent) are never split across rows when they fit.
    const cards = taggedCards(r, b.code);
    const gsr = groupSplitRatio(cards);
    assert.equal(gsr.ratio, 0, `group-split ratio must be 0, got ${gsr.split}/${gsr.total}`);
    assert.ok(gsr.total > 0, "expected at least one non-trivial (>=2 member) primary-parent group to check");

    // C10: no lane that needed wrapping ends on an avoidably sparse trailing row.
    for (const band of bands(r.debug.lanes)) {
      if (band.rows.length < 2) continue; // this lane did not wrap — nothing to balance
      const spans = band.rows.map((ri) => rowSpan(r.debug.cards.filter((c) => c.lane === ri)));
      const widest = Math.max(...spans), last = spans[spans.length - 1];
      assert.ok(last / widest >= 0.5, `"${band.label}" trailing row fill ${(last / widest * 100).toFixed(1)}% of its widest row`);
    }

    // C11: identical input/options render byte-identical SVG.
    const again = renderSwimlane(b.code, { theme: "portal", title });
    assert.equal(again.svg, r.svg);
  });
}

test("maxWidth override (C17): a 1400 override on kitchen-sink.md bounds to 1400, produces fewer-or-equal physical rows, and a measurably different SVG than the 1024 default", () => {
  const [b] = extractBlocks(readRoot("kitchen-sink.md"), THEME_NAMES);
  const title = "Kitchen sink health model";
  const byDefault = renderSwimlane(b.code, { theme: "portal", title }); // opts: {}
  const overridden = renderSwimlane(b.code, { theme: "portal", title, maxWidth: 1400 });

  assert.ok(byDefault.W <= DEFAULT_MAX_WIDTH, `default: ${byDefault.W}`);
  assert.ok(overridden.W <= 1400, `override: ${overridden.W}`);
  assert.notEqual(overridden.svg, byDefault.svg, "an accepted override must change the render, not be silently ignored");
  assert.ok(overridden.lanes <= byDefault.lanes, `a larger budget should need fewer-or-equal physical rows: ${overridden.lanes} vs ${byDefault.lanes}`);
  assert.deepEqual(verifyGeometry(overridden), []);
});

test("maxWidth infeasible override (C3): a value below the computed structural minimum warns naming both numbers and clamps up to exactly that minimum, never throwing", () => {
  const diag = new Diagnostics();
  // legend on, a real title, and a trivially small graph: headW alone already exceeds this —
  // infeasible purely from header/legend overhead, independent of node content (a minimal fixture
  // isolates the clamp-to-exact-minimum claim from unrelated routing/corridor width contributions,
  // which the override/default tests above already cover for a real, content-heavy fixture).
  const code = "flowchart BT\na[Child] --> b[Parent]\nclass a green;\nclass b amber;\nclassDef green x;\nclassDef amber x;";
  const r = renderSwimlane(code, { theme: "portal", title: "A reasonably descriptive title", diag, maxWidth: 100 });
  const warn = diag.warnings.find((w) => w.message.includes("maxWidth"));
  assert.ok(warn, "expected a warning naming maxWidth");
  assert.match(warn.message, /maxWidth 100 is below/);
  const minimum = Number(warn.message.match(/minimum feasible width \((\d+)px/)[1]);
  assert.ok(minimum > 100, "the computed minimum must exceed the impossible request");
  assert.equal(r.W, minimum, "r.W must equal the exact minimum the warning names, not 100 and not some other value");
  assert.deepEqual(verifyGeometry(r), []);
});

test("maxWidth C4 exception: an unavoidably wide entity title stays complete and unclipped even under a small maxWidth", () => {
  const multiWord = "Payment gateway with a very long descriptive name that remains visible across every wrapped line in the entity header";
  const singleToken = "QueueProcessorWithoutBreaks".repeat(8);
  const diag = new Diagnostics();
  const r = renderSwimlane([
    "flowchart BT",
    `a["${multiWord}"] --> root[Root]`,
    `b["${singleToken}"] --> root`,
    "class a,b,root green;",
  ].join("\n"), { theme: "portal", title: "Long entity titles", diag, maxWidth: 300 });

  const visibleText = [...r.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/\s/g, "");
  assert.ok(visibleText.includes(multiWord.replace(/\s/g, "")));
  assert.ok(visibleText.includes(singleToken));
  assert.doesNotMatch(r.svg, /…/);
  assert.deepEqual(verifyGeometry(r), []);
  assert.deepEqual(verifySvgString(r.svg), []);
});

// ---------- laneLabels: optional lane-label gutter, a second width-reclaim lever (C18-C20) ----------
// Genuine lane-label texts are the only debug.texts entries with no `container` field that sit
// near the canvas's right edge (every other text source — title, subtitle, legend, card/pill
// content — either carries a container or sits far from that edge) — a black-box boundary,
// not an internal read, that also sidesteps a real fixture coincidence: kitchen-sink.md's root
// entity is itself literally named "Workload root", the same string as the default lane-0 label.
function laneLabelTexts(r) {
  return r.debug.texts.filter((t) => !t.container && t.x > r.W - 250);
}

test("laneLabels (C18): unset is identical to explicitly true — shown by default, mirroring legend's own shape", () => {
  const [b] = extractBlocks(readRoot("kitchen-sink.md"), THEME_NAMES);
  const title = "Kitchen sink health model";
  const unset = renderSwimlane(b.code, { theme: "portal", title });
  const explicitTrue = renderSwimlane(b.code, { theme: "portal", title, laneLabels: true });
  assert.equal(unset.svg, explicitTrue.svg, "unset laneLabels must render byte-identically to an explicit true");
  assert.ok(laneLabelTexts(unset).length > 0, "expected lane-label text to be present by default");
});

test("laneLabels: false (C19) removes label text and its gutter while preserving band fills/hairlines and every graph-semantic guarantee, and (C20) reclaims measurable row budget", () => {
  for (const { file, read: readFixture, title } of [
    { file: "kitchen-sink.md", read: readRoot, title: "Kitchen sink health model" },
    { file: "torture-dense.md", read, title: "x" },
  ]) {
    const [b] = extractBlocks(readFixture(file), THEME_NAMES);
    const on = renderSwimlane(b.code, { theme: "portal", title, maxWidth: 1024 });
    const off = renderSwimlane(b.code, { theme: "portal", title, maxWidth: 1024, laneLabels: false });

    // C19: label text and its gutter gone; band rects + hairlines (structural lane grouping)
    // and every graph-semantic guarantee (node/edge counts, geometry) unchanged.
    assert.ok(laneLabelTexts(on).length > 0, `${file}: expected label text with labels on`);
    assert.equal(laneLabelTexts(off).length, 0, `${file}: expected zero label text with labels off`);
    const bandRects = (s) => (s.match(/<rect x="0" y="[\d.]+" width=/g) || []).length;
    const hairlines = (s) => (s.match(/<line x1="0"/g) || []).length;
    assert.equal(bandRects(off.svg), bandRects(on.svg), `${file}: band rect count must be unchanged`);
    assert.equal(hairlines(off.svg), hairlines(on.svg), `${file}: hairline count must be unchanged`);
    assert.equal(off.nodes, on.nodes, `${file}: node count must be unchanged`);
    const edgeKeys = (r) => new Set(r.debug.segs.map((s) => s.edge)).size;
    assert.equal(edgeKeys(off), edgeKeys(on), `${file}: distinct edge count must be unchanged`);
    assert.deepEqual(verifyGeometry(off, { maxWidth: 1024 }), []);
    assert.deepEqual(verifySvgString(off.svg), []);

    // C20: at the SAME maxWidth, labels-off never needs MORE physical rows than labels-on, and
    // reclaims a measurable width budget (the W a labels-on render would have needed to hit the
    // same physical-row count shrinks once the ~190px gutter is no longer reserved).
    assert.ok(off.lanes <= on.lanes, `${file}: labels-off must not need MORE physical rows (${off.lanes} vs ${on.lanes})`);
    assert.ok(off.W < on.W, `${file}: labels-off must render narrower at the same maxWidth (${off.W} vs ${on.W})`);
  }
});

test("laneLabels: false drops a custom `lanes:` label the same way — it must not leak into the SVG", () => {
  const code = "flowchart BT\na[Child] --> b[Parent]\nclass a green;\nclass b amber;\nclassDef green x;\nclassDef amber x;";
  const r = renderSwimlane(code, { theme: "portal", lanes: ["Zeta layer", "Yolo tier"], laneLabels: false, title: "t" });
  assert.doesNotMatch(r.svg, /Zeta layer/);
  assert.doesNotMatch(r.svg, /Yolo tier/);
  assert.deepEqual(verifyGeometry(r), []);
});

// ---------- routing readability: generalized shared-trunk bundling (C24-C32) ----------
// Baseline captured live against the unmodified (pre-this-revision) renderer, same measurement
// method as countCrossings/manhattanLength below: kitchen-sink.md 60 crossings/12259px/0%
// trunk-sharing; torture-dense.md 88 crossings/11685px/0% trunk-sharing (see the blueprint's
// "Routing-readability baseline"). C27 requires strictly fewer crossings than that baseline;
// C28 allows Manhattan length to grow by at most 10% over it (bundling may add short branch
// segments at merge/split points, but must not make routes systematically longer).
const ROUTING_FIXTURES = [
  {
    read: readRoot, file: "kitchen-sink.md", title: "Kitchen sink health model",
    edgeCount: 16, maxTrunks: 6, baselineCrossings: 60, manhattanCeiling: 12259 * 1.1,
    dashedLabelled: ["cache->shop", "reporting->root"],
  },
  {
    read, file: "torture-dense.md", title: "x",
    edgeCount: 23, maxTrunks: 5, baselineCrossings: 88, manhattanCeiling: 11685 * 1.1,
    dashedLabelled: ["a->p3", "b->p2", "d->p1", "e->p3"],
  },
];

for (const { read: readFixture, file, title, edgeCount, maxTrunks, baselineCrossings, manhattanCeiling, dashedLabelled } of ROUTING_FIXTURES) {
  test(`routing readability (C24-C32): ${file}'s default wrapped render generalizes bundling across physical-row distance and strictly improves crossings/Manhattan length over the recorded baseline`, () => {
    const [b] = extractBlocks(readFixture(file), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title });

    // C29: every source edge still has its own independently-keyed debug.segs entries — no
    // information loss, even where a trunk portion is pixel-coincident with a sibling's.
    const edgeKeys = new Set(r.debug.segs.map((s) => s.edge));
    assert.equal(edgeKeys.size, edgeCount, `expected ${edgeCount} distinct edge keys, got ${edgeKeys.size}`);

    // C26: bundle-eligible edges collapse into a bounded number of distinct shared trunks
    // (topology-derived from this fixture's own static edge list — see the blueprint).
    const trunkTags = new Set(r.debug.segs.map((s) => s.trunk).filter((t) => t != null));
    assert.ok(trunkTags.size >= 1, "expected at least one shared trunk to form");
    assert.ok(trunkTags.size <= maxTrunks, `expected at most ${maxTrunks} distinct trunks, got ${trunkTags.size}`);

    // C25: dashed/labelled edges are excluded from bundling — still routed individually, never
    // carrying a trunk tag, preserving their own dedicated pill/anti-collision handling.
    for (const edge of dashedLabelled) {
      const segs = r.debug.segs.filter((s) => s.edge === edge);
      assert.ok(segs.length > 0, `expected segments for ${edge}`);
      assert.ok(segs.every((s) => s.trunk == null), `${edge} must never carry a trunk tag`);
    }

    // C27 / C28: strictly fewer v×h crossings, and Manhattan length within the stated ceiling,
    // both measured against this exact fixture's own recorded pre-redesign baseline.
    const crossings = countCrossings(r.debug);
    const manhattan = manhattanLength(r.debug);
    assert.ok(crossings < baselineCrossings, `expected strictly fewer than the ${baselineCrossings}-crossing baseline, got ${crossings}`);
    assert.ok(manhattan <= manhattanCeiling, `expected at or below the ${Math.round(manhattanCeiling)}px ceiling, got ${Math.round(manhattan)}`);

    // C30: a bundled trunk renders in the theme's neutral T.muted stroke — distinct from every
    // member's own state-derived color — never any one branch's own color, across all 4 themes.
    for (const themeName of THEME_NAMES) {
      const T = THEMES[themeName];
      const themed = renderSwimlane(b.code, { theme: themeName, title });
      const mutedConnectorPaths = (themed.svg.match(new RegExp(`<path d="[^"]*" stroke="${T.muted.replace("#", "\\#")}" stroke-width="1\\.7"`, "g")) || []).length;
      assert.ok(mutedConnectorPaths > 0, `${themeName}: expected at least one muted-stroke shared-trunk connector path`);
      for (const state of Object.keys(T.state)) assert.notEqual(T.muted, T.state[state].border, `${themeName}: T.muted must be visually distinct from every state color`);
    }

    // C31: every existing layout guarantee holds for the new trunk/branch geometry (this file's
    // own relaxed collinearity rule recognizes the intentional shared-trunk coincidence).
    assert.deepEqual(verifyGeometry(r), []);
    assert.deepEqual(verifySvgString(r.svg), []);

    // C32: identical input/options still render byte-identical SVG under the new routing.
    const again = renderSwimlane(b.code, { theme: "portal", title });
    assert.equal(again.svg, r.svg);
  });
}

test("routing readability: torture-deep.md (the sparse, never-wraps, original lane-skip fixture) confirms the generalization at the opposite end of the density spectrum — a multi-row-skip member (l5c) now shares one trunk with an adjacent member (l4a), and geometry stays clean", () => {
  const [b] = extractBlocks(read("torture-deep.md"), THEME_NAMES);
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading });
  assert.deepEqual(verifyGeometry(r), []);
  assert.deepEqual(verifySvgString(r.svg), []);
  // l3a receives from l4a (one physical row below) and l5c (a genuine multi-row skip) — both
  // solid/unlabeled — the exact low-density case the ll-lu===1-only gate used to miss.
  const l3aTrunkEdges = new Set(r.debug.segs.filter((s) => s.trunk === "l3a").map((s) => s.edge));
  assert.deepEqual([...l3aTrunkEdges].sort(), ["l4a->l3a", "l5c->l3a"]);
});

// ---------- status pill vs header text (regression: long subtitle slid under the pill) ----------
// The header qualifier (subtitle) shares its row with the right-aligned status pill. The card is
// sized to reserve the pill's horizontal band plus a gap; these tests hold that contract at the
// render boundary. See fix: measureNode's HEADER_SAFETY weight buffer for regular-weight text.
const HEADER_PILL_GAP = 12; // reserved estimator-space gap between subtitle right and pill left
const sameBox = (a, b) => a && b && Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;

function nodeParts(r, id) {
  const card = r.debug.cards.find((c) => c.id === id);
  const pill = r.debug.statusPills.find((p) => p.id === id);
  const texts = r.debug.texts.filter((t) => sameBox(t.container, card));
  return { card, pill, texts };
}

test("status pill clears the Shop subtitle in every theme and both lane modes (real consumer fixture)", () => {
  const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
  for (const theme of THEME_NAMES) {
    for (const laneLabels of [true, false]) {
      const tag = `${theme}/laneLabels=${laneLabels}`;
      const r = renderSwimlane(b.code, { theme, title: b.heading, laneLabels });
      assert.deepEqual(verifyGeometry(r), [], `geometry violations in ${tag}`);
      assert.deepEqual(verifySvgString(r.svg), [], `svg violations in ${tag}`);
      const { card, pill, texts } = nodeParts(r, "shop");
      assert.ok(card && pill, `missing shop card/pill in ${tag}`);
      const sub = texts.find((t) => t.text.includes("minimum healthy"));
      assert.ok(sub, `missing subtitle text in ${tag}`);
      assert.ok(sub.x + sub.w + HEADER_PILL_GAP <= pill.x + 0.5,
        `${tag}: subtitle right ${(sub.x + sub.w).toFixed(1)} + ${HEADER_PILL_GAP} exceeds pill left ${pill.x.toFixed(1)}`);
      assert.ok(pill.x >= card.x - 0.5 && pill.x + pill.w <= card.x + card.w + 0.5, `${tag}: pill escapes card`);
      assert.ok(sub.x + sub.w <= card.x + card.w + 0.5, `${tag}: subtitle escapes card`);
    }
  }
});

// state class -> the label the pill renders; drives pill width (Unhealthy is the widest)
const STATE_CASES = [["green", "Healthy"], ["amber", "Degraded"], ["red", "Unhealthy"], ["purple", "Standby"], [null, "Unknown"]];
const SUBTITLE_CASES = {
  none: { lines: [], marker: null },
  short: { lines: ["(active-active)"], marker: "active-active" },
  long: { lines: ["(active-active)", "(minimum healthy:", "min 2 of 3 regions)"], marker: "minimum healthy" },
  longTitle: { title: "Shop, commerce, and marketplace order fulfillment", lines: ["(active-active)"], marker: "active-active" },
};

function svcSource({ title = "Shop and commerce", lines = [], cls = "green" } = {}) {
  const label = [title, ...lines].join("<br/>");
  return [
    "flowchart BT",
    `    a["Upstream A<br/>Region A signal"] --> svc["${label}"]`,
    `    b["Upstream B<br/>Region B signal"] --> svc`,
    `    svc --> root["Contoso E-Shop<br/>healthy"]`,
    "    class a,b blue;",
    "    class root green;",
    cls ? `    class svc ${cls};` : "",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
    "    classDef amber fill:none,stroke:#F5A623;",
    "    classDef red fill:none,stroke:#D0021B;",
    "    classDef purple fill:none,stroke:#7B61FF;",
  ].join("\n");
}

for (const [cls, label] of STATE_CASES)
  for (const [subKey, sub] of Object.entries(SUBTITLE_CASES))
    for (const laneLabels of [true, false]) {
      const tag = `state=${label}/subtitle=${subKey}/laneLabels=${laneLabels}`;
      test(`header text clears the status pill (${tag})`, () => {
        const r = renderSwimlane(svcSource({ title: sub.title, lines: sub.lines, cls }), { theme: "portal", laneLabels });
        assert.deepEqual(verifyGeometry(r), [], `geometry violations in ${tag}`);
        assert.deepEqual(verifySvgString(r.svg), [], `svg violations in ${tag}`);
        const { card, pill, texts } = nodeParts(r, "svc");
        assert.ok(card && pill, `missing svc card/pill in ${tag}`);
        if (sub.marker) {
          const q = texts.find((t) => t.text.includes(sub.marker));
          assert.ok(q, `missing subtitle text in ${tag}`);
          assert.ok(q.x + q.w + HEADER_PILL_GAP <= pill.x + 0.5,
            `${tag}: subtitle right ${(q.x + q.w).toFixed(1)} + ${HEADER_PILL_GAP} exceeds pill left ${pill.x.toFixed(1)}`);
          assert.ok(q.x + q.w <= card.x + card.w + 0.5, `${tag}: subtitle escapes card`);
        } else {
          // no subtitle: the bold title (accurate metrics) must still stay left of the pill
          const title = texts.find((t) => t.text.includes("Shop"));
          assert.ok(title && title.x + title.w <= pill.x + 0.5, `${tag}: title overlaps pill`);
        }
        assert.ok(pill.x >= card.x - 0.5 && pill.x + pill.w <= card.x + card.w + 0.5, `${tag}: pill escapes card`);
      });
    }

test("a short subtitle that the title dominates never widens the card (no over-expansion)", () => {
  const w = (lines) => renderSwimlane(svcSource({ lines }), { theme: "portal" }).debug.cards.find((c) => c.id === "svc").w;
  assert.equal(w(["(active-active)"]), w([]),
    "a short subtitle must not force a wider card when the bold title already dominates the header width");
});

// Real-render proof: the estimator can only approximate glyph advances, so the actual browser
// getBBox is the ground truth that would have caught the original overlap. Skipped when no Chrome.
const CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
  "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));

test("browser: the Shop subtitle's real glyph box clears the status pill by >= 12px",
  { skip: !CHROME ? "no Chrome/Chromium available" : false }, () => {
    const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
    const page = `<!doctype html><meta charset="utf-8"><body>${r.svg}<script>
      const texts=[...document.querySelectorAll('text')];
      const sub=texts.find(t=>t.textContent.includes('minimum healthy'));
      const sb=sub.getBBox();
      const pill=[...document.querySelectorAll('rect')].filter(x=>x.getAttribute('rx')==='9')
        .map(x=>({x:+x.getAttribute('x'),y:+x.getAttribute('y')}))
        .sort((p,q)=>Math.abs(p.y-sb.y)-Math.abs(q.y-sb.y))[0];
      document.body.textContent=JSON.stringify({subRight:sb.x+sb.width,pillX:pill.x});
    <\/script></body>`;
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(page);
    const dom = execFileSync(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", url], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const m = dom.match(/\{"subRight".*?\}/s);
    assert.ok(m, "could not read getBBox measurements from Chrome");
    const { subRight, pillX } = JSON.parse(m[0]);
    const gap = pillX - subRight;
    assert.ok(gap >= 12, `real-render gap ${gap.toFixed(2)}px must be >= 12 (subtitle right ${subRight.toFixed(1)}, pill left ${pillX.toFixed(1)})`);
  });

// ---------- bounded subtitle wrapping (v3.1.3) ----------
// Supersedes v3.1.2's width-only fix: a subtitle wider than a bounded text column now WRAPS at
// word boundaries and the card grows TALLER, instead of the card widening to fit one long line.
// The title still drives one-line minimum width; the pill stays clear; nothing is ever truncated.
const CARD_MAX_W = 480;
const svgHeight = (svg) => Number(svg.match(/height="(\d+)"/)[1]);
const SUB1 = "single region";
const SUB2 = "active-active · minimum healthy: · min 2 of 3 regions";
const SUB3 = "active-active across many regions · minimum healthy is min 2 of 3 regions worldwide plus standby";
const UNBROKEN_TOKEN = "supercalifragilisticexpialidocioushyperultramegatokenthatcannotbebrokenonspaces";

// A middle-lane service with its own signal row (so its card height is not clamped) plus a leaf
// lane below and a root lane above — exercises coherent downstream shift when the middle grows.
function dsSource(sub) {
  const mid = ["Mid service", "healthy", ...(sub ? [sub] : [])].join("<br/>");
  return [
    "flowchart BT",
    `    leafSig["Leaf availability<br/>Region signal"] --> leaf["Leaf node<br/>healthy"]`,
    `    leaf --> mid["${mid}"]`,
    `    midSig["Mid availability<br/>Region signal"] --> mid`,
    `    mid --> root["Root service<br/>healthy"]`,
    "    class leafSig,midSig blue;",
    "    class leaf,mid,root green;",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
  ].join("\n");
}

test("a long subtitle wraps to >=2 lines and the card stays within the bounded width (no widen-to-fit)", () => {
  const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
  const shop = r.debug.cards.find((c) => c.id === "shop");
  assert.ok(shop.qualLines >= 2, `expected a wrapped subtitle, got ${shop.qualLines} line(s)`);
  assert.ok(shop.w < CARD_MAX_W, `card must not hit the max width (got ${shop.w})`);
  // header width is bounded: headerFixed(Healthy≈114.3) + SUBTITLE_MAX_W*HEADER_SAFETY ⇒ ~294px
  assert.ok(shop.w <= 295, `subtitle must not widen the card past the bounded column (got ${shop.w})`);
  assert.doesNotMatch(r.svg, /…/, "subtitle is never truncated");
});

test("subtitle line count grows headerH by exactly 11px per line, deterministically", () => {
  const card = (sub) => renderSwimlane(svcSource({ lines: sub ? [sub] : [] }), { theme: "portal" })
    .debug.cards.find((c) => c.id === "svc");
  const c1 = card(SUB1), c2 = card(SUB2), c3 = card(SUB3);
  assert.deepEqual([c1.qualLines, c2.qualLines, c3.qualLines], [1, 2, 3], "fixtures must wrap to 1/2/3 lines");
  assert.equal(c2.headerH - c1.headerH, 11, "2 lines grows one line-height over 1 line");
  assert.equal(c3.headerH - c1.headerH, 22, "3 lines grows two line-heights over 1 line");
  const a = renderSwimlane(svcSource({ lines: [SUB2] }), { theme: "portal" }).svg;
  const d = renderSwimlane(svcSource({ lines: [SUB2] }), { theme: "portal" }).svg;
  assert.equal(a, d, "re-render is byte-identical");
});

test("a taller card shifts every following lane, edge, and the footer down by the exact same delta", () => {
  const g = (r, id) => r.debug.cards.find((c) => c.id === id);
  const r1 = renderSwimlane(dsSource(SUB1), { theme: "portal", laneLabels: false });
  const r2 = renderSwimlane(dsSource(SUB2), { theme: "portal", laneLabels: false });
  const D = g(r2, "mid").h - g(r1, "mid").h;
  assert.ok(D > 0, "the growing card must actually get taller");
  assert.equal(g(r2, "mid").y - g(r1, "mid").y, 0, "the growing card's own top does not move");
  assert.equal(g(r2, "leaf").y - g(r1, "leaf").y, D, "the lane below shifts down by the delta");
  assert.equal(g(r2, "root").y - g(r1, "root").y, 0, "the lane above does not move");
  assert.equal(svgHeight(r2.svg) - svgHeight(r1.svg), D, "the footer/total height shifts by the delta");
  assert.deepEqual(verifyGeometry(r2), [], "edges stay connected and nothing overlaps after growth");
  assert.deepEqual(verifySvgString(r2.svg), []);
});

test("subtitle bbox (real Chrome): every wrapped line clears the status pill by >= 12px",
  { skip: !CHROME ? "no Chrome/Chromium available" : false }, () => {
    const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
    const page = `<!doctype html><meta charset="utf-8"><body>${r.svg}<script>
      const texts=[...document.querySelectorAll('text')];
      const subs=texts.filter(t=>/active-active|minimum healthy|regions|min/.test(t.textContent));
      const pills=[...document.querySelectorAll('rect')].filter(x=>x.getAttribute('rx')==='9')
        .map(x=>({x:+x.getAttribute('x'),y:+x.getAttribute('y')}));
      const out=subs.map(t=>{const bb=t.getBBox();
        const pill=pills.slice().sort((p,q)=>Math.abs(p.y-bb.y)-Math.abs(q.y-bb.y))[0];
        return {text:t.textContent,gap:pill.x-(bb.x+bb.width)};});
      document.body.textContent=JSON.stringify(out);
    <\/script></body>`;
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(page);
    const dom = execFileSync(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", url], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const m = dom.match(/\[.*\]/s);
    assert.ok(m, "could not read getBBox measurements from Chrome");
    const lines = JSON.parse(m[0]);
    assert.ok(lines.length >= 2, `expected >=2 wrapped subtitle lines, got ${lines.length}`);
    for (const l of lines)
      assert.ok(l.gap >= 12, `line "${l.text}" real gap ${l.gap.toFixed(2)}px must be >= 12`);
  });

test("nodes in one lane wrapping to different line counts: lane sizes to the tallest, none overlap", () => {
  const code = [
    "flowchart BT",
    `    sA["Sig A<br/>Region signal"] --> nodeA["Node A<br/>${SUB2}"]`,
    `    sB["Sig B<br/>Region signal"] --> nodeB["Node B<br/>${SUB1}"]`,
    "    nodeA --> root[\"Root<br/>healthy\"]",
    "    nodeB --> root",
    "    class sA,sB blue;",
    "    class nodeA,nodeB,root green;",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
  ].join("\n");
  const r = renderSwimlane(code, { theme: "portal", laneLabels: false });
  const A = r.debug.cards.find((c) => c.id === "nodeA"), B = r.debug.cards.find((c) => c.id === "nodeB");
  assert.equal(A.lane, B.lane, "both nodes share a lane");
  assert.ok(A.qualLines > B.qualLines, "the two nodes wrap to different line counts");
  const lane = r.debug.lanes[A.lane];
  assert.ok(lane.h >= Math.max(A.h, B.h) - 0.5, "lane sizes to the tallest card");
  assert.deepEqual(verifyGeometry(r), [], "no node/pill/subtitle overlaps another");
});

test("a long unbroken token hard-breaks inside the column: no ellipsis, no widening past the cap", () => {
  const r = renderSwimlane(svcSource({ lines: [UNBROKEN_TOKEN] }), { theme: "portal" });
  const svc = r.debug.cards.find((c) => c.id === "svc");
  assert.ok(svc.qualLines >= 2, `over-long token must hard-break across lines (got ${svc.qualLines})`);
  assert.ok(svc.w < CARD_MAX_W, `token must not widen the card to the max (got ${svc.w})`);
  assert.doesNotMatch(r.svg, /…/, "hard-break never ellipsizes");
  const { texts, card } = nodeParts(r, "svc");
  const joined = texts.filter((t) => sameBox(t.container, card)).map((t) => t.text).join("");
  assert.ok(joined.includes(UNBROKEN_TOKEN), "the full token survives, split across lines");
});
