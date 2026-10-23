import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const COMMAND_RE = /([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;

export function sha256(textOrBuffer) {
  return createHash("sha256").update(textOrBuffer).digest("hex");
}

export function parseViewBox(svg) {
  const match = svg.match(/\bviewBox="([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)"/);
  assert.ok(match, "missing viewBox");
  return {
    minX: Number(match[1]),
    minY: Number(match[2]),
    width: Number(match[3]),
    height: Number(match[4]),
  };
}

export function parseNodeRects(svg) {
  const nodes = [];
  const nodeOpen = /<g class="pele-node[^"]*" data-id="([^"]+)"[^>]*transform="translate\(([^,]+),([^)]+)\)"[^>]*>/g;
  for (const open of svg.matchAll(nodeOpen)) {
    const start = open.index;
    const fullGroup = readBalancedGroup(svg, start);
    if (!fullGroup) continue;
    const id = open[1];
    const tx = Number(open[2]);
    const ty = Number(open[3]);
    const body = fullGroup.slice(fullGroup.indexOf(">") + 1, -4);
    const rect = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    assert.ok(rect, `missing node rect for ${id}`);
    const clipDefs = [...body.matchAll(/<defs class="ahm-node-clips">[\s\S]*?<\/defs>/g)].map((m) => m[0]).join("");
    const textMarkup = clipDefs + [...body.matchAll(/<text[^>]*>[\s\S]*?<\/text>/g)].map((m) => m[0]).join("");
    nodes.push({
      id,
      originX: tx,
      originY: ty,
      x: tx + Number(rect[1]),
      y: ty + Number(rect[2]),
      w: Number(rect[3]),
      h: Number(rect[4]),
      body,
      textMarkup,
    });
  }
  return nodes;
}

function readBalancedGroup(svg, startIndex) {
  const tagRe = /<\/?g\b[^>]*>/g;
  tagRe.lastIndex = startIndex;
  let depth = 0;
  let startSeen = false;
  let start = startIndex;
  let match;
  while ((match = tagRe.exec(svg)) != null) {
    const idx = match.index;
    const tag = match[0];
    if (!startSeen) {
      if (idx !== startIndex || !tag.startsWith("<g")) continue;
      startSeen = true;
      start = idx;
    }
    if (tag.startsWith("</g")) depth -= 1;
    else depth += 1;
    if (startSeen && depth === 0) {
      return svg.slice(start, idx + tag.length);
    }
  }
  return null;
}

export function parseRootSvgMetadata(svg) {
  const root = svg.match(/^<svg\b([^>]*)>/);
  assert.ok(root, "missing svg root");
  const attrs = root[1];
  return {
    width: Number(attrs.match(/\bwidth="([^"]+)"/)?.[1]),
    height: Number(attrs.match(/\bheight="([^"]+)"/)?.[1]),
    viewBox: attrs.match(/\bviewBox="([^"]+)"/)?.[1] ?? "0 0 0 0",
    style: attrs.match(/\bstyle="([^"]+)"/)?.[1] ?? "",
    fill: attrs.match(/\bfill="([^"]+)"/)?.[1] ?? "#242424",
  };
}

export function parseEdgeLabelTargets(svg) {
  const out = [];
  for (const match of svg.matchAll(/<g class="pele-edge-label"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g)) {
    const id = match[1];
    const body = match[2];
    const rect = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"[^>]*>/);
    const text = body.match(/<text[^>]*>[\s\S]*?<\/text>/)?.[0];
    if (!rect || !text) continue;
    out.push({
      id,
      rect: {
        x: Number(rect[1]),
        y: Number(rect[2]),
        w: Number(rect[3]),
        h: Number(rect[4]),
      },
      textMarkup: text,
    });
  }
  return out;
}

export function parseNodeTextLines(node) {
  const lines = [];
  for (const textMatch of node.body.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)) {
    const block = textMatch[1];
    let blockHadTspan = false;
    for (const tspan of block.matchAll(/<tspan([^>]*)>([\s\S]*?)<\/tspan>/g)) {
      blockHadTspan = true;
      const attrs = tspan[1];
      lines.push({
        text: decodeXmlText(stripTags(tspan[2])),
        x: parseOptionalNumber(attrs.match(/\bx="([^"]+)"/)?.[1]),
        y: parseOptionalNumber(attrs.match(/\by="([^"]+)"/)?.[1]),
      });
    }
    if (!blockHadTspan) {
      lines.push({
        text: decodeXmlText(stripTags(block)),
        x: null,
        y: null,
      });
    }
  }
  return lines.filter((line) => line.text.length > 0);
}

