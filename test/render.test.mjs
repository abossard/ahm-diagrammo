import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import { renderAhm } from "../src/ahm-render.mjs";
import { parseAhmSource } from "../src/health-model.mjs";
import { getAhmPalette } from "../src/ahm-tokens.mjs";
import { AHM_DIRECTIONS, NEGATIVE_FIXTURES, POSITIVE_FIXTURES, readAhmFixture } from "./helpers/ahm-fixtures.mjs";
import { assertCodepointsCovered, resolveNativeFontConfig } from "./helpers/ahm-native-fonts.mjs";
import {
  assertNoCardOverlap,
  assertNoConnectorThroughNonIncidentCards,
  assertNodeAndPathInsideViewbox,
  assertTextContainedInNodes,
  parseEdgeLabelTargets,
  parseEdgeGroups,
  parseNodeRects,
  parseNodeTextLines,
  parseRootSvgMetadata,
  parseViewBox,
  pathToPolyline,
} from "./helpers/ahm-svg.mjs";

const STATE_LABEL = {
  healthy: "Healthy",
  degraded: "Degraded",
  unhealthy: "Unhealthy",
  unknown: "Unknown",
};
const NATIVE_FONT_CONFIG = resolveNativeFontConfig();

function nodeTextIndex(nodes) {
  const index = new Map();
  for (const node of nodes) {
    const lines = parseNodeTextLines(node).map((line) => line.text).join("\n");
    index.set(node.id, lines);
  }
  return index;
}

function assertOwnershipAndSignalRows(model, nodes, svg, context) {
  const nodeById = nodeTextIndex(nodes);
  for (const entity of model.entities) {
    const text = nodeById.get(entity.id);
    assert.ok(text, `${context}: missing rendered node ${entity.id}`);
    const stateCounts = new Map();
    for (const row of entity.signals) {
      const nameVisible = containsAuthoredText(text, row.name);
      const nameTitled = nodeCarriesFullTitle(svg, entity.id, row.name);
      assert.ok(nameVisible || nameTitled, `${context}: missing signal name "${row.name}" in ${entity.id}`);
      if (row.valueKind === "present" && row.value != null) {
        const valueVisible = containsAuthoredText(text, row.value);
        const valueTitled = nodeCarriesFullTitle(svg, entity.id, row.value);
        assert.ok(valueVisible || valueTitled, `${context}: missing signal value "${row.value}" in ${entity.id}`);
      }
      if (row.valueKind === "empty") {
        assert.match(text, /\[empty\]/, `${context}: missing explicit empty marker in ${entity.id}`);
      }

      function nodeCarriesFullTitle(svg, entityId, text) {
        const escapedId = escapeRegex(entityId);
        const escapedTitle = escapeRegex(escapeXml(text));
        const re = new RegExp(`<g class="pele-node[^"]*" data-id="${escapedId}"[\\s\\S]*?<title>${escapedTitle}<\\/title>`);
        return re.test(svg);
      }
      stateCounts.set(row.state, (stateCounts.get(row.state) ?? 0) + 1);
    }
    for (const [state, count] of stateCounts) {
      const label = STATE_LABEL[state];
      const hits = [...text.matchAll(new RegExp(`\\b${escapeRegex(label)}\\b`, "g"))].length;
      assert.ok(hits >= count, `${context}: missing state cues for ${state} in ${entity.id}`);
    }
  }
}

function assertEdgeColorOwnership(svg, model, context) {
  const edges = parseEdgeGroups(svg);
  const byEntity = new Map(model.entities.map((entity) => [entity.id, entity]));
  const palette = getAhmPalette("portal");
  assert.equal(edges.length, model.dependencies.length, `${context}: edge count mismatch`);
  edges.forEach((edge, idx) => {
    const dependency = model.dependencies[idx];
    const state = byEntity.get(dependency.from)?.state ?? "unknown";
    const expected = palette.entity[state].accent;
    assert.match(edge.attrs, new RegExp(`stroke:${escapeRegex(expected)}`), `${context}: edge ${dependency.from}->${dependency.to} missing source color`);
    assert.match(edge.body, new RegExp(`class="pele-marker"[^>]*fill="${escapeRegex(expected)}"`), `${context}: edge ${dependency.from}->${dependency.to} marker fill mismatch`);
    assert.match(edge.body, new RegExp(`class="pele-marker"[^>]*stroke="${escapeRegex(expected)}"`), `${context}: edge ${dependency.from}->${dependency.to} marker stroke mismatch`);
    if (dependency.dashed) {
      assert.match(
        `${edge.attrs} ${edge.body}`,
        /stroke-dasharray|stroke-dashoffset/,
        `${context}: dashed dependency ${dependency.from}->${dependency.to} lost dash style`
      );
    }
  });
}

