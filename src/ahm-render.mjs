import { createHash } from "node:crypto";
import { parse as peleParse, render as peleRender } from "pele";
import { buildPeleAhmSource, parseAhmSource } from "./health-model.mjs";
import { projectNestedModel } from "./ahm-nested-model.mjs";
import { BASELINE_METRICS, alignPlanToReservationGrid, createAhmTextMeasurer, planEntityCard } from "./ahm-card-plan.mjs";
import { getAhmPalette, stateLabel } from "./ahm-tokens.mjs";
import { getTheme } from "./themes.mjs";
import { projectLabelCenterToRelaxedPath, relaxOrthogonalPath } from "./route-presentation.mjs";

const ALLOWED_OPTION_KEYS = new Set([
  "theme",
  "colors",
  "lanes",
  "direction",
  "legend",
  "idPrefix",
  "fontFamily",
  "fontSize",
  "tableHeaders",
  "limit",
  "maxEdges",
  "outputLimit",
  "nested",
]);
const AHM_LAYOUT_CONFIG = Object.freeze({
  flowchart: Object.freeze({
    nodeSpacing: 88,
    rankSpacing: 140,
  }),
});
const DEFAULT_FONT_FAMILY = "Segoe UI, Arial Unicode MS, Arial, sans-serif";
function normalizePositiveInteger(value, key) {
  if (value == null) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`invalid option "${key}": expected a positive integer`);
  }
  return value;
}

function withStaticRenderDefaults(options = {}) {
  return {
    responsive: false,
    links: false,
    images: false,
    autoDirection: false,
    ...options,
  };
}

function escapeXml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function formatNumber(value) {
  return Number(value.toFixed(2)).toString();
}

function setSvgDimensions(svg, width, height) {
  return svg.replace(/^<svg\b([^>]*)>/, (_full, attrs) => {
    const withoutWidth = attrs.replace(/\swidth="[^"]*"/, "");
    const withoutHeight = withoutWidth.replace(/\sheight="[^"]*"/, "");
    const withoutViewBox = withoutHeight.replace(/\sviewBox="[^"]*"/, "");
    return `<svg${withoutViewBox} viewBox="0 0 ${formatNumber(width)} ${formatNumber(height)}" width="${formatNumber(width)}" height="${formatNumber(height)}">`;
  });
}

function parseTranslate(transformValue) {
  const raw = String(transformValue ?? "").trim();
  if (!raw) return { x: 0, y: 0 };
  const translate = raw.match(/translate\(\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*(?:,\s*|\s+)?([-+]?\d*\.?\d+(?:e[-+]?\d+)?)?\s*\)/i);
  if (translate) {
    return {
      x: Number(translate[1]),
      y: Number(translate[2] ?? 0),
    };
  }
  const matrix = raw.match(/matrix\(\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*[,\s]\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*[,\s]\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*[,\s]\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*[,\s]\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*[,\s]\s*([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*\)/i);
  if (matrix) {
    return { x: Number(matrix[5]), y: Number(matrix[6]) };
  }
  return { x: 0, y: 0 };
}

function extractEdgeLabelRects(svg) {
  const labels = new Map();
  const labelRe = /<g class="pele-edge-label"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/g;
  for (const match of svg.matchAll(labelRe)) {
    const edgeId = match[1];
    const groupMarkup = match[0];
    const body = match[2];
    const openTag = groupMarkup.slice(0, groupMarkup.indexOf(">") + 1);
    const transform = openTag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
    const offset = parseTranslate(transform);
    const rect = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    if (!rect) continue;
    const x = Number(rect[1]) + offset.x;
    const y = Number(rect[2]) + offset.y;
    const w = Number(rect[3]);
    const h = Number(rect[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    labels.set(edgeId, { x, y, w, h });
  }
  return labels;
}

function rectOverlaps(a, b, eps = 0.75) {
  return a.x + eps < b.x + b.w &&
    b.x + eps < a.x + a.w &&
    a.y + eps < b.y + b.h &&
    b.y + eps < a.y + a.h;
}

function pathToPolyline(pathD, curveSamples = 24) {
  const tokens = [];
  for (const tokenMatch of String(pathD).matchAll(/([MmLlHhVvCcSsQqTtAaZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g)) {
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
        points.push({ ...next });
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "L") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const next = readPoint(relative);
        points.push({ ...next });
        current = next;
      }
      previousControl = null;
      continue;
    }
    if (op === "H") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const x = Number(tokens[i++]);
        current = { x: relative ? current.x + x : x, y: current.y };
        points.push({ ...current });
      }
      previousControl = null;
      continue;
    }
    if (op === "V") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const y = Number(tokens[i++]);
        current = { x: current.x, y: relative ? current.y + y : y };
        points.push({ ...current });
      }
      previousControl = null;
      continue;
    }
    if (op === "C") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c1 = readPoint(relative);
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        for (let sample = 1; sample <= curveSamples; sample += 1) {
          const t = sample / curveSamples;
          const mt = 1 - t;
          const x = (mt ** 3) * current.x + 3 * (mt ** 2) * t * c1.x + 3 * mt * (t ** 2) * c2.x + (t ** 3) * end.x;
          const y = (mt ** 3) * current.y + 3 * (mt ** 2) * t * c1.y + 3 * mt * (t ** 2) * c2.y + (t ** 3) * end.y;
          points.push({ x, y });
        }
        current = end;
        previousControl = c2;
      }
      continue;
    }
    if (op === "S") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c1 = previousControl
          ? { x: 2 * current.x - previousControl.x, y: 2 * current.y - previousControl.y }
          : { ...current };
        const c2 = readPoint(relative);
        const end = readPoint(relative);
        for (let sample = 1; sample <= curveSamples; sample += 1) {
          const t = sample / curveSamples;
          const mt = 1 - t;
          const x = (mt ** 3) * current.x + 3 * (mt ** 2) * t * c1.x + 3 * mt * (t ** 2) * c2.x + (t ** 3) * end.x;
          const y = (mt ** 3) * current.y + 3 * (mt ** 2) * t * c1.y + 3 * mt * (t ** 2) * c2.y + (t ** 3) * end.y;
          points.push({ x, y });
        }
        current = end;
        previousControl = c2;
      }
      continue;
    }
    if (op === "Q") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c = readPoint(relative);
        const end = readPoint(relative);
        for (let sample = 1; sample <= curveSamples; sample += 1) {
          const t = sample / curveSamples;
          const mt = 1 - t;
          const x = (mt ** 2) * current.x + 2 * mt * t * c.x + (t ** 2) * end.x;
          const y = (mt ** 2) * current.y + 2 * mt * t * c.y + (t ** 2) * end.y;
          points.push({ x, y });
        }
        current = end;
        previousControl = c;
      }
      continue;
    }
    if (op === "T") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c = previousControl
          ? { x: 2 * current.x - previousControl.x, y: 2 * current.y - previousControl.y }
          : { ...current };
        const end = readPoint(relative);
        for (let sample = 1; sample <= curveSamples; sample += 1) {
          const t = sample / curveSamples;
          const mt = 1 - t;
          const x = (mt ** 2) * current.x + 2 * mt * t * c.x + (t ** 2) * end.x;
          const y = (mt ** 2) * current.y + 2 * mt * t * c.y + (t ** 2) * end.y;
          points.push({ x, y });
        }
        current = end;
        previousControl = c;
      }
      continue;
    }
    if (op === "A") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        i += 5;
        const end = readPoint(relative);
        points.push({ ...end });
        current = end;
      }
      previousControl = null;
      continue;
    }
    if (op === "Z") {
      points.push({ ...subpathStart });
      current = { ...subpathStart };
      previousControl = null;
      continue;
    }
    throw new Error(`unsupported path command ${command}`);
  }
  return points;
}

function replacePrimaryEdgePath(svg, edgeId, pathData) {
  const edgeGroupRe = new RegExp(`(<g class="pele-edge"[^>]*data-id="${edgeId}"[^>]*>[\\s\\S]*?<path(?![^>]*class="pele-marker")[^>]*\\bd=")([^"]+)("[^>]*>)`);
  return svg.replace(edgeGroupRe, (_full, prefix, _old, suffix) => `${prefix}${pathData}${suffix}`);
}

function withStateClass(attrs, state) {
  const stateClass = `state-${state}`;
  const classMatch = attrs.match(/\sclass="([^"]*)"/);
  if (!classMatch) return `${attrs} class="${stateClass}"`;
  const classes = classMatch[1].split(/\s+/).filter(Boolean);
  if (!classes.includes(stateClass)) classes.push(stateClass);
  return attrs.replace(/\sclass="[^"]*"/, ` class="${classes.join(" ")}"`);
}

function renderCellText({
  className,
  lines,
  x,
  y,
  fontSize,
  fill,
  clipId,
  fontWeight,
  lineHeight,
}) {
  const clipAttr = clipId ? ` clip-path="url(#${clipId})"` : "";
  const weightAttr = fontWeight != null ? ` font-weight="${fontWeight}"` : "";
  const parts = [`<text class="${className}" x="${formatNumber(x)}" y="${formatNumber(y)}" font-size="${fontSize}" fill="${fill}" text-anchor="start"${weightAttr}${clipAttr}>`];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const lineY = y + ((lineHeight ?? (fontSize * 1.15)) * i);
    parts.push(`<tspan x="${formatNumber(x)}" y="${formatNumber(lineY)}">${escapeXml(line)}</tspan>`);
  }
  parts.push("</text>");
  return { markup: parts.join(""), lineCount: lines.length };
}

