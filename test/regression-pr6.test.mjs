// PR #6 visual-regression guard. PR #6's width-bounding/wrapping introduced cross-row edge
// "trunk" bundling painted in the neutral T.muted gray and multi-row corridor jogging, which
// turned state-colored connectors gray/black ("lines are black.gray instead of green") and made
// routing look like "spaghetti" on three real consumer health-model diagrams. The rollback
// restores pre-PR6 semantics; this test pins them against the three actual consumer sources
// (test/fixtures/pr6-regressions.md):
//   1. every drawn edge uses its source node's STATE color, with gray allowed only for unknown;
//   2. the state palette per diagram is exactly the states its nodes carry (non-trivially mixed);
//   3. no wrapping — each logical lane renders as exactly one physical band (no cross-row spines).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSwimlane } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FIX = join(TEST_DIR, "fixtures");
const ROOT = dirname(TEST_DIR);
const BLOCKS = extractBlocks(readFileSync(join(FIX, "pr6-regressions.md"), "utf8"), THEME_NAMES);
const bySlug = (slug) => BLOCKS.find((b) => b.slug === slug);

// Every edge <path>: `<path d="…" stroke="COLOR" stroke-width="1.6|1.7"[ stroke-dasharray="5 4"]/>`.
const EDGE_RE = /<path d="([^"]*)" stroke="(#[0-9a-fA-F]{6})" stroke-width="1\.[67]"(?: stroke-dasharray="5 4")?\/>/g;
const edgeStrokes = (svg) => [...svg.matchAll(EDGE_RE)].map((m) => m[2].toLowerCase());
const edgePaths = (svg) => [...svg.matchAll(EDGE_RE)].map((m) => ({ d: m[1], stroke: m[2].toLowerCase() }));
const pathStart = (d) => {
  const m = d.match(/^M([\d.]+) ([\d.]+)/);
  return { x: Number(m[1]), y: Number(m[2]) };
};
const sourceIdForPath = (r, d, sourceIds) => {
  const start = pathStart(d);
  const cards = r.debug.cards.filter((c) => sourceIds.includes(c.id));
  cards.sort((a, b) => {
    const sa = Math.abs((a.y + a.h) - start.y) + Math.abs((a.x + a.w / 2) - start.x);
    const sb = Math.abs((b.y + b.h) - start.y) + Math.abs((b.x + b.w / 2) - start.x);
    return sa - sb;
  });
  return cards[0].id;
};
const repeatedLaneLabels = (r) => {
  const counts = new Map();
  for (const lane of r.debug.lanes) counts.set(lane.label, (counts.get(lane.label) || 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([label, count]) => `${label}×${count}`);
};
const multicolorCoincidentPaths = (svg) => {
  const byD = new Map();
  for (const m of svg.matchAll(EDGE_RE)) {
    const d = m[1], color = m[2].toLowerCase();
    if (!byD.has(d)) byD.set(d, new Set());
    byD.get(d).add(color);
  }
  return [...byD.entries()].filter(([, colors]) => colors.size > 1);
};

// The three named consumer diagrams and the exact set of node STATES whose connectors they draw.
// These are deliberately mixed (healthy + at least one non-healthy) so the palette assertion
// proves color routing works, not merely that nothing is gray.
const DIAGRAMS = {
  "add-operational-quality-signals-to-the-workload-model": ["healthy", "degraded"],
  "add-security-signals-to-your-platform-health-model": ["healthy", "unhealthy"],
  "aggregate-health-across-the-workload-portfolio": ["healthy", "degraded", "alt"],
};

for (const [slug, states] of Object.entries(DIAGRAMS)) {
  const block = bySlug(slug);
  test(`regression ${slug}: exists in the fixture and parses without issues`, () => {
    assert.ok(block, `fixture block ${slug} missing`);
    assert.deepEqual(block.issues, [], `${slug}: ${JSON.stringify(block.issues)}`);
  });

  for (const themeName of THEME_NAMES) {
    const T = THEMES[themeName];
    const expected = new Set(states.map((s) => T.state[s].border.toLowerCase()));
    test(`regression ${slug} [${themeName}]: connectors are state-colored, never neutral gray, and route on single lanes`, () => {
      const r = renderSwimlane(block.code, { theme: themeName, title: block.heading });
      const strokes = edgeStrokes(r.svg);
      assert.ok(strokes.length > 0, "expected drawn connectors");

      // (1) no neutral trunk: the gray T.muted must never paint an edge (the core regression).
      assert.equal(strokes.includes(T.muted.toLowerCase()), false,
        `${slug} [${themeName}]: an edge is painted neutral gray ${T.muted} — the PR#6 trunk regression`);

      // (2) exact state palette — proves healthy stays green AND non-healthy stays its own color.
      assert.deepEqual(new Set(strokes), expected,
        `${slug} [${themeName}]: edge colors ${JSON.stringify([...new Set(strokes)])} ≠ expected ${JSON.stringify([...expected])}`);
      assert.ok(strokes.includes(T.state.healthy.border.toLowerCase()),
        `${slug} [${themeName}]: expected at least one healthy (green) connector`);

      // (3) no wrapping: one physical band per logical lane (cross-row spaghetti came from >1).
      assert.deepEqual(repeatedLaneLabels(r), [],
        `${slug} [${themeName}]: repeated lane-label bands indicate wrapped logical lanes (${repeatedLaneLabels(r).join(", ")})`);

      // geometry stays clean (nothing overlapping, hidden, or clipped) and SVG well-formed.
      assert.deepEqual(verifyGeometry(r), [], `${slug} [${themeName}] geometry`);
      assert.deepEqual(verifySvgString(r.svg), [], `${slug} [${themeName}] svg`);
      assert.deepEqual(multicolorCoincidentPaths(r.svg), [],
        `${slug} [${themeName}]: coincident connector paths with multiple colors were emitted`);
    });
  }
}

test("regression dense topology: no coincident connector geometry is emitted in different colors", () => {
  const [dense] = extractBlocks(readFileSync(join(FIX, "torture-dense.md"), "utf8"), THEME_NAMES);
  const r = renderSwimlane(dense.code, { theme: "portal", title: dense.heading });
  assert.deepEqual(multicolorCoincidentPaths(r.svg), []);
  assert.deepEqual(verifyGeometry(r), [], "dense topology geometry");
  assert.deepEqual(verifySvgString(r.svg), [], "dense topology svg");
});

const [ROOT_PILLS_STRESS] = extractBlocks(readFileSync(join(ROOT, "pills-stress.md"), "utf8"), THEME_NAMES);
test("regression root pills-stress fixture is available and issue-free", () => {
  assert.ok(ROOT_PILLS_STRESS, "missing pills-stress root fixture");
  assert.deepEqual(ROOT_PILLS_STRESS.issues, [], `pills-stress parser issues: ${JSON.stringify(ROOT_PILLS_STRESS.issues)}`);
});

for (const themeName of THEME_NAMES) {
  test(`regression root pills-stress [${themeName}]: no crossings, no lane-wrap duplication, and no multicolor coincident paths`, () => {
    const r = renderSwimlane(ROOT_PILLS_STRESS.code, { theme: themeName, title: ROOT_PILLS_STRESS.heading });
    assert.deepEqual(repeatedLaneLabels(r), [],
      `pills-stress [${themeName}]: repeated lane labels indicate physical lane wrapping (${repeatedLaneLabels(r).join(", ")})`);
    assert.deepEqual(verifyGeometry(r), [], `pills-stress [${themeName}] geometry`);
    assert.deepEqual(verifySvgString(r.svg), [], `pills-stress [${themeName}] svg`);
    assert.deepEqual(multicolorCoincidentPaths(r.svg), [],
      `pills-stress [${themeName}]: coincident connector paths with multiple colors were emitted`);
  });
}

const UNKNOWN_SOURCE_FIXTURE = [
  "flowchart BT",
  'h["Healthy source<br/>healthy"] --> root["Workload root<br/>healthy"]',
  'd["Degraded source<br/>degraded"] --> root',
  'u["Unknown source"] --> root',
  "class h green;",
  "class d amber;",
  "class root green;",
].join("\n");
const UNKNOWN_SOURCE_STATES = new Map([
  ["h", "healthy"],
  ["d", "degraded"],
  ["u", "unknown"],
]);
for (const themeName of THEME_NAMES) {
  const T = THEMES[themeName];
  test(`unknown-source connector color rule [${themeName}]: only unknown sources may render gray`, () => {
    const r = renderSwimlane(UNKNOWN_SOURCE_FIXTURE, { theme: themeName, title: "unknown-source-check" });
    const bySource = new Map();
    for (const path of edgePaths(r.svg)) {
      const sourceId = sourceIdForPath(r, path.d, [...UNKNOWN_SOURCE_STATES.keys()]);
      bySource.set(sourceId, path.stroke);
    }
    assert.equal(bySource.size, UNKNOWN_SOURCE_STATES.size, "expected one connector stroke per source");
    for (const [sourceId, state] of UNKNOWN_SOURCE_STATES.entries()) {
      const expected = T.state[state].border.toLowerCase();
      assert.equal(bySource.get(sourceId), expected,
        `${themeName}: ${sourceId} (${state}) must use ${expected}, got ${bySource.get(sourceId)}`);
    }
    assert.equal(bySource.get("u"), T.state.unknown.border.toLowerCase(), `${themeName}: unknown source must use unknown gray`);
    assert.notEqual(bySource.get("h"), T.state.unknown.border.toLowerCase(), `${themeName}: healthy source must not use unknown gray`);
    assert.notEqual(bySource.get("d"), T.state.unknown.border.toLowerCase(), `${themeName}: degraded source must not use unknown gray`);
    assert.equal(edgeStrokes(r.svg).includes(T.muted.toLowerCase()), false, `${themeName}: connector strokes must never use muted trunk color`);
    assert.deepEqual(verifyGeometry(r), [], `${themeName}: geometry`);
    assert.deepEqual(verifySvgString(r.svg), [], `${themeName}: svg`);
  });
}
