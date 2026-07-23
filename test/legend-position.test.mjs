// Bottom-legend placement guard. As of v3.1.0 the legend is emitted as a dedicated single
// horizontal footer row below ALL content (lane bands, node cards, edges), left-aligned at the
// title margin, by default. This pins the contract:
//   - legend sits strictly below content (baseline y > every content y + gap);
//   - all six labels (Legend, Healthy, Degraded, Unhealthy, Unknown, Metric) share ONE y baseline
//     in order and never wrap;
//   - SVG height grows by exactly the footer delta while every content y stays byte-identical;
//   - width stays content-driven when content is wider; a legend floor prevents clipping when the
//     legend is the widest element;
//   - the title keeps its top-left position and the header no longer carries a legend;
//   - legend:false grows neither height nor width (old behaviour), draws no legend text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "../src/extract.mjs";
import { renderSwimlane } from "../src/swimlane.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FIX = join(ROOT, "test", "fixtures");
const BASE = join(FIX, "legend-baseline");

// Footer geometry chosen at replicate (must match src/swimlane.mjs).
const LEGEND_GAP = 20;
const LEGEND_ROW_H = 28;
const FOOTER_DELTA = LEGEND_GAP + LEGEND_ROW_H; // 48
const RIGHT_MARGIN = 40;
const M_LEFT = 40;
const LEGEND_LABELS = ["Legend", "Healthy", "Degraded", "Unhealthy", "Unknown", "Metric"];

const OP = extractBlocks(readFileSync(join(FIX, "pr6-regressions.md"), "utf8"), THEME_NAMES)
  .find((b) => b.slug === "add-operational-quality-signals-to-the-workload-model");
const NARROW = extractBlocks(readFileSync(join(FIX, "torture-weird.md"), "utf8"), THEME_NAMES)
  .find((b) => b.slug === "single-node");

const EDGE_RE = /<path d="[^"]*" stroke="#[0-9a-fA-F]{6}" stroke-width="1\.[67]"(?: stroke-dasharray="5 4")?\/>/g;
const CARD_RE = /<rect x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*" rx="10"[^>]*>/g;
const edges = (svg) => svg.match(EDGE_RE) || [];
const cards = (svg) => svg.match(CARD_RE) || [];

// Every <text> as {x,y,text}; used to locate the six legend labels and the title/subtitle.
const TEXT_RE = /<text x="([\-\d.]+)" y="([\-\d.]+)"[^>]*>([^<]*)<\/text>/g;
function texts(svg) {
  const out = [];
  for (const m of svg.matchAll(TEXT_RE)) out.push({ x: +m[1], y: +m[2], text: m[3] });
  return out;
}
// Legend texts are the only font-size="11.5" <text> nodes (title=18, subtitle=12, lane labels=13,
// pills use their own size) — scope by that so content words like a "Healthy" node never match.
const LEGEND_TEXT_RE = /<text x="([\-\d.]+)" y="([\-\d.]+)" font-size="11\.5"[^>]*>([^<]*)<\/text>/g;
function legendTexts(svg) {
  const out = [];
  for (const m of svg.matchAll(LEGEND_TEXT_RE)) out.push({ x: +m[1], y: +m[2], text: m[3] });
  return out;
}

// Max content y: lane band rect bottoms, card rect bottoms, and edge path vertical extents.
function maxContentY(svg) {
  let max = 0;
  for (const m of svg.matchAll(/<rect [^>]*y="([\-\d.]+)"[^>]*height="([\-\d.]+)"[^>]*\/>/g))
    max = Math.max(max, +m[1] + +m[2]);
  for (const m of svg.matchAll(EDGE_RE)) {
    for (const n of m[0].matchAll(/[ML,MLC]?\s*[\-\d.]+[ ,]([\-\d.]+)/g)) {
      const y = +n[1];
      if (!Number.isNaN(y)) max = Math.max(max, y);
    }
  }
  return max;
}

const baseline = (name) => readFileSync(join(BASE, `${name}.svg`), "utf8");
const dims = (svg) => {
  const m = svg.match(/width="(\d+)" height="(\d+)"/);
  return { W: +m[1], H: +m[2] };
};

// ── legend below content, one line, in order ──────────────────────────────────────────────────
for (const themeName of THEME_NAMES) {
  for (const laneLabels of [true, false]) {
    test(`legend [${themeName}, laneLabels=${laneLabels}]: one bottom row below all content, in order`, () => {
      const r = renderSwimlane(OP.code, { theme: themeName, title: OP.heading, laneLabels });
      const ls = legendTexts(r.svg);

      // all six labels present, in order.
      assert.deepEqual(ls.map((t) => t.text), LEGEND_LABELS, "six legend labels in order");

      // one shared baseline — no wrap onto a second y.
      const ys = new Set(ls.map((t) => t.y.toFixed(1)));
      assert.equal(ys.size, 1, `legend must share one y baseline, saw ${[...ys].join(",")}`);
      const legendY = ls[0].y;

      // strictly below the deepest content + gap, and below the content boundary.
      const contentMaxY = maxContentY(r.svg);
      assert.ok(legendY > contentMaxY, `legend y ${legendY} must exceed max content y ${contentMaxY}`);
      assert.ok(legendY >= r.H - FOOTER_DELTA, `legend y ${legendY} must sit in the footer strip`);

      // header carries no legend: no legend label appears above the content top (y < 78).
      assert.equal(ls.filter((t) => t.y < 78).length, 0, "no legend label in the header band");

      // clean, well-formed.
      assert.deepEqual(verifyGeometry(r), [], `${themeName} geometry`);
      assert.deepEqual(verifySvgString(r.svg), [], `${themeName} svg`);
    });
  }
}