function centeredFirstBaseline({ top, height, fontSize, lineCount, lineHeight }) {
  const ascent = fontSize * BASELINE_METRICS.ascentRatio;
  const descent = fontSize * BASELINE_METRICS.descentRatio;
  const textBlockHeight = ascent + descent + Math.max(0, lineCount - 1) * lineHeight;
  const textTop = top + Math.max(0, (height - textBlockHeight) / 2);
  return textTop + ascent;
}

function makeReservationFontSize(userFontSize) {
  const base = Number.isFinite(userFontSize) ? userFontSize : 16;
  return Math.max(1, base / 8);
}

function escapeClassContent(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function escapeLabel(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function modelCardNodeId(modelId) {
  return `ahm_model_${String(modelId).replace(/[^\w-]/g, "_")}`;
}

function wrapHeaderLine(value, maxLineLength = 34) {
  const out = [];
  let remaining = String(value ?? "");
  while (remaining.length > maxLineLength) {
    const splitAt = remaining.lastIndexOf(" ", maxLineLength);
    const cut = splitAt > 10 ? splitAt : maxLineLength;
    out.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  out.push(remaining);
  return out;
}

function buildNestedRenderArtifacts({ parsed, canonicalModel, nestedProjection, options, palette, reservationLabels = null }) {
  const direction = String(options.direction ?? canonicalModel.direction ?? "BT").toUpperCase();
  const lanesOn = options.lanes === true;
  const modelById = new Map((nestedProjection.trace.models ?? []).map((item) => [item.id, item]));
  const entityById = new Map(canonicalModel.entities.map((entity) => [entity.id, entity]));
  const traceEntities = new Map((nestedProjection.trace.entities ?? []).map((item) => [item.id, item]));
  const displayedModels = nestedProjection.projection.displayed.models ?? [];
  const displayedEntities = nestedProjection.projection.displayed.entities ?? [];
  const displayedModelSet = new Set(displayedModels);
  const displayedEntitySet = new Set(displayedEntities);
  const subgraphById = new Map((parsed.subgraphs ?? []).map((subgraph) => [subgraph.id, subgraph]));
  const subgraphChildren = new Map();
  const parentBySubgraph = new Map();
  for (const subgraph of parsed.subgraphs ?? []) {
    for (const member of subgraph.nodes ?? []) {
      if (!subgraphById.has(member)) continue;
      parentBySubgraph.set(member, subgraph.id);
      if (!subgraphChildren.has(subgraph.id)) subgraphChildren.set(subgraph.id, []);
      subgraphChildren.get(subgraph.id).push(member);
    }
  }

  const lines = [];
  lines.push(`flowchart ${direction}`);
  const entityClassDef = (state) => {
    const token = palette.entity[state];
    const parts = [
      `fill:${token.fill}`,
      `stroke:${token.border}`,
      "stroke-width:2px",
      `color:${palette.canvas.ink}`,
    ];
    if (token.dash) parts.push(`stroke-dasharray:${token.dash}`);
    return `classDef ahm_${state} ${parts.join(",")};`;
  };
  lines.push(entityClassDef("healthy"));
  lines.push(entityClassDef("degraded"));
  lines.push(entityClassDef("unhealthy"));
  lines.push(entityClassDef("unknown"));
  lines.push(entityClassDef("standby"));
  lines.push(`classDef ahm_card font-size:${formatNumber(makeReservationFontSize(options.fontSize))}px;`);

  const renderNodes = [];
  const pushEntityNode = (entityId) => {
    const entity = entityById.get(entityId);
    if (!entity) return;
    let nodeLabel = reservationLabels?.get(entity.id);
    if (nodeLabel == null) {
      const labelLines = [entity.presentation?.title ?? entity.label ?? ""];
      if (entity.presentation?.qualifier) labelLines.push(entity.presentation.qualifier);
      if ((entity.signals?.length ?? 0) > 0) {
        entity.signals.forEach((row, idx) => {
          const value = row.valueKind === "missing" ? "∅" : row.valueKind === "empty" ? "[empty]" : (row.value ?? "");
          labelLines.push(`row ${idx + 1} ${row.name} = ${value} (${stateLabel(row.state)})`);
        });
      }
      nodeLabel = labelLines.join("\n");
    }
    lines.push(`${entity.id}["${escapeLabel(nodeLabel)}"]`);
    lines.push(`class ${entity.id} ahm_${entity.state};`);
    lines.push(`class ${entity.id} ahm_card;`);
    renderNodes.push(entity);
  };
  const pushModelNode = (modelId) => {
    const model = modelById.get(modelId);
    if (!model) return;
    const nodeId = modelCardNodeId(model.id);
    const detail = model.detailRef ? `detailRef: ${model.detailRef}` : "detailRef: n/a";
    const label = [
      `${model.name}`,
      `modelId: ${model.id}`,
      detail,
    ];
    const nodeLabel = reservationLabels?.get(nodeId) ?? label.join("\n");
    lines.push(`${nodeId}["${escapeLabel(nodeLabel)}"]`);
    lines.push(`class ${nodeId} ahm_${model.state};`);
    lines.push(`class ${nodeId} ahm_card;`);
    renderNodes.push({
      id: nodeId,
      label: model.name,
      state: model.state,
      presentation: { title: model.name, qualifier: `${model.id}${model.detailRef ? ` | ${model.detailRef}` : ""}` },
      signals: [],
    });
  };

  const modelHeaderLinesById = {};

  if (nestedProjection.projection.mode === "collapsed") {
    const laneRoles = nestedProjection.projection.topLevelRoles ?? [];
    if (lanesOn && laneRoles.some((role) => role.role === "lane")) {
      const emittedModelIds = new Set();
      const emittedEntityIds = new Set();
      let laneIndex = 0;
      for (const lane of laneRoles.filter((item) => item.role === "lane")) {
        lines.push(`subgraph lane_${laneIndex}["${escapeClassContent(lane.label)}"]`);
        for (const modelId of displayedModels) {
          const topLevelGroupId = modelById.get(modelId)?.topLevelGroupId;
          if (topLevelGroupId !== lane.id) continue;
          pushModelNode(modelId);
          emittedModelIds.add(modelId);
        }
        for (const entityId of displayedEntities) {
          const topLevelGroupId = traceEntities.get(entityId)?.topLevelGroupId;
          if (topLevelGroupId !== lane.id) continue;
          pushEntityNode(entityId);
          emittedEntityIds.add(entityId);
        }
        lines.push("end");
        laneIndex += 1;
      }
      for (const modelId of displayedModels) {
        if (emittedModelIds.has(modelId)) continue;
        pushModelNode(modelId);
      }
      for (const entityId of displayedEntities) {
        if (emittedEntityIds.has(entityId)) continue;
        pushEntityNode(entityId);
      }
    } else {
      for (const modelId of displayedModels) pushModelNode(modelId);
      for (const entityId of displayedEntities) pushEntityNode(entityId);
    }
  } else {
    const modelChildren = new Map();
    for (const model of nestedProjection.trace.models ?? []) {
      if (!displayedModelSet.has(model.id)) continue;
      const parentKey = model.parentId && displayedModelSet.has(model.parentId) ? model.parentId : "__root__";
      if (!modelChildren.has(parentKey)) modelChildren.set(parentKey, []);
      modelChildren.get(parentKey).push(model.id);
    }
    const emitModelGroup = (modelId) => {
      const model = modelById.get(modelId);
      if (!model) return;
      const detailRef = model.detailRef ? model.detailRef : "n/a";
      const headerLines = [
        ...wrapHeaderLine(model.name),
        `[${stateLabel(model.state)}]`,
        ...wrapHeaderLine(`id: ${model.id}`),
        ...String(detailRef).split(/\r?\n/).flatMap((line, index) => wrapHeaderLine(`${index === 0 ? "ref" : "↳"}: ${line}`)),
      ];
      modelHeaderLinesById[model.id] = headerLines;
      // the header made safe for a quoted subgraph title
      const headerLabel = headerLines
        .map((line) => String(line ?? "")
          .replaceAll("\\", "⧵")
          .replaceAll('"', "＂")
          .replaceAll("[", "［")
          .replaceAll("]", "］")
          .replaceAll("<", "‹")
          .replaceAll(">", "›"))
        .join("\n");
      lines.push(`subgraph ${model.id}["${escapeClassContent(headerLabel)}"]`);
      for (const entityId of model.directEntityIds ?? []) {
        if (displayedEntitySet.has(entityId)) pushEntityNode(entityId);
      }
      for (const childModelId of modelChildren.get(model.id) ?? []) emitModelGroup(childModelId);
      lines.push("end");
    };

    const rootModels = modelChildren.get("__root__") ?? [];
    const laneRoles = nestedProjection.projection.topLevelRoles ?? [];
    if (lanesOn && laneRoles.some((role) => role.role === "lane")) {
      let laneIndex = 0;
      const emittedRootModelIds = new Set();
      for (const lane of laneRoles.filter((item) => item.role === "lane")) {
        lines.push(`subgraph lane_${laneIndex}["${escapeClassContent(lane.label)}"]`);
        for (const modelId of rootModels) {
          const topLevelGroupId = modelById.get(modelId)?.topLevelGroupId;
          if (topLevelGroupId === lane.id) {
            emitModelGroup(modelId);
            emittedRootModelIds.add(modelId);
          }
        }
        for (const entityId of displayedEntities) {
          const topLevelGroupId = traceEntities.get(entityId)?.topLevelGroupId;
          if (topLevelGroupId === lane.id && !traceEntities.get(entityId)?.nearestModelId) {
            pushEntityNode(entityId);
          }
        }
        lines.push("end");
        laneIndex += 1;
      }
      for (const modelId of rootModels) {
        if (!emittedRootModelIds.has(modelId)) emitModelGroup(modelId);
      }
    } else {
      for (const modelId of rootModels) emitModelGroup(modelId);
    }

    const modeledEntityIds = new Set(
      (nestedProjection.trace.models ?? []).flatMap((model) => model.directEntityIds ?? [])
    );
    for (const entityId of displayedEntities) {
      if (!modeledEntityIds.has(entityId)) pushEntityNode(entityId);
    }
  }

  const endpointToNodeId = (endpointId) => {
    if (nestedProjection.projection.mode === "collapsed" && (displayedModelSet.has(endpointId) || modelById.has(endpointId))) {
      return modelCardNodeId(endpointId);
    }
    return endpointId;
  };

  const renderedRelationships = nestedProjection.projection.relationships ?? [];
  const modelParentById = new Map(
    (nestedProjection.trace.models ?? []).map((model) => [model.id, model.parentId ?? model.nearestModelParentId ?? null])
  );
  const nearestModelForEntity = new Map(
    (nestedProjection.trace.entities ?? []).map((entity) => [entity.id, entity.nearestModelId ?? null])
  );
  const endpointModelId = (endpointId) => {
    if (modelById.has(endpointId)) return endpointId;
    return nearestModelForEntity.get(endpointId) ?? null;
  };
  const isStrictModelAncestor = (maybeAncestorId, modelId) => {
    let cursor = modelParentById.get(modelId) ?? null;
    while (cursor) {
      if (cursor === maybeAncestorId) return true;
      cursor = modelParentById.get(cursor) ?? null;
    }
    return false;
  };
  const diagnostics = [];
  const edgeSourceStates = [];
  let emittedEdgeIndex = 0;
  const isExpandedOrDetail = nestedProjection.projection.mode === "expanded" || nestedProjection.projection.mode === "detail";
  if (isExpandedOrDetail) {
    const firstModelSelfEdge = renderedRelationships.find((dep) => dep.from === dep.to && displayedModelSet.has(dep.from));
    if (firstModelSelfEdge) {
      throw new Error(`unsupported-model-group-self-edge:${firstModelSelfEdge.from}:${nestedProjection.projection.mode}`);
    }
  }
  renderedRelationships.forEach((dep) => {
    const fromIsModelEndpoint = modelById.has(dep.from);
    const toIsModelEndpoint = modelById.has(dep.to);
    if (isExpandedOrDetail && (fromIsModelEndpoint || toIsModelEndpoint)) {
      const fromModelId = endpointModelId(dep.from);
      const toModelId = endpointModelId(dep.to);
      if (fromModelId && toModelId && fromModelId !== toModelId) {
        const ancestorPair = isStrictModelAncestor(fromModelId, toModelId) || isStrictModelAncestor(toModelId, fromModelId);
        if (ancestorPair) {
          throw new Error(`unsupported-model-group-ancestor-edge:${dep.from}:${dep.to}:${nestedProjection.projection.mode}`);
        }
      }
    }

    const fromNode = endpointToNodeId(dep.from);
    const toNode = endpointToNodeId(dep.to);
    const connector = dep.dashed ? "-.->" : "-->";
    const label = dep.label ? `|"${escapeClassContent(dep.label)}"|` : "";
    lines.push(`${fromNode} ${connector} ${label}${toNode}`.replace(/\s+/g, " ").trim());
    const sourceState = dep.sourceState ?? "unknown";
    const color = palette.entity[sourceState]?.accent ?? palette.entity.unknown.accent;
    lines.push(`linkStyle ${emittedEdgeIndex} stroke:${color},stroke-width:2px;`);
    emittedEdgeIndex += 1;
    edgeSourceStates.push(sourceState);
  });

  const generatedSource = lines.join("\n");
  const trace = {
    ...nestedProjection.trace,
    projectionMode: nestedProjection.projection.mode,
    projectionDisplayed: nestedProjection.projection.displayed,
    topLevelRoles: nestedProjection.projection.topLevelRoles,
    modelHeaderLinesById,
  };
  return {
    source: generatedSource,
    diagnostics,
    renderNodes,
    trace,
    edgeSourceStates,
  };
}

export function renderAhm(source, options = {}) {
  // options: a plain object of known keys with valid values
  if (options == null || Array.isArray(options) || typeof options !== "object") {
    throw new Error('invalid options: expected an object');
  }
  for (const key of Object.keys(options)) {
    if (key === "config") throw new Error('unsupported option "config": dynamic render config is not allowed');
    if (!ALLOWED_OPTION_KEYS.has(key)) throw new Error(`unknown option "${key}"`);
  }
  if (options.direction != null && typeof options.direction !== "string") {
    throw new Error('invalid option "direction": expected string');
  }
  if (options.lanes != null && typeof options.lanes !== "boolean") {
    throw new Error('invalid option "lanes": expected boolean');
  }
  if (options.legend != null && typeof options.legend !== "boolean") {
    throw new Error('invalid option "legend": expected boolean');
  }
  if (options.idPrefix != null && (typeof options.idPrefix !== "string" || !/^[A-Za-z][\w:-]*$/.test(options.idPrefix))) {
    throw new Error('invalid option "idPrefix": expected identifier pattern [A-Za-z][\\w:-]*');
  }
  if (options.fontSize != null && (!Number.isFinite(options.fontSize) || options.fontSize <= 0)) {
    throw new Error('invalid option "fontSize": expected a positive finite number');
  }
  if (options.tableHeaders != null && typeof options.tableHeaders !== "boolean") {
    throw new Error('invalid option "tableHeaders": expected boolean');
  }
  if (options.nested != null && (!options.nested || typeof options.nested !== "object" || Array.isArray(options.nested))) {
    throw new Error('invalid option "nested": expected object');
  }
  normalizePositiveInteger(options.limit, "limit");
  normalizePositiveInteger(options.maxEdges, "maxEdges");
  normalizePositiveInteger(options.outputLimit, "outputLimit");
  // font family: a comma list of plain or quoted family names
  let fontFamily = DEFAULT_FONT_FAMILY;
  if (options.fontFamily != null) {
    if (typeof options.fontFamily !== "string") {
      throw new Error('invalid option "fontFamily": expected a non-empty string');
    }
    const raw = String(options.fontFamily).trim();
    if (raw === "") {
      throw new Error('invalid option "fontFamily": expected a non-empty string');
    }
    const names = raw.split(",").map((part) => part.trim()).filter(Boolean);
    if (names.length === 0) {
      throw new Error('invalid option "fontFamily": expected at least one family name');
    }
    fontFamily = names.map((name) => {
      if ((name.startsWith("\"") && name.endsWith("\"")) || (name.startsWith("'") && name.endsWith("'"))) {
        const inner = name.slice(1, -1);
        if (!/^[\w .-]+$/.test(inner)) throw new Error('invalid option "fontFamily": unsupported characters in family name');
        return `"${inner}"`;
      }
      if (!/^[\w .-]+$/.test(name)) throw new Error('invalid option "fontFamily": unsupported characters in family name');
      return name;
    }).join(", ");
  }
  const requestedFontSize = Number.isFinite(options.fontSize) ? options.fontSize : 16;
  const typography = {
    requested: requestedFontSize,
    scale: requestedFontSize / 16,
    fontFamily,
  };
  const idPrefix = options.idPrefix || `ahm-${createHash("sha256").update(String(source)).digest("hex").slice(0, 10)}`;
  const diagnostics = [];
  try {
    peleParse(source, { limit: options.limit, maxEdges: options.maxEdges });
  } catch (error) {
    throw new Error(`source parse failed: ${error.message}`);
  }

  const model = parseAhmSource(source, {
    ...options,
    allowGroupEndpoints: options.nested != null,
  });
  const textMeasurer = createAhmTextMeasurer();
  const reservationFontSize = makeReservationFontSize(options.fontSize);
  // calibrate Pele's card box from 1- and 2-line probes: line height and vertical/horizontal padding
  const probeId = "ahm_probe_node";
  const probeWidth = 100;
  const renderProbe = (lineCount) => {
    const lines = [];
    for (let i = 0; i < lineCount; i += 1) lines.push(`probe_${lineCount}_${i}`);
    const probeSource = [
      "flowchart LR",
      `classDef ahm_card font-size:${formatNumber(reservationFontSize)}px;`,
      `${probeId}["${lines.join("\\n")}"]`,
      `class ${probeId} ahm_card;`,
    ].join("\n");
    const probe = peleRender(probeSource, withStaticRenderDefaults({
      config: AHM_LAYOUT_CONFIG,
      measurer: {
        width() {
          return probeWidth;
        },
      },
    }));
    const match = probe.svg.match(new RegExp(`<g class="pele-node[^"]*" data-id="${probeId}"[^>]*>[\\s\\S]*?<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"`));
    if (!match) return null;
    return {
      x: Number(match[1]),
      y: Number(match[2]),
      width: Number(match[3]),
      height: Number(match[4]),
    };
  };
  const one = renderProbe(1);
  const two = renderProbe(2);
  if (!one || !two) throw new Error("render failed: unable to calibrate card reservation metrics");
  const probeLineHeight = Math.max(1, two.height - one.height);
  const calibration = {
    lineHeight: probeLineHeight,
    padY: Math.max(0, one.height - probeLineHeight),
    padX: Math.max(0, one.width - probeWidth),
  };
  let generated;
  let renderNodes = model.entities;
  let nestedTrace = null;
  let edgeSourceStates = model.dependencies.map((dep) => {
    const sourceEntity = model.entities.find((entity) => entity.id === dep.from);
    return sourceEntity?.state ?? "unknown";
  });
  let nestedInputs = null;
  if (options.nested) {
    const parsed = peleParse(source, { limit: options.limit, maxEdges: options.maxEdges });
    const nestedProjection = projectNestedModel({
      canonical: model,
      parsed,
      nested: options.nested,
    });
    nestedInputs = {
      parsed,
      canonicalModel: model,
      nestedProjection,
      options,
      palette: getAhmPalette(options.theme ?? "portal", options.colors),
    };
    const nestedArtifacts = buildNestedRenderArtifacts(nestedInputs);
    generated = nestedArtifacts;
    renderNodes = nestedArtifacts.renderNodes;
    nestedTrace = nestedArtifacts.trace;
    edgeSourceStates = nestedArtifacts.edgeSourceStates;
  }

  const planByEntity = new Map(renderNodes.map((entity) => {
    const rawPlan = planEntityCard(entity, textMeasurer, {
      fontSize: options.fontSize,
      tableHeaders: options.tableHeaders,
    });
    return [entity.id, alignPlanToReservationGrid(rawPlan, calibration)];
  }));
  // reservation labels: placeholder lines that make Pele reserve each card's planned height
  const reservationLabels = new Map();
  const reservationPrefix = String(idPrefix).replace(/[^\w-]/g, "_");
  for (let i = 0; i < renderNodes.length; i += 1) {
    const entity = renderNodes[i];
    const plan = planByEntity.get(entity.id);
    if (!plan) continue;
    const estimated = Math.ceil(Math.max(1, plan.cardHeight - calibration.padY) / calibration.lineHeight);
    const bounded = Math.max(1, Math.min(estimated, Math.max(1, Math.ceil(plan.semanticLineCount * 8))));
    const lines = [];
    for (let line = 0; line < bounded; line += 1) lines.push(`${reservationPrefix}_${i}_l${line}`);
    reservationLabels.set(entity.id, lines.join("\n"));
  }
  const reservationWidths = new Map();
  for (const [entityId, label] of reservationLabels.entries()) {
    const plan = planByEntity.get(entityId);
    if (!plan) continue;
    for (const token of label.split("\n")) {
      reservationWidths.set(token, Math.max(1, plan.cardWidth - calibration.padX));
    }
  }
  if (nestedInputs) {
    generated = buildNestedRenderArtifacts({
      ...nestedInputs,
      reservationLabels,
    });
    nestedTrace = generated.trace;
    edgeSourceStates = generated.edgeSourceStates;
  } else if (!generated) {
    generated = buildPeleAhmSource(model, {
      ...options,
      reservation: {
        classDef: `classDef ahm_card font-size:${formatNumber(reservationFontSize)}px;`,
        entityLabels: reservationLabels,
      },
    });
  }
  diagnostics.push(...generated.diagnostics);
  // size budget for the generated source: the largest of the authored, generated and limit budgets
  const authoredLength = String(source ?? "").length;
  const generatedLength = String(generated.source ?? "").length;
  const generatedLimit = Math.max(
    authoredLength + Math.max(1024, Math.ceil(authoredLength * 0.5)),
    generatedLength + Math.max(1024, Math.ceil(generatedLength * 0.25)),
    Number.isInteger(options.limit) && options.limit > 0
      ? options.limit + Math.max(1024, Math.ceil(options.limit * 0.5))
      : 0,
  );

  try {
    peleParse(generated.source, { limit: generatedLimit, maxEdges: options.maxEdges });
  } catch (error) {
    throw new Error(`generated source parse failed: ${error.message}`);
  }

  let rendered;
  try {
    rendered = peleRender(generated.source, withStaticRenderDefaults({
      fontFamily: typography.fontFamily,
      fontSize: typography.requested,
      idPrefix,
      limit: generatedLimit,
      maxEdges: options.maxEdges,
      outputLimit: options.outputLimit,
      config: AHM_LAYOUT_CONFIG,
      measurer: {
        width(text, size, style) {
          if (typeof text === "string" && reservationWidths.has(text)) return reservationWidths.get(text);
          return textMeasurer.width(text, size, style);
        },
      },
    }));
  } catch (error) {
    throw new Error(`render failed: ${error.message}`);
  }

  const palette = getAhmPalette(options.theme ?? "portal", options.colors);

  // Theme pass: resolve Pele's CSS variables to theme colors, then draw the signal tables, model
  // headers, source-state colored (and where safe relaxed) routes and their projected labels.
  let out = rendered.svg;

  const theme = getTheme(options.theme ?? "portal");
  const replacements = new Map([
    ["var(--pele-bg,#fff)", theme.bg],
    ["var(--pele-fg,#1f1f1f)", theme.ink],
    ["var(--pele-muted,#6e6e6e)", theme.muted],
    ["var(--pele-line,#1f1f1f)", theme.muted],
    ["var(--pele-surface,#f3f3f3)", theme.bg],
    ["var(--pele-surface-alt,#e6e6e6)", theme.band],
    ["var(--pele-border,#8a8a8a)", theme.hair],
    ["var(--pele-accent,#5b7bd5)", theme.state.signal.dot],
    ["var(--pele-font,sans-serif)", typography.fontFamily],
    ["var(--pele-font-mono,monospace)", "SFMono-Regular, Menlo, monospace"],
    ["var(--pele-radius,4px)", "4px"],
    ["var(--_bg)", theme.bg],
    ["var(--_fg)", theme.ink],
    ["var(--_m)", theme.muted],
    ["var(--_l)", theme.muted],
    ["var(--_s)", theme.bg],
    ["var(--_a)", theme.band],
    ["var(--_b)", theme.hair],
    ["var(--_c)", theme.state.signal.dot],
    ["var(--_r)", "4px"],
    ["var(--_fm)", "SFMono-Regular, Menlo, monospace"],
  ]);
  for (const [from, to] of replacements.entries()) out = out.replaceAll(from, to);
  out = out.replace(/<svg\b([^>]*)>/, `<svg$1><rect class="ahm-bg" x="0" y="0" width="100%" height="100%" fill="${palette.canvas.bg}"/>`);

  const signalColorByState = new Map([
    ["Healthy", palette.signal.healthy.accent],
    ["Degraded", palette.signal.degraded.accent],
    ["Unhealthy", palette.signal.unhealthy.accent],
    ["Unknown", palette.signal.unknown.accent],
  ]);
  for (const [stateLabel, color] of signalColorByState.entries()) {
    const linePattern = new RegExp(`<tspan([^>]*)>([^<]*\\(${stateLabel}\\)[^<]*)<\\/tspan>`, "g");
    out = out.replace(linePattern, (_full, attrs, body) => `<tspan${withStateClass(attrs, stateLabel.toLowerCase())} fill="${color}">${body}</tspan>`);
  }

  for (const entity of renderNodes) {
    const nodeGroupPattern = new RegExp(`(<g class="pele-node[^"]*" data-id="${entity.id}"[^>]*>)([\\s\\S]*?)(<\\/g>)`, "g");
    out = out.replace(nodeGroupPattern, (_full, open, body, close) => {
      const plan = planByEntity.get(entity.id);
      if (!plan) return `${open}${body}${close}`;
      // the card content: header (title, qualifier, status badge) and the Signal/Value/State table
      const rectMatch = body.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"[^>]*>/);
      if (!rectMatch) return `${open}${body}${close}`;
      const rect = {
        x: Number(rectMatch[1]),
        y: Number(rectMatch[2]),
        w: Number(rectMatch[3]),
        h: Number(rectMatch[4]),
      };
      const padX = plan.constants.sidePad;
      const headerTextColor = palette.canvas.muted;
      const valueColor = palette.canvas.ink;
      const borderColor = palette.entity[entity.state].border;
      const contentX = rect.x + padX;
      const tableW = plan.contentWidth;
      const entityKey = `${String(idPrefix ?? "ahm").replace(/[^\w-]/g, "_")}_${entity.id.replace(/[^\w-]/g, "_")}`;
      const entityState = entity.state;
      let cursorY = rect.y + plan.tableY;

      const header = [];
      const clipDefs = [];
      header.push(`<g class="ahm-entity-header entity-state-${entityState}">`);
      const titleCell = renderCellText({
        className: "ahm-entity-title",
        lines: plan.titleLines,
        x: contentX,
        y: rect.y + plan.titleY,
        fontSize: plan.constants.titleSize,
        fontWeight: 700,
        lineHeight: plan.constants.titleLineHeight,
        fill: palette.canvas.ink,
      });
      header.push(titleCell.markup);
      if (plan.qualifierLines.length > 0) {
        const qualifier = renderCellText({
          className: "ahm-entity-qualifier",
          lines: plan.qualifierLines,
          x: contentX,
          y: rect.y + plan.qualifierY,
          fontSize: plan.constants.qualifierSize,
          fontWeight: 500,
          lineHeight: plan.constants.bodyLineHeight,
          fill: palette.canvas.muted,
        });
        header.push(qualifier.markup);
      }
      header.push(`<rect class="ahm-entity-status-badge entity-state-${entityState}" x="${formatNumber(contentX + plan.badgeX)}" y="${formatNumber(rect.y + plan.badgeY)}" width="${formatNumber(plan.badgeWidth)}" height="${formatNumber(plan.constants.badgeHeight)}" rx="${formatNumber(plan.constants.badgeRadius)}" ry="${formatNumber(plan.constants.badgeRadius)}" fill="${palette.entity[entityState].fill}" stroke="${palette.entity[entityState].border}" stroke-width="1.2"/>`);
      const badgeTextBaseline = centeredFirstBaseline({
        top: rect.y + plan.badgeY,
        height: plan.constants.badgeHeight,
        fontSize: plan.constants.badgeSize,
        lineCount: 1,
        lineHeight: plan.constants.bodyLineHeight,
      });
      header.push(`<text class="ahm-entity-status-text entity-state-${entityState}" x="${formatNumber(contentX + plan.badgeX + Math.max(plan.constants.cellPadX, plan.constants.badgeSize * 0.75))}" y="${formatNumber(badgeTextBaseline)}" font-size="${plan.constants.badgeSize}" font-weight="600" fill="${palette.entity[entityState].accent}" text-anchor="start">${escapeXml(plan.badgeText)}</text>`);
      header.push("</g>");

      if (plan.rows.length === 0) {
        const plainMarkup = `<g class="ahm-node-content"><defs class="ahm-node-clips">${clipDefs.join("")}</defs>${header.join("")}</g>`;
        return `${open}${body.replace(/<text class="pele-label"[\s\S]*?<\/text>/, () => plainMarkup)}${close}`;
      }

      const tableX = contentX;
      const nameW = plan.columns.name;
      const valueW = plan.columns.value;
      const stateW = plan.columns.state;
      const valueX = tableX + nameW;
      const stateX = valueX + valueW;

      const rows = [];
      const tableHeaderY = rect.y + plan.tableY;
      rows.push(`<g class="ahm-signal-table">`);
      if (plan.tableHeaders) {
        rows.push(`<g class="ahm-signal-table-header">`);
        rows.push(`<rect x="${formatNumber(tableX)}" y="${formatNumber(tableHeaderY)}" width="${formatNumber(tableW)}" height="${formatNumber(plan.constants.tableHeaderHeight)}" fill="${palette.canvas.bg}" stroke="${borderColor}" stroke-width="1"/>`);
        rows.push(`<line class="ahm-signal-col-sep" x1="${formatNumber(valueX)}" y1="${formatNumber(tableHeaderY)}" x2="${formatNumber(valueX)}" y2="${formatNumber(tableHeaderY + plan.constants.tableHeaderHeight)}" stroke="${borderColor}" stroke-width="1"/>`);
        rows.push(`<line class="ahm-signal-col-sep" x1="${formatNumber(stateX)}" y1="${formatNumber(tableHeaderY)}" x2="${formatNumber(stateX)}" y2="${formatNumber(tableHeaderY + plan.constants.tableHeaderHeight)}" stroke="${borderColor}" stroke-width="1"/>`);
        const headerBaseline = centeredFirstBaseline({
          top: tableHeaderY,
          height: plan.constants.tableHeaderHeight,
          fontSize: plan.constants.headerSize,
          lineCount: 1,
          lineHeight: plan.constants.bodyLineHeight,
        });
        rows.push(`<text x="${formatNumber(tableX + plan.constants.cellPadX)}" y="${formatNumber(headerBaseline)}" font-size="${plan.constants.headerSize}" font-weight="600" fill="${headerTextColor}" text-anchor="start">Signal</text>`);
        rows.push(`<text x="${formatNumber(valueX + plan.constants.cellPadX)}" y="${formatNumber(headerBaseline)}" font-size="${plan.constants.headerSize}" font-weight="600" fill="${headerTextColor}" text-anchor="start">Value</text>`);
        rows.push(`<text x="${formatNumber(stateX + plan.constants.cellPadX)}" y="${formatNumber(headerBaseline)}" font-size="${plan.constants.headerSize}" font-weight="600" fill="${headerTextColor}" text-anchor="start">State</text>`);
        rows.push(`</g>`);
        cursorY += plan.constants.tableHeaderHeight;
      }

      for (const rowPlan of plan.rows) {
        const stateToken = palette.signal[rowPlan.row.state];
        const clipBase = `${entityKey}-r${rowPlan.i}`;
        const nameClipId = `ahm-clip-${clipBase}-name`;
        const valueClipId = `ahm-clip-${clipBase}-value`;
        const stateClipId = `ahm-clip-${clipBase}-state`;
        const nameCell = renderCellText({
          className: "ahm-signal-name",
          lines: rowPlan.nameLines,
          x: tableX + plan.constants.cellPadX,
          y: centeredFirstBaseline({
            top: cursorY,
            height: rowPlan.rowHeight,
            fontSize: plan.constants.bodySize,
            lineCount: rowPlan.nameLines.length,
            lineHeight: plan.constants.bodyLineHeight,
          }),
          fontSize: plan.constants.bodySize,
          fontWeight: 500,
          lineHeight: plan.constants.bodyLineHeight,
          fill: valueColor,
          clipId: nameClipId,
        });
        const valueCell = renderCellText({
          className: "ahm-signal-value",
          lines: rowPlan.valueLines,
          x: valueX + plan.constants.cellPadX,
          y: centeredFirstBaseline({
            top: cursorY,
            height: rowPlan.rowHeight,
            fontSize: plan.constants.bodySize,
            lineCount: rowPlan.valueLines.length,
            lineHeight: plan.constants.bodyLineHeight,
          }),
          fontSize: plan.constants.bodySize,
          fontWeight: 500,
          lineHeight: plan.constants.bodyLineHeight,
          fill: valueColor,
          clipId: valueClipId,
        });
        clipDefs.push(`<clipPath id="${nameClipId}"><rect x="${formatNumber(tableX + plan.constants.clipPadX)}" y="${formatNumber(cursorY + plan.constants.clipPadY)}" width="${formatNumber(Math.max(plan.constants.minClipSpan, nameW - (plan.constants.clipPadX * 2)))}" height="${formatNumber(Math.max(plan.constants.minClipSpan, rowPlan.rowHeight - (plan.constants.clipPadY * 2)))}"/></clipPath>`);
        clipDefs.push(`<clipPath id="${valueClipId}"><rect x="${formatNumber(valueX + plan.constants.clipPadX)}" y="${formatNumber(cursorY + plan.constants.clipPadY)}" width="${formatNumber(Math.max(plan.constants.minClipSpan, valueW - (plan.constants.clipPadX * 2)))}" height="${formatNumber(Math.max(plan.constants.minClipSpan, rowPlan.rowHeight - (plan.constants.clipPadY * 2)))}"/></clipPath>`);
        clipDefs.push(`<clipPath id="${stateClipId}"><rect x="${formatNumber(stateX + plan.constants.clipPadX)}" y="${formatNumber(cursorY + plan.constants.clipPadY)}" width="${formatNumber(Math.max(plan.constants.minClipSpan, stateW - (plan.constants.clipPadX * 2)))}" height="${formatNumber(Math.max(plan.constants.minClipSpan, rowPlan.rowHeight - (plan.constants.clipPadY * 2)))}"/></clipPath>`);
        rows.push(`<g class="ahm-signal-row row-state-${rowPlan.row.state}" data-signal-id="${escapeXml(rowPlan.row.signalId ?? `row-${rowPlan.i}`)}" data-row-index="${rowPlan.i}" data-state="${rowPlan.row.state}">`);
        rows.push(`<rect x="${formatNumber(tableX)}" y="${formatNumber(cursorY)}" width="${formatNumber(tableW)}" height="${formatNumber(rowPlan.rowHeight)}" fill="${stateToken.fill}" stroke="${stateToken.border}" stroke-width="1"/>`);
        rows.push(`<line class="ahm-signal-col-sep" x1="${formatNumber(valueX)}" y1="${formatNumber(cursorY)}" x2="${formatNumber(valueX)}" y2="${formatNumber(cursorY + rowPlan.rowHeight)}" stroke="${stateToken.border}" stroke-width="1"/>`);
        rows.push(`<line class="ahm-signal-col-sep" x1="${formatNumber(stateX)}" y1="${formatNumber(cursorY)}" x2="${formatNumber(stateX)}" y2="${formatNumber(cursorY + rowPlan.rowHeight)}" stroke="${stateToken.border}" stroke-width="1"/>`);
        rows.push(nameCell.markup);
        rows.push(valueCell.markup);
        rows.push(`<circle class="ahm-signal-state-dot" cx="${formatNumber(stateX + plan.constants.stateDotXOffset)}" cy="${formatNumber(cursorY + (rowPlan.rowHeight / 2))}" r="${formatNumber(plan.constants.stateDotRadius)}" fill="${stateToken.accent}"/>`);
        rows.push(`<text class="ahm-signal-state state-${rowPlan.row.state}" x="${formatNumber(stateX + plan.constants.stateTextXOffset)}" y="${formatNumber(centeredFirstBaseline({
          top: cursorY,
          height: rowPlan.rowHeight,
          fontSize: plan.constants.stateSize,
          lineCount: 1,
          lineHeight: plan.constants.bodyLineHeight,
        }))}" font-size="${plan.constants.stateSize}" font-weight="600" fill="${stateToken.accent}" text-anchor="start" clip-path="url(#${stateClipId})">${escapeXml(rowPlan.stateLabel)}</text>`);
        rows.push(`</g>`);
        cursorY += rowPlan.rowHeight;
      }
      rows.push(`</g>`);

      const tableBoundary = `<rect class="ahm-signal-table-outline" x="${formatNumber(tableX)}" y="${formatNumber(tableHeaderY)}" width="${formatNumber(tableW)}" height="${formatNumber(Math.max(plan.constants.tableHeaderHeight, cursorY - tableHeaderY))}" fill="none" stroke="${borderColor}" stroke-width="1"/>`;

      const tableMarkup = `<g class="ahm-node-content"><defs class="ahm-node-clips">${clipDefs.join("")}</defs>${header.join("")}${rows.join("")}${tableBoundary}</g>`;
      return `${open}${body.replace(/<text class="pele-label"[\s\S]*?<\/text>/, () => tableMarkup)}${close}`;
    });
  }
  for (const entity of renderNodes) {
    const nodePattern = new RegExp(`(<g class="pele-node[^"]*" data-id="${entity.id}"[^>]*)(>)`, "g");
    out = out.replace(nodePattern, (_full, openTag, close) => `${withStateClass(openTag, entity.state)}${close}`);
  }
  const clusterHeaderOverlays = [];
  const clusterOverlayById = new Set();
  const clusterBoundsById = new Map(
    [...out.matchAll(/<g class="pele-cluster" data-id="([^"]+)">[\s\S]*?<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"[^>]*fill-opacity="0\.5"/g)]
      .map((match) => ([
        match[1],
        {
          left: Number(match[2]),
          top: Number(match[3]),
          right: Number(match[2]) + Number(match[4]),
          bottom: Number(match[3]) + Number(match[5]),
        },
      ]))
  );
  const applyClusterHeaderLabel = (body, modelItem, token, clusterBounds) => {
    const rawHeaderLines = nestedTrace?.modelHeaderLinesById?.[modelItem.id] ?? [];
    if (rawHeaderLines.length === 0) return body;
    let nextBody = body.replace(/(<text class="pele-cluster-label"[^>]*fill=")([^"]*)"/, `$1${token.accent}"`);
    nextBody = nextBody.replace(/<text class="pele-cluster-label"([^>]*)>([\s\S]*?)<\/text>/, (textNode, attrs, inner) => {
      const tspans = [...inner.matchAll(/<tspan x="([^"]+)" y="([^"]+)">[\s\S]*?<\/tspan>/g)];
      if (tspans.length === 0) return textNode;
      const attrsWithoutFill = attrs.replace(/\sfill="[^"]*"/, "");
      const originalX = Number(tspans[0][1]);
      const y = Number(tspans[0][2]);
      const lineHeight = tspans.length > 1 ? Number(tspans[1][2]) - Number(tspans[0][2]) : 24;
      const anchor = (attrsWithoutFill.match(/\stext-anchor="([^"]+)"/)?.[1] ?? "middle").toLowerCase();
      const fontSize = Number(attrsWithoutFill.match(/\sfont-size="([0-9.]+)"/)?.[1] ?? typography.requested);
      const textWidths = rawHeaderLines.map((line) => textMeasurer?.width(line, fontSize, { fontWeight: 500 }) ?? (line.length * fontSize * 0.5));
      const maxTextWidth = Math.max(1, ...textWidths);
      const padX = Math.max(6, fontSize * 0.4);
      const padY = Math.max(4, fontSize * 0.22);
      let width = maxTextWidth + (padX * 2);
      const height = Math.max(lineHeight + (padY * 2), (rawHeaderLines.length * lineHeight) + (padY * 2));
      let left;
      if (anchor === "start") left = originalX - padX;
      else if (anchor === "end") left = originalX - width + padX;
      else left = originalX - (width / 2);
      let top = y - (lineHeight * 0.85) - padY;
      if (clusterBounds) {
        const clusterWidth = Math.max(1, clusterBounds.right - clusterBounds.left);
        const minLeft = clusterBounds.left + 2;
        const maxWidth = Math.max(4, clusterWidth - 4);
        width = Math.min(width, maxWidth);
        if (anchor === "start") left = minLeft;
        else if (anchor === "end") left = clusterBounds.right - width - 2;
        else left = clusterBounds.left + ((clusterWidth - width) / 2);
        const minTop = clusterBounds.top + 2;
        const maxTop = clusterBounds.bottom - height - 2;
        if (top < (clusterBounds.top - 1) || top > (clusterBounds.bottom + 1)) {
          top = minTop;
        }
        top = Math.min(Math.max(top, minTop), Math.max(minTop, maxTop));
      }
      const textX = anchor === "start"
        ? left + padX
        : anchor === "end"
          ? left + width - padX
          : left + (width / 2);
      const textStartY = top + padY + (lineHeight * 0.85);
      const serialized = rawHeaderLines
        .map((line, index) => `<tspan x="${formatNumber(textX)}" y="${formatNumber(textStartY + (index * lineHeight))}">${escapeXml(line)}</tspan>`)
        .join("");
      if (!clusterOverlayById.has(modelItem.id)) {
        clusterOverlayById.add(modelItem.id);
        clusterHeaderOverlays.push(
          `<g class="ahm-cluster-header-overlay" data-id="${modelItem.id}">` +
            `<rect x="${formatNumber(left)}" y="${formatNumber(top)}" width="${formatNumber(width)}" height="${formatNumber(height)}" fill="${palette.canvas.bg}" fill-opacity="1" stroke="${token.border}" stroke-width="0.8"/>` +
            `<text class="pele-cluster-label" fill="${token.accent}"${attrsWithoutFill}>${serialized}</text>` +
          `</g>`
        );
      }
      return `<text class="pele-cluster-label"${attrsWithoutFill}>${serialized}</text>`;
    });
    return nextBody;
  };
  const displayedModelIds = new Set(nestedTrace?.projectionDisplayed?.models ?? []);
  for (const modelItem of nestedTrace?.models ?? []) {
    if (!displayedModelIds.has(modelItem.id)) continue;
    const token = palette.entity[modelItem.state] ?? palette.entity.unknown;
    const clusterPattern = new RegExp(`(<g class="pele-cluster" data-id="${modelItem.id}">)([\\s\\S]*?)(</g>)`, "g");
    out = out.replace(
      clusterPattern,
      (_full, open, body, close) => `${open}${body.replace(
        /(<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+"[^>]*stroke=")([^"]*)"/,
        `$1${token.border}"`
      )}${close}`
    );
    const titlePattern = new RegExp(`(<g class="pele-cluster-title" data-id="${modelItem.id}">)([\\s\\S]*?)(</g>)`, "g");
    out = out.replace(
      titlePattern,
      (_full, open, body, close) => `${open}${applyClusterHeaderLabel(body, modelItem, token, clusterBoundsById.get(modelItem.id) ?? null)}${close}`
    );
    if (!clusterOverlayById.has(modelItem.id)) {
      out = out.replace(
        clusterPattern,
        (_full, open, body, close) => `${open}${applyClusterHeaderLabel(body, modelItem, token, clusterBoundsById.get(modelItem.id) ?? null)}${close}`
      );
    }
  }
  let edgeIndex = 0;
  // card rect (plus group translate) of every reserved node card, read from its balanced <g>
  const nodeCardRectsById = new Map();
  for (const open of out.matchAll(/<g class="pele-node[^"]*\bahm_card\b[^"]*" data-id="([^"]+)"[^>]*>/g)) {
    const startIndex = open.index ?? 0;
    const tagRe = /<\/?g\b[^>]*>/g;
    tagRe.lastIndex = startIndex;
    let depth = 0;
    let startSeen = false;
    let start = startIndex;
    let group = null;
    let match;
    while ((match = tagRe.exec(out)) != null) {
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
        group = out.slice(start, idx + tag.length);
        break;
      }
    }
    if (!group) continue;
    const openTag = group.slice(0, group.indexOf(">") + 1);
    const id = open[1];
    const transform = openTag.match(/\btransform="([^"]+)"/)?.[1] ?? "";
    const offset = parseTranslate(transform);
    const rect = group.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
    if (!rect) continue;
    const x = Number(rect[1]) + offset.x;
    const y = Number(rect[2]) + offset.y;
    const w = Number(rect[3]);
    const h = Number(rect[4]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) continue;
    nodeCardRectsById.set(id, { x, y, w, h });
  }
  const viewBoxMatch = out.match(/\bviewBox="([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)\s+([0-9.+-]+)"/);
  const rootViewBox = viewBoxMatch
    ? { minX: Number(viewBoxMatch[1]), minY: Number(viewBoxMatch[2]), width: Number(viewBoxMatch[3]), height: Number(viewBoxMatch[4]) }
    : null;
  const edgeLabelRectsById = extractEdgeLabelRects(out);
  const projectedLabelCandidates = [];
  out = out.replace(/<g class="pele-edge"([^>]*)>([\s\S]*?)<\/g>/g, (_full, attrs, body) => {
    const depState = edgeSourceStates[edgeIndex];
    const dep = model.dependencies[edgeIndex] ?? null;
    const edgeId = attrs.match(/\bdata-id="([^"]+)"/)?.[1] ?? `edge-${edgeIndex}`;
    edgeIndex += 1;
    const state = depState ?? "unknown";
    const color = palette.entity[state].accent;
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
    let nextAttrs = `${attrs} style="stroke:${color};"`;
    if (styleMatch) {
      const cleaned = styleMatch[1]
        .split(";")
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((x) => !x.startsWith("stroke:"));
      cleaned.unshift(`stroke:${color}`);
      nextAttrs = attrs.replace(/\sstyle="[^"]*"/, ` style="${cleaned.join(";")};"`);
    }
    let nextBody = body;
    const pathMatch = nextBody.match(/<path(?![^>]*class="pele-marker")[^>]*\bd="([^"]+)"/);
    if (pathMatch) {
      try {
        const relaxed = relaxOrthogonalPath(pathMatch[1], {
          minCornerRadius: 26,
          maxCornerRadius: 46,
        });
        if (relaxed.changed) {
          const incidentNodeIds = new Set([dep?.from, dep?.to].filter((id) => typeof id === "string" && id.length > 0));
          // first card (other than the edge's own endpoints) whose interior the relaxed route enters
          let crossingNodeId = null;
          const routePoints = pathToPolyline(relaxed.path, 24);
          for (let i = 0; i < routePoints.length - 1 && !crossingNodeId; i += 1) {
            const a = routePoints[i];
            const b = routePoints[i + 1];
            for (const [nodeId, rect] of nodeCardRectsById.entries()) {
              if (incidentNodeIds.has(nodeId)) continue;
              const left = rect.x + 0.75;
              const right = rect.x + rect.w - 0.75;
              const top = rect.y + 0.75;
              const bottom = rect.y + rect.h - 0.75;
              if (left >= right || top >= bottom) continue;
              const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
              let inside = false;
              for (let k = 1; k < steps; k += 1) {
                const t = k / steps;
                const x = a.x + ((b.x - a.x) * t);
                const y = a.y + ((b.y - a.y) * t);
                if (x > left && x < right && y > top && y < bottom) {
                  inside = true;
                  break;
                }
              }
              if (inside) {
                crossingNodeId = nodeId;
                break;
              }
            }
          }
          if (crossingNodeId) {
            diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (crosses-nonincident-card:${crossingNodeId})`);
          } else {
            const labelRect = edgeLabelRectsById.get(edgeId) ?? null;
            if (!labelRect) {
              nextBody = nextBody.replace(pathMatch[1], relaxed.path);
            } else if (!rootViewBox) {
              diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:missing-viewBox)`);
            } else {
              try {
                const labelCenter = {
                  x: labelRect.x + (labelRect.w / 2),
                  y: labelRect.y + (labelRect.h / 2),
                };
                const projection = projectLabelCenterToRelaxedPath(pathMatch[1], relaxed.path, labelCenter, { samples: 24 });
                const dx = projection.x - labelCenter.x;
                const dy = projection.y - labelCenter.y;
                const candidateRect = {
                  x: labelRect.x + dx,
                  y: labelRect.y + dy,
                  w: labelRect.w,
                  h: labelRect.h,
                };
                let blockingCardId = null;
                for (const [nodeId, rect] of nodeCardRectsById.entries()) {
                  if (incidentNodeIds.has(nodeId)) continue;
                  if (rectOverlaps(candidateRect, rect, 1)) {
                    blockingCardId = nodeId;
                    break;
                  }
                }
                const insideViewBox = candidateRect.x >= rootViewBox.minX + 1 &&
                  candidateRect.y >= rootViewBox.minY + 1 &&
                  candidateRect.x + candidateRect.w <= rootViewBox.minX + rootViewBox.width - 1 &&
                  candidateRect.y + candidateRect.h <= rootViewBox.minY + rootViewBox.height - 1;
                if (!insideViewBox) {
                  diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:outside-viewBox)`);
                } else if (blockingCardId) {
                  diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:crosses-nonincident-card:${blockingCardId})`);
                } else {
                  nextBody = nextBody.replace(pathMatch[1], relaxed.path);
                  edgeLabelRectsById.set(edgeId, candidateRect);
                  projectedLabelCandidates.push({
                    edgeId,
                    dx,
                    dy,
                    candidateRect,
                    nativePath: pathMatch[1],
                    relaxedPath: relaxed.path,
                    originalRect: labelRect,
                  });
                }
              } catch (projectionError) {
                diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:${projectionError.message})`);
              }
            }
          }
        } else {
          diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (${relaxed.reason ?? "no-safe-larger-corner-fit"})`);
        }
      } catch (error) {
        diagnostics.push(`route presentation note [${edgeId}]: retained original connector route due to path parse guard (${error.message})`);
      }
    }
    nextBody = nextBody.replace(/<path class="pele-marker"[^>]*>/g, (markerTag) => {
      const withFill = /fill="[^"]*"/.test(markerTag)
        ? markerTag.replace(/fill="[^"]*"/, `fill="${color}"`)
        : markerTag.replace("<path", `<path fill="${color}"`);
      return /stroke="[^"]*"/.test(withFill)
        ? withFill.replace(/stroke="[^"]*"/, `stroke="${color}"`)
        : withFill.replace("<path", `<path stroke="${color}"`);
    });
    return `<g class="pele-edge"${nextAttrs}>${nextBody}</g>`;
  });
  let currentLabelRects = extractEdgeLabelRects(out);
  for (const candidate of projectedLabelCandidates) {
    const { edgeId, dx, dy, candidateRect, nativePath, originalRect } = candidate;
    const foreignEdgePaths = new Map();
    for (const edgeGroup of out.matchAll(/<g class="pele-edge"([^>]*)>([\s\S]*?)<\/g>/g)) {
      const id = edgeGroup[1].match(/\bdata-id="([^"]+)"/)?.[1];
      const path = edgeGroup[2].match(/<path(?![^>]*class="pele-marker")[^>]*\bd="([^"]+)"/)?.[1];
      if (!id || !path) continue;
      foreignEdgePaths.set(id, path);
    }
    // first other edge whose route touches the moved label (padded by 0.75)
    let crossingForeignEdgeId = null;
    const left = candidateRect.x - 0.75;
    const right = candidateRect.x + candidateRect.w + 0.75;
    const top = candidateRect.y - 0.75;
    const bottom = candidateRect.y + candidateRect.h + 0.75;
    for (const [foreignEdgeId, foreignPath] of foreignEdgePaths.entries()) {
      if (foreignEdgeId === edgeId) continue;
      const points = pathToPolyline(foreignPath, 40);
      let touches = false;
      if (left < right && top < bottom) {
        for (let i = 0; i < points.length - 1 && !touches; i += 1) {
          const a = points[i];
          const b = points[i + 1];
          const steps = Math.max(8, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
          for (let k = 0; k <= steps; k += 1) {
            const t = k / steps;
            const x = a.x + ((b.x - a.x) * t);
            const y = a.y + ((b.y - a.y) * t);
            if (x >= left && x <= right && y >= top && y <= bottom) {
              touches = true;
              break;
            }
          }
        }
      }
      if (touches) {
        crossingForeignEdgeId = foreignEdgeId;
        break;
      }
    }
    if (crossingForeignEdgeId) {
      out = replacePrimaryEdgePath(out, edgeId, nativePath);
      edgeLabelRectsById.set(edgeId, originalRect);
      diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:crosses-foreign-edge:${crossingForeignEdgeId})`);
      continue;
    }
    let blockingLabelId = null;
    for (const [otherEdgeId, otherRect] of currentLabelRects.entries()) {
      if (otherEdgeId === edgeId) continue;
      if (rectOverlaps(candidateRect, otherRect, 0.5)) {
        blockingLabelId = otherEdgeId;
        break;
      }
    }
    if (blockingLabelId) {
      out = replacePrimaryEdgePath(out, edgeId, nativePath);
      edgeLabelRectsById.set(edgeId, originalRect);
      diagnostics.push(`route presentation note [${edgeId}]: retained original connector route (label-projection-guard:overlaps-foreign-label:${blockingLabelId})`);
      continue;
    }
    // move the label group by (dx, dy)
    const labelGroup = out.match(new RegExp(`<g class="pele-edge-label"[^>]*data-id="${edgeId}"[^>]*>[\\s\\S]*?<\\/g>`))?.[0] ?? null;
    if (labelGroup && !(Math.hypot(dx, dy) <= 1e-6)) {
      const deltaX = Number(dx);
      const deltaY = Number(dy);
      const shifted = labelGroup.replace(/\b([xy])="([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)"/g, (_full, axis, raw) => {
        const base = Number(raw);
        const next = axis === "x" ? (base + deltaX) : (base + deltaY);
        return `${axis}="${formatNumber(next)}"`;
      });
      out = out.replace(labelGroup, shifted);
      currentLabelRects.set(edgeId, candidateRect);
    }
  }
  if (clusterHeaderOverlays.length > 0) {
    out = out.replace(/<\/svg>\s*$/, `<g class="ahm-cluster-header-overlays">${clusterHeaderOverlays.join("")}</g></svg>`);
  }

  // drop the remaining CSS custom properties
  out = out.replace(/\sstyle="([^"]*)"/g, (_full, styleText) => {
    const kept = styleText
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !part.startsWith("--") && !part.includes("var(--"));
    if (kept.length === 0) return "";
    return ` style="${kept.join(";")};"`;
  });

  // accessibility: img role, title and description on the root
  const titleId = `${idPrefix}-title`;
  const descId = `${idPrefix}-desc`;
  out = out.replace(/^<svg\b([^>]*)>/, (_full, attrs) => {
    let next = attrs
      .replace(/\saria-labelledby="[^"]*"/, "")
      .replace(/\saria-label="[^"]*"/, "")
      .replace(/\srole="[^"]*"/, "")
      .replace(/\sdata-ahm-theme="[^"]*"/, "");
    const classMatch = next.match(/\sclass="([^"]*)"/);
    if (classMatch) {
      const classes = classMatch[1].split(/\s+/).filter(Boolean);
      if (!classes.includes("ahm-root")) classes.push("ahm-root");
      next = next.replace(/\sclass="[^"]*"/, ` class="${classes.join(" ")}"`);
    } else {
      next = `${next} class="ahm-root"`;
    }
    next = `${next} role="img" aria-labelledby="${titleId} ${descId}"`;
    next = `${next} data-ahm-theme="${palette.theme}"`;
    return `<svg${next}>`;
  });
  const rootEnd = out.indexOf(">") + 1;
  const rootBody = out.slice(rootEnd)
    .replace(/^\s*<title\b[^>]*>[\s\S]*?<\/title>\s*/i, "")
    .replace(/^\s*<desc\b[^>]*>[\s\S]*?<\/desc>\s*/i, "");
  out = `${out.slice(0, rootEnd)}${rootBody}`;
  out = out.replace(/^<svg\b[^>]*>/, (root) => `${root}<title id="${titleId}">AHM diagram</title><desc id="${descId}">Static Azure Health Model rendering</desc>`);

  // the requested font family on the root style
  out = out.replace(/^<svg\b([^>]*)>/, (_full, attrs) => {
    const styleMatch = attrs.match(/\sstyle="([^"]*)"/);
    const baseStyle = styleMatch?.[1]
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !part.startsWith("font-family:")) ?? [];
    baseStyle.unshift(`font-family:${typography.fontFamily}`);
    const serializedStyle = ` style="${baseStyle.join(";")};"`;
    if (styleMatch) {
      return `<svg${attrs.replace(/\sstyle="[^"]*"/, serializedStyle)}>`;
    }
    return `<svg${attrs}${serializedStyle}>`;
  });
  let finalWidth = rendered.width;
  let finalHeight = rendered.height;
  if (options.legend !== false) {
    // legend footer: entity and signal state cues plus the authored solid/dashed line styles
    const width = rendered.width;
    const height = rendered.height;
    const footerPadTop = 20 * typography.scale;
    const footerPadBottom = 16 * typography.scale;
    const rowHeight = 22 * typography.scale;
    const titleFontSize = 12 * typography.scale;
    const labelFontSize = 11.5 * typography.scale;
    const markerRadius = 4 * typography.scale;
    const labelX = 10 * typography.scale;
    const entryGap = 18 * typography.scale;
    const yCenter = height + footerPadTop;
    const entityEntries = [
      { label: "Healthy", cue: "H", color: palette.entity.healthy.accent },
      { label: "Degraded", cue: "D", color: palette.entity.degraded.accent },
      { label: "Unhealthy", cue: "U", color: palette.entity.unhealthy.accent },
      { label: "Unknown", cue: "?", color: palette.entity.unknown.accent },
      ...(model.entities.some((entity) => entity.state === "standby") ? [{ label: "Standby", cue: "S", color: palette.entity.standby.accent }] : []),
    ];
    const signalEntries = [
      { label: "Healthy", cue: "H", color: palette.signal.healthy.accent },
      { label: "Degraded", cue: "D", color: palette.signal.degraded.accent },
      { label: "Unhealthy", cue: "U", color: palette.signal.unhealthy.accent },
      { label: "Unknown", cue: "?", color: palette.signal.unknown.accent },
    ];
    let x = 20;
    let itemsSvg = '<text x="20" y="' + formatNumber(yCenter + (4 * typography.scale)) + '" font-size="' + formatNumber(titleFontSize) + '" fill="' + palette.canvas.ink + '">Legend</text>';
    x += Math.max(56 * typography.scale, textMeasurer.width("Legend", titleFontSize, { fontWeight: 400 }) + (20 * typography.scale));
    const sections = [
      { title: "Entity/Model", entries: entityEntries },
      { title: "Signal", entries: signalEntries },
    ];
    for (const section of sections) {
      itemsSvg += `<text x="${formatNumber(x)}" y="${formatNumber(yCenter + (4 * typography.scale))}" font-size="${formatNumber(labelFontSize)}" fill="${palette.canvas.muted}">${escapeXml(section.title)}:</text>`;
      x += textMeasurer.width(`${section.title}:`, labelFontSize, { fontWeight: 500 }) + (10 * typography.scale);
      for (const entry of section.entries) {
        const labelText = `[${entry.cue}] ${entry.label}`;
        itemsSvg += `<g transform="translate(${formatNumber(x)},${formatNumber(yCenter)})"><circle cx="0" cy="0" r="${formatNumber(markerRadius)}" fill="${entry.color}" /><text x="${formatNumber(labelX)}" y="${formatNumber(4 * typography.scale)}" font-size="${formatNumber(labelFontSize)}" fill="${palette.canvas.ink}">${escapeXml(labelText)}</text></g>`;
        x += entryGap + labelX + textMeasurer.width(labelText, labelFontSize, { fontWeight: 400 });
      }
      x += 18 * typography.scale;
    }
    const styleAnchorX = x;
    itemsSvg += `<g transform="translate(${formatNumber(styleAnchorX)},${formatNumber(yCenter)})"><line x1="0" y1="0" x2="${formatNumber(28 * typography.scale)}" y2="0" stroke="${palette.entity.healthy.accent}" stroke-width="2"/><text x="${formatNumber(36 * typography.scale)}" y="${formatNumber(4 * typography.scale)}" font-size="${formatNumber(labelFontSize)}" fill="${palette.canvas.ink}">Authored solid</text></g>`;
    const dashedY = yCenter + (11 * typography.scale);
    itemsSvg += `<g transform="translate(${formatNumber(styleAnchorX)},${formatNumber(dashedY)})"><line x1="0" y1="0" x2="${formatNumber(28 * typography.scale)}" y2="0" stroke="${palette.entity.degraded.accent}" stroke-width="2" stroke-dasharray="5 4"/><text x="${formatNumber(36 * typography.scale)}" y="${formatNumber(4 * typography.scale)}" font-size="${formatNumber(labelFontSize)}" fill="${palette.canvas.ink}">Authored dashed</text></g>`;
    x += (220 * typography.scale);
    const minWidth = x + 24;
    const nextWidth = Math.max(width, minWidth);
    const nextHeight = height + footerPadTop + rowHeight + footerPadBottom;
    const legendGroup = `<g class="ahm-legend" transform="translate(0,0)">${itemsSvg}</g>`;
    out = setSvgDimensions(out, nextWidth, nextHeight);
    out = out.replace(/<\/svg>\s*$/, `${legendGroup}</svg>`);
    finalWidth = nextWidth;
    finalHeight = nextHeight;
  } else {
    out = setSvgDimensions(out, rendered.width, rendered.height);
  }
  if (options.outputLimit != null && out.length > options.outputLimit) {
    throw new Error(`render failed: final SVG output length ${out.length} exceeds outputLimit ${options.outputLimit}`);
  }
  // static safety: no scripts, links, animation, external references or unresolved CSS
  // variables; finite positive dimensions that match the viewBox
  const openTagRe = /<([A-Za-z][\w:-]*)([^<>]*)>/g;
  let tag;
  while ((tag = openTagRe.exec(out)) != null) {
    const tagName = tag[1].toLowerCase();
    const attrsRaw = tag[2] ?? "";
    if (tagName === "script" || tagName === "image" || tagName === "foreignobject" || tagName === "a" || tagName === "style") {
      throw new Error(`render failed: SVG contains unsupported static tag <${tagName}>`);
    }
    if (tagName === "set" || tagName.startsWith("animate")) {
      throw new Error(`render failed: SVG contains unsupported animation tag <${tagName}>`);
    }
    const attributes = [];
    const attrRe = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let attrMatch;
    while ((attrMatch = attrRe.exec(attrsRaw)) != null) {
      attributes.push({ name: attrMatch[1], value: attrMatch[3] ?? attrMatch[4] ?? "" });
    }
    const residue = attrsRaw.replace(/([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g, "").trim();
    if (residue.includes("=")) {
      throw new Error(`render failed: SVG contains unsupported attribute syntax on <${tagName}>`);
    }
    for (const { name, value } of attributes) {
      const attrName = name.toLowerCase();
      if (attrName.startsWith("on")) {
        throw new Error(`render failed: SVG contains unsupported event attribute "${name}"`);
      }
      if (attrName === "href" || attrName === "xlink:href") {
        throw new Error(`render failed: SVG contains unsupported link attribute "${name}"`);
      }
      const uriBearingAttr = /^(?:src|style|fill|stroke|filter|clip-path|mask|marker-start|marker-mid|marker-end)$/i.test(attrName);
      if (uriBearingAttr) {
        if (/\b(?:https?|ftp|file|data|javascript):/i.test(value) || /^\/\//.test(value)) {
          throw new Error(`render failed: SVG contains unsupported external reference in "${name}"`);
        }
        if (/url\(\s*(['"]?)(?!#)/i.test(value)) {
          throw new Error(`render failed: SVG contains unsupported non-local url() in "${name}"`);
        }
      }
      if (/var\(--/i.test(value) || /--[A-Za-z0-9_-]+\s*:/.test(value)) {
        throw new Error(`render failed: SVG contains unresolved CSS variable content in "${name}"`);
      }
    }
  }
  {
    const header = out.match(/^<svg\b([^>]*)>/);
    if (!header) throw new Error("render failed: output is not an SVG root document");
    const attrs = header[1];
    const width = Number((attrs.match(/\bwidth="([^"]+)"/) ?? [])[1]);
    const height = Number((attrs.match(/\bheight="([^"]+)"/) ?? [])[1]);
    const vb = (attrs.match(/\bviewBox="([^"]+)"/) ?? [])[1];
    if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
      throw new Error("render failed: SVG dimensions must be finite positive numbers");
    }
    const parts = String(vb ?? "")
      .trim()
      .split(/\s+/)
      .map((x) => Number(x));
    if (parts.length !== 4 || parts.some((x) => !Number.isFinite(x)) || parts[2] <= 0 || parts[3] <= 0) {
      throw new Error("render failed: SVG viewBox must have finite positive width and height");
    }
    if (Math.abs(width - parts[2]) > 1e-6 || Math.abs(height - parts[3]) > 1e-6) {
      throw new Error("render failed: SVG width/height must match viewBox dimensions");
    }
  }
  return {
    svg: out,
    width: finalWidth,
    height: finalHeight,
    diagnostics,
    ...(nestedTrace ? { trace: nestedTrace } : {}),
  };
}