function assertLegendPlacement(svg, nodes, fixture, context) {
  assert.match(svg, /<g class="ahm-legend"/, `${context}: missing legend group`);
  const legendY = Number((svg.match(/<g class="ahm-legend"[\s\S]*?<text x="20" y="([^"]+)"/) ?? [])[1]);
  assert.ok(Number.isFinite(legendY), `${context}: missing legend label anchor`);
  const contentBottom = Math.max(...nodes.map((node) => node.y + node.h));
  assert.ok(legendY >= contentBottom + 2, `${context}: legend overlaps diagram content`);
  if (fixture === "kitchen-sink-main.mmd") {
    assert.match(svg, /\[S\] Standby/, `${context}: missing Standby legend entry`);
  }
}

function edgeLabelById(svg, edgeId) {
  return parseEdgeLabelTargets(svg).find((label) => label.id === edgeId) ?? null;
}

function distancePointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const den = (dx * dx) + (dy * dy);
  if (den <= 1e-9) return Math.hypot(point.x - a.x, point.y - a.y);
  const t = Math.max(0, Math.min(1, (((point.x - a.x) * dx) + ((point.y - a.y) * dy)) / den));
  const px = a.x + (dx * t);
  const py = a.y + (dy * t);
  return Math.hypot(point.x - px, point.y - py);
}

function minDistanceToPath(pathD, point) {
  const polyline = pathToPolyline(pathD, 24);
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const distance = distancePointToSegment(point, polyline[i], polyline[i + 1]);
    if (distance < best) best = distance;
  }
  return best;
}

function pathIntersectsRect(pathD, rect, padding = 0.75) {
  const polyline = pathToPolyline(pathD, 40);
  const left = rect.x - padding;
  const right = rect.x + rect.w + padding;
  const top = rect.y - padding;
  const bottom = rect.y + rect.h + padding;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let s = 0; s <= steps; s += 1) {
      const t = s / steps;
      const x = a.x + ((b.x - a.x) * t);
      const y = a.y + ((b.y - a.y) * t);
      if (x >= left && x <= right && y >= top && y <= bottom) return true;
    }
  }
  return false;
}

function assertNativeTextInkBounds(svg, context) {
  const root = parseRootSvgMetadata(svg);
  const nodes = parseNodeRects(svg);
  const edgeLabels = parseEdgeLabelTargets(svg);

  for (const node of nodes) {
    if (!node.textMarkup) continue;
    const ink = rasterInkBounds({
      width: root.width,
      height: root.height,
      viewBox: root.viewBox,
      style: root.style,
      fill: root.fill,
      markup: `<g transform="translate(${node.originX},${node.originY})">${node.textMarkup}</g>`,
      fontConfig: NATIVE_FONT_CONFIG,
    });
    assert.ok(ink != null, `${context}: node ${node.id} has no text ink`);
    assert.ok(ink.minX >= node.x + 2, `${context}: node ${node.id} text violates 2px left clearance`);
    assert.ok(ink.maxX <= node.x + node.w - 2, `${context}: node ${node.id} text violates 2px right clearance`);
    assert.ok(ink.minY >= node.y + 2, `${context}: node ${node.id} text violates 2px top clearance`);
    assert.ok(ink.maxY <= node.y + node.h - 2, `${context}: node ${node.id} text violates 2px bottom clearance`);
  }

  for (const label of edgeLabels) {
    const ink = rasterInkBounds({
      width: root.width,
      height: root.height,
      viewBox: root.viewBox,
      style: root.style,
      fill: root.fill,
      markup: label.textMarkup,
      fontConfig: NATIVE_FONT_CONFIG,
    });
    assert.ok(ink != null, `${context}: edge label ${label.id} has no text ink`);
    assert.ok(ink.minX >= label.rect.x + 2, `${context}: edge label ${label.id} violates 2px left clearance`);
    assert.ok(ink.maxX <= label.rect.x + label.rect.w - 2, `${context}: edge label ${label.id} violates 2px right clearance`);
    assert.ok(ink.minY >= label.rect.y + 2, `${context}: edge label ${label.id} violates 2px top clearance`);
    assert.ok(ink.maxY <= label.rect.y + label.rect.h - 2, `${context}: edge label ${label.id} violates 2px bottom clearance`);
  }
  assertNodeAndLabelFontSizes(svg, context);
  if (svg.includes("🚀")) {
    assertRocketGlyphContribution(svg, nodes, root, context);
  }
}

