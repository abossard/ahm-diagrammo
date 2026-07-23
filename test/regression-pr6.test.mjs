// PR #6 visual-regression guard. PR #6's width-bounding/wrapping introduced cross-row edge
// "trunk" bundling painted in the neutral T.muted gray and multi-row corridor jogging, which
// turned state-colored connectors gray/black ("lines are black.gray instead of green") and made
// routing look like "spaghetti" on three real consumer health-model diagrams. The rollback
// restores pre-PR6 semantics; this test pins them against the three actual consumer sources
// (test/fixtures/pr6-regressions.md):
//   1. every drawn edge uses its source node's STATE color — never the neutral T.muted gray;
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

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const BLOCKS = extractBlocks(readFileSync(join(FIX, "pr6-regressions.md"), "utf8"), THEME_NAMES);
const bySlug = (slug) => BLOCKS.find((b) => b.slug === slug);

// Every edge <path>: `<path d="…" stroke="COLOR" stroke-width="1.6|1.7"[ stroke-dasharray="5 4"]/>`.
const EDGE_RE = /<path d="[^"]*" stroke="(#[0-9a-fA-F]{6})" stroke-width="1\.[67]"(?: stroke-dasharray="5 4")?\/>/g;
const edgeStrokes = (svg) => [...svg.matchAll(EDGE_RE)].map((m) => m[1].toLowerCase());

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
      assert.equal(r.debug.lanes.length, r.lanes,
        `${slug} [${themeName}]: ${r.debug.lanes.length} bands for ${r.lanes} lanes — a lane wrapped onto multiple rows`);

      // geometry stays clean (nothing overlapping, hidden, or clipped) and SVG well-formed.
      assert.deepEqual(verifyGeometry(r), [], `${slug} [${themeName}] geometry`);
      assert.deepEqual(verifySvgString(r.svg), [], `${slug} [${themeName}] svg`);
    });
  }
}
