import { test } from "node:test";
import assert from "node:assert/strict";
import { renderAhm } from "../src/ahm-render.mjs";
import { AHM_DIRECTIONS } from "./helpers/ahm-fixtures.mjs";

const SIMPLE = [
  "flowchart TB",
  'child["Child service"]',
  'parent["Parent service"]',
  'sig["Latency = 250 ms (degraded)"]:::blue',
  "sig --> child",
  "child --> parent",
  "class child amber;",
  "class parent green;",
].join("\n");

function nodePosition(svg, id) {
  const match = svg.match(new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[^>]*transform="translate\\(([^,]+),([^\\)]+)\\)"`));
  if (!match) return null;
  return { x: Number(match[1]), y: Number(match[2]) };
}

for (const direction of AHM_DIRECTIONS) {
  for (const lanes of [true, false]) {
    test(`renderAhm keeps child->parent direction=${direction} lanes=${lanes}`, () => {
      const result = renderAhm(SIMPLE, { direction, lanes, idPrefix: `layout-${direction}-${lanes}` });
      const child = nodePosition(result.svg, "child");
      const parent = nodePosition(result.svg, "parent");
      assert.ok(child && parent, `missing child/parent for ${direction}, lanes=${lanes}`);
      if (direction === "TB" || direction === "TD") assert.ok(child.y < parent.y, `${direction} expected child above parent`);
      if (direction === "BT") assert.ok(child.y > parent.y, `${direction} expected child below parent`);
      if (direction === "LR") assert.ok(child.x < parent.x, `${direction} expected child left of parent`);
      if (direction === "RL") assert.ok(child.x > parent.x, `${direction} expected child right of parent`);
    });
  }
}

test("renderAhm resists Pele autoDirection flips for BT in a wide graph", () => {
  const wide = [
    "flowchart BT",
    'child["Child service with intentionally very wide text that can encourage horizontal automatic routing"]',
    'parent["Parent"]',
    'sig["Orders per minute = 12345 (healthy)"]:::blue',
    "sig --> child",
    "child --> parent",
    "class child green;",
    "class parent amber;",
  ].join("\n");
  const lanesOn = renderAhm(wide, { direction: "BT", lanes: true, idPrefix: "trap-bt-lanes-on" });
  const lanesOff = renderAhm(wide, { direction: "BT", lanes: false, idPrefix: "trap-bt-lanes-off" });
  const childOn = nodePosition(lanesOn.svg, "child");
  const parentOn = nodePosition(lanesOn.svg, "parent");
  const childOff = nodePosition(lanesOff.svg, "child");
  const parentOff = nodePosition(lanesOff.svg, "parent");
  assert.ok(childOn && parentOn && childOff && parentOff, "missing trap nodes");
  assert.ok(childOn.y > parentOn.y, "BT lanes-on should keep child below parent");
  assert.ok(childOff.y > parentOff.y, "BT lanes-off should keep child below parent");
});