function assertNodeAndLabelFontSizes(svg, context) {
  const rootSize = Number((svg.match(/\bstyle="[^"]*\bfont:([0-9.]+)px\b/) ?? [])[1]);
  assert.ok(Number.isFinite(rootSize) && rootSize >= 12, `${context}: root font size must be >=12px`);
  for (const match of svg.matchAll(/<g class="pele-edge-labels"[^>]*font-size="([0-9.]+)"/g)) {
    const size = Number(match[1]);
    assert.ok(size >= 12, `${context}: edge label font size ${size} below 12px`);
  }
}

function assertEmojiNotTofu(fontConfig, context) {
  const rocket = rasterHashForGlyph("🚀", fontConfig);
  const box = rasterHashForGlyph("□", fontConfig);
  const replacement = rasterHashForGlyph("�", fontConfig);
  assert.notEqual(rocket, box, `${context}: rocket glyph rendered as tofu square`);
  assert.notEqual(rocket, replacement, `${context}: rocket glyph rendered as replacement glyph`);
}

function assertRocketGlyphContribution(svg, nodes, root, context) {
  const target = nodes.find((node) => node.textMarkup.includes("🚀"));
  assert.ok(target, `${context}: missing unicode specimen node with rocket glyph`);
  const originalMarkup = `<g transform="translate(${target.originX},${target.originY})">${target.textMarkup}</g>`;
  const withoutRocketMarkup = `<g transform="translate(${target.originX},${target.originY})">${target.textMarkup.replaceAll("🚀", "")}</g>`;
  const tofuMarkup = `<g transform="translate(${target.originX},${target.originY})">${target.textMarkup.replaceAll("🚀", "□")}</g>`;
  const original = rasterPixelHash({
    width: root.width,
    height: root.height,
    viewBox: root.viewBox,
    style: root.style,
    fill: root.fill,
    markup: originalMarkup,
    fontConfig: NATIVE_FONT_CONFIG,
  });
  const noRocket = rasterPixelHash({
    width: root.width,
    height: root.height,
    viewBox: root.viewBox,
    style: root.style,
    fill: root.fill,
    markup: withoutRocketMarkup,
    fontConfig: NATIVE_FONT_CONFIG,
  });
  const tofu = rasterPixelHash({
    width: root.width,
    height: root.height,
    viewBox: root.viewBox,
    style: root.style,
    fill: root.fill,
    markup: tofuMarkup,
    fontConfig: NATIVE_FONT_CONFIG,
  });
  assert.notEqual(original, noRocket, `${context}: rocket glyph produced no distinct ink`);
  assert.notEqual(original, tofu, `${context}: rocket glyph collapsed to tofu box in corpus specimen`);
}

function rasterHashForGlyph(glyph, fontConfig) {
  const svg = `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"128\" viewBox=\"0 0 128 128\"><text x=\"12\" y=\"88\" font-size=\"72\">${glyph}</text></svg>`;
  const pixels = new Resvg(svg, {
    font: {
      fontFiles: fontConfig.files,
      loadSystemFonts: false,
      defaultFontFamily: fontConfig.family,
    },
  }).render().pixels;
  return createHash("sha256").update(pixels).digest("hex");
}

function rasterInkBounds({ width, height, viewBox, style, fill, markup, fontConfig }) {
  const image = rasterImage({ width, height, viewBox, style, fill, markup, fontConfig });
  const { pixels, bitmapWidth, bitmapHeight } = image;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < bitmapHeight; y++) {
    for (let x = 0; x < bitmapWidth; x++) {
      const idx = (y * bitmapWidth + x) * 4;
      const alpha = pixels[idx + 3];
      if (alpha === 0) continue;
      const point = bitmapPixelToUserSpace(x, y, image);
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    }
  }
  if (maxX < minX || maxY < minY) return null;
  return { minX, minY, maxX, maxY };
}

