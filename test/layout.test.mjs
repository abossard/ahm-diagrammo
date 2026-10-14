// Unit tests for the pure layout algorithms.
import { test } from "node:test";
import assert from "node:assert/strict";
import { projectPositions, assignTracks, corridorsOf, pickCorridorX } from "../src/layout.mjs";

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