// ── content geometry byte-invariant vs pristine baseline; height grows by exactly the delta ─────
for (const themeName of THEME_NAMES) {
  test(`legend [${themeName}]: content y invariant vs v3.0.0 baseline; H grows by footer delta`, () => {
    const r = renderSwimlane(OP.code, { theme: themeName, title: OP.heading });
    const base = baseline(`op-${themeName}`);
    const b = dims(base), n = dims(r.svg);

    // edges + cards byte-identical (no reroute, recolor, or x/y shift of content).
    assert.deepEqual(edges(r.svg), edges(base), "edge paths byte-identical");
    assert.deepEqual(cards(r.svg), cards(base), "card rects byte-identical");

    // title unchanged (top-left), subtitle unchanged.
    const title = texts(r.svg).find((t) => t.text === OP.heading);
    assert.ok(r.svg.includes(`<text x="40" y="34" font-size="18" font-weight="700"`), "title line unchanged");
    assert.equal(title.y, 34, "title y unchanged");
    const bTitle = texts(base).find((t) => t.text === OP.heading);
    assert.equal(title.x, bTitle.x, "title x unchanged");

    // width content-driven and unchanged for the wide fixture.
    assert.equal(n.W, b.W, "wide fixture width stays content-driven (unchanged)");
    // height grows by exactly the footer delta.
    assert.equal(n.H, b.H + FOOTER_DELTA, `H must grow by exactly ${FOOTER_DELTA}`);

    // legend not clipped: rightmost legend text starts within the right margin.
    const ls = legendTexts(r.svg);
    const rightmost = Math.max(...ls.map((t) => t.x));
    assert.ok(rightmost <= n.W - RIGHT_MARGIN, `rightmost legend x ${rightmost} <= W-${RIGHT_MARGIN}`);
  });
}

// ── narrow fixture: legend width floor engages, no clip ─────────────────────────────────────────
test("legend [narrow single-node]: width floor prevents clipping; legend still one bottom row", () => {
  const r = renderSwimlane(NARROW.code, { theme: "portal", title: NARROW.heading });
  const base = baseline("single-node-portal");
  const b = dims(base), n = dims(r.svg);

  const ls = legendTexts(r.svg);
  assert.deepEqual(ls.map((t) => t.text), LEGEND_LABELS, "six legend labels in order");
  const ys = new Set(ls.map((t) => t.y.toFixed(1)));
  assert.equal(ys.size, 1, "narrow legend shares one baseline");

  // content geometry unchanged; height grew by the footer delta.
  assert.deepEqual(cards(r.svg), cards(base), "card rects byte-identical");
  assert.equal(n.H, b.H + FOOTER_DELTA, "narrow H grows by footer delta");

  // width floor: at least legend intrinsic width; legend left-aligned at M.left; no clip.
  assert.equal(ls[0].x, M_LEFT, "legend starts left-aligned at the title margin");
  const lastText = ls[ls.length - 1]; // "Metric"
  assert.ok(lastText.x <= n.W - RIGHT_MARGIN, `rightmost legend text x ${lastText.x} <= W-${RIGHT_MARGIN}`);
  assert.deepEqual(verifyGeometry(r), [], "narrow geometry");
  assert.deepEqual(verifySvgString(r.svg), [], "narrow svg");
});

// ── legend disabled: no footer growth, no legend text ───────────────────────────────────────────
test("legend:false — no footer height/width growth, no legend text", () => {
  const r = renderSwimlane(NARROW.code, { theme: "portal", title: NARROW.heading, legend: false });
  const base = baseline("single-node-portal-legendoff");
  const b = dims(base), n = dims(r.svg);
  assert.equal(legendTexts(r.svg).length, 0, "no legend text when disabled");
  assert.equal(n.H, b.H, "disabled height unchanged vs old behaviour");
  assert.equal(n.W, b.W, "disabled width unchanged vs old behaviour");
});

// ── determinism ─────────────────────────────────────────────────────────────────────────────────
test("legend: rendering is byte-stable across reruns", () => {
  const a = renderSwimlane(OP.code, { theme: "portal", title: OP.heading });
  const b = renderSwimlane(OP.code, { theme: "portal", title: OP.heading });
  assert.equal(a.svg, b.svg, "footer render must be deterministic");
});