function rasterPixelHash(args) {
  return createHash("sha256").update(rasterPixels(args)).digest("hex");
}

function rasterPixels({ width, height, viewBox, style, fill, markup, fontConfig }) {
  return rasterImage({ width, height, viewBox, style, fill, markup, fontConfig }).pixels;
}

function rasterImage({ width, height, viewBox, style, fill, markup, fontConfig }) {
  const svg = `<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"${width}\" height=\"${height}\" viewBox=\"${viewBox}\" style=\"${style}\" fill=\"${fill}\">${markup}</svg>`;
  const rendered = new Resvg(svg, {
    font: {
      fontFiles: fontConfig.files,
      loadSystemFonts: false,
      defaultFontFamily: fontConfig.family,
    },
  }).render();
  const pixels = rendered.pixels;
  assert.equal(
    pixels.length,
    rendered.width * rendered.height * 4,
    "native raster output length must match bitmap dimensions"
  );
  return {
    pixels,
    bitmapWidth: rendered.width,
    bitmapHeight: rendered.height,
    viewportWidth: width,
    viewportHeight: height,
    viewBox: parseViewBoxNumbers(viewBox),
  };
}

function parseViewBoxNumbers(viewBox) {
  const values = String(viewBox).trim().split(/\s+/).map(Number);
  assert.equal(values.length, 4, `invalid viewBox "${viewBox}"`);
  assert.ok(values.every((value) => Number.isFinite(value)), `non-finite viewBox "${viewBox}"`);
  return { minX: values[0], minY: values[1], width: values[2], height: values[3] };
}

function bitmapPixelToUserSpace(x, y, image) {
  const { bitmapWidth, bitmapHeight, viewportWidth, viewportHeight, viewBox } = image;
  const viewportX = ((x + 0.5) / bitmapWidth) * viewportWidth;
  const viewportY = ((y + 0.5) / bitmapHeight) * viewportHeight;
  const scale = Math.min(viewportWidth / viewBox.width, viewportHeight / viewBox.height);
  const renderedWidth = viewBox.width * scale;
  const renderedHeight = viewBox.height * scale;
  const offsetX = (viewportWidth - renderedWidth) / 2;
  const offsetY = (viewportHeight - renderedHeight) / 2;
  return {
    x: (viewportX - offsetX) / scale + viewBox.minX,
    y: (viewportY - offsetY) / scale + viewBox.minY,
  };
}

// Inferred lanes are drawn as bands and their connectors routed between them: no two connectors
// run along each other (within 3px for 10px, away from the cards) and none crosses another's label.
function assertLaneRoutesApart(svg, nodes, context) {
  const densify = (points) => points.flatMap((p, i) => {
    if (i === 0) return [p];
    const a = points[i - 1], steps = Math.max(1, Math.ceil(Math.hypot(p.x - a.x, p.y - a.y) / 3));
    return Array.from({ length: steps }, (_, k) => ({ x: a.x + ((p.x - a.x) * (k + 1)) / steps, y: a.y + ((p.y - a.y) * (k + 1)) / steps }));
  });
  const nearCard = (p) => nodes.some((n) => p.x > n.x - 14 && p.x < n.x + n.w + 14 && p.y > n.y - 14 && p.y < n.y + n.h + 14);
  const edges = parseEdgeGroups(svg).map((edge) => ({
    id: edge.attrs.match(/\bdata-id="([^"]+)"/)?.[1],
    pathD: edge.pathD,
    points: pathToPolyline(edge.pathD, 24),
  }));
  for (const a of edges) {
    const own = densify(a.points);
    for (const b of edges) {
      if (a === b) continue;
      // length of a's path within 3px of b: a crossing contributes about 6px, running along 10px+
      let run = 0;
      own.forEach((p, k) => {
        const along = !nearCard(p) && b.points.some((q, i) => i > 0 && distancePointToSegment(p, b.points[i - 1], q) < 3);
        run = along && k > 0 ? run + Math.hypot(p.x - own[k - 1].x, p.y - own[k - 1].y) : 0;
        assert.ok(run < 10, `${context}: ${a.id} runs along ${b.id} near (${p.x.toFixed(0)},${p.y.toFixed(0)})`);
      });
    }
  }
  for (const target of parseEdgeLabelTargets(svg)) {
    for (const edge of edges) {
      if (edge.id === target.id) continue;
      assert.equal(pathIntersectsRect(edge.pathD, target.rect, -1), false, `${context}: ${edge.id} crosses the label of ${target.id}`);
    }
  }
}