function parseOptionalNumber(value) {
  if (value == null) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function stripTags(text) {
  return String(text).replace(/<[^>]+>/g, "");
}

function decodeXmlText(text) {
  return String(text)
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

export function parseEdgeGroups(svg) {
  const edges = [];
  for (const edgeGroup of svg.matchAll(/<g class="pele-edge"([^>]*)>([\s\S]*?)<\/g>/g)) {
    const attrs = edgeGroup[1];
    const body = edgeGroup[2];
    const pathMatch = body.match(/<path\b[^>]*\bd="([^"]+)"/);
    if (!pathMatch) continue;
    edges.push({
      attrs,
      body,
      pathD: pathMatch[1],
    });
  }
  return edges;
}

export function rectsOverlap(a, b, eps = 0.5) {
  return a.x + eps < b.x + b.w &&
    b.x + eps < a.x + a.w &&
    a.y + eps < b.y + b.h &&
    b.y + eps < a.y + a.h;
}

export function assertNoCardOverlap(nodes, contextLabel) {
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      assert.equal(
        rectsOverlap(nodes[i], nodes[j]),
        false,
        `${contextLabel}: node overlap "${nodes[i].id}" and "${nodes[j].id}"`
      );
    }
  }
}

export function assertNodeAndPathInsideViewbox(nodes, edgeGroups, viewBox, contextLabel) {
  const maxX = viewBox.minX + viewBox.width;
  const maxY = viewBox.minY + viewBox.height;
  for (const node of nodes) {
    assert.ok(node.x >= viewBox.minX - 1, `${contextLabel}: node ${node.id} starts left of viewBox`);
    assert.ok(node.y >= viewBox.minY - 1, `${contextLabel}: node ${node.id} starts above viewBox`);
    assert.ok(node.x + node.w <= maxX + 1, `${contextLabel}: node ${node.id} exceeds viewBox width`);
    assert.ok(node.y + node.h <= maxY + 1, `${contextLabel}: node ${node.id} exceeds viewBox height`);
  }

  for (const edge of edgeGroups) {
    const polyline = pathToPolyline(edge.pathD, 24);
    for (const point of polyline) {
      assert.ok(point.x >= viewBox.minX - 1, `${contextLabel}: edge point left of viewBox`);
      assert.ok(point.x <= maxX + 1, `${contextLabel}: edge point right of viewBox`);
      assert.ok(point.y >= viewBox.minY - 1, `${contextLabel}: edge point above viewBox`);
      assert.ok(point.y <= maxY + 1, `${contextLabel}: edge point below viewBox`);
    }
  }
}

export function assertTextContainedInNodes(nodes, contextLabel) {
  for (const node of nodes) {
    const lines = parseNodeTextLines(node);
    for (const line of lines) {
      if (line.y != null) {
        const absoluteY = node.originY + line.y;
        assert.ok(
          absoluteY >= node.y - 1 && absoluteY <= node.y + node.h + 1,
          `${contextLabel}: line "${line.text}" escaped node ${node.id} vertically`
        );
      }
      if (line.x != null) {
        const absoluteX = node.originX + line.x;
        assert.ok(
          absoluteX >= node.x - 1 && absoluteX <= node.x + node.w + 1,
          `${contextLabel}: line "${line.text}" escaped node ${node.id} horizontally`
        );
      }
    }
  }
}

export function assertNoConnectorThroughNonIncidentCards(edgesWithOwners, nodesById, contextLabel) {
  for (const edge of edgesWithOwners) {
    const points = pathToPolyline(edge.pathD, 24);
    for (let i = 0; i < points.length - 1; i++) {
      const a = points[i];
      const b = points[i + 1];
      for (const node of nodesById.values()) {
        if (node.id === edge.from || node.id === edge.to) continue;
        if (segmentIntersectsRectInterior(a, b, node, 0.75)) {
          assert.fail(
            `${contextLabel}: edge ${edge.from}->${edge.to} crosses interior of nonincident node ${node.id}`
          );
        }
      }
    }
  }
}

