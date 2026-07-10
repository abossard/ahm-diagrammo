// Documentation stays true: examples/showcase.md is the living feature demo, so every claim in
// it must keep working — renderer detection, all three option channels, themes, custom lanes,
// measurements, and clean geometry. If a feature changes, this test (and the docs) must too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "../src/extract.mjs";
import { renderSwimlane, looksLikeHealthModel } from "../src/swimlane.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { galleryHtml } from "../src/gallery.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const blocks = extractBlocks(readFileSync(join(ROOT, "examples", "showcase.md"), "utf8"), THEME_NAMES);

test("showcase.md demonstrates every option channel exactly as documented", () => {
  assert.equal(blocks.length, 6);
  const bySlug = Object.fromEntries(blocks.map((b) => [b.slug, b]));

  // block 1: zero config → auto-detected health model
  assert.equal(looksLikeHealthModel(bySlug["health-model-zero-config"].code), true);
  assert.deepEqual(bySlug["health-model-zero-config"].options, {});

  // block 2: fence info sets the theme
  assert.equal(bySlug["fence-info-options-theme-in-the-fence-line"].options.theme, "midnight");

  // block 3: frontmatter sets title/theme/subtitle/lanes
  const fm = bySlug["order-pipeline-health"].options;
  assert.equal(fm.title, "Order pipeline health");
  assert.equal(fm.theme, "candy");
  assert.deepEqual(fm.lanes, ["Storefront", "Order flows", "Services"]);

  // block 4: %%| directives set theme/title/subtitle/legend
  const dir = bySlug["ingestion-path"].options;
  assert.equal(dir.theme, "slate");
  assert.equal(dir.legend, false);

  // blocks 5–6: non-health blocks route to the mermaid renderer
  assert.equal(looksLikeHealthModel(bySlug["any-other-mermaid-still-works"].code), false);
  assert.equal(looksLikeHealthModel(bySlug["plain-flowchart-forced-theme"].code), false);
  assert.equal(bySlug["plain-flowchart-forced-theme"].options.theme, "slate");

  // no block carries option mistakes
  for (const b of blocks) assert.deepEqual(b.issues, [], `${b.slug}: ${JSON.stringify(b.issues)}`);
});

test("every showcase health model renders geometrically clean in its declared theme", () => {
  for (const b of blocks) {
    if (!looksLikeHealthModel(b.code)) continue;
    const r = renderSwimlane(b.code, {
      theme: b.options.theme || "portal",
      title: b.options.title ?? b.heading,
      subtitle: b.options.subtitle,
      lanes: b.options.lanes,
      legend: b.options.legend,
    });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `${b.slug}:\n  ${geo.join("\n  ")}`);
    assert.deepEqual(verifySvgString(r.svg), []);
  }
});

test("showcase measurement syntax lands in the output (value + state per row)", () => {
  const b = blocks.find((x) => x.slug === "order-pipeline-health");
  const r = renderSwimlane(b.code, { theme: "candy", title: b.options.title, lanes: b.options.lanes });
  assert.match(r.svg, /230 ms/);   // explicit result survives
  assert.match(r.svg, /0\.4%/);
  assert.match(r.svg, /12 min/);
  assert.match(r.svg, />Storefront</); // custom lane label
});

test("gallery.html lists every rendered diagram with title, renderer, and theme", () => {
  const html = galleryHtml(
    [{ svg: "a.svg", title: "First <figure>", renderer: "swimlane", theme: "candy", nodes: 5 },
     { svg: "b.svg", title: "Second", renderer: "mermaid", theme: "slate" }],
    { source: "doc.md" },
  );
  assert.match(html, /<img src="a\.svg"/);
  assert.match(html, /First &lt;figure&gt;/); // titles are escaped
  assert.match(html, /swimlane · candy · 5 nodes/);
  assert.match(html, /mermaid · slate/);
  assert.match(html, /2 diagrams from doc\.md/);
});