function collectGeometrySignature(svg) {
  const nodes = parseNodeRects(svg).map((node) => [node.id, node.x, node.y, node.w, node.h].join(":")).sort();
  const edges = parseEdgeGroups(svg).map((edge) => edge.pathD).sort();
  return `${nodes.join("|")}||${edges.join("|")}`;
}

function findEdgePathById(svg, edgeId) {
  const escaped = edgeId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = svg.match(new RegExp(`<g class="pele-edge"[^>]*data-id="${escaped}"[^>]*>[\\s\\S]*?<path d="([^"]+)"`));
  return match?.[1] ?? null;
}

for (const fixture of POSITIVE_FIXTURES) {
  const source = readAhmFixture(fixture);
  for (const direction of AHM_DIRECTIONS) {
    for (const lanes of [true, false]) {
      const label = `${fixture} direction=${direction} lanes=${lanes}`;
      test(`corpus geometry and semantics ${label}`, () => {
        const model = parseAhmSource(source);
        const result = renderAhm(source, { direction, lanes, idPrefix: idPrefixForFixture(fixture, direction, lanes) });
        const nodes = parseNodeRects(result.svg);
        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const viewBox = parseViewBox(result.svg);

        assert.ok(Number.isFinite(result.width) && result.width > 0, `${label}: non-positive width`);
        assert.ok(Number.isFinite(result.height) && result.height > 0, `${label}: non-positive height`);
        assert.equal(result.diagnostics.some((line) => /warning|error/i.test(line)), false, `${label}: unexpected diagnostics ${result.diagnostics.join(" | ")}`);
        assertNoCardOverlap(nodes, label);
        assertTextContainedInNodes(nodes, label);
        assertEdgeColorOwnership(result.svg, model, label);
        assertOwnershipAndSignalRows(model, nodes, result.svg, label);
        assertNativeTextInkBounds(result.svg, label);
        assertNodeAndPathInsideViewbox(nodes, parseEdgeGroups(result.svg), viewBox, label);

        const edgesWithOwners = parseEdgeGroups(result.svg).map((edge, idx) => ({
          pathD: edge.pathD,
          from: model.dependencies[idx]?.from ?? "__missing__",
          to: model.dependencies[idx]?.to ?? "__missing__",
        }));
        assertNoConnectorThroughNonIncidentCards(edgesWithOwners, nodeById, label);

        if (lanes) {
          assert.match(result.svg, /class="pele pele-flowchart ahm-root"/, `${label}: expected flowchart root class`);
          assert.match(result.svg, /<g class="pele-cluster" data-id="lane_0">/, `${label}: expected lane cluster`);
          assert.match(result.svg, /pele-cluster-label/, `${label}: expected lane labels`);
          if (/<g transform="translate\([^)]*\)"><g class="pele-clusters">/.test(result.svg)) assertLaneRoutesApart(result.svg, nodes, label);
          assert.doesNotMatch(result.svg, /class="pele pele-swimlane/, `${label}: swimlane renderer should not be used`);
        } else {
          assert.doesNotMatch(result.svg, /data-id="lane_0"/, `${label}: lane clusters should be absent`);
          assert.doesNotMatch(result.svg, /rotate\(-90 /, `${label}: rotated lane labels should be absent`);
        }

        assertLegendPlacement(result.svg, nodes, fixture, label);
      });
    }
  }
}

test("route presentation: lane-routed edges never need the card fallback, lanes-off primary keeps its smooth path", () => {
  const source = readAhmFixture("pills-stress-main.mmd");
  for (const direction of AHM_DIRECTIONS) {
    const lanesOn = renderAhm(source, { direction, lanes: true, idPrefix: `guard-on-${direction}` });
    const unsafeNote = lanesOn.diagnostics.find((line) => typeof line === "string" && line.includes("crosses-nonincident-card:"));
    assert.equal(unsafeNote, undefined, `expected lane-routed edges to stay clear of other cards in direction=${direction}`);
  }

  const lanesOff = renderAhm(source, { direction: "BT", lanes: false, idPrefix: "guard-off" });
  const primaryFallback = lanesOff.diagnostics.find((line) => typeof line === "string" && line.includes("[L_mid_root_0]"));
  assert.equal(primaryFallback, undefined, "lanes-off primary rollup should remain smoothed, not forced to fallback");
  const primaryPath = findEdgePathById(lanesOff.svg, "L_mid_root_0");
  assert.ok(primaryPath && primaryPath.includes("C"), "lanes-off primary rollup should preserve cubic presentation");
});

test("route presentation keeps dense labelled-hop association on its own edge across public directions", () => {
  const source = readAhmFixture("dense-multi-parent.mmd");
  for (const direction of AHM_DIRECTIONS) {
    const result = renderAhm(source, { direction, lanes: false, legend: false, idPrefix: `dense-label-${direction}` });
    const label = edgeLabelById(result.svg, "L_a_p3_0");
    const ownPath = findEdgePathById(result.svg, "L_a_p3_0");
    assert.ok(label && ownPath, `missing labelled-hop edge geometry for direction=${direction}`);
    const center = {
      x: label.rect.x + (label.rect.w / 2),
      y: label.rect.y + (label.rect.h / 2),
    };
    const ownDistance = minDistanceToPath(ownPath, center);
    let nearestForeign = Number.POSITIVE_INFINITY;
    for (const edge of parseEdgeGroups(result.svg)) {
      const edgeId = edge.attrs.match(/\bdata-id="([^"]+)"/)?.[1];
      if (!edgeId || edgeId === "L_a_p3_0") continue;
      const distance = minDistanceToPath(edge.pathD, center);
      if (distance < nearestForeign) nearestForeign = distance;
    }
    assert.ok(ownDistance <= 10, `labelled-hop label drifted off its own edge in direction=${direction} (distance=${ownDistance.toFixed(2)})`);
    assert.ok(
      ownDistance + 1.5 < nearestForeign,
      `labelled-hop label became closer to a foreign edge in direction=${direction} (own=${ownDistance.toFixed(2)}, foreign=${nearestForeign.toFixed(2)})`
    );
    if (direction === "TB" || direction === "TD" || direction === "BT") {
      for (const edge of parseEdgeGroups(result.svg)) {
        const edgeId = edge.attrs.match(/\bdata-id="([^"]+)"/)?.[1];
        if (!edgeId || edgeId === "L_a_p3_0") continue;
        assert.equal(
          pathIntersectsRect(edge.pathD, label.rect, 0.75),
          false,
          `labelled-hop label occludes foreign edge ${edgeId} in direction=${direction}`
        );
      }
    }
  }
});

