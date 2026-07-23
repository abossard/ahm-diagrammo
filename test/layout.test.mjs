// Unit tests for the pure layout algorithms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPositions, assignTracks, corridorsOf, pickCorridorX, packRows } from "../src/layout.mjs";

test("projectPositions keeps order and separations", () => {
  const desired = [100, 100, 100, 100];   // everyone wants the same spot
  const sep = [50, 50, 50];
  const xs = projectPositions(desired, sep);
  for (let i = 1; i < xs.length; i++) assert.ok(xs[i] - xs[i - 1] >= 50 - 1e-6, `sep ${i}: ${xs[i] - xs[i - 1]}`);
  // cluster centers on the common desire
  const mid = (xs[0] + xs[3]) / 2;
  assert.ok(Math.abs(mid - 100) < 1e-6, `cluster mid ${mid}`);
});

test("projectPositions leaves non-conflicting nodes at their desired spots", () => {
  const xs = projectPositions([0, 200, 500], [50, 50]);
  assert.deepEqual(xs, [0, 200, 500]);
});

test("projectPositions handles mixed clusters", () => {
  const xs = projectPositions([0, 10, 400], [60, 60]);
  assert.ok(xs[1] - xs[0] >= 60 - 1e-6);
  assert.ok(xs[2] - xs[1] >= 60 - 1e-6);
  assert.equal(xs[2], 400); // far node untouched
});

test("assignTracks: overlapping intervals get distinct levels, disjoint share", () => {
  const items = [
    { id: "a", xL: 0, xR: 100, pill: false },
    { id: "b", xL: 50, xR: 150, pill: false },
    { id: "c", xL: 200, xR: 300, pill: false },
  ];
  const { levelOf } = assignTracks(items);
  assert.notEqual(levelOf.get("a"), levelOf.get("b"));
  // c is disjoint from at least one of them and may share that level
  assert.ok(levelOf.get("c") === levelOf.get("a") || levelOf.get("c") === levelOf.get("b"));
});

test("assignTracks: plain rows sit above pill rows (pills go to the bottom of the channel)", () => {
  const items = [
    { id: "plain", xL: 0, xR: 100, pill: false },
    { id: "pill", xL: 0, xR: 100, pill: true },
  ];
  const { levelOf, pillLevels, plainLevels } = assignTracks(items);
  assert.equal(pillLevels, 1);
  assert.equal(plainLevels, 1);
  assert.ok(levelOf.get("plain") < levelOf.get("pill"));
});

test("assignTracks: pills pack by caller order (descending span sinks short pills)", () => {
  const items = [
    { id: "short", xL: 0, xR: 40, pill: true, order: -40 },
    { id: "long", xL: 0, xR: 400, pill: true, order: -400 },
  ];
  const { levelOf } = assignTracks(items);
  assert.ok(levelOf.get("long") < levelOf.get("short"), "long span above, short span below");
});

test("corridors exist between and beside cards", () => {
  const cards = [{ x: 100, w: 200 }, { x: 400, w: 100 }];
  const cs = corridorsOf(cards);
  // left flank, middle gap, right flank
  assert.equal(cs.length, 3);
  const [l, m, r] = cs;
  assert.ok(l[1] <= 100 - 10 + 1e-9);
  assert.ok(m[0] >= 300 + 10 - 1e-9 && m[1] <= 400 - 10 + 1e-9);
  assert.ok(r[0] >= 500 + 10 - 1e-9);
});

test("pickCorridorX avoids taken positions", () => {
  const cs = [[0, 100]];
  const x1 = pickCorridorX(cs, 50, []);
  const x2 = pickCorridorX(cs, 50, [x1]);
  assert.ok(Math.abs(x1 - x2) >= 7 - 1e-9);
  assert.ok(x2 >= 0 && x2 <= 100);
});

test("pickCorridorX returns null when nothing fits", () => {
  const cs = [[0, 10]];
  const taken = [0, 7]; // corridor saturated at spacing 7
  const x = pickCorridorX(cs, 5, taken);
  assert.ok(x === null || (Math.abs(x - 0) >= 7 && Math.abs(x - 7) >= 7));
});

// ---------- packRows: group-aware multi-row lane wrapping ----------

test("packRows: a non-finite or non-positive budget is the 'unset' case — returns ids unchanged, one row", () => {
  const ids = ["a", "b", "c"];
  const widthOf = () => 100;
  for (const budget of [undefined, NaN, Infinity, -Infinity, 0, -50]) {
    const rows = packRows(ids, widthOf, 10, budget, (id) => id);
    assert.deepEqual(rows, [ids], `budget ${budget} must pass ids through as a single row`);
  }
});

