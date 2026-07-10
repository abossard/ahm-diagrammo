// Golden-file regression: rendering is deterministic (asserted in swimlane.test.mjs), so the
// committed SVGs under test/golden/ pin the exact visual output. Any layout or styling change —
// intended or not — shows up as a diff here.
//
// After an INTENDED change:   UPDATE_GOLDENS=1 npm test   (or npm run goldens), then review the
// SVG diffs like any other code change and commit them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "../src/extract.mjs";
import { renderSwimlane, looksLikeHealthModel } from "../src/swimlane.mjs";
import { THEME_NAMES } from "../src/themes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const GOLDEN = join(ROOT, "test", "golden");
const UPDATE = !!process.env.UPDATE_GOLDENS;

const SOURCES = [
  "kitchen-sink.md",
  "pills-stress.md",
  "examples/showcase.md",
  "test/fixtures/torture-deep.md",
  "test/fixtures/torture-pills.md",
  "test/fixtures/torture-text.md",
  "test/fixtures/torture-dense.md",
  "test/fixtures/torture-weird.md",
];

for (const source of SOURCES) {
  const blocks = extractBlocks(readFileSync(join(ROOT, source), "utf8"), THEME_NAMES);
  for (const b of blocks) {
    if (!looksLikeHealthModel(b.code)) continue; // mermaid-cli output isn't ours to pin
    test(`golden: ${source} → ${b.slug}.svg`, () => {
      const { svg } = renderSwimlane(b.code, {
        theme: b.options.theme || "portal",
        title: b.options.title ?? b.heading,
        subtitle: b.options.subtitle,
        lanes: b.options.lanes,
        legend: b.options.legend,
      });
      const file = join(GOLDEN, `${b.slug}.svg`);
      if (UPDATE) {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(file, svg);
        return;
      }
      assert.ok(existsSync(file), `missing golden ${file} — run UPDATE_GOLDENS=1 npm test`);
      assert.equal(svg, readFileSync(file, "utf8"),
        `${b.slug}.svg differs from its golden — if the change is intended, run UPDATE_GOLDENS=1 npm test and review the diff`);
    });
  }
}
