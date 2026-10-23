import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { renderAhm } from "../src/ahm-render.mjs";
import { parseAhmSource } from "../src/health-model.mjs";
import { alignPlanToReservationGrid, createAhmTextMeasurer, planEntityCard } from "../src/ahm-card-plan.mjs";
import { getAhmPalette } from "../src/ahm-tokens.mjs";
import { resolveNativeFontConfig } from "./helpers/ahm-native-fonts.mjs";
import { parseNodeRects } from "./helpers/ahm-svg.mjs";

const SOURCE = [
  "flowchart LR",
  'subgraph laneIngress["Ingress"]',
  'api["API gateway (degraded)"]',
  'worker["Worker queue (healthy)"]',
  "end",
  'subgraph laneData["Data"]',
  'db["Primary DB (unhealthy)"]',
  "end",
  'shared["Shared signal = 42 (healthy)"]:::blue',
  'latency["Latency = 2350 ms (degraded)"]:::blue',
  'errors["Errors = 7.25% (unhealthy)"]:::blue',
  'missing["No reading"]:::blue',
  'empty["Probe =  (unknown)"]:::blue',
  'zero["Requests = 0 (healthy)"]:::blue',
  "shared --> api",
  "shared --> worker",
  "latency --> api",
  "errors --> db",
  "missing --> db",
  "empty --> worker",
  "zero --> db",
  "api -->|depends| db",
  "worker -.->|fallback| db",
  "class api amber;",
  "class worker green;",
  "class db red;",
].join("\n");

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "ahm");
const readFixture = (name) => readFileSync(join(FIXTURES, name), "utf8");
const PATH_TOKEN_RE = /([AaCcHhLlMmQqSsTtVvZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;

const SIMPLE = [
  "flowchart TB",
  'child["Child"]',
  'parent["Parent"]',
  'sig["Health = good (healthy)"]:::blue',
  "sig --> child",
  "child --> parent",
  "class child green;",
  "class parent amber;",
].join("\n");

const NESTED_SOURCE = [
  "flowchart TB",
  'subgraph platform["Platform"]',
  'subgraph payments["Payments"]',
  'api["API"]',
  'worker["Worker"]',
  'subgraph ledger["Ledger"]',
  'db["Primary DB"]',
  "end",
  "end",
  'infra["Infra"]',
  "end",
  'shared["Latency = 120 (degraded)"]:::blue',
  "shared --> api",
  "shared --> infra",
  "payments --> infra",
  "infra --> payments",
  "ledger --> payments",
  "payments --> payments",
  "api --> worker",
  "worker --> db",
  "infra --> api",
  "infra --> worker",
  "class api healthy;",
  "class worker degraded;",
  "class db unhealthy;",
  "class infra standby;",
].join("\n");
const NESTED_SOURCE_ANCESTOR_STRESS = NESTED_SOURCE.replace("\npayments --> payments", "");
const NESTED_SOURCE_SUPPORTED = NESTED_SOURCE_ANCESTOR_STRESS.replace("\nledger --> payments", "");

function nodePosition(svg, id) {
  const re = new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[^>]*transform="translate\\(([^,]+),([^\\)]+)\\)"`);
  const m = svg.match(re);
  if (!m) return null;
  return { x: Number(m[1]), y: Number(m[2]) };
}

function parseViewBox(svg) {
  const match = svg.match(/viewBox="([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)"/);
  if (!match) return null;
  return { minX: Number(match[1]), minY: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
}

function edgeStrokeColors(svg) {
  return [...svg.matchAll(/<g class="pele-edge"[^>]*style="[^"]*stroke:([^;"\s]+)[^"]*"/g)].map((m) => m[1]);
}

function edgeMarkerColors(svg) {
  return [...svg.matchAll(/<path class="pele-marker"[^>]*fill="([^"]+)"/g)].map((m) => m[1]);
}

function edgePathById(svg, edgeId) {
  return svg.match(new RegExp(`<g class="pele-edge"[^>]*data-id="${edgeId}"[^>]*>[\\s\\S]*?<path d="([^"]+)"`))?.[1] ?? null;
}

function extractRoundedCornerRadii(svg) {
  const radii = [];
  for (const pathMatch of svg.matchAll(/<g class="pele-edge"[\s\S]*?<path d="([^"]+)"/g)) {
    const path = pathMatch[1];
    const tokens = [...path.matchAll(PATH_TOKEN_RE)].map((match) => match[1] ?? Number(match[2]));
    let i = 0;
    let command = null;
    let current = { x: 0, y: 0 };
    while (i < tokens.length) {
      if (typeof tokens[i] === "string") {
        command = tokens[i];
        i += 1;
      } else if (!command) {
        throw new Error("path parser expected command token");
      }
      const relative = command === command.toLowerCase();
      const op = command.toUpperCase();
      if (op === "M" || op === "L") {
        while (i < tokens.length && typeof tokens[i] !== "string") {
          const x = Number(tokens[i++]);
          const y = Number(tokens[i++]);
          current = relative ? { x: current.x + x, y: current.y + y } : { x, y };
          if (op === "M") command = relative ? "l" : "L";
        }
        continue;
      }
      if (op === "H") {
        while (i < tokens.length && typeof tokens[i] !== "string") {
          const x = Number(tokens[i++]);
          current = relative ? { x: current.x + x, y: current.y } : { x, y: current.y };
        }
        continue;
      }
      if (op === "V") {
        while (i < tokens.length && typeof tokens[i] !== "string") {
          const y = Number(tokens[i++]);
          current = relative ? { x: current.x, y: current.y + y } : { x: current.x, y };
        }
        continue;
      }
      if (op === "C") {
        while (i < tokens.length && typeof tokens[i] !== "string") {
          const c1x = Number(tokens[i++]);
          const c1y = Number(tokens[i++]);
          const c2x = Number(tokens[i++]);
          const c2y = Number(tokens[i++]);
          const ex = Number(tokens[i++]);
          const ey = Number(tokens[i++]);
          const start = current;
          const c1 = relative ? { x: current.x + c1x, y: current.y + c1y } : { x: c1x, y: c1y };
          const c2 = relative ? { x: current.x + c2x, y: current.y + c2y } : { x: c2x, y: c2y };
          const end = relative ? { x: current.x + ex, y: current.y + ey } : { x: ex, y: ey };
          current = end;
          const verticalIn = Math.abs(start.x - c1.x) <= 0.3;
          const horizontalIn = Math.abs(start.y - c1.y) <= 0.3;
          const verticalOut = Math.abs(end.x - c2.x) <= 0.3;
          const horizontalOut = Math.abs(end.y - c2.y) <= 0.3;
          if (!((verticalIn && horizontalOut) || (horizontalIn && verticalOut))) continue;
          const radiusIn = Math.hypot(c1.x - start.x, c1.y - start.y);
          const radiusOut = Math.hypot(end.x - c2.x, end.y - c2.y);
          radii.push(Math.min(radiusIn, radiusOut));
        }
        continue;
      }
      if (op === "Q") {
        while (i < tokens.length && typeof tokens[i] !== "string") i += 4;
        continue;
      }
      if (op === "Z") continue;
      throw new Error(`unsupported path command ${command}`);
    }
  }
  return radii;
}

function nodeRectStyle(svg, id) {
  const re = new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[\\s\\S]*?<rect[^>]*style="([^"]+)"`);
  const match = svg.match(re);
  return match?.[1] ?? "";
}

function nodeRectWidth(svg, id) {
  const re = new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[\\s\\S]*?<rect[^>]*width="([^"]+)"`);
  const match = svg.match(re);
  return match ? Number(match[1]) : NaN;
}

function nodeRectHeight(svg, id) {
  const re = new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[\\s\\S]*?<rect[^>]*height="([^"]+)"`);
  const match = svg.match(re);
  return match ? Number(match[1]) : NaN;
}

function parseClusterRects(svg) {
  const clusters = new Map();
  for (const clusterMatch of svg.matchAll(/<g class="pele-cluster[^"]*" data-id="([^"]+)">([\s\S]*?)<\/g>/g)) {
    const id = clusterMatch[1];
    const body = clusterMatch[2];
    const rect = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    if (!rect) continue;
    clusters.set(id, {
      minX: Number(rect[1]),
      minY: Number(rect[2]),
      maxX: Number(rect[1]) + Number(rect[3]),
      maxY: Number(rect[2]) + Number(rect[4]),
    });
  }
  return clusters;
}

function parseNodeBounds(svg, id) {
  const match = svg.match(new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[^>]*transform="translate\\(([^,]+),([^)]+)\\)"[^>]*>([\\s\\S]*?)<\\/g>`));
  if (!match) return null;
  const tx = Number(match[1]);
  const ty = Number(match[2]);
  const rect = match[3].match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  if (!rect) return null;
  const x = tx + Number(rect[1]);
  const y = ty + Number(rect[2]);
  const w = Number(rect[3]);
  const h = Number(rect[4]);
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

function parseTableOutlineBounds(svg, id) {
  const match = svg.match(new RegExp(`<g class="pele-node[^"]*" data-id="${id}"[^>]*transform="translate\\(([^,]+),([^)]+)\\)"[^>]*>[\\s\\S]*?class="ahm-signal-table-outline" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`));
  if (!match) return null;
  const tx = Number(match[1]);
  const ty = Number(match[2]);
  const x = tx + Number(match[3]);
  const y = ty + Number(match[4]);
  const w = Number(match[5]);
  const h = Number(match[6]);
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

function containsRect(outer, inner, pad = 1) {
  return inner.minX >= outer.minX - pad
    && inner.maxX <= outer.maxX + pad
    && inner.minY >= outer.minY - pad
    && inner.maxY <= outer.maxY + pad;
}

function parseOverlayRect(svg, id) {
  const match = svg.match(new RegExp(`<g class="ahm-cluster-header-overlay" data-id="${id}">([\\s\\S]*?)<\\/g>`));
  if (!match) return null;
  const rect = match[1].match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  if (!rect) return null;
  const x = Number(rect[1]);
  const y = Number(rect[2]);
  const w = Number(rect[3]);
  const h = Number(rect[4]);
  return { minX: x, minY: y, maxX: x + w, maxY: y + h };
}

function parseOverlayText(svg, id) {
  const match = svg.match(new RegExp(`<g class="ahm-cluster-header-overlay" data-id="${id}">([\\s\\S]*?)<\\/g>`));
  if (!match) return null;
  const textMatch = match[1].match(/<text class="pele-cluster-label"([^>]*)>([\s\S]*?)<\/text>/);
  if (!textMatch) return null;
  const attrs = textMatch[1];
  const anchor = attrs.match(/text-anchor="([^"]+)"/)?.[1] ?? "middle";
  const firstTspanX = Number(textMatch[2].match(/<tspan x="([^"]+)"/)?.[1] ?? NaN);
  return { anchor, firstTspanX };
}

