// laneLabels isolation guard. The rebuilt `laneLabels` option is a pure visibility toggle for the
// right-hand lane-label gutter. It must be provably isolated from the layout/routing/color engine:
//   - default / laneLabels:true  → byte-identical to the historical (pre-PR6) output;
//   - laneLabels:false           → ONLY the lane-label <text> is removed and the reclaimed right
//                                   gutter trims total width. Every edge path (topology + color),
//                                   every node card rect (position), lane-band count, and the SVG
//                                   height stay byte-identical. It can never wrap, reroute, or
//                                   recolor anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { renderSwimlane } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "diagrammo.mjs");
const FIX = join(ROOT, "test", "fixtures");

// A nontrivial, multi-lane graph (the real operational consumer diagram — several lanes, mixed
// states, dashed edge) is the representative case for the isolation proof.
const OP = extractBlocks(readFileSync(join(FIX, "pr6-regressions.md"), "utf8"), THEME_NAMES)
  .find((b) => b.slug === "add-operational-quality-signals-to-the-workload-model");

const EDGE_RE = /<path d="[^"]*" stroke="#[0-9a-fA-F]{6}" stroke-width="1\.[67]"(?: stroke-dasharray="5 4")?\/>/g;
const CARD_RE = /<rect x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*" rx="10"[^>]*>/g;
const LANE_LABEL_RE = /<text [^>]*font-size="13" font-weight="700"[^>]*>[^<]*<\/text>/g;
const edges = (svg) => svg.match(EDGE_RE) || [];
const cards = (svg) => svg.match(CARD_RE) || [];
const laneLabels = (svg) => svg.match(LANE_LABEL_RE) || [];

test("laneLabels: omitted, true, and a non-boolean all render the shown (default) output byte-identically", () => {
  const base = renderSwimlane(OP.code, { theme: "portal", title: OP.heading });
  const explicitTrue = renderSwimlane(OP.code, { theme: "portal", title: OP.heading, laneLabels: true });
  // A non-boolean that somehow reaches the renderer must fall back to SHOWN, never accidentally hide.
  const bogus = renderSwimlane(OP.code, { theme: "portal", title: OP.heading, laneLabels: "nope" });
  assert.equal(explicitTrue.svg, base.svg, "laneLabels:true must equal the default (shown) output");
  assert.equal(bogus.svg, base.svg, "a non-boolean laneLabels must fall back to shown, not hide");
  assert.ok(laneLabels(base.svg).length > 0, "the default output must draw lane labels");
});

test("laneLabels: rendering is deterministic across reruns for both true and false", () => {
  for (const laneLabelsOpt of [true, false]) {
    const a = renderSwimlane(OP.code, { theme: "portal", title: OP.heading, laneLabels: laneLabelsOpt });
    const b = renderSwimlane(OP.code, { theme: "portal", title: OP.heading, laneLabels: laneLabelsOpt });
    assert.equal(a.svg, b.svg, `laneLabels:${laneLabelsOpt} must be byte-stable across reruns`);
  }
});

for (const themeName of THEME_NAMES) {
  test(`laneLabels [${themeName}]: false removes only labels + reclaims the gutter; edges, cards, height invariant`, () => {
    const on = renderSwimlane(OP.code, { theme: themeName, title: OP.heading, laneLabels: true });
    const off = renderSwimlane(OP.code, { theme: themeName, title: OP.heading, laneLabels: false });

    // labels: present when shown, entirely gone when hidden.
    assert.ok(laneLabels(on.svg).length > 0, "shown output must contain lane-label text");
    assert.equal(laneLabels(off.svg).length, 0, "hidden output must contain no lane-label text");

    // width: strictly narrower (gutter reclaimed); height unchanged.
    assert.ok(off.W < on.W, `expected narrower width when hidden (${off.W} !< ${on.W})`);
    assert.equal(off.H, on.H, "height must not change");

    // topology + color: every edge path byte-identical (no reroute, no recolor, no translation).
    assert.deepEqual(edges(off.svg), edges(on.svg), "edge paths must be byte-identical");
    // node placement + order: every card rect byte-identical.
    assert.deepEqual(cards(off.svg), cards(on.svg), "node card rects must be byte-identical");
    // lane structure preserved (bands/hairlines remain; one band per lane, no wrapping).
    assert.equal(off.lanes, on.lanes, "lane count must not change");
    assert.equal(off.debug.lanes.length, off.lanes, "each lane still renders exactly one band");

    // both remain geometrically clean, well-formed SVG.
    for (const r of [on, off]) {
      assert.deepEqual(verifyGeometry(r), [], `${themeName} geometry`);
      assert.deepEqual(verifySvgString(r.svg), [], `${themeName} svg`);
    }
  });
}

test("laneLabels: end-to-end via the CLI — `%%| laneLabels: false` hides labels and narrows the SVG", async () => {
  const dir = mkdtempSync(join(tmpdir(), "diagrammo-lanelabels-"));
  try {
    const shownMd = join(dir, "shown.md");
    const hiddenMd = join(dir, "hidden.md");
    const lines = OP.code.split("\n"); // line 0 is `flowchart BT`
    const fence = (directive) =>
      "# Ops\n\n```mermaid\n" + lines[0] + "\n" + directive + lines.slice(1).join("\n") + "\n```\n";
    writeFileSync(shownMd, fence(""));
    writeFileSync(hiddenMd, fence("%%| laneLabels: false\n"));
    const outShown = join(dir, "out-shown");
    const outHidden = join(dir, "out-hidden");
    const r1 = await pexec(process.execPath, [CLI, shownMd, "-o", outShown, "--strict"]);
    const r2 = await pexec(process.execPath, [CLI, hiddenMd, "-o", outHidden, "--strict"]);
    assert.ok(r1.stdout.includes("1 mermaid block") && r2.stdout.includes("1 mermaid block"));

    const findSvg = (out) => JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"))[0];
    const shown = findSvg(outShown), hidden = findSvg(outHidden);
    const shownSvg = readFileSync(join(outShown, shown.svg), "utf8");
    const hiddenSvg = readFileSync(join(outHidden, hidden.svg), "utf8");

    assert.ok(laneLabels(shownSvg).length > 0, "shown CLI render must contain lane labels");
    assert.equal(laneLabels(hiddenSvg).length, 0, "hidden CLI render must contain no lane labels");
    assert.ok(hidden.w < shown.w, `hidden CLI SVG must be narrower (${hidden.w} !< ${shown.w})`);
    assert.equal(hidden.h, shown.h, "hidden CLI SVG height must be unchanged");
    assert.deepEqual(edges(hiddenSvg), edges(shownSvg), "CLI edge paths must be byte-identical");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
