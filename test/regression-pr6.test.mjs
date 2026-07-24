// Real-consumer routing guard. Shared trunk spans are structural and neutral, while each branch
// keeps its source state color. These fixtures verify that the neutral trunk never replaces the
// state-colored branches and that bounded wrapping remains geometrically clean.
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
    test(`regression ${slug} [${themeName}]: state-colored branches and neutral shared trunks remain distinct`, () => {
      const r = renderSwimlane(block.code, { theme: themeName, title: block.heading });
      const strokes = edgeStrokes(r.svg);
      assert.ok(strokes.length > 0, "expected drawn connectors");

      // Exact palette: source-state branch colors plus the visually distinct structural trunk.
      expected.add(T.muted.toLowerCase());
      assert.deepEqual(new Set(strokes), expected,
        `${slug} [${themeName}]: edge colors ${JSON.stringify([...new Set(strokes)])} ≠ expected ${JSON.stringify([...expected])}`);
      assert.ok(strokes.includes(T.state.healthy.border.toLowerCase()),
        `${slug} [${themeName}]: expected at least one healthy (green) connector`);
      assert.ok(strokes.includes(T.muted.toLowerCase()),
        `${slug} [${themeName}]: expected at least one neutral shared-trunk span`);

      const trunkTags = new Set(r.debug.segs.map((s) => s.trunk).filter(Boolean));
      assert.ok(trunkTags.size > 0, `${slug} [${themeName}]: expected tagged shared-trunk geometry`);
      assert.ok(r.debug.segs.some((s) => s.trunk == null),
        `${slug} [${themeName}]: expected independently routed/state-colored branch geometry`);

      // geometry stays clean (nothing overlapping, hidden, or clipped) and SVG well-formed.
      assert.deepEqual(verifyGeometry(r), [], `${slug} [${themeName}] geometry`);
      assert.deepEqual(verifySvgString(r.svg), [], `${slug} [${themeName}] svg`);
    });
  }
}