test("route presentation keeps no-lane pills primary label attached to smoothed arc across directions", () => {
  const source = readAhmFixture("pills-stress-main.mmd");
  for (const direction of AHM_DIRECTIONS) {
    const lanesOff = renderAhm(source, { direction, lanes: false, legend: false, idPrefix: `pills-primary-${direction}-off` });
    const fallback = lanesOff.diagnostics.find((line) => typeof line === "string" && line.includes("[L_mid_root_0]"));
    assert.equal(fallback, undefined, `unexpected fallback for no-lane primary edge in direction=${direction}`);
    const path = findEdgePathById(lanesOff.svg, "L_mid_root_0");
    const label = edgeLabelById(lanesOff.svg, "L_mid_root_0");
    assert.ok(path && path.includes("C"), `no-lane primary edge must remain cubic in direction=${direction}`);
    assert.ok(label, `missing primary edge label in direction=${direction}`);
    const center = {
      x: label.rect.x + (label.rect.w / 2),
      y: label.rect.y + (label.rect.h / 2),
    };
    const distance = minDistanceToPath(path, center);
    assert.ok(distance <= 12, `no-lane primary label drifted from its edge in direction=${direction} (distance=${distance.toFixed(2)})`);
  }
});

test("negative orphan and signal-to-signal specimen fails with actionable diagnostics", () => {
  for (const fixture of NEGATIVE_FIXTURES) {
    const source = readAhmFixture(fixture);
    assert.throws(
      () => renderAhm(source, { direction: "BT", lanes: false }),
      /dangling edge|signal|owner|relationship|unsupported/i,
      `expected actionable failure for ${fixture}`
    );
  }
});