function extractIds(svg) {
  return new Set([...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

function assertNodeGeometryContained(svg) {
  const vb = parseViewBox(svg);
  assert.ok(vb, "missing viewBox");
  const maxX = vb.minX + vb.width;
  const maxY = vb.minY + vb.height;
  for (const nodeMatch of svg.matchAll(/<g class="pele-node[^"]*" data-id="([^"]+)" transform="translate\(([^,]+),([^)]+)\)">([\s\S]*?)<\/g>/g)) {
    const tx = Number(nodeMatch[2]);
    const ty = Number(nodeMatch[3]);
    const body = nodeMatch[4];
    const rect = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    assert.ok(rect, `missing node rect for ${nodeMatch[1]}`);
    const rx = tx + Number(rect[1]);
    const ry = ty + Number(rect[2]);
    const rw = Number(rect[3]);
    const rh = Number(rect[4]);
    assert.ok(rx >= vb.minX - 1 && ry >= vb.minY - 1, `node ${nodeMatch[1]} starts outside viewBox`);
    assert.ok(rx + rw <= maxX + 1 && ry + rh <= maxY + 1, `node ${nodeMatch[1]} exceeds viewBox`);
    for (const tspan of body.matchAll(/<tspan[^>]* y="([^"]+)"/g)) {
      const y = ty + Number(tspan[1]);
      assert.ok(y >= ry - 1 && y <= ry + rh + 1, `text y for ${nodeMatch[1]} escaped node bounds`);
    }
  }
}

test("renderAhm returns self-contained SVG with semantically complete owner cards", () => {
  const result = renderAhm(SOURCE, { lanes: true, direction: "LR", idPrefix: "ahm-semantic" });
  const text = svgToText(result.svg);
  assert.match(result.svg, /^<svg[\s\S]*<\/svg>\s*$/);
  assert.ok(Number.isFinite(result.width) && result.width > 0);
  assert.ok(Number.isFinite(result.height) && result.height > 0);
  assert.doesNotMatch(result.svg, /var\(--/);
  assert.match(text, /Shared\s+signal/);
  assert.match(text, /\b42\b/);
  assert.match(text, /Latency/);
  assert.match(text, /2350\s+ms/);
  assert.match(text, /Errors/);
  assert.match(text, /7\.25%/);
  assert.match(text, /No\s+reading/);
  assert.match(text, /∅/);
  assert.match(text, /Probe/);
  assert.match(text, /\[empty\]/);
  assert.match(text, /Requests/);
  assert.match(text, /\b0\b/);
  assert.ok((text.match(/\bHealthy\b/g) ?? []).length >= 2);
  assert.ok((text.match(/\bDegraded\b/g) ?? []).length >= 1);
  assert.ok((text.match(/\bUnhealthy\b/g) ?? []).length >= 1);
  assert.ok((text.match(/\bUnknown\b/g) ?? []).length >= 2);
  assert.match(result.svg, /depends/);
  assert.match(result.svg, /fallback/);
  assert.match(result.svg, /#c26a00/);
  assert.match(result.svg, /#4c9a2a/);
  assert.match(result.svg, /class="ahm-signal-row row-state-healthy"/);
  assert.match(result.svg, /class="ahm-signal-row row-state-degraded"/);
  assert.match(result.svg, /class="ahm-signal-row row-state-unhealthy"/);
  assert.match(result.svg, /class="ahm-signal-row row-state-unknown"/);
  assert.match(result.svg, /class="pele-cluster-label" fill="#605e5c"/);
  assert.match(result.svg, /class="pele-edge-label"[\s\S]*fill="#ffffff"/);
  assert.doesNotMatch(result.svg, /<foreignObject/i);
  assert.doesNotMatch(result.svg, /href=/i);
  assert.doesNotMatch(result.svg, /xlink:href=/i);
  assert.ok((text.match(/Shared\s+signal/g) ?? []).length >= 2);
  assertNodeGeometryContained(result.svg);
});

const ORIENTATIONS = ["TB", "TD", "BT", "LR", "RL"];
for (const direction of ORIENTATIONS) {
  test(`renderAhm preserves requested orientation ${direction}`, () => {
    const withLanes = renderAhm(SIMPLE, { direction, lanes: true, idPrefix: `with-lanes-${direction}` });
    const withoutLanes = renderAhm(SIMPLE, { direction, lanes: false, idPrefix: `without-lanes-${direction}` });
    const child = nodePosition(withoutLanes.svg, "child");
    const parent = nodePosition(withoutLanes.svg, "parent");
    const childWithLanes = nodePosition(withLanes.svg, "child");
    const parentWithLanes = nodePosition(withLanes.svg, "parent");
    assert.ok(child && parent, `missing node transforms for ${direction}`);
    assert.ok(childWithLanes && parentWithLanes, `missing lane-on node transforms for ${direction}`);
    assert.ok(withLanes.width > 0 && withLanes.height > 0);
    assert.ok(withoutLanes.width > 0 && withoutLanes.height > 0);
    assert.match(withLanes.svg, /class="pele pele-flowchart ahm-root"/);
    assert.doesNotMatch(withLanes.svg, /class="pele pele-swimlane/);
    assert.match(withLanes.svg, /<g class="pele-cluster" data-id="lane_0">/);
    assert.doesNotMatch(withoutLanes.svg, /data-id="lane_0"/);
    if (direction === "TB" || direction === "TD") assert.ok(child.y < parent.y, `expected child above parent for ${direction}`);
    if (direction === "BT") assert.ok(child.y > parent.y, `expected child below parent for ${direction}`);
    if (direction === "LR") assert.ok(child.x < parent.x, "expected child left of parent for LR");
    if (direction === "RL") assert.ok(child.x > parent.x, "expected child right of parent for RL");
    if (direction === "TB" || direction === "TD") assert.ok(childWithLanes.y < parentWithLanes.y, `expected lane-on child above parent for ${direction}`);
    if (direction === "BT") assert.ok(childWithLanes.y > parentWithLanes.y, "expected lane-on child below parent for BT");
    if (direction === "LR") assert.ok(childWithLanes.x < parentWithLanes.x, "expected lane-on child left of parent for LR");
    if (direction === "RL") assert.ok(childWithLanes.x > parentWithLanes.x, "expected lane-on child right of parent for RL");
    assertNodeGeometryContained(withLanes.svg);
    assertNodeGeometryContained(withoutLanes.svg);
  });
}

test("renderAhm updates primary-rollup cubic route in pills stress variants", () => {
  const source = readFixture("pills-stress-main.mmd");
  const laneSpecs = [
    {
      lanes: true,
      key: "lanes-on",
      expectedChangedEdge: "L_shared_root_0",
      expectedLegacyPath: null,
      trackedEdgePathId: "L_mid_root_0",
    },
    {
      lanes: false,
      key: "lanes-off",
      expectedChangedEdge: "L_mid_root_0",
      expectedLegacyPath: "M1828,258.5L1828,120.5C1828,105.38 3263.17,75.13 3263.17,60L3263.17,54",
      trackedEdgePathId: "L_mid_root_0",
    },
  ];
  for (const { lanes, key, expectedChangedEdge, expectedLegacyPath, trackedEdgePathId } of laneSpecs) {
    const result = renderAhm(source, {
      direction: "BT",
      lanes,
      legend: false,
      theme: "portal",
      idPrefix: `pills-route-${key}`,
    });
    const edgePath = edgePathById(result.svg, trackedEdgePathId);
    assert.ok(edgePath, `missing ${trackedEdgePathId} for ${key}`);
    if (expectedLegacyPath) {
      assert.notEqual(edgePath, expectedLegacyPath, `expected ${key} tracked route to change from legacy path`);
    }
    assert.ok(
      !result.diagnostics.some((entry) => typeof entry === "string" && entry.includes(`[${expectedChangedEdge}]`)),
      `expected no route fallback diagnostic for ${expectedChangedEdge} in ${key}`
    );
  }
});

test("renderAhm can be rasterized natively with explicit pinned fonts", () => {
  const fontConfig = resolveNativeFontConfig();
  const result = renderAhm(readFixture("text-extremes.mmd"), {
    lanes: true,
    direction: "LR",
    idPrefix: "ahm-raster",
  });

  test("renderAhm relaxes right-angle connector corners without changing route endpoints", () => {
    const source = readFixture("hero-main.mmd");
    const result = renderAhm(source, { direction: "BT", lanes: true, legend: false, idPrefix: "relaxed-corners" });
    const radii = extractRoundedCornerRadii(result.svg);
    assert.ok(radii.length > 0, "expected rounded corners in edge paths");
    assert.ok(Math.max(...radii) >= 18, `expected at least one relaxed corner radius >= 18, got max=${Math.max(...radii).toFixed(2)}`);
  });
  const resvg = new Resvg(result.svg, {
    font: {
      fontFiles: fontConfig.files,
      loadSystemFonts: false,
      defaultFontFamily: fontConfig.family,
    },
  });
  const rendered = resvg.render();
  const png = rendered.asPng();
  const pixels = rendered.pixels;
  assert.ok(png.length > 0);
  assert.ok(pixels.length === rendered.width * rendered.height * 4, "unexpected pixel buffer size");
  const ink = findInkBounds(pixels, rendered.width, rendered.height);
  assert.ok(ink.width >= 12, `ink width ${ink.width} below minimum visual cue`);
  assert.ok(ink.height >= 12, `ink height ${ink.height} below minimum visual cue`);
  assert.ok(ink.coveredPixels > 2000, "expected non-trivial rendered ink");
  assert.match(result.svg, /🚀/, "expected emoji specimen in SVG for glyph coverage proof");
  assert.match(result.svg, /日本語サービス/, "expected CJK specimen in SVG for glyph coverage proof");
});

test("renderAhm keeps native text ink and unclipped geometry across representative font sizes", () => {
  const fontConfig = resolveNativeFontConfig();
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    'db["Primary DB (degraded)"]',
    'sigA["Availability = 99.95% (healthy)"]:::blue',
    'sigB["Latency p99 = 2350ms (degraded)"]:::blue',
    'sigC["Unicode = 日本語サービス🚀 (healthy)"]:::blue',
    "sigA --> svc",
    "sigB --> svc",
    "sigC --> db",
    'svc -->|"depends on"| db',
    "class svc green;",
    "class db amber;",
  ].join("\n");
  const families = [undefined, fontConfig.family];
  for (const fontSize of [16, 24, 40]) {
    for (const family of families) {
      const result = renderAhm(source, {
        legend: true,
        direction: "LR",
        fontSize,
        ...(family ? { fontFamily: family } : {}),
      });
      assertNodeGeometryContained(result.svg);
      const rendered = new Resvg(result.svg, {
        font: {
          fontFiles: fontConfig.files,
          loadSystemFonts: false,
          defaultFontFamily: fontConfig.family,
        },
      }).render();
      const ink = findInkBounds(rendered.pixels, rendered.width, rendered.height);
      assert.ok(ink.width >= 12, `ink width ${ink.width} too small for fontSize ${fontSize}`);
      assert.ok(ink.height >= 12, `ink height ${ink.height} too small for fontSize ${fontSize}`);
      assert.ok(ink.coveredPixels > 2000, `ink coverage ${ink.coveredPixels} too small for fontSize ${fontSize}`);
    }
  }
});

test("renderAhm keeps no-signal header text clear of top-right badge across scaled fonts and states", () => {
  const fontConfig = resolveNativeFontConfig(process.env);
  const measurer = createAhmTextMeasurer();
  const stateClass = {
    healthy: "green",
    degraded: "amber",
    unhealthy: "red",
    unknown: "gray",
    standby: "standby",
  };
  const fontSizes = [16, 20, 24, 40];
  const states = ["healthy", "degraded", "unhealthy", "unknown", "standby"];
  for (const fontSize of fontSizes) {
    for (const state of states) {
      const title = "Long no-signal order hub title for badge separation";
      const qualifier = "Qualifier line for wrapped header proof";
      const source = [
        "flowchart BT",
        `a["${title}<br/>${qualifier}<br/>${state}"]`,
        'b["B<br/>healthy"]',
        "a --> b",
        `class a ${stateClass[state]};`,
        "class b green;",
      ].join("\n");
      const result = renderAhm(source, { fontSize, legend: false, idPrefix: `nosignal-${state}-${fontSize}` });
      const model = parseAhmSource(source);
      const entity = model.entities.find((item) => item.id === "a");
      assert.ok(entity, "missing no-signal entity for planning proof");
      const plan = planEntityCard(entity, measurer, { fontSize });
      const requiredLeft = Math.max(
        1,
        Math.ceil(measurer.width(entity.presentation?.title ?? entity.label ?? "", plan.constants.titleSize, { fontWeight: 700 }) + 8),
        Math.ceil(measurer.width(entity.presentation?.qualifier ?? "", plan.constants.qualifierSize, { fontWeight: 500 }) + 8),
      );
      assert.ok(
        plan.contentWidth >= plan.badgeWidth + plan.constants.badgeGapX + requiredLeft,
        `content width budget regression at fontSize=${fontSize}, state=${state}: content=${plan.contentWidth}, badge=${plan.badgeWidth}, gap=${plan.constants.badgeGapX}, left=${requiredLeft}`
      );

      const node = parseNodeRects(result.svg).find((item) => item.id === "a");
      assert.ok(node, "missing no-signal node");
      const nodeRect = node.body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
      const badge = node.body.match(/<rect class="ahm-entity-status-badge[^"]*" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
      const titleMarkup = node.body.match(/<text class="ahm-entity-title"[\s\S]*?<\/text>/)?.[0] ?? "";
      const qualifierMarkup = node.body.match(/<text class="ahm-entity-qualifier"[\s\S]*?<\/text>/)?.[0] ?? "";
      assert.ok(nodeRect && badge && titleMarkup, "missing node geometry or header text");
      const headerMarkup = `${titleMarkup}${qualifierMarkup}`;
      const box = {
        minX: Number(nodeRect[1]),
        minY: Number(nodeRect[2]),
        width: Number(nodeRect[3]),
        height: Number(nodeRect[4]),
      };
      const ink = rasterInkBounds({
        width: Math.ceil(box.width),
        height: Math.ceil(box.height),
        viewBox: box,
        markup: headerMarkup,
        fontConfig,
      });
      assert.ok(ink, `missing header ink for fontSize=${fontSize}, state=${state}`);
      const badgeX = Number(badge[1]);
      const badgeXInBox = badgeX - box.minX;
      assert.ok(
        ink.maxX <= badgeXInBox - 1,
        `native header ink overlaps badge at fontSize=${fontSize}, state=${state}: inkMaxX=${ink.maxX}, badgeXInBox=${badgeXInBox}`
      );
    }
  }
});

test("renderAhm keeps title, header labels, and badge text vertically balanced across real native font sets", () => {
  const fontConfigs = [resolveNativeFontConfig(process.env)];
  const source = [
    "flowchart LR",
    'ship["Shipping service (healthy)"]',
    'hub["Order hub<br/>healthy"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    "sigH --> ship",
    "ship --> hub",
    "class ship green;",
    "class hub green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "native-balance-proof" });

  const nodes = parseNodeRects(result.svg);
  const shipNode = nodes.find((node) => node.id === "ship");
  const hubNode = nodes.find((node) => node.id === "hub");
  assert.ok(shipNode && hubNode, "missing ship/hub node groups");

  const shipHeader = shipNode.body.match(/<g class="ahm-signal-table-header">([\s\S]*?)<\/g>/)?.[1] ?? "";
  assert.ok(shipHeader, "missing ship table header");
  const signalLabel = shipHeader.match(/<text[^>]*>Signal<\/text>/)?.[0] ?? null;
  const signalHeaderRect = shipHeader.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  assert.ok(signalLabel && signalHeaderRect, "missing Signal header label/box");

  const hubTitle = hubNode.body.match(/<text class="ahm-entity-title"[\s\S]*?<\/text>/)?.[0] ?? null;
  const hubBadgeRect = hubNode.body.match(/<rect class="ahm-entity-status-badge[^"]*" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  const hubBadgeText = hubNode.body.match(/<text class="ahm-entity-status-text[^"]*"[\s\S]*?<\/text>/)?.[0] ?? null;
  assert.ok(hubTitle && hubBadgeRect && hubBadgeText, "missing hub title or badge");
  const hubBadgeBox = {
    x: Number(hubBadgeRect[1]),
    y: Number(hubBadgeRect[2]),
    w: Number(hubBadgeRect[3]),
    h: Number(hubBadgeRect[4]),
  };

  for (const fontConfig of fontConfigs) {
    const titleMargins = measureInkMarginsInBox({
      markup: hubTitle,
      box: { x: Number(signalHeaderRect[1]), y: hubBadgeBox.y, w: Number(signalHeaderRect[3]), h: hubBadgeBox.h },
      fontConfig,
    });
    const badgeMargins = measureInkMarginsInBox({
      markup: hubBadgeText,
      box: hubBadgeBox,
      fontConfig,
    });
    const headerMargins = measureInkMarginsInBox({
      markup: signalLabel,
      box: {
        x: Number(signalHeaderRect[1]),
        y: Number(signalHeaderRect[2]),
        w: Number(signalHeaderRect[3]),
        h: Number(signalHeaderRect[4]),
      },
      fontConfig,
    });

    assert.ok(titleMargins, `missing title ink for ${fontConfig.family}`);
    assert.ok(badgeMargins, `missing badge ink for ${fontConfig.family}`);
    assert.ok(headerMargins, `missing header ink for ${fontConfig.family}`);
    assert.ok(Math.abs(titleMargins.topMargin - titleMargins.bottomMargin) <= 2, `title not balanced for ${fontConfig.family}: top=${titleMargins.topMargin}, bottom=${titleMargins.bottomMargin}`);
    assert.ok(Math.abs(badgeMargins.topMargin - badgeMargins.bottomMargin) <= 5, `badge text not balanced for ${fontConfig.family}: top=${badgeMargins.topMargin}, bottom=${badgeMargins.bottomMargin}`);
    assert.ok(Math.abs(headerMargins.topMargin - headerMargins.bottomMargin) <= 2, `header label not balanced for ${fontConfig.family}: top=${headerMargins.topMargin}, bottom=${headerMargins.bottomMargin}`);
  }
});

test("renderAhm adds legend row by default and preserves graph dimensions when legend is off", () => {
  const on = renderAhm(SIMPLE, { direction: "LR", idPrefix: "legend-on" });
  const off = renderAhm(SIMPLE, { direction: "LR", idPrefix: "legend-off", legend: false });
  assert.match(on.svg, />Legend</);
  assert.doesNotMatch(off.svg, />Legend</);
  assert.ok(on.height > off.height, `expected legend-on height > legend-off (${on.height} <= ${off.height})`);
  assert.ok(on.width >= off.width);
});

test("renderAhm nested option projects canonical source to expanded/collapsed/detail with trace", () => {
  const nested = {
    models: {
      payments: { state: "degraded", detailRef: "diagram://payments" },
      ledger: { state: "unhealthy", detailRef: "diagram://ledger" },
    },
    view: { mode: "expanded" },
  };
  const expanded = renderAhm(NESTED_SOURCE_SUPPORTED, { direction: "TB", legend: false, nested, idPrefix: "nested-expanded" });
  const collapsed = renderAhm(NESTED_SOURCE_SUPPORTED, {
    direction: "TB",
    legend: false,
    nested: { ...nested, view: { mode: "collapsed" } },
    idPrefix: "nested-collapsed",
  });
  const detail = renderAhm(NESTED_SOURCE_SUPPORTED, {
    direction: "TB",
    legend: false,
    nested: { ...nested, view: { mode: "detail", detailFocus: "payments" } },
    idPrefix: "nested-detail",
  });

  for (const result of [expanded, collapsed, detail]) {
    assert.ok(result.trace, "nested render should return trace");
    assert.ok(Array.isArray(result.trace.models), "trace.models should be present");
    assert.ok(Array.isArray(result.trace.relationships), "trace.relationships should be present");
    assert.ok(Array.isArray(result.trace.signalOwners), "trace.signalOwners should be present");
    assert.doesNotMatch(result.svg, /<g class="ahm-legend"/, "legend:false must remain respected");
  }
  const expandedText = svgToText(expanded.svg);
  assert.match(expandedText, /Payments/, "expanded should preserve model group identity");
  assert.match(expandedText, /diagram:\/\/payments/, "expanded should preserve model detailRef");
  assert.match(collapsed.svg, /diagram:\/\/payments/, "collapsed should show detailRef on model card");
  assert.ok(
    detail.trace.relationships.some((item) => item.kind === "outside-focus"),
    "detail trace should mark external relationships"
  );
  assert.ok(
    collapsed.trace.relationships.some((item) => item.kind === "detail-only"),
    "collapsed trace should retain internal relationships as detail-only"
  );
});

test("renderAhm detail mode renders each registered model as a visible focus root", () => {
  const models = {
    payments: { state: "degraded", detailRef: "diagram://payments-detail" },
    ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
  };
  const expectedEntityByFocus = new Map([
    ["payments", ["api", "worker", "db"]],
    ["ledger", ["db"]],
  ]);
  for (const [detailFocus, expectedEntities] of expectedEntityByFocus.entries()) {
    const result = renderAhm(NESTED_SOURCE_SUPPORTED, {
      direction: "TB",
      lanes: true,
      legend: false,
      idPrefix: `nested-focus-${detailFocus}`,
      nested: { models, view: { mode: "detail", detailFocus } },
    });
    assert.ok(Array.isArray(result.trace?.projectionDisplayed?.models), "trace projection models missing");
    assert.ok(result.trace.projectionDisplayed.models.includes(detailFocus), `focus model ${detailFocus} was not displayed`);
    for (const entityId of expectedEntities) {
      assert.match(result.svg, new RegExp(`data-id="${entityId}"`), `missing entity ${entityId} for focus ${detailFocus}`);
    }
    assert.ok(!/class="pele-nodes"><\/g>/.test(result.svg), `detail focus ${detailFocus} rendered no nodes`);
  }
});

test("renderAhm expanded nested view keeps member containment and excludes non-members", () => {
  const models = {
    payments: { state: "degraded", detailRef: "diagram://payments-detail" },
    ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
  };
  const expanded = renderAhm(NESTED_SOURCE_SUPPORTED, {
    direction: "TB",
    lanes: true,
    legend: false,
    idPrefix: "nested-containment",
    nested: { models, view: { mode: "expanded" } },
  });
  const clusters = parseClusterRects(expanded.svg);
  const platformCluster = clusters.get("lane_0");
  const paymentsCluster = clusters.get("payments");
  const ledgerCluster = clusters.get("ledger");
  assert.ok(platformCluster && paymentsCluster && ledgerCluster, "missing platform/payments/ledger clusters");

  const api = parseNodeBounds(expanded.svg, "api");
  const worker = parseNodeBounds(expanded.svg, "worker");
  const db = parseNodeBounds(expanded.svg, "db");
  const infra = parseNodeBounds(expanded.svg, "infra");
  assert.ok(api && worker && db && infra, "missing expanded member nodes");

  assert.ok(containsRect(platformCluster, paymentsCluster), "platform must contain payments cluster");
  assert.ok(containsRect(platformCluster, ledgerCluster), "platform must contain ledger cluster");
  assert.ok(containsRect(paymentsCluster, api), "payments must contain api");
  assert.ok(containsRect(paymentsCluster, worker), "payments must contain worker");
  assert.ok(containsRect(ledgerCluster, db), "ledger must contain db");
  assert.ok(containsRect(paymentsCluster, db), "ancestor payments must contain nested db");
  assert.ok(!containsRect(ledgerCluster, api), "ledger must not contain api");
  assert.ok(!containsRect(ledgerCluster, worker), "ledger must not contain worker");
  assert.ok(!containsRect(paymentsCluster, infra), "payments must not contain infra");
  assert.ok(!containsRect(ledgerCluster, infra), "ledger must not contain infra");

  const paymentsHeader = parseOverlayRect(expanded.svg, "payments");
  const ledgerHeader = parseOverlayRect(expanded.svg, "ledger");
  assert.ok(paymentsHeader && ledgerHeader, "missing model header overlays");
  assert.ok(containsRect(platformCluster, paymentsHeader), "payments header overlay must stay inside platform");
  assert.ok(containsRect(platformCluster, ledgerHeader), "ledger header overlay must stay inside platform");
});

test("renderAhm expanded headers include model name/state/identity and model edges target group boundaries", () => {
  const models = {
    payments: { state: "degraded", detailRef: "diagram://payments-detail" },
    ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
  };
  const expanded = renderAhm(NESTED_SOURCE_SUPPORTED, {
    direction: "TB",
    lanes: true,
    legend: false,
    idPrefix: "nested-header",
    nested: { models, view: { mode: "expanded" } },
  });
  const text = svgToText(expanded.svg);
  assert.match(text, /Payments/);
  assert.match(text, /Degraded/);
  assert.match(text, /payments/);
  assert.match(text, /diagram:\/\/payments-detail/);
  assert.match(text, /Ledger/);
  assert.match(text, /Unhealthy/);
  assert.match(text, /ledger/);
  assert.match(text, /diagram:\/\/ledger-detail/);
  assert.doesNotMatch(expanded.svg, /data-id="ahm_model_/);
  assert.match(expanded.svg, /class="ahm-cluster-header-overlays"/, "expanded headers should render readability overlays");
  assert.match(expanded.svg, /data-id="L_payments_infra_0"/, "model->entity edge should use group endpoint");
  assert.match(expanded.svg, /data-id="L_infra_payments_0"/, "cross-model edge should use group endpoints");
  assert.doesNotMatch(expanded.svg, /data-id="L_ledger_payments_0"/, "supported canonical source should not include ancestor-stress edge");
});

test("renderAhm nested header overlays stay anchored and contained across representative typography", () => {
  const models = {
    payments: { state: "degraded", detailRef: "diagram://payments-detail" },
    ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
  };
  const fontConfig = resolveNativeFontConfig(process.env);
  const families = [undefined, fontConfig.family];
  for (const fontSize of [16, 28]) {
    for (const fontFamily of families) {
      const expanded = renderAhm(NESTED_SOURCE_SUPPORTED, {
        direction: "TB",
        lanes: true,
        legend: false,
        fontSize,
        ...(fontFamily ? { fontFamily } : {}),
        idPrefix: `nested-overlay-${fontSize}-${fontFamily ? "pinned" : "default"}`,
        nested: { models, view: { mode: "expanded" } },
      });
      const clusters = parseClusterRects(expanded.svg);
      const platformCluster = clusters.get("lane_0");
      const paymentsCluster = clusters.get("payments");
      const ledgerCluster = clusters.get("ledger");
      const paymentsOverlay = parseOverlayRect(expanded.svg, "payments");
      const ledgerOverlay = parseOverlayRect(expanded.svg, "ledger");
      const paymentsOverlayText = parseOverlayText(expanded.svg, "payments");
      const ledgerOverlayText = parseOverlayText(expanded.svg, "ledger");

      assert.ok(platformCluster && paymentsCluster && ledgerCluster, "missing cluster geometry");
      assert.ok(paymentsOverlay && ledgerOverlay && paymentsOverlayText && ledgerOverlayText, "missing header overlay geometry/text");
      assert.ok(containsRect(paymentsCluster, paymentsOverlay), "payments overlay must stay inside payments cluster");
      assert.ok(containsRect(ledgerCluster, ledgerOverlay), "ledger overlay must stay inside ledger cluster");
      assert.ok(containsRect(platformCluster, paymentsOverlay), "payments overlay must stay inside platform cluster");
      assert.ok(containsRect(platformCluster, ledgerOverlay), "ledger overlay must stay inside platform cluster");

      if (paymentsOverlayText.anchor === "middle") {
        assert.ok(Math.abs(paymentsOverlayText.firstTspanX - ((paymentsOverlay.minX + paymentsOverlay.maxX) / 2)) <= 1.5, "payments overlay text anchor mismatch");
      }
      if (ledgerOverlayText.anchor === "middle") {
        assert.ok(Math.abs(ledgerOverlayText.firstTspanX - ((ledgerOverlay.minX + ledgerOverlay.maxX) / 2)) <= 1.5, "ledger overlay text anchor mismatch");
      }

      assert.ok(
        expanded.svg.indexOf('class="ahm-cluster-header-overlays"') > expanded.svg.indexOf('class="pele-edges"'),
        "header overlays must render above edge traffic"
      );
      const text = svgToText(expanded.svg);
      assert.match(text, /diagram:\/\/payments-detail/);
      assert.match(text, /diagram:\/\/ledger-detail/);
    }
  }
});

test("renderAhm collapsed nested view preserves top-level platform label and model card identity", () => {
  const models = {
    payments: { state: "degraded", detailRef: "diagram://payments-detail" },
    ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
  };
  const collapsed = renderAhm(NESTED_SOURCE_SUPPORTED, {
    direction: "TB",
    lanes: true,
    legend: false,
    idPrefix: "nested-collapsed-platform",
    nested: { models, view: { mode: "collapsed" } },
  });
  const text = svgToText(collapsed.svg);
  assert.match(text, /Platform/, "collapsed top-level lane label should remain visible");
  assert.match(collapsed.svg, /data-id="ahm_model_payments"/, "collapsed top-level model card is missing");
  assert.match(text, /Payments/);
  assert.match(text, /Degraded/);
  assert.match(text, /payments/);
  assert.match(text, /diagram:\/\/payments-detail/);
});

test("renderAhm preserves adversarial detailRef literals in expanded/detail headers without parse or static-safety failures", () => {
  const detailRef = 'a"<b>x</b>\n]]; end';
  const models = {
    payments: { state: "degraded", detailRef },
    ledger: { state: "unhealthy", detailRef: "ok" },
  };
  for (const view of [{ mode: "expanded" }, { mode: "detail", detailFocus: "payments" }]) {
    const result = renderAhm(NESTED_SOURCE_SUPPORTED, {
      direction: "TB",
      lanes: true,
      legend: false,
      nested: { models, view },
      idPrefix: `nested-adv-${view.mode}`,
    });
    assert.doesNotMatch(result.svg, /<script\b/i);
    assert.doesNotMatch(result.svg, /<foreignObject\b/i);
    assert.match(result.svg, /&lt;b&gt;x&lt;\/b&gt;/, "detailRef HTML must remain literal escaped text");
    assert.match(svgToText(result.svg), /a"<b>x<\/b>/, "detailRef quote/html text should remain visible");
    assert.match(svgToText(result.svg), /\]\]; end/, "detailRef with ]] should remain visible");
  }
});

test("renderAhm rejects model self-edge in expanded/detail with named unsupported diagnostic", () => {
  const nested = {
    models: {
      payments: { state: "degraded", detailRef: "diagram://payments-detail" },
      ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
    },
    view: { mode: "expanded" },
  };
  assert.throws(
    () => renderAhm(NESTED_SOURCE, { direction: "TB", legend: false, nested, idPrefix: "nested-self-edge-expanded" }),
    /unsupported-model-group-self-edge:payments:expanded/
  );
  assert.throws(
    () => renderAhm(NESTED_SOURCE, {
      direction: "TB",
      legend: false,
      nested: { ...nested, view: { mode: "detail", detailFocus: "payments" } },
      idPrefix: "nested-self-edge-detail",
    }),
    /unsupported-model-group-self-edge:payments:detail/
  );
  const collapsed = renderAhm(NESTED_SOURCE, {
    direction: "TB",
    legend: false,
    nested: { ...nested, view: { mode: "collapsed" } },
    idPrefix: "nested-self-edge-collapsed",
  });
  assert.ok(
    collapsed.trace.relationships.some((item) => item.authored.from === "payments" && item.authored.to === "payments" && item.kind === "rendered"),
    "collapsed should keep authored model self-edge rendered"
  );
});

test("renderAhm keeps self-edge outside-focus in detail mode when detailFocus excludes the self-edge model", () => {
  const nested = {
    models: {
      payments: { state: "degraded", detailRef: "diagram://payments-detail" },
      ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
    },
    view: { mode: "detail", detailFocus: "ledger" },
  };
  const result = renderAhm(NESTED_SOURCE, {
    direction: "TB",
    legend: false,
    nested,
    idPrefix: "nested-self-edge-outside-focus",
  });
  assert.ok(
    result.trace.relationships.some((item) => item.authored.from === "payments" && item.authored.to === "payments" && item.kind === "outside-focus"),
    "detail outside-focus should keep authored self-edge as trace-only without unsupported render exception"
  );
});

test("renderAhm rejects model-group ancestor edge in expanded/detail with named unsupported diagnostic", () => {
  const nested = {
    models: {
      payments: { state: "degraded", detailRef: "diagram://payments-detail" },
      ledger: { state: "unhealthy", detailRef: "diagram://ledger-detail" },
    },
    view: { mode: "expanded" },
  };
  assert.throws(
    () => renderAhm(NESTED_SOURCE_ANCESTOR_STRESS, { direction: "TB", legend: false, nested, idPrefix: "nested-ancestor-expanded" }),
    /unsupported-model-group-ancestor-edge:ledger:payments:expanded/
  );
  assert.throws(
    () => renderAhm(NESTED_SOURCE_ANCESTOR_STRESS, {
      direction: "TB",
      legend: false,
      nested: { ...nested, view: { mode: "detail", detailFocus: "payments" } },
      idPrefix: "nested-ancestor-detail",
    }),
    /unsupported-model-group-ancestor-edge:ledger:payments:detail/
  );
  const collapsed = renderAhm(NESTED_SOURCE_ANCESTOR_STRESS, {
    direction: "TB",
    legend: false,
    nested: { ...nested, view: { mode: "collapsed" } },
    idPrefix: "nested-ancestor-collapsed",
  });
  assert.ok(
    collapsed.trace.relationships.some((item) => item.authored.from === "ledger" && item.authored.to === "payments" && item.kind === "detail-only"),
    "collapsed should retain ancestor-stress authored relationship as non-rendered compatibility trace"
  );
  const detailOutsideFocus = renderAhm(NESTED_SOURCE_ANCESTOR_STRESS, {
    direction: "TB",
    legend: false,
    nested: { ...nested, view: { mode: "detail", detailFocus: "ledger" } },
    idPrefix: "nested-ancestor-detail-outside",
  });
  assert.ok(
    detailOutsideFocus.trace.relationships.some((item) => item.authored.from === "ledger" && item.authored.to === "payments" && item.kind === "outside-focus"),
    "detail outside-focus should preserve ancestor-stress relationship trace without render-time exception"
  );
});

test("renderAhm rejects unknown and unsafe options", () => {
  assert.throws(
    () => renderAhm(SIMPLE, { direction: "LR", inject: true }),
    /unknown option "inject"/
  );
  assert.throws(
    () => renderAhm(SIMPLE, { direction: "LR", config: { securityLevel: "loose" } }),
    /unsupported option "config"/
  );
});

test("renderAhm validates fontSize and fontFamily option boundaries", () => {
  for (const badFontSize of [NaN, -3, "x", Infinity, -Infinity]) {
    assert.throws(
      () => renderAhm(SIMPLE, { direction: "LR", fontSize: badFontSize }),
      /invalid option "fontSize"/
    );
  }
  for (const badFontFamily of [42, true, "", "   "]) {
    assert.throws(
      () => renderAhm(SIMPLE, { direction: "LR", fontFamily: badFontFamily }),
      /invalid option "fontFamily"/
    );
  }
  assert.doesNotThrow(() => renderAhm(SIMPLE, { direction: "LR", fontSize: 1000000 }));
});

test("renderAhm rejects non-object top-level options and invalid numeric guards", () => {
  for (const bad of [null, 42, "x", true, []]) {
    assert.throws(
      () => renderAhm(SIMPLE, bad),
      /invalid options: expected an object/
    );
  }
  for (const [key, value] of [["limit", "x"], ["limit", 0], ["maxEdges", 0], ["outputLimit", 0]]) {
    assert.throws(
      () => renderAhm(SIMPLE, { [key]: value }),
      new RegExp(`invalid option "${key}"`)
    );
  }
  assert.throws(
    () => renderAhm(SIMPLE, { tableHeaders: "nope" }),
    /invalid option "tableHeaders": expected boolean/
  );
});

test("renderAhm preserves literal authored dollar tokens in no-signal and signal-table cards", () => {
  const noSignal = [
    "flowchart TB",
    'a["A<br/>healthy"]',
    'r["Root<br/>healthy"]',
    "a --> r",
    "class a green;",
    "class r green;",
  ].join("\n");
  const withSignals = (value) => [
    "flowchart TB",
    `sig["Cost=${value} (healthy)"]:::blue`,
    'a["A<br/>healthy"]',
    "sig --> a",
    "class a green;",
  ].join("\n");
  const dollars = ["$&", "$$", "$'", "$`", "$1"];
  const plain = renderAhm(noSignal, { legend: false, idPrefix: "dollar-plain" }).svg;
  assert.doesNotMatch(plain, /pele-label/);
  for (const token of dollars) {
    const rendered = renderAhm(withSignals(token), { legend: false, idPrefix: `dollar-${token.replace(/[^a-z0-9]/gi, "_")}` }).svg;
    assert.match(svgToText(rendered), new RegExp(escapeRegex(token)));
    assert.doesNotMatch(rendered, /pele-label/);
    assert.equal((rendered.match(/<svg\b/g) ?? []).length, 1, `unexpected svg root duplication for ${token}`);
  }
});

test("renderAhm static safety checks ignore ordinary text while still rejecting active content", () => {
  const ordinaryText = [
    "flowchart TB",
    'sigA["Cfg=run once=5 (healthy)"]:::blue',
    'sigB["see href=x (healthy)"]:::blue',
    'sigC["--verbose: on (healthy)"]:::blue',
    'a["A<br/>healthy"]',
    "sigA --> a",
    "sigB --> a",
    "sigC --> a",
    "class a green;",
  ].join("\n");
  const rendered = renderAhm(ordinaryText, { legend: false, idPrefix: "static-safety-text" }).svg;
  assert.doesNotMatch(rendered, /<script\b/i);
  assert.doesNotMatch(rendered, /<image\b/i);
  assert.doesNotMatch(rendered, /<foreignObject\b/i);
  assert.doesNotMatch(rendered, /<a\b/i);
  assert.doesNotMatch(rendered, /\shref=/i);
  assert.doesNotMatch(rendered, /\sxlink:href=/i);
});

test("renderAhm enforces authored limit only while keeping generated parse bounded", () => {
  const heroSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "hero-source.mmd"), "utf8");
  assert.equal(heroSource.length, 1664);
  assert.doesNotThrow(() => renderAhm(heroSource, { limit: 1664, legend: false, idPrefix: "limit-authored-1664" }));
  assert.throws(
    () => renderAhm(`${heroSource}\nextra`, { limit: 1664, legend: false }),
    /source parse failed/
  );
});

test("renderAhm enforces outputLimit on final serialized SVG", () => {
  const heroSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "hero-source.mmd"), "utf8");
  const full = renderAhm(heroSource);
  assert.throws(
    () => renderAhm(heroSource, { outputLimit: full.svg.length - 1 }),
    /final SVG output length/
  );
  assert.doesNotThrow(() => renderAhm(heroSource, { outputLimit: full.svg.length }));
});

test("renderAhm honors fontFamily and fontSize in visible typography", () => {
  const source = [
    "flowchart TB",
    'sig["Latency = 2350 ms (degraded)"]:::blue',
    'a["A<br/>healthy"]',
    "sig --> a",
    "class a green;",
  ].join("\n");
  const base = renderAhm(source, { legend: false, idPrefix: "font-base" }).svg;
  const adjusted = renderAhm(source, { legend: false, fontSize: 40, fontFamily: "Courier New", idPrefix: "font-adjusted" }).svg;
  assert.match(adjusted, /font-family:Courier New/);
  const baseSizes = new Set([...base.matchAll(/font-size="([^"]+)"/g)].map((m) => Number(m[1])));
  const adjustedSizes = new Set([...adjusted.matchAll(/font-size="([^"]+)"/g)].map((m) => Number(m[1])));
  assert.ok(baseSizes.has(12) && baseSizes.has(14), "expected default table/header typography");
  assert.ok(adjustedSizes.has(30), "expected 12px tokens to scale to 30px at fontSize=40");
  assert.ok(adjustedSizes.has(35), "expected 14px tokens to scale to 35px at fontSize=40");
});

test("renderAhm applies entity and signal color overrides in final SVG", () => {
  const source = [
    "flowchart LR",
    'healthy["Healthy"]',
    'degraded["Degraded"]',
    'unhealthy["Unhealthy"]',
    'unknown["Unknown"]',
    'standby["Standby"]',
    'root["Root"]',
    'sigH["Signal H = 1 (healthy)"]:::blue',
    'sigD["Signal D = 2 (degraded)"]:::blue',
    'sigU["Signal U = 3 (unhealthy)"]:::blue',
    'sigX["Signal X = 4 (unknown)"]:::blue',
    "sigH --> healthy",
    "sigD --> degraded",
    "sigU --> unhealthy",
    "sigX --> unknown",
    "healthy --> root",
    "degraded --> root",
    "unhealthy --> root",
    "unknown --> root",
    "standby --> root",
    "class healthy green;",
    "class degraded amber;",
    "class unhealthy red;",
    "class unknown unknown;",
    "class standby standby;",
    "class root green;",
  ].join("\n");

  const colors = {
    entity: {
      healthy: { border: "#00aa11", fill: "#ccffdd", accent: "#117733" },
      degraded: { border: "#aa6600", fill: "#ffe0aa", accent: "#cc7700" },
      unhealthy: { border: "#aa0000", fill: "#ffcccc", accent: "#dd2222" },
      unknown: { border: "#666666", fill: "#eeeeee", accent: "#777777" },
      standby: { border: "#551199", fill: "#e2d4ff", accent: "#6633aa" },
    },
    signal: {
      healthy: { accent: "#118844" },
      degraded: { accent: "#dd8800" },
      unhealthy: { accent: "#dd1111" },
      unknown: { accent: "#6666aa" },
    },
  };
  const result = renderAhm(source, { direction: "LR", legend: false, colors, idPrefix: "color-overrides" });

  const expectedEntityStyles = [
    ["healthy", colors.entity.healthy],
    ["degraded", colors.entity.degraded],
    ["unhealthy", colors.entity.unhealthy],
    ["unknown", colors.entity.unknown],
    ["standby", colors.entity.standby],
  ];
  for (const [id, token] of expectedEntityStyles) {
    const style = nodeRectStyle(result.svg, id);
    assert.match(style, new RegExp(`fill:${token.fill};`), `missing fill override for ${id}`);
    assert.match(style, new RegExp(`stroke:${token.border};`), `missing border override for ${id}`);
  }
  assert.match(nodeRectStyle(result.svg, "unknown"), /stroke-dasharray:4 3;/);

  for (const entityState of Object.values(colors.entity)) {
    assert.ok(edgeStrokeColors(result.svg).includes(entityState.accent), `missing edge accent ${entityState.accent}`);
    assert.ok(edgeMarkerColors(result.svg).includes(entityState.accent), `missing marker accent ${entityState.accent}`);
  }

  assert.match(result.svg, new RegExp(`class="ahm-signal-state state-healthy"[^>]*fill="${escapeRegex(colors.signal.healthy.accent)}"`));
  assert.match(result.svg, new RegExp(`class="ahm-signal-state state-degraded"[^>]*fill="${escapeRegex(colors.signal.degraded.accent)}"`));
  assert.match(result.svg, new RegExp(`class="ahm-signal-state state-unhealthy"[^>]*fill="${escapeRegex(colors.signal.unhealthy.accent)}"`));
  assert.match(result.svg, new RegExp(`class="ahm-signal-state state-unknown"[^>]*fill="${escapeRegex(colors.signal.unknown.accent)}"`));
});

test("renderAhm colors edge line and arrowhead by source state with underscore ids", () => {
  const source = [
    "flowchart LR",
    'svc_a["A"]',
    'svc_b["B"]',
    'svc_c["C"]',
    'target["Target"]',
    "svc_a -->|solid| target",
    "svc_b -.->|dashed| target",
    "svc_c --> target",
    "class svc_a green;",
    "class svc_b amber;",
    "class svc_c red;",
    "class target purple;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", idPrefix: "underscore-edges", legend: false });
  const strokes = edgeStrokeColors(result.svg);
  const markers = edgeMarkerColors(result.svg);
  assert.ok(strokes.includes("#4c9a2a"), "expected healthy source edge color");
  assert.ok(strokes.includes("#c26a00"), "expected degraded source edge color");
  assert.ok(strokes.includes("#c50f18"), "expected unhealthy source edge color");
  assert.ok(markers.includes("#4c9a2a"), "expected healthy source arrowhead color");
  assert.ok(markers.includes("#c26a00"), "expected degraded source arrowhead color");
  assert.ok(markers.includes("#c50f18"), "expected unhealthy source arrowhead color");
});

test("renderAhm emits static accessible SVG with deterministic ids and no CSS variables", () => {
  const first = renderAhm(SIMPLE, { direction: "TB", legend: false });
  const second = renderAhm(SIMPLE, { direction: "TB", legend: false });
  assert.equal(first.svg, second.svg);
  assert.match(first.svg, /class="pele pele-flowchart ahm-root"/);
  assert.match(first.svg, /data-ahm-theme="portal"/);
  assert.match(first.svg, /<g class="pele-node[^"]*state-healthy[^"]*" data-id="child"/);
  assert.match(first.svg, /<g class="pele-node[^"]*state-degraded[^"]*" data-id="parent"/);
  assert.match(first.svg, /class="ahm-signal-state state-healthy"[^>]*>Healthy</);
  assert.match(first.svg, /class="pele-edge"/);
  assert.match(first.svg, /<title id="ahm-[a-f0-9]+-title">/);
  assert.match(first.svg, /<desc id="ahm-[a-f0-9]+-desc">/);
  assert.match(first.svg, /aria-labelledby="ahm-[a-f0-9]+-title ahm-[a-f0-9]+-desc"/);
  assert.doesNotMatch(first.svg, /var\(--/);
  assert.doesNotMatch(first.svg, /--[A-Za-z0-9_-]+:/);
});

test("renderAhm renders in-card signal table with independent row state styling", async (t) => {
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    'sigD["Latency p95 = 620 ms (degraded)"]:::blue',
    'sigU["Errors = 7.8% (unhealthy)"]:::blue',
    'sigX["Carrier API availability =  (unknown)"]:::blue',
    "sigH --> svc",
    "sigD --> svc",
    "sigU --> svc",
    "sigX --> svc",
    "class svc green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "signal-table-card"   });

  await t.test("renderAhm places entity status badge at top-right without overlapping wrapped header text", () => {
    const source = [
      "flowchart LR",
      'sig["Latency = 2350 ms (degraded)"]:::blue',
      `svc["${"Long shipping service title ".repeat(8)}<br/>healthy"]`,
      "sig --> svc",
      "class svc green;",
    ].join("\n");
    const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "badge-top-right" });
    const node = result.svg.match(/<g class="pele-node[^"]*" data-id="svc"[^>]*>([\s\S]*?)<\/g>/);
    assert.ok(node, "missing svc node");
    const badge = node[1].match(/<rect class="ahm-entity-status-badge[^"]*" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    const title = node[1].match(/<text class="ahm-entity-title"[^>]*>([\s\S]*?)<\/text>/);
    assert.ok(badge && title, "missing badge or title block");
    const badgeX = Number(badge[1]);
    const badgeY = Number(badge[2]);
    const titleXs = [...title[1].matchAll(/<tspan[^>]* x="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.ok(titleXs.length > 0, "missing title tspans");
    assert.ok(titleXs.every((x) => x < badgeX), "title text should stay left of top-right badge");
    const titleYs = [...title[1].matchAll(/<tspan[^>]* y="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.ok(titleYs.length > 0);

    const noSignal = [
      "flowchart LR",
      `solo["${"Standalone entity title ".repeat(8)}<br/>healthy"]`,
      "class solo green;",
    ].join("\n");
    const noSignalSvg = renderAhm(noSignal, { direction: "LR", legend: false, idPrefix: "badge-top-right-nosignal" }).svg;
    const soloNode = noSignalSvg.match(/<g class="pele-node[^"]*" data-id="solo"[^>]*>([\s\S]*?)<\/g>/);
    assert.ok(soloNode, "missing no-signal node");
    const soloBadge = soloNode[1].match(/<rect class="ahm-entity-status-badge[^"]*" x="([^"]+)" y="([^"]+)"/);
    const soloTitleXs = [...soloNode[1].matchAll(/<text class="ahm-entity-title"[^>]*>[\s\S]*?<tspan[^>]* x="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.ok(soloBadge && soloTitleXs.length > 0, "missing no-signal badge/title");
    assert.ok(soloTitleXs.every((x) => x < Number(soloBadge[1])), "no-signal title should stay left of top-right badge");
  });

  await t.test("renderAhm balances table cell top/bottom margins for multiline rows", () => {
    const long = "日本語サービス🚀 ".repeat(10).trim();
    const source = [
      "flowchart LR",
      'svc["Shipping service (healthy)"]',
      `sig["Long value = ${long} (healthy)"]:::blue`,
      "sig --> svc",
      "class svc green;",
    ].join("\n");
    const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "balanced-cell-margins" });
    const row = result.svg.match(/<g class="ahm-signal-row row-state-healthy"[\s\S]*?<\/g>/);
    assert.ok(row, "missing healthy signal row");
    const rowRect = row[0].match(/<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/);
    assert.ok(rowRect, "missing row rect");
    const rowY = Number(rowRect[1]);
    const rowH = Number(rowRect[2]);
    const valueText = row[0].match(/<text class="ahm-signal-value"[^>]*font-size="([^"]+)"[^>]*>([\s\S]*?)<\/text>/);
    assert.ok(valueText, "missing value text");
    const fontSize = Number(valueText[1]);
    const ys = [...valueText[2].matchAll(/<tspan[^>]* y="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.ok(ys.length >= 2, "expected wrapped multiline value for margin-balance proof");
    const lineHeight = ys[1] - ys[0];
    const textTop = ys[0] - fontSize;
    const textBottom = ys[0] + ((ys.length - 1) * lineHeight);
    const topMargin = textTop - rowY;
    const bottomMargin = (rowY + rowH) - textBottom;
    assert.ok(Math.abs(topMargin - bottomMargin) <= 7, `expected near-balanced margins, got top=${topMargin}, bottom=${bottomMargin}`);
  });

  await t.test("renderAhm uses equal left inset for Signal/Value/State table headers", () => {
    const source = [
      "flowchart LR",
      'svc["Shipping service (healthy)"]',
      'sigA["Availability = 99.95% (healthy)"]:::blue',
      "sigA --> svc",
      "class svc green;",
    ].join("\n");
    const svg = renderAhm(source, { direction: "LR", legend: false, idPrefix: "header-left-inset-proof" }).svg;
    const header = svg.match(/<g class="ahm-signal-table-header">([\s\S]*?)<\/g>/)?.[1] ?? "";
    assert.ok(header, "missing table header group");
    const sepMatches = [...header.matchAll(/class="ahm-signal-col-sep" x1="([^"]+)"/g)].map((m) => Number(m[1]));
    assert.equal(sepMatches.length, 2, "expected two header separators");
    const textMatches = [...header.matchAll(/<text x="([^"]+)"[^>]*>(Signal|Value|State)<\/text>/g)];
    const textX = new Map(textMatches.map((m) => [m[2], Number(m[1])]));
    assert.equal(textX.size, 3, "expected Signal/Value/State header labels");
    const valueInset = textX.get("Value") - sepMatches[0];
    const stateInset = textX.get("State") - sepMatches[1];
    assert.ok(Math.abs(valueInset - stateInset) <= 0.01, `expected equal header inset for Value/State, got ${valueInset} vs ${stateInset}`);
    assert.ok(textX.get("Signal") < textX.get("Value") && textX.get("Value") < textX.get("State"), "expected Signal/Value/State headers in column order");
  });

  await t.test("renderAhm tableHeaders=false removes header labels/separators/height while keeping rows", () => {
    const source = [
      "flowchart LR",
      'svc["Shipping service (healthy)"]',
      'sigA["Availability = 99.95% (healthy)"]:::blue',
      'sigB["Latency = 2350ms (degraded)"]:::blue',
      "sigA --> svc",
      "sigB --> svc",
      "class svc green;",
    ].join("\n");
    const on = renderAhm(source, { direction: "LR", legend: false, tableHeaders: true, idPrefix: "headers-on" });
    const off = renderAhm(source, { direction: "LR", legend: false, tableHeaders: false, idPrefix: "headers-off" });
    assert.match(on.svg, />Signal</);
    assert.match(on.svg, />Value</);
    assert.match(on.svg, />State</);
    assert.match(on.svg, /class="ahm-signal-table-header"/);
    assert.doesNotMatch(off.svg, />Signal</);
    assert.doesNotMatch(off.svg, />Value</);
    assert.doesNotMatch(off.svg, />State</);
    assert.doesNotMatch(off.svg, /class="ahm-signal-table-header"/);
    assert.match(off.svg, /class="ahm-signal-row row-state-healthy"/);
    assert.match(off.svg, /class="ahm-signal-row row-state-degraded"/);
    assert.ok(off.height < on.height, `expected tableHeaders=false to shrink geometry (${off.height} !< ${on.height})`);
  });
  const text = svgToText(result.svg);

  assert.match(result.svg, /class="ahm-signal-table"/);
  assert.match(result.svg, /class="ahm-signal-table-header"/);
  assert.match(result.svg, />Signal</);
  assert.match(result.svg, />Value</);
  assert.match(result.svg, />State</);

  for (const state of ["healthy", "degraded", "unhealthy", "unknown"]) {
    assert.match(result.svg, new RegExp(`class="ahm-signal-row[^"]*row-state-${state}`), `missing ${state} row class`);
  }

  assert.match(result.svg, /class="ahm-entity-status-badge[^"]*entity-state-healthy"/);
  assert.equal((text.match(/Shipping service/g) ?? []).length, 1, "entity title should be shown once");
  assert.equal((text.match(/\bHealthy\b/g) ?? []).length, 2, "expect one entity badge and one healthy row state");
  assert.match(text, /Carrier API\s+availability/);
  assert.match(text, /\[empty\]/, "empty authored signal value should remain explicit");
});

test("renderAhm consumes standalone subsequent state line and keeps state text singular", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service<br/>healthy"]',
    "class svc green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "shipping-standalone-state-line" });
  assert.match(svgToText(result.svg), /Shipping\s+service/);
  assert.doesNotMatch(result.svg, /class="ahm-entity-qualifier"[\s\S]*>healthy</i);
  assert.equal((result.svg.match(/>Healthy<\/text>/g) ?? []).length, 1, "entity state should appear once in the badge");
});

test("renderAhm reserves practical table width and omits table for entities without signals", () => {
  const source = [
    "flowchart LR",
    'subgraph laneOps["Ops"]',
    'svc["Shipping service (healthy)"]',
    'observer["Observer service (healthy)"]',
    "end",
    'subgraph laneCore["Core"]',
    'hub["Order hub (healthy)"]',
    "end",
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    'sigD["Latency p95 = 620 ms (degraded)"]:::blue',
    'sigU["Error rate = 7.8% (unhealthy)"]:::blue',
    'sigX["Carrier API availability =  (unknown)"]:::blue',
    "sigH --> svc",
    "sigD --> svc",
    "sigU --> svc",
    "sigX --> svc",
    "svc -->|roll-up source| hub",
    "observer -.->|propagates fallback| svc",
    "class svc green;",
    "class observer green;",
    "class hub green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", lanes: true, legend: false, idPrefix: "table-width-budget" });
  const text = svgToText(result.svg);
  const width = nodeRectWidth(result.svg, "svc");
  assert.ok(width >= 300 && width < 340, `expected content-fit reserved card width in [300,340), got ${width}`);
  const svcBounds = result.svg.match(/data-id="svc"[\s\S]*?<rect x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/);
  const tableOutline = result.svg.match(/data-id="svc"[\s\S]*?<rect class="ahm-signal-table-outline" x="[^"]+" y="([^"]+)" width="[^"]+" height="([^"]+)"/);
  assert.ok(svcBounds && tableOutline, "missing svc bounds or table outline");
  const svcBottom = Number(svcBounds[1]) + Number(svcBounds[2]);
  const tableBottom = Number(tableOutline[1]) + Number(tableOutline[2]);
  const slack = svcBottom - tableBottom;
  assert.ok(slack <= 28, `expected bottom slack <= one row, got ${slack}`);
  const healthyRowHeight = Number((result.svg.match(/class="ahm-signal-row row-state-healthy"[\s\S]*?<rect x="[^"]+" y="[^"]+" width="[^"]+" height="([^"]+)"/) ?? [])[1]);
  assert.ok(healthyRowHeight <= 30, `expected one-line healthy row to stay compact, got ${healthyRowHeight}`);
  const stateHeaderX = Number((result.svg.match(/>State<\/text>/) && (result.svg.match(/<text x="([^"]+)" y="[^"]+" font-size="12" font-weight="600" fill="#605e5c" text-anchor="start">State<\/text>/) ?? [])[1]));
  const firstStateCellX = Number((result.svg.match(/class="ahm-signal-state state-healthy" x="([^"]+)"/) ?? [])[1]);
  assert.ok(firstStateCellX > stateHeaderX, "State body text should remain indented for the indicator dot while header keeps column inset");

  assert.match(result.svg, /data-id="svc"[\s\S]*class="ahm-signal-table"/);
  assert.doesNotMatch(result.svg, /data-id="observer"[\s\S]*class="ahm-signal-table"/, "no-signal entities must not render empty table grid");
  assert.equal((result.svg.match(/>Ops</g) ?? []).length, 1, "Ops lane label should not be duplicated");
  assert.equal((result.svg.match(/>Core</g) ?? []).length, 1, "Core lane label should not be duplicated");
  assert.match(text, /roll-up source/);
  assert.match(text, /propagates fallback/);
});

test("renderAhm keeps unbreakable title and qualifier words whole for narrow table-demand cards", () => {
  const source = [
    "flowchart BT",
    'auth["Authentication<br/>Supercalifragilisticexpialidocious<br/>healthy"]',
    'peer["Peer (degraded)"]',
    'sigA["A = 1 (healthy)"]:::blue',
    'sigB["B = 2 (degraded)"]:::blue',
    "sigA --> auth",
    "sigB --> auth",
    "auth --> peer",
    "class auth green;",
    "class peer amber;",
  ].join("\n");
  const result = renderAhm(source, { direction: "BT", lanes: false, legend: false, idPrefix: "header-word-whole" });
  const node = parseNodeRects(result.svg).find((item) => item.id === "auth");
  assert.ok(node, "missing auth node");
  const titleBlock = node.body.match(/<text class="ahm-entity-title"[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
  const qualifierBlock = node.body.match(/<text class="ahm-entity-qualifier"[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
  const titleLines = [...titleBlock.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((line) => line[1]);
  const qualifierLines = [...qualifierBlock.matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)].map((line) => line[1]);
  assert.ok(titleLines.includes("Authentication"), `expected whole Authentication line, got ${JSON.stringify(titleLines)}`);
  assert.ok(qualifierLines.includes("Supercalifragilisticexpialidocious"), `expected whole qualifier line, got ${JSON.stringify(qualifierLines)}`);
});

test("renderAhm reserves exact planned card sizes within serialization tolerance", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service long regional title with qualifier<br/>Follow-up qualifier line (healthy)"]',
    'observer["Observer service (healthy)"]',
    'hub["Order hub (healthy)"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    'sigD["Latency p95 for checkout orchestration = 620 ms (degraded)"]:::blue',
    "sigH --> svc",
    "sigD --> svc",
    "svc -->|roll-up source| hub",
    "observer -.->|propagates fallback| svc",
    "class svc green;",
    "class observer green;",
    "class hub green;",
  ].join("\n");
  const options = { direction: "LR", lanes: true, legend: false, idPrefix: "planned-size-proof" };
  const result = renderAhm(source, options);
  const model = parseAhmSource(source, options);
  const measurer = createAhmTextMeasurer();
  const reservationCalibration = { lineHeight: 3, padY: 24 };
  for (const entity of model.entities) {
    const plan = alignPlanToReservationGrid(planEntityCard(entity, measurer), reservationCalibration);
    const actualW = nodeRectWidth(result.svg, entity.id);
    const actualH = nodeRectHeight(result.svg, entity.id);
    assert.ok(Math.abs(actualW - plan.cardWidth) <= 0.02, `expected width match for ${entity.id}: planned ${plan.cardWidth}, got ${actualW}`);
    assert.ok(Math.abs(actualH - plan.cardHeight) <= 0.02, `expected height match for ${entity.id}: planned ${plan.cardHeight}, got ${actualH}`);
  }
});

test("renderAhm keeps same-tier card widths content-fit across short, long, and no-signal cards", () => {
  const longValue = "123456789012345678901234567890".repeat(2);
  const source = [
    "flowchart TB",
    'short["Short service (healthy)"]',
    'long["Long service (degraded)"]',
    'solo["No signal title (healthy)"]',
    'root["Root service (healthy)"]',
    'sigShort["Q = 7 (healthy)"]:::blue',
    `sigLong["Queue backlog absolute count = ${longValue} (degraded)"]:::blue`,
    "sigShort --> short",
    "sigLong --> long",
    "short --> root",
    "long --> root",
    "solo --> root",
    "class short green;",
    "class long amber;",
    "class solo green;",
    "class root green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "TB", lanes: false, legend: false, idPrefix: "content-fit-widths" });
  const shortWidth = nodeRectWidth(result.svg, "short");
  const longWidth = nodeRectWidth(result.svg, "long");
  const soloWidth = nodeRectWidth(result.svg, "solo");
  assert.ok(shortWidth < 390, `short signal card should not be pinned to wide legacy floor: ${shortWidth}`);
  assert.ok(longWidth > shortWidth, `long signal card should be wider than short signal card: long=${longWidth}, short=${shortWidth}`);
  assert.ok(soloWidth !== shortWidth, `no-signal card should not match short signal width by global sizing: solo=${soloWidth}, short=${shortWidth}`);
});

test("renderAhm uses compact primary horizontal spacing for the actual hero lanes-off source", () => {
  const heroSource = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "examples", "hero-source.mmd"), "utf8");
  const result = renderAhm(heroSource, { direction: "BT", lanes: false, theme: "portal", legend: true });
  const nodes = parseNodeRects(result.svg);
  const leafIds = ["web", "app", "db", "analytics", "queue", "ship"];
  const leaves = leafIds
    .map((id) => nodes.find((node) => node.id === id))
    .filter(Boolean)
    .sort((a, b) => a.x - b.x);
  assert.equal(leaves.length, leafIds.length, "missing primary hero leaves");
  const gaps = [];
  for (let i = 0; i < leaves.length - 1; i += 1) {
    const left = leaves[i];
    const right = leaves[i + 1];
    gaps.push(Number((right.x - (left.x + left.w)).toFixed(2)));
  }
  assert.ok(gaps.every((gap) => Math.abs(gap - 88) <= 1), `expected compact 88px leaf gaps, got ${gaps.join(",")}`);
  assert.ok(result.width < 2701, `expected compact hero width below C4 baseline 2701, got ${result.width}`);
});

test("renderAhm keeps table text readable and ids prefix-disjoint across idPrefix values", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service primary region with long title (healthy)"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    'sigD["Latency p95 for checkout orchestration = 620 ms (degraded)"]:::blue',
    "sigH --> svc",
    "sigD --> svc",
    "class svc green;",
  ].join("\n");

  const a = renderAhm(source, { direction: "LR", legend: false, idPrefix: "prefix-A" });
  const b = renderAhm(source, { direction: "LR", legend: false, idPrefix: "prefix-B" });

  for (const cls of ["ahm-entity-qualifier", "ahm-signal-name", "ahm-signal-value", "ahm-signal-state"]) {
    for (const match of a.svg.matchAll(new RegExp(`<text class="${cls}"[^>]*font-size="([0-9.]+)"`, "g"))) {
      assert.ok(Number(match[1]) >= 12, `${cls} font-size must be >= 12`);
    }
  }

  assert.doesNotMatch(a.svg, /<text class="ahm-entity-title"[\s\S]*?<title>/, "entity title must be fully visible without title fallback");
  assert.doesNotMatch(a.svg, /<text class="ahm-entity-qualifier"[\s\S]*?<title>/, "entity qualifier must be fully visible without title fallback");

  const idsA = extractIds(a.svg);
  const idsB = extractIds(b.svg);
  for (const id of idsA) {
    assert.ok(!idsB.has(id), `id collision across prefixes: ${id}`);
  }
  assert.match(a.svg, /clipPath id="ahm-clip-prefix-A_/);
  assert.match(b.svg, /clipPath id="ahm-clip-prefix-B_/);
});

test("renderAhm wraps long unbroken values without truncating readings", () => {
  const longValue = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    `sigH["Availability token = ${longValue} (healthy)"]:::blue`,
    'sigU["Error rate = 7.8% (unhealthy)"]:::blue',
    "sigH --> svc",
    "sigU --> svc",
    "class svc green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "long-value-proof" });

  assert.doesNotMatch(
    result.svg,
    /<text class="ahm-signal-value"[\s\S]*?<title>/,
    "value cells must not use truncation title fallback for long readings"
  );
  assert.match(result.svg, /class="ahm-signal-state state-healthy"[^>]*font-size="12"/);
  assert.match(result.svg, /class="ahm-signal-state state-unhealthy"[^>]*font-size="12"/);
  assert.match(result.svg, /class="ahm-entity-title"[^>]*font-size="14"[^>]*font-weight="700"/);
  const valueBlock = result.svg.match(/<g class="ahm-signal-row row-state-healthy"[\s\S]*?<text class="ahm-signal-value"[^>]*>([\s\S]*?)<\/text>/);
  assert.ok(valueBlock, "missing healthy signal value block");
  const reconstructed = (valueBlock[1].match(/<tspan[^>]*>([^<]*)<\/tspan>/g) ?? [])
    .map((line) => line.replace(/<[^>]+>/g, ""))
    .join("");
  assert.equal(reconstructed, longValue, "long value should be fully visible through wrapped tspans");
});

test("renderAhm applies supplied no-equals signal states to row state and tint", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    'sigD["Queue depth (degraded)"]:::blue',
    'sigU["Queue depth (unhealthy)"]:::blue',
    "sigD --> svc",
    "sigU --> svc",
    "class svc green;",
  ].join("\n");
  const palette = getAhmPalette("portal");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "no-equals-signal-state" });
  assert.match(result.svg, /class="ahm-signal-row row-state-degraded"[^>]*>/);
  assert.match(result.svg, /class="ahm-signal-row row-state-unhealthy"[^>]*>/);
  assert.match(result.svg, /class="ahm-signal-value"[\s\S]*>∅<\/tspan>/);
  assert.match(
    result.svg,
    new RegExp(`class="ahm-signal-row row-state-degraded"[\\s\\S]*?<rect[^>]*fill="${escapeRegex(palette.entity.degraded.fill)}"[^>]*stroke="${escapeRegex(palette.entity.degraded.border)}"`),
    "degraded no-equals row should use degraded tint tokens"
  );
  assert.match(
    result.svg,
    new RegExp(`class="ahm-signal-row row-state-unhealthy"[\\s\\S]*?<rect[^>]*fill="${escapeRegex(palette.entity.unhealthy.fill)}"[^>]*stroke="${escapeRegex(palette.entity.unhealthy.border)}"`),
    "unhealthy no-equals row should use unhealthy tint tokens"
  );
});

test("renderAhm keeps reservation bounded for tiny and huge finite fontSize", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    "sigH --> svc",
    "class svc green;",
  ].join("\n");
  const tiny = renderAhm(source, { direction: "LR", legend: false, fontSize: 0.5, idPrefix: "tiny-font" });
  const huge = renderAhm(source, { direction: "LR", legend: false, fontSize: 1000000, idPrefix: "huge-font" });
  assert.ok(tiny.width > 0 && tiny.height > 0);
  assert.ok(huge.width > 0 && huge.height > 0);
  assert.ok(huge.svg.length < 250000, "huge font reservation should stay bounded");
});

test("renderAhm keeps tiny-font table geometry inside card and viewBox", () => {
  const buildSource = ({ rowCount, longTitle }) => {
    const title = longTitle ? `${"W ".repeat(40).trim()}<br/>healthy` : "Shipping service (healthy)";
    const rows = rowCount > 1
      ? Array.from({ length: rowCount }, (_, i) => `sig${i}["Signal number ${i} = ${i} units (Healthy)"]:::blue`)
      : ['sig0["Availability = 99.95% (healthy)"]:::blue'];
    const links = Array.from({ length: rows.length }, (_, i) => `sig${i} --> svc`);
    return [
      "flowchart LR",
      `svc["${title}"]`,
      ...rows,
      ...links,
      "class svc green;",
    ].join("\n");
  };

  const cases = [
    { fontSize: 0.01, tableHeaders: true, rowCount: 150, longTitle: true, id: "tiny-rows-proof" },
    { fontSize: 0.5, tableHeaders: true, rowCount: 1, longTitle: false, id: "tiny-font" },
    { fontSize: 1, tableHeaders: false, rowCount: 12, longTitle: false, id: "tiny-mid" },
    { fontSize: 16, tableHeaders: true, rowCount: 1, longTitle: true, id: "default" },
    { fontSize: 40, tableHeaders: false, rowCount: 12, longTitle: true, id: "large" },
  ];

  for (const { fontSize, tableHeaders, rowCount, longTitle, id } of cases) {
    const fontToken = String(fontSize).replaceAll(".", "p");
    const idPrefix = `tinyGeom-${id}-${fontToken}-${tableHeaders ? "h1" : "h0"}-rows${rowCount}-${longTitle ? "title1" : "title0"}`;
    const result = renderAhm(buildSource({ rowCount, longTitle }), {
      direction: "LR",
      legend: false,
      fontSize,
      tableHeaders,
      idPrefix,
    });
    const card = parseNodeBounds(result.svg, "svc");
    const table = parseTableOutlineBounds(result.svg, "svc");
    const vb = parseViewBox(result.svg);
    assert.ok(card && table && vb, `missing geometry for ${idPrefix}`);
    assert.ok(containsRect(card, table), `table escaped card for ${idPrefix}`);
    assert.ok(table.maxX <= vb.minX + vb.width + 1, `table exceeds viewBox right edge for ${idPrefix}`);
    assert.ok(table.maxY <= vb.minY + vb.height + 1, `table exceeds viewBox bottom edge for ${idPrefix}`);
  }
});

test("renderAhm uses planned line heights for multi-line entity titles", () => {
  const source = [
    "flowchart TB",
    `sig["Metric = value (healthy)"]:::blue`,
    `a["${"very long title ".repeat(12)}<br/>healthy"]`,
    "sig --> a",
    "class a green;",
  ].join("\n");
  const fontSize = 40;
  const result = renderAhm(source, { legend: false, fontSize, idPrefix: "title-lineheight-proof" });
  const model = parseAhmSource(source);
  const plan = planEntityCard(model.entities[0], createAhmTextMeasurer(), { fontSize });
  const titleBlock = result.svg.match(/<text class="ahm-entity-title"[^>]*>([\s\S]*?)<\/text>/);
  assert.ok(titleBlock, "missing title text block");
  const ys = [...titleBlock[1].matchAll(/<tspan[^>]* y="([^"]+)"/g)].map((m) => Number(m[1]));
  assert.ok(ys.length >= 2, "title did not wrap to multiple lines");
  for (let i = 1; i < ys.length; i += 1) {
    const delta = ys[i] - ys[i - 1];
    assert.ok(Math.abs(delta - plan.constants.titleLineHeight) <= 0.01, `title baseline drift: expected ${plan.constants.titleLineHeight}, got ${delta}`);
  }
});

test("renderAhm keeps tiny-many-rows and huge-font outputs bounded and valid", () => {
  const title = "W ".repeat(40).trim();
  const rows = Array.from({ length: 150 }, (_, i) => `sig${i}["Signal number ${i} = ${i} units (Healthy)"]:::blue`);
  const links = Array.from({ length: 150 }, (_, i) => `sig${i} --> a`);
  const source = [
    "flowchart BT",
    `a["${title}<br/>healthy"]`,
    ...rows,
    ...links,
    "class a green;",
  ].join("\n");

  const tiny = renderAhm(source, { legend: false, fontSize: 0.01, idPrefix: "tiny-rows-proof" });
  assert.ok(tiny.svg.length > 0);
  assertNodeGeometryContained(tiny.svg);

  const huge = renderAhm(source, { legend: false, fontSize: 1000, idPrefix: "huge-font-proof" });
  assert.ok(huge.svg.length > 0 && huge.svg.length < 500000, "huge finite font output should remain bounded");
  assertNodeGeometryContained(huge.svg);

  const extreme = renderAhm(source, { legend: false, fontSize: 1e9, idPrefix: "extreme-font-proof" });
  assert.ok(extreme.svg.length > 0 && extreme.svg.length < 500000, "extreme finite font output should remain bounded");
});

test("renderAhm keeps signal cell text within clip width at control and large font scales", () => {
  const measure = createAhmTextMeasurer();
  const baseSource = [
    "flowchart LR",
    'db["Primary DB (healthy)"]',
    'sigH["Availability = 99.95% (healthy)"]:::blue',
    'sigD["Latency p99 = 2350ms (degraded)"]:::blue',
    'sigU["Unicode = 日本語サービス🚀 (healthy)"]:::blue',
    "sigH --> db",
    "sigD --> db",
    "sigU --> db",
    "class db green;",
  ].join("\n");
  const hugeRows = Array.from({ length: 150 }, (_, i) => `sig${i}["Signal number ${i} = ${i} units (Healthy)"]:::blue`);
  const hugeLinks = Array.from({ length: 150 }, (_, i) => `sig${i} --> a`);
  const hugeSource = [
    "flowchart BT",
    `a["${"W ".repeat(40).trim()}<br/>healthy"]`,
    ...hugeRows,
    ...hugeLinks,
    "class a green;",
  ].join("\n");

  const cases = [
    { id: "control-8", source: baseSource, options: { direction: "LR", legend: true, fontSize: 8 } },
    { id: "regression-40", source: baseSource, options: { direction: "LR", legend: true, fontSize: 40 } },
    { id: "regression-1000", source: hugeSource, options: { direction: "BT", legend: false, fontSize: 1000, idPrefix: "huge-font-proof" } },
  ];

  for (const { id, source, options } of cases) {
    const svg = renderAhm(source, { ...options, idPrefix: `${id}-clip-fit` }).svg;
    const rows = parseSignalCellFits(svg, measure);
    assert.ok(rows.length > 0, `missing signal cell rows for ${id}`);
    const overflowRows = rows.filter((row) => row.overflow > 0.01);
    assert.equal(overflowRows.length, 0, `${id} has clipped signal text: ${overflowRows.slice(0, 5).map((row) => `${row.cls}:${row.text}:${row.overflow.toFixed(3)}`).join(" | ")}`);
    if (id === "regression-1000") {
      for (const token of ["100 units", "101 units", "148 units", "149 units"]) {
        const hit = rows.find((row) => row.cls.includes("ahm-signal-value") && row.text.includes(token));
        assert.ok(hit, `missing value row token ${token} in ${id}`);
      }
    }
  }
});

test("renderAhm preserves long Unicode value graphemes inside value cell bounds", () => {
  const unicodeValue = "日本語サービス🚀日本語サービス🚀日本語サービス🚀";
  const source = [
    "flowchart LR",
    'svc["Shipping service (healthy)"]',
    `sigH["Unicode reading = ${unicodeValue} (healthy)"]:::blue`,
    "sigH --> svc",
    "class svc green;",
  ].join("\n");
  const result = renderAhm(source, { direction: "LR", legend: false, idPrefix: "unicode-value-proof" });
  assert.doesNotMatch(result.svg, /<text class="ahm-signal-value"[\s\S]*?<title>/, "unicode values must not be truncated");
  const row = result.svg.match(/<g class="ahm-signal-row row-state-healthy"[\s\S]*?<\/g>/);
  assert.ok(row, "missing unicode value row");
  const valueTextBody = row[0].match(/<text class="ahm-signal-value"[^>]*>([\s\S]*?)<\/text>/)?.[1] ?? "";
  const reconstructed = (valueTextBody.match(/<tspan[^>]*>([^<]*)<\/tspan>/g) ?? [])
    .map((line) => line.replace(/<[^>]+>/g, ""))
    .join("");
  assert.equal(reconstructed, unicodeValue);

  const rowRect = row[0].match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  const colSeps = [...row[0].matchAll(/class="ahm-signal-col-sep" x1="([^"]+)"/g)].map((m) => Number(m[1]));
  const tspans = [...row[0].matchAll(/<text class="ahm-signal-value"[^>]*><tspan x="([^"]+)" y="([^"]+)">/g)];
  assert.ok(rowRect && colSeps.length === 2 && tspans.length > 0, "missing value cell geometry");
  const rowY = Number(rowRect[2]);
  const rowH = Number(rowRect[4]);
  const valueX = colSeps[0];
  const stateX = colSeps[1];
  for (const tspan of tspans) {
    const x = Number(tspan[1]);
    const y = Number(tspan[2]);
    assert.ok(x >= valueX + 5 && x <= stateX - 2, `value tspan x out of value cell: ${x}`);
    assert.ok(y >= rowY + 1 && y <= rowY + rowH - 1, `value tspan y out of row bounds: ${y}`);
  }

  const svcNode = result.svg.match(/<g class="pele-node[^"]*" data-id="svc"[^>]*transform="translate\(([^,]+),([^)]+)\)">([\s\S]*?)<\/g>/);
  assert.ok(svcNode, "missing svc node for unicode value ink check");
  const tx = Number(svcNode[1]);
  const ty = Number(svcNode[2]);
  const valueText = row[0].match(/<text class="ahm-signal-value"[\s\S]*?<\/text>/)?.[0];
  assert.ok(valueText, "missing unicode value text markup");

  const vb = parseViewBox(result.svg);
  assert.ok(vb, "missing viewbox for unicode value ink check");
  const ink = rasterInkBounds({
    width: result.width,
    height: result.height,
    viewBox: vb,
    markup: `<g transform="translate(${tx},${ty})">${valueText}</g>`,
    fontConfig: resolveNativeFontConfig(),
  });
  assert.ok(ink, "expected unicode value ink");
  assert.ok(ink.minX >= tx + valueX + 2, `unicode value ink escaped left cell edge: ${ink.minX}`);
  assert.ok(ink.maxX <= tx + stateX - 2, `unicode value ink escaped right cell edge: ${ink.maxX}`);
  assert.ok(ink.minY >= ty + rowY + 2, `unicode value ink escaped top cell edge: ${ink.minY}`);
  assert.ok(ink.maxY <= ty + rowY + rowH - 2, `unicode value ink escaped bottom cell edge: ${ink.maxY}`);
});

test("renderAhm handles long/escaped labels and dense dependencies from preserved fixtures", () => {
  const textExtremes = renderAhm(readFixture("text-extremes.mmd"), { lanes: false, direction: "BT", idPrefix: "text-extremes" });
  assert.match(textExtremes.svg, /&lt;entities&gt;/);
  assert.match(textExtremes.svg, /日本語サービス/);
  assert.doesNotMatch(textExtremes.svg, /&lt;br\/&gt;/i);
  assert.doesNotMatch(textExtremes.svg, /<br\/>/i);
  assert.match(textExtremes.svg, /2350 ms/);
  const dense = renderAhm(readFixture("dense-multi-parent.mmd"), { lanes: false, direction: "BT", idPrefix: "dense" });
  assert.match(dense.svg, /labelled hop/);
  assert.match(dense.svg, /dashed hop|sampled/);
  assert.ok(dense.width > 0 && dense.height > 0);
});

function findInkBounds(pixels, width, height) {
  const WHITE = { r: 255, g: 255, b: 255, a: 255 };
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let coveredPixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];
      const isInk = a > 0 && (Math.abs(r - WHITE.r) > 2 || Math.abs(g - WHITE.g) > 2 || Math.abs(b - WHITE.b) > 2);
      if (!isInk) continue;
      coveredPixels += 1;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX || maxY < minY) {
    return { minX: 0, minY: 0, maxX: -1, maxY: -1, width: 0, height: 0, coveredPixels: 0 };
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    coveredPixels,
  };
}

function measureInkMarginsInBox({ markup, box, fontConfig }) {
  if (!markup || !box) return null;
  const width = Math.max(1, Math.ceil(box.w));
  const height = Math.max(1, Math.ceil(box.h));
  const viewBox = { minX: box.x, minY: box.y, width: box.w, height: box.h };
  const ink = rasterInkBounds({ width, height, viewBox, markup, fontConfig });
  if (!ink) return null;
  const topMargin = ink.minY;
  const bottomMargin = height - 1 - ink.maxY;
  return { topMargin, bottomMargin, delta: Math.abs(topMargin - bottomMargin), inkHeight: ink.height };
}

function parseSignalCellFits(svg, measurer) {
  const clips = new Map();
  for (const match of svg.matchAll(/<clipPath id="([^"]+)"><rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"\/><\/clipPath>/g)) {
    clips.set(match[1], { x: Number(match[2]), y: Number(match[3]), w: Number(match[4]), h: Number(match[5]) });
  }
  const rows = [];
  for (const match of svg.matchAll(/<text class="(ahm-signal-(?:name|value|state)[^"]*)" x="([^"]+)" y="([^"]+)" font-size="([^"]+)"[^>]*font-weight="([^"]+)"[^>]*clip-path="url\(#([^)]+)\)">([\s\S]*?)<\/text>/g)) {
    const cls = match[1];
    const x = Number(match[2]);
    const fontSize = Number(match[4]);
    const fontWeight = Number(match[5]);
    const clip = clips.get(match[6]);
    if (!clip) continue;
    const tspans = [...match[7].matchAll(/<tspan[^>]*>([^<]*)<\/tspan>/g)];
    const text = tspans.length
      ? tspans.map((line) => line[1]).join(" ")
      : match[7].replace(/<[^>]+>/g, " ");
    const normalized = text
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, "\"")
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
    const measured = measurer.width(normalized, fontSize, { fontWeight });
    const available = clip.w - (x - clip.x);
    rows.push({ cls, text: normalized, measured, available, overflow: measured - available });
  }
  return rows;
}

function rasterInkBounds({ width, height, viewBox, markup, fontConfig }) {
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${viewBox.minX} ${viewBox.minY} ${viewBox.width} ${viewBox.height}">`,
    '<rect width="100%" height="100%" fill="#fff"/>',
    markup,
    "</svg>",
  ].join("");
  const rendered = new Resvg(svg, {
    font: {
      fontFiles: fontConfig.files,
      loadSystemFonts: false,
      defaultFontFamily: fontConfig.family,
    },
  }).render();
  const ink = findInkBounds(rendered.pixels, rendered.width, rendered.height);
  if (ink.width <= 0 || ink.height <= 0) return null;
  return ink;
}

function svgToText(svg) {
  return svg
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
