// Near-aligned-edge straightening (user feedback: "if a line has only a very small horizontal
// shift ... can we make the line straight?"). A single-channel tracked (labeled/dashed) edge whose
// two risers only differ by makeSlots' anti-collinearity bump draws a redundant jog around its
// label row; we collapse that to one straight vertical. Genuine L-shaped routing (real horizontal
// travel) must survive. Verified at the public renderSwimlane boundary via debug.segs + the exact
// snap threshold via the pure straightenTrackedX predicate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSwimlane, straightenTrackedX } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

// segments the renderer emitted for one edge ("from->to"); "v" = vertical, "h" = horizontal.
const edgeSegs = (r, edge) => r.debug.segs.filter((s) => s.edge === edge);
const kinds = (segs) => ({ v: segs.filter((s) => s.kind === "v").length, h: segs.filter((s) => s.kind === "h").length });

// --- exact snap boundary (pure predicate; layout only ever yields the 6px bump or a large offset,
//     so the 8/12 boundary is unreachable through a diagram and is proven here directly) ---
const uLo = 50, uHi = 150, xIn = 100; // xIn is inside [uLo,uHi]
for (const { delta, straight } of [
  { delta: 0, straight: true },     // perfectly aligned
  { delta: 6, straight: true },     // the observed one-pitch bump (screenshot 1)
  { delta: 8, straight: true },     // STRAIGHT_SNAP_DX boundary, inclusive
  { delta: 12, straight: false },   // two pitches: an intervening vertical could hide here
  { delta: 34.5, straight: false }, // screenshot 2's genuine L-shape travel
]) {
  test(`straightenTrackedX: |Δ|=${delta} → ${straight ? "snap" : "keep dogleg"}`, () => {
    assert.equal(straightenTrackedX(xIn, xIn + delta, uLo, uHi), straight);
    assert.equal(straightenTrackedX(xIn, xIn - delta, uLo, uHi), straight); // sign-symmetric
  });
}

test("straightenTrackedX: near-aligned but exit x outside the parent slot range keeps the dogleg", () => {
  // Δ=2 (well under threshold) yet the snap x would land off the upper card → must not snap.
  assert.equal(straightenTrackedX(uHi + 40, uHi + 42, uLo, uHi), false);
  assert.equal(straightenTrackedX(uLo - 40, uLo - 42, uLo, uHi), false);
});

// --- screenshot 1: the real consumer diagram that regressed (a golden fixture) ---
const OP_SLUG = "add-operational-quality-signals-to-the-workload-model";
const opBlock = () =>
  extractBlocks(readFileSync(join(FIX, "pr6-regressions.md"), "utf8"), THEME_NAMES).find((b) => b.slug === OP_SLUG);

test(`screenshot 1 (${OP_SLUG}): the suppressed-propagation edge is one straight vertical`, () => {
  const b = opBlock();
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading });
  const segs = edgeSegs(r, "load->root");
  const k = kinds(segs);
  assert.equal(k.h, 0, `expected no horizontal jog, got ${JSON.stringify(segs)}`);
  assert.equal(k.v, 1, "expected exactly one vertical segment");
  assert.equal(segs[0].x1, segs[0].x2, "the vertical must be truly vertical (one x)");

  // the straightened edge keeps its identity: degraded-orange, dashed, both label lines visible.
  assert.match(r.svg, /<path d="M599\.0 237\.0 L599\.0 154\.0" stroke="#db7500" stroke-width="1\.6" stroke-dasharray="5 4"\/>/);
  assert.match(r.svg, />suppressed propagation</);

  assert.deepEqual(verifyGeometry(r), [], "geometry (incl. pill-not-crossed) must stay clean");
  assert.deepEqual(verifySvgString(r.svg), []);
});

// --- a minimal aligned edge reproduces the bump and straightens; identical under laneLabels off ---
const ALIGNED = [
  "flowchart BT",
  'child["Child<br/>degraded"] -. "suppressed<br/>propagation" .-> parent["Parent<br/>healthy"]',
  "class child amber; class parent green;",
].join("\n");

test("aligned adjacent dashed edge straightens, and laneLabels off changes only width", () => {
  const on = renderSwimlane(ALIGNED, { theme: "portal", title: "aligned", laneLabels: true });
  const off = renderSwimlane(ALIGNED, { theme: "portal", title: "aligned", laneLabels: false });
  for (const r of [on, off]) {
    const k = kinds(edgeSegs(r, "child->parent"));
    assert.deepEqual(k, { v: 1, h: 0 }, "aligned edge must be a single straight vertical");
    assert.deepEqual(verifyGeometry(r), []);
  }
  // the connector path bytes are identical regardless of the label gutter; W never shrinks with it.
  const pathOf = (svg) => svg.match(/<path d="[^"]*" stroke="#c8c6c4"[^/]*\/>/)[0];
  assert.equal(pathOf(on.svg), pathOf(off.svg));
  assert.ok(on.W >= off.W, "laneLabels on never narrows the canvas");
});

// --- screenshot 2 essence: a genuine horizontal offset must keep its L-shape ---
const MEANINGFUL_L = [
  "flowchart BT",
  'order["Order service<br/>unhealthy"] -. "limited<br/>propagation" .-> appRoot["Application root<br/>degraded"]',
  'sibling["A wide neighbour card padding padding<br/>healthy"] --> appRoot',
  "class order red; class appRoot amber; class sibling green;",
].join("\n");

test("meaningful L-shaped labeled edge (real horizontal travel) stays orthogonal", () => {
  const r = renderSwimlane(MEANINGFUL_L, { theme: "portal", title: "L" });
  const segs = edgeSegs(r, "order->appRoot");
  const k = kinds(segs);
  assert.equal(k.h, 1, "the genuine horizontal run must survive");
  assert.equal(k.v, 2, "…between two risers");
  const h = segs.find((s) => s.kind === "h");
  assert.ok(h.x2 - h.x1 > 12, `horizontal travel ${h.x2 - h.x1}px must exceed the snap threshold`);
  assert.deepEqual(verifyGeometry(r), []);
});

// --- multi-channel lane-skipping tracked edge is out of scope (channels.length > 1) ---
const LANE_SKIP = [
  "flowchart BT",
  'sig["Sig<br/>degraded"] -. "limited<br/>propagation" .-> root["Root<br/>healthy"]',
  'sig --> mid["Mid<br/>healthy"]',
  "mid --> root",
  "class sig amber; class mid green; class root green;",
].join("\n");

test("lane-skipping (multi-channel) tracked edge is never straightened", () => {
  const r = renderSwimlane(LANE_SKIP, { theme: "portal", title: "skip" });
  const k = kinds(edgeSegs(r, "sig->root"));
  assert.ok(k.h >= 1, "a corridor-routed lane-skipper must keep its horizontal corridor hops");
  assert.deepEqual(verifyGeometry(r), []);
});