export function pathToPolyline(pathD, curveSamples = 20) {
  const tokens = [];
  for (const tokenMatch of pathD.matchAll(COMMAND_RE)) {
    tokens.push(tokenMatch[1] ?? Number(tokenMatch[2]));
  }
  const points = [];
  let i = 0;
  let command = "M";
  let current = { x: 0, y: 0 };
  let subpathStart = { x: 0, y: 0 };
  let previousControl = null;

  const readPoint = (relative) => {
    const x = Number(tokens[i++]);
    const y = Number(tokens[i++]);
    if (!relative) return { x, y };
    return { x: current.x + x, y: current.y + y };
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === "string") {
      command = tokens[i++];
    }
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();
    if (op === "M") {
      current = readPoint(relative);
      subpathStart = { ...current };
      points.push({ ...current });
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const next = readPoint(relative);
        appendLine(points, current, next);
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "L") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const next = readPoint(relative);
        appendLine(points, current, next);
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "H") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const x = Number(tokens[i++]);
        const next = { x: relative ? current.x + x : x, y: current.y };
        appendLine(points, current, next);
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "V") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const y = Number(tokens[i++]);
        const next = { x: current.x, y: relative ? current.y + y : y };
        appendLine(points, current, next);
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "C") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c1 = readPoint(relative);
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        appendCubic(points, current, c1, c2, end, curveSamples);
        current = end;
        previousControl = c2;
      }
      continue;
    }
    if (op === "S") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c1 = previousControl ? reflect(current, previousControl) : { ...current };
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        appendCubic(points, current, c1, c2, end, curveSamples);
        current = end;
        previousControl = c2;
      }
      continue;
    }
    if (op === "Q") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c = readPoint(relative);
        const end = readPoint(relative);
        appendQuadratic(points, current, c, end, curveSamples);
        current = end;
        previousControl = c;
      }
      continue;
    }
    if (op === "T") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c = previousControl ? reflect(current, previousControl) : { ...current };
        const end = readPoint(relative);
        appendQuadratic(points, current, c, end, curveSamples);
        current = end;
        previousControl = c;
      }
      continue;
    }
    if (op === "A") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        i += 5;
        const end = readPoint(relative);
        appendLine(points, current, end);
        current = end;
      }
      previousControl = null;
      continue;
    }
    if (op === "Z") {
      appendLine(points, current, subpathStart);
      current = { ...subpathStart };
      previousControl = null;
      continue;
    }
    throw new Error(`unsupported path command ${command}`);
  }

  return dedupePoints(points);
}

function appendLine(points, from, to) {
  if (points.length === 0) points.push({ ...from });
  points.push({ ...to });
}

function appendCubic(points, p0, p1, p2, p3, samples) {
  if (points.length === 0) points.push({ ...p0 });
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = (mt ** 3) * p0.x + 3 * (mt ** 2) * t * p1.x + 3 * mt * (t ** 2) * p2.x + (t ** 3) * p3.x;
    const y = (mt ** 3) * p0.y + 3 * (mt ** 2) * t * p1.y + 3 * mt * (t ** 2) * p2.y + (t ** 3) * p3.y;
    points.push({ x, y });
  }
}

function appendQuadratic(points, p0, p1, p2, samples) {
  if (points.length === 0) points.push({ ...p0 });
  for (let i = 1; i <= samples; i++) {
    const t = i / samples;
    const mt = 1 - t;
    const x = (mt ** 2) * p0.x + 2 * mt * t * p1.x + (t ** 2) * p2.x;
    const y = (mt ** 2) * p0.y + 2 * mt * t * p1.y + (t ** 2) * p2.y;
    points.push({ x, y });
  }
}

function reflect(point, control) {
  return {
    x: 2 * point.x - control.x,
    y: 2 * point.y - control.y,
  };
}

function dedupePoints(points) {
  const out = [];
  for (const point of points) {
    const prev = out[out.length - 1];
    if (!prev || Math.abs(prev.x - point.x) > 1e-9 || Math.abs(prev.y - point.y) > 1e-9) {
      out.push(point);
    }
  }
  return out;
}

function segmentIntersectsRectInterior(a, b, rect, inset = 0.5) {
  const left = rect.x + inset;
  const right = rect.x + rect.w - inset;
  const top = rect.y + inset;
  const bottom = rect.y + rect.h - inset;
  if (left >= right || top >= bottom) return false;
  const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    if (x > left && x < right && y > top && y < bottom) return true;
  }
  return false;
}
