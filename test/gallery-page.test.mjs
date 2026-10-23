// The gallery (docs/gallery) matches docs/gallery/source.md, shows every health model in both
// looks, and ships static SVG only. Regenerate with `npm run gallery`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildGallery, compareGallery, GALLERY_DIR } from "../scripts/gallery.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { looksLikeHealthModel } from "../src/swimlane.mjs";
import { THEME_NAMES } from "../src/themes.mjs";

const source = readFileSync(join(GALLERY_DIR, "source.md"), "utf8");
const sourceLines = source.split("\n");
const files = buildGallery(source);
const readme = files.get("README.md");
const svgs = [...files.keys()].filter((path) => path.startsWith("svg/"));

test("docs/gallery is up to date with source.md (run `npm run gallery`)", () => {
  assert.deepEqual(compareGallery(files), { stale: [], extra: [] });
});

for (const block of extractBlocks(source, THEME_NAMES)) {
  const above = sourceLines.slice(0, block.line - 1).reverse().find((line) => line.trim());
  const library = /^<!--\s*gallery:/.test(above ?? "");
  const bothLooks = !library && !block.options.renderer && looksLikeHealthModel(block.code);
  test(`gallery block ${block.slug} shows ${bothLooks ? "both looks" : "its single look"}`, () => {
    const own = svgs.filter((path) => path.startsWith(`svg/${block.slug}.`)).sort();
    if (bothLooks) assert.deepEqual(own, [`svg/${block.slug}.pele.svg`, `svg/${block.slug}.swimlane.svg`]);
    else assert.ok(own.length >= 1 && own.every((path) => !path.endsWith(".swimlane.svg")), own.join(", "));
    for (const path of own) assert.ok(readme.includes(`](${path})`), `README.md does not embed ${path}`);
  });
}

for (const path of svgs) {
  test(`gallery ${path} is static, Learn-safe SVG`, () => {
    const svg = files.get(path);
    assert.match(svg, /^<svg\b/);
    assert.match(svg, /<text/);
    assert.doesNotMatch(svg, /<(foreignObject|script|style|image)\b|var\(--/i);
  });
}