test("packRows: never reorders or drops ids — concatenating every row reproduces the input exactly", () => {
  const widths = { f: 171, a: 173, b: 184, c: 173, d: 185, e: 172, h: 180, gg: 171, i: 174, j: 171 };
  const parent = { f: "p1", a: "p1", b: "p1", c: "p1", d: "p1", e: "p1", h: "p3", gg: "p2", i: "p2", j: "p2" };
  const ids = Object.keys(widths);
  const rows = packRows(ids, (id) => widths[id], 30, 770, (id) => parent[id]);
  assert.deepEqual(rows.flat(), ids, "row concatenation must equal the original order exactly");
});

test("packRows: a same-key contiguous run that fits the budget as a whole is never split across rows", () => {
  const widths = { x: 100, y: 100, z: 100 };
  const rows = packRows(["x", "y", "z"], (id) => widths[id], 10, 400, () => "g1");
  assert.deepEqual(rows, [["x", "y", "z"]], "the whole group (300 <= 400 budget) stays in one row");
});

test("packRows: a group whose own width exceeds the budget degrades to per-node next-fit for just its members", () => {
  // real torture-dense.md lane2 numbers: primary-parent group p1 has 6 members totalling 1208px
  // (6 widths + 5 gaps), which exceeds the 770px budget on its own — it must still place every
  // member (never drop one), splitting across rows only because it structurally has to.
  const widths = { f: 171, a: 173, b: 184, c: 173, d: 185, e: 172 };
  const ids = Object.keys(widths);
  const rows = packRows(ids, (id) => widths[id], 30, 770, () => "p1"); // one oversized group
  assert.deepEqual(rows.flat(), ids, "every member of the oversized group is still placed, in order");
  assert.ok(rows.length > 1, "an oversized single group must span more than one row");
  for (const row of rows) {
    const w = row.reduce((acc, id, i) => acc + widths[id] + (i > 0 ? 30 : 0), 0);
    // only a single leftover node (not the whole 1208px group) may exceed budget alone, per the
    // caller's unavoidable-content exception — never true here, since every individual width
    // (171-185px) is well under the 770px budget.
    assert.ok(w <= 770 + 1e-6 || row.length === 1, `row [${row}] (${w}px) neither fits nor is a lone unavoidable node`);
  }
});

test("packRows: a single node wider than the budget is placed alone in its own row, unsplit", () => {
  const widths = { small: 50, big: 500 };
  const rows = packRows(["small", "big"], (id) => widths[id], 10, 200, (id) => id);
  assert.deepEqual(rows, [["small"], ["big"]], "the 500px node gets its own row despite exceeding the 200px budget");
});

test("packRows: without a groupKeyOf, every id is its own singleton unit (no merging across different ids)", () => {
  const rows = packRows(["p", "q", "r"], () => 60, 10, 125, undefined);
  assert.deepEqual(rows, [["p"], ["q"], ["r"]], "each 60px node forms its own row once two no longer fit (60+10+60=130 > 125)");
});

test("packRows: the rebalance sweep fires on a constructed sparse-last-row input, relieving it above 50% fill", () => {
  // 4 singleton units (100,100,100,100) plus one small trailing unit (30) at budget 220: naive
  // next-fit alone would leave a lone 30px trailing row (30/220 = 13.6% fill); the bounded sweep
  // must pull the previous row's trailing unit forward to relieve it.
  const widths = { u1: 100, u2: 100, u3: 100, u4: 100, u5: 30 };
  const ids = Object.keys(widths);
  const rows = packRows(ids, (id) => widths[id], 10, 220, (id) => id);
  assert.deepEqual(rows.flat(), ids, "order and membership preserved");
  const fills = rows.map((r) => r.reduce((a, id, i) => a + widths[id] + (i > 0 ? 10 : 0), 0) / 220);
  const last = fills[fills.length - 1];
  assert.ok(last >= 0.5, `expected the rebalanced last row to reach >=50% fill, got ${(last * 100).toFixed(1)}%`);
  // the naive (non-rebalanced) shape would have been a lone trailing [u5]; the sweep must have
  // actually moved something into the last row, not merely happened to already satisfy 50%.
  assert.ok(rows[rows.length - 1].length > 1, "the last row must have gained a unit from its neighbor");
});

test("packRows: the rebalance sweep does not fire when no move exists — a lone-unit donor row is never emptied", () => {
  // two 300px units each fill their own row alone (nothing else fits beside them at budget 310),
  // then a 40px trailing unit is sparse on its own (40/310 = 12.9%); the immediately preceding
  // donor row holds exactly one unit, so moving it would empty that row entirely — disallowed.
  const widths = { a: 300, b: 300, c: 40 };
  const ids = Object.keys(widths);
  const rows = packRows(ids, (id) => widths[id], 10, 310, (id) => id);
  assert.deepEqual(rows, [["a"], ["b"], ["c"]], "no rebalance move is possible, so the sparse trailing row is left as-is");
});