test("disabling legend removes footer while preserving graph geometry", () => {
  const source = readAhmFixture("weird-single-node.mmd");
  const withLegend = renderAhm(source, { direction: "TB", lanes: false, idPrefix: "legend-on" });
  const withoutLegend = renderAhm(source, { direction: "TB", lanes: false, legend: false, idPrefix: "legend-off" });
  assert.match(withLegend.svg, /<g class="ahm-legend"/);
  assert.doesNotMatch(withoutLegend.svg, /<g class="ahm-legend"/);
  assert.ok(withLegend.height > withoutLegend.height, "legend-on should increase height");
  assert.equal(
    collectGeometrySignature(withLegend.svg),
    collectGeometrySignature(withoutLegend.svg),
    "legend toggle should not change graph geometry"
  );
});

for (const dimensions of [
  { label: "integer-width", width: 512, height: 128 },
  { label: "fractional-width", width: 512.5, height: 128 },
]) {
  test(`raster ink bounds avoid false left-edge ink (${dimensions.label})`, () => {
    const ink = rasterInkBounds({
      width: dimensions.width,
      height: dimensions.height,
      viewBox: `0 0 ${dimensions.width} ${dimensions.height}`,
      style: "font:16px sans-serif",
      fill: "#000",
      markup: "<text x=\"180\" y=\"72\" font-size=\"28\">only</text>",
      fontConfig: NATIVE_FONT_CONFIG,
    });
    assert.ok(ink != null, `${dimensions.label}: text should produce visible ink`);
    assert.ok(ink.minX >= 120, `${dimensions.label}: unexpected left-edge ink at x=${ink.minX}`);
    assert.ok(ink.maxX <= dimensions.width - 60, `${dimensions.label}: unexpected right-edge ink at x=${ink.maxX}`);
  });
}

test("theme color changes preserve graph membership and measured geometry", () => {
  const source = readAhmFixture("hero-main.mmd");
  const portal = renderAhm(source, { direction: "LR", lanes: true, theme: "portal", idPrefix: "portal-hero" });
  const midnight = renderAhm(source, { direction: "LR", lanes: true, theme: "midnight", idPrefix: "midnight-hero" });
  assert.notEqual(portal.svg, midnight.svg, "theme change should affect SVG colors");
  assert.equal(
    collectGeometrySignature(portal.svg),
    collectGeometrySignature(midnight.svg),
    "theme change must preserve geometry"
  );
});

test("native glyph coverage renders rocket distinctly from tofu/replacement glyphs", () => {
  assertEmojiNotTofu(NATIVE_FONT_CONFIG, "glyph-coverage");
});

test("native font set resolves unicode specimen codepoints to non-.notdef glyphs", () => {
  const specimen = "日本語サービス🚀 deploys per day = 12 Ünïcödé";
  const codepoints = [...new Set([...specimen].map((ch) => ch.codePointAt(0)).filter((cp) => cp != null))];
  const coverage = assertCodepointsCovered(NATIVE_FONT_CONFIG, codepoints);
  const rocket = coverage.find((entry) => entry.codepoint === 0x1f680);
  assert.ok(rocket?.covered, "U+1F680 should resolve to a non-.notdef glyph");
  assert.match(
    rocket.fontPath,
    /unifont_upper-18\.0\.01\.otf$/,
    `expected rocket fallback to unifont_upper, got ${rocket.fontPath}`
  );
});

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function whitespaceAgnosticPattern(text) {
  return new RegExp(
    escapeRegex(text).replace(/\s+/g, "\\s+"),
    "m"
  );
}

function containsAuthoredText(rendered, authored) {
  if (whitespaceAgnosticPattern(authored).test(rendered)) return true;
  const renderedCompact = String(rendered).replace(/\s+/g, "");
  const authoredCompact = String(authored).replace(/\s+/g, "");
  return renderedCompact.includes(authoredCompact);
}

function idPrefixForFixture(fixture, direction, lanes) {
  const slug = fixture
    .replace(/\.mmd$/i, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
  return `c-${slug}-${direction}-${lanes ? "lanes-on" : "lanes-off"}`;
}
