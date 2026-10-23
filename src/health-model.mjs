import { parse as peleParse } from "pele";
import { getAhmPalette, normalizeEntityState, stateLabel } from "./ahm-tokens.mjs";

const ENTITY_CLASS_TO_STATE = Object.freeze({
  green: "healthy",
  amber: "degraded",
  red: "unhealthy",
  purple: "standby",
  healthy: "healthy",
  degraded: "degraded",
  unhealthy: "unhealthy",
  unknown: "unknown",
  standby: "standby",
});

const SIGNAL_CLASS_NAMES = new Set(["blue", "signal"]);
const DIRS = new Set(["TB", "TD", "BT", "LR", "RL"]);
const ESCAPED_SEPARATOR = "__AHM_ESC_SEP__";
const ESCAPED_OPEN = "__AHM_ESC_OPEN__";
const ESCAPED_CLOSE = "__AHM_ESC_CLOSE__";

function normalizeDirection(value) {
  const direction = String(value ?? "").toUpperCase();
  if (!DIRS.has(direction)) throw new Error(`unsupported direction "${value}"`);
  return direction;
}

function parseNodeLineRaw(line) {
  const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*\[\s*"([\s\S]*)"\s*\]\s*(?:\s*:::\s*([A-Za-z_][\w-]*))?\s*;?\s*$/);
  if (m) return { id: m[1], label: m[2], inlineClass: m[3]?.toLowerCase() ?? null };
  const n = line.match(/^\s*([A-Za-z_][\w-]*)\s*\[\s*([^\]]+)\s*\]\s*(?:\s*:::\s*([A-Za-z_][\w-]*))?\s*;?\s*$/);
  if (n) return { id: n[1], label: n[2], inlineClass: n[3]?.toLowerCase() ?? null };
  return null;
}

function unescapeText(text) {
  return String(text ?? "")
    .replaceAll("\\=", "=")
    .replaceAll("\\(", "(")
    .replaceAll("\\)", ")")
    .replaceAll("\\|", "|")
    .replaceAll('\\"', '"')
    .replaceAll("\\\\", "\\");
}

function normalizeAuthoredBreaks(text) {
  return String(text ?? "").replace(/<br\s*\/?>/gi, "\n");
}

function escapeLabel(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"');
}

function escapeClassContent(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function buildEntityReservationLines(entity) {
  const lines = [entity.presentation.title];
  if (entity.presentation.qualifier) lines.push(entity.presentation.qualifier);
  lines.push(`Status: ${stateLabel(entity.state)}`);
  if (entity.signals.length === 0) return lines;
  lines.push("Signal | Value | State");
  entity.signals.forEach((row, idx) => {
    const value = row.valueKind === "missing" ? "∅" : row.valueKind === "empty" ? "[empty]" : (row.value ?? "");
    lines.push(`row ${idx + 1} ${row.name} = ${value} (${stateLabel(row.state)})`);
  });
  return lines;
}

export function parseAhmSource(source, options = {}) {
  if (typeof source !== "string" || source.trim() === "") {
    throw new Error("source must be a non-empty Mermaid string");
  }
  // Policy scan over the raw lines: only flowchart statements AHM understands are allowed, and raw
  // (still escaped) node labels are kept for signal-row parsing.
  const diagnostics = [];
  const rawNodeLabelById = new Map();
  const declaredNodeIds = new Set();
  const sourceLines = source.replace(/\r\n/g, "\n").split("\n");
  let headerFound = false;
  let subgraphDepth = 0;
  for (let i = 0; i < sourceLines.length; i += 1) {
    const raw = sourceLines[i];
    const line = raw.trim();
    if (!line || line.startsWith("%%")) {
      if (/^\s*%%\s*\{/.test(raw)) {
        throw new Error(`unsupported statement at line ${i + 1}: Mermaid init/config directives are not allowed`);
      }
      continue;
    }
    const header = raw.match(/^\s*(flowchart|graph|swimlane-beta)\s+([A-Za-z]{2})\s*$/i);
    if (header) {
      normalizeDirection(header[2]);
      headerFound = true;
      continue;
    }
    if (!headerFound) {
      throw new Error(`unsupported statement at line ${i + 1}: expected flowchart/graph header first`);
    }
    if (/^\s*---\s*$/.test(raw) || /^\s*(config|frontmatter)\b/i.test(raw)) {
      throw new Error(`unsupported statement at line ${i + 1}: frontmatter/config is not allowed`);
    }
    if (/^\s*(click|href|linkStyle|style)\b/i.test(raw)) {
      throw new Error(`unsupported statement at line ${i + 1}: "${line.split(/\s+/)[0]}" is not allowed`);
    }
    if (/^\s*end\s*$/i.test(raw)) {
      if (subgraphDepth > 0) subgraphDepth -= 1;
      continue;
    }
    if (/^\s*subgraph\s+(.+?)\s*$/i.test(raw)) {
      subgraphDepth += 1;
      continue;
    }
    const classDef = raw.match(/^\s*classDef\s+([A-Za-z_][\w-]*)\b([\s\S]*)$/i);
    if (classDef) {
      diagnostics.push({
        level: "warn",
        message: `classDef "${classDef[1]}" styles are ignored in AHM semantic rendering`,
      });
      continue;
    }
    const classLine = raw.match(/^\s*class\s+(.+?)\s+([A-Za-z_][\w-]*)\s*;?\s*$/);
    if (classLine) {
      for (const id of classLine[1].split(",").map((x) => x.trim()).filter(Boolean)) declaredNodeIds.add(id);
      continue;
    }
    // edge: both endpoints must be a node declaration or a bare id; declarations keep raw labels
    const dashedEdge = raw.match(/^\s*(.*?)\s*-\.\s*(?:"([^"]+)"|((?:[^.]|\.(?!->))+))\s*\.->\s*(.*?)\s*;?\s*$/);
    const plainEdge = dashedEdge ? null : raw.match(/^\s*(.*?)\s*(-\.->|-->)\s*(.*?)\s*;?\s*$/);
    if (dashedEdge || plainEdge) {
      const leftExpr = dashedEdge ? dashedEdge[1] : plainEdge[1];
      let rightExpr = dashedEdge ? dashedEdge[4] : plainEdge[3];
      if (plainEdge) {
        // a leading |label| belongs to the edge, not to the right endpoint
        const input = String(rightExpr ?? "").trimStart();
        if (input.startsWith("|")) {
          let escaped = false;
          let inQuote = false;
          for (let k = 1; k < input.length; k += 1) {
            const ch = input[k];
            if (escaped) {
              escaped = false;
              continue;
            }
            if (ch === "\\") {
              escaped = true;
              continue;
            }
            if (ch === '"') {
              inQuote = !inQuote;
              continue;
            }
            if (ch === "|" && !inQuote) {
              const rest = input.slice(k + 1).trim();
              if (rest) rightExpr = rest;
              break;
            }
          }
        }
      }
      const leftNode = parseNodeLineRaw(leftExpr);
      const rightNode = parseNodeLineRaw(rightExpr);
      if ((leftNode || /^[A-Za-z_][\w-]*$/.test(leftExpr.trim())) && (rightNode || /^[A-Za-z_][\w-]*$/.test(rightExpr.trim()))) {
        if (leftNode) {
          rawNodeLabelById.set(leftNode.id, leftNode.label);
          declaredNodeIds.add(leftNode.id);
        }
        if (rightNode) {
          rawNodeLabelById.set(rightNode.id, rightNode.label);
          declaredNodeIds.add(rightNode.id);
        }
        continue;
      }
    }
    const rawNode = parseNodeLineRaw(raw);
    if (rawNode) {
      rawNodeLabelById.set(rawNode.id, rawNode.label);
      declaredNodeIds.add(rawNode.id);
      continue;
    }
    if (subgraphDepth > 0) {
      const bareMember = raw.match(/^\s*([A-Za-z_][\w-]*)\s*;?\s*$/);
      if (bareMember) {
        declaredNodeIds.add(bareMember[1]);
        continue;
      }
    }
    throw new Error(`unsupported statement at line ${i + 1}: ${line}`);
  }
  if (!headerFound) throw new Error("source must start with flowchart/graph/swimlane-beta and a direction");

  let parsed;
  try {
    parsed = peleParse(source, { limit: options.limit, maxEdges: options.maxEdges });
  } catch (error) {
    throw new Error(`invalid Mermaid source: ${error.message}`);
  }
  const direction = normalizeDirection(parsed.direction ?? "BT");
  const allowGroupEndpoints = options.allowGroupEndpoints === true;
  const subgraphIds = new Set((parsed.subgraphs ?? []).map((sg) => sg.id));

  const signals = new Map();
  const entities = new Map();
  for (const [id, node] of parsed.nodes.entries()) {
    if (!declaredNodeIds.has(id)) continue;
    const authoredLabel = normalizeAuthoredBreaks(node.text ?? id);
    const label = unescapeText(authoredLabel);
    const classes = new Set((node.classes ?? []).map((x) => String(x).toLowerCase()));
    const isSignal = [...classes].some((name) => SIGNAL_CLASS_NAMES.has(name));
    if (isSignal) {
      // one table row per authored line: `Signal = Value (state)`; \=, \( and \) stay literal
      const rows = [];
      for (const rawRow of normalizeAuthoredBreaks(rawNodeLabelById.get(id) ?? authoredLabel).split("\n").map((x) => x.trim()).filter(Boolean)) {
        const row = String(rawRow ?? "").trim();
        if (!row) continue;
        const prepared = row
          .replaceAll("\\=", ESCAPED_SEPARATOR)
          .replaceAll("\\(", ESCAPED_OPEN)
          .replaceAll("\\)", ESCAPED_CLOSE);
        const idx = prepared.indexOf("=");
        let nameSection = prepared;
        let valueSection = null;
        let valueKind = "missing";
        if (idx >= 0) {
          nameSection = prepared.slice(0, idx);
          valueSection = prepared.slice(idx + 1);
          valueKind = valueSection === "" ? "empty" : "present";
        }
        let name = nameSection.trim();
        if (!name) throw new Error(`signal row "${row}" is missing a signal name`);
        const terminalSource = valueSection === null ? name : valueSection.trim();
        const terminal = terminalSource.match(/\(([^()]*)\)\s*$/);
        let rowState = "unknown";
        let rowValue = null;
        if (terminal) {
          const parsedState = terminal[1].trim().toLowerCase();
          if (parsedState && !["healthy", "degraded", "unhealthy", "unknown"].includes(parsedState)) {
            throw new Error(
              `unsupported signal state "${terminal[1].trim()}" in row "${row}" (escape literal terminal parentheses as \\( ... \\))`
            );
          }
          rowState = parsedState || "unknown";
          if (valueSection !== null) {
            rowValue = valueSection.slice(0, terminal.index).trim();
          } else {
            name = name.slice(0, terminal.index).trim();
          }
        } else if (valueSection !== null) {
          rowValue = valueSection.trim();
        }
        if (valueSection === null) rowValue = null;
        name = name
          .replaceAll(ESCAPED_SEPARATOR, "=")
          .replaceAll(ESCAPED_OPEN, "(")
          .replaceAll(ESCAPED_CLOSE, ")");
        if (!name.trim()) throw new Error(`signal row "${row}" is missing a signal name`);
        rowValue = rowValue
          ?.replaceAll(ESCAPED_SEPARATOR, "=")
          .replaceAll(ESCAPED_OPEN, "(")
          .replaceAll(ESCAPED_CLOSE, ")") ?? null;
        if (valueSection !== null && rowValue === "") valueKind = "empty";
        rows.push({ name, value: rowValue, valueKind, state: rowState });
      }
      signals.set(id, { id, label, rows, owners: new Set() });
      continue;
    }

    // entity state: a health class and/or a "(state)" hint (terminal on the first line, or a
    // standalone line); class and hint must agree
    const clsUnique = [...new Set([...classes].map((name) => ENTITY_CLASS_TO_STATE[name]).filter(Boolean))];
    if (clsUnique.length > 1) {
      throw new Error(`entity "${id}" has conflicting classes (${clsUnique.join(", ")})`);
    }
    const rawLines = normalizeAuthoredBreaks(authoredLabel)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    const hinted = [];
    const terminalHint = (rawLines[0] ?? "").match(/\((healthy|degraded|unhealthy|unknown|standby)\)\s*$/i);
    if (terminalHint) hinted.push(terminalHint[1].toLowerCase());
    for (let i = 1; i < rawLines.length; i += 1) {
      const m = rawLines[i].match(/^\(?\s*(healthy|degraded|unhealthy|unknown|standby)\s*\)?$/i);
      if (m) hinted.push(m[1].toLowerCase());
    }
    const hints = [...new Set(hinted)];
    if (hints.length > 1) {
      throw new Error(`entity "${id}" entity label has conflicting state hints (${hints.join(", ")})`);
    }
    const hintState = hints[0] ?? null;
    if (clsUnique.length && hints.length && clsUnique[0] !== hintState) {
      throw new Error(`entity "${id}" has conflicting class "${clsUnique[0]}" and hint "${hintState}"`);
    }
    const state = normalizeEntityState(clsUnique[0] ?? hintState ?? "unknown");

    // card title and qualifier: the authored lines without the state hint
    const titleLines = rawLines.map((line) => unescapeText(line));
    const statePattern = new RegExp(`\\s*\\(${stateLabel(state)}\\)\\s*$`, "i");
    const escapedTerminalPattern = new RegExp(`\\\\\\(\\s*${stateLabel(state)}\\s*\\\\\\)\\s*$`, "i");
    if (titleLines.length > 0 && !escapedTerminalPattern.test(rawLines[0])) {
      titleLines[0] = titleLines[0].replace(statePattern, "").trim();
    }
    const standalonePattern = new RegExp(`^\\(?\\s*${stateLabel(state)}\\s*\\)?$`, "i");
    const escapedStandalonePattern = new RegExp(`^\\\\\\(\\s*${stateLabel(state)}\\s*\\\\\\)$`, "i");
    const qualifierParts = titleLines
      .slice(1)
      .filter((line, index) => {
        if (!line) return false;
        if (escapedStandalonePattern.test(rawLines[index + 1] ?? "")) return true;
        return !standalonePattern.test(line);
      });
    const presentation = {
      title: (titleLines[0] ?? "") || unescapeText(authoredLabel),
      qualifier: qualifierParts.join(" · "),
    };
    entities.set(id, {
      id,
      label,
      state,
      presentation,
      signals: [],
    });
  }

  const deps = [];
  for (const edge of parsed.edges ?? []) {
    const from = edge.start;
    const to = edge.end;
    const normalizedEdge = {
      from,
      to,
      dashed: edge.stroke === "dotted",
      label: edge.text ? unescapeText(edge.text) : null,
    };
    if (signals.has(from) && entities.has(to)) {
      signals.get(from).owners.add(to);
      continue;
    }
    if (signals.has(to) && entities.has(from)) {
      signals.get(to).owners.add(from);
      continue;
    }
    if (signals.has(from) && signals.has(to)) {
      throw new Error(`signal-to-signal relationship "${from} -> ${to}" is unsupported`);
    }
    if (entities.has(from) && entities.has(to)) {
      deps.push(normalizedEdge);
      continue;
    }
    if (allowGroupEndpoints) {
      const fromSupported = entities.has(from) || subgraphIds.has(from);
      const toSupported = entities.has(to) || subgraphIds.has(to);
      if (fromSupported && toSupported) {
        deps.push(normalizedEdge);
        continue;
      }
    }
    throw new Error(`dangling edge "${from} -> ${to}" references an unknown node`);
  }

  for (const signal of signals.values()) {
    if (signal.owners.size === 0) throw new Error(`signal "${signal.id}" has no owning entity`);
    for (const ownerId of signal.owners) {
      const owner = entities.get(ownerId);
      for (const row of signal.rows) {
        owner.signals.push({
          signalId: signal.id,
          ...row,
        });
      }
    }
  }

  // top-level subgraphs are explicit lanes holding every entity nested anywhere inside them
  const entityIds = new Set(entities.keys());
  const topLaneByEntity = new Map();
  const topLaneLabels = new Map();
  const explicitLanes = [];
  const subgraphById = new Map((parsed.subgraphs ?? []).map((x) => [x.id, x]));
  const nestedSubgraphIds = new Set();
  for (const sg of parsed.subgraphs ?? []) {
    for (const member of sg.nodes ?? []) {
      if (subgraphById.has(member)) nestedSubgraphIds.add(member);
    }
  }
  const collectEntities = (memberId, sink) => {
    if (entityIds.has(memberId)) {
      sink.push(memberId);
      return;
    }
    const nested = subgraphById.get(memberId);
    if (!nested) return;
    for (const n of nested.nodes ?? []) collectEntities(n, sink);
  };
  for (const lane of (parsed.subgraphs ?? []).filter((sg) => !nestedSubgraphIds.has(sg.id))) {
    const label = unescapeText(lane.title ?? lane.id);
    topLaneLabels.set(lane.id, label);
    const members = [];
    for (const member of lane.nodes ?? []) collectEntities(member, members);
    explicitLanes.push({ id: lane.id, label, entities: members });
    for (const entityId of members) {
      if (!topLaneByEntity.has(entityId)) topLaneByEntity.set(entityId, lane.id);
    }
  }

  return {
    direction,
    diagnostics,
    entities: [...entities.values()],
    dependencies: deps,
    topLaneByEntity,
    topLaneLabels,
    explicitLanes,
  };
}

export function buildPeleAhmSource(model, options = {}) {
  const theme = options.theme ?? "portal";
  const lanes = options.lanes ?? false;
  // laneBands: inferred lanes become flat rows that renderAhm draws itself (Pele's subgraph
  // layout bends every edge that crosses a lane border); authored lanes stay subgraphs
  const bandsWanted = lanes && options.laneBands === true &&
    (model.explicitLanes?.length ?? 0) === 0 && model.topLaneByEntity.size === 0;
  let bands = null;
  const levelByEntity = new Map();
  const direction = normalizeDirection(options.direction ?? model.direction ?? "BT");
  const palette = getAhmPalette(theme, options.colors);
  const laneDiagnostics = [];
  const laneByEntity = new Map();
  const explicitLaneOrder = [];

  if (lanes) {
    if ((model.explicitLanes?.length ?? 0) > 0) {
      for (const lane of model.explicitLanes) {
        explicitLaneOrder.push(lane.id);
        for (const entityId of lane.entities) laneByEntity.set(entityId, lane.id);
      }
    } else if (model.topLaneByEntity.size > 0) {
      for (const [entity, lane] of model.topLaneByEntity.entries()) {
        laneByEntity.set(entity, lane);
      }
    } else {
      // no subgraphs: lanes by roll-up depth, roots (no outgoing dependency) are Level 0
      const outBy = new Map();
      const inBy = new Map();
      for (const entity of model.entities) {
        outBy.set(entity.id, []);
        inBy.set(entity.id, []);
      }
      for (const dep of model.dependencies) {
        outBy.get(dep.from)?.push(dep.to);
        inBy.get(dep.to)?.push(dep.from);
      }
      const roots = model.entities.filter((e) => (outBy.get(e.id) ?? []).length === 0);
      if (bandsWanted && roots.length > 0) {
        // a card always sits below all of its parents, so a lane that is one row needs the
        // longest roll-up path to a root; a cycle has no consistent level and keeps subgraphs
        const visiting = new Set();
        const longest = (id) => {
          if (levelByEntity.has(id)) return levelByEntity.get(id);
          if (visiting.has(id)) return null;
          visiting.add(id);
          let level = 0;
          for (const parent of outBy.get(id) ?? []) {
            const up = longest(parent);
            if (up == null) { visiting.delete(id); return null; }
            level = Math.max(level, up + 1);
          }
          visiting.delete(id);
          levelByEntity.set(id, level);
          return level;
        };
        if (model.entities.every((entity) => longest(entity.id) != null)) {
          for (const entity of model.entities) laneByEntity.set(entity.id, `Level ${levelByEntity.get(entity.id)}`);
          bands = [];
        } else {
          levelByEntity.clear();
        }
      }
      if (!bands && roots.length === 0) {
        laneDiagnostics.push({ level: "warn", message: "lane inference fallback: cycle has no roll-up root, using unnamed lane" });
      } else if (!bands) {
        const dist = new Map();
        const queue = roots.map((e) => ({ id: e.id, d: 0 }));
        for (const root of roots) dist.set(root.id, 0);
        while (queue.length > 0) {
          const { id, d } = queue.shift();
          for (const parent of inBy.get(id) ?? []) {
            const next = d + 1;
            const prev = dist.get(parent);
            if (prev == null || next < prev) {
              dist.set(parent, next);
              queue.push({ id: parent, d: next });
            }
          }
        }
        for (const entity of model.entities) {
          const level = dist.get(entity.id);
          if (level == null) continue;
          laneByEntity.set(entity.id, `Level ${level}`);
        }
        const unresolved = model.entities.filter((entity) => !dist.has(entity.id)).map((entity) => entity.id);
        if (unresolved.length > 0) {
          laneDiagnostics.push({
            level: "warn",
            message: `lane inference fallback: unresolved cycle/component entities ${unresolved.join(", ")} assigned to Ungrouped`,
          });
        }
      }
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
  if (options.reservation?.classDef) lines.push(options.reservation.classDef);

  const entityById = new Map(model.entities.map((x) => [x.id, x]));
  const lanesByName = new Map();
  if (lanes) {
    for (const laneLabel of explicitLaneOrder) {
      if (!lanesByName.has(laneLabel)) lanesByName.set(laneLabel, []);
    }
    for (const entity of model.entities) {
      const key = laneByEntity.get(entity.id) || "__ahm_ungrouped";
      if (!lanesByName.has(key)) lanesByName.set(key, []);
      lanesByName.get(key).push(entity);
    }
    let i = 0;
    for (const [laneName, entities] of lanesByName.entries()) {
      const laneId = `lane_${i}`;
      const label = laneName === "__ahm_ungrouped" ? "Ungrouped" : (model.topLaneLabels.get(laneName) ?? laneName);
      if (bands) bands.push({ id: laneId, label, level: levelByEntity.get(entities[0].id), entityIds: entities.map((entity) => entity.id) });
      else lines.push(`subgraph ${laneId}["${escapeClassContent(label)}"]`);
      for (const entity of entities) {
        const customLabel = options.reservation?.entityLabels?.get(entity.id);
        const labelParts = customLabel ? [customLabel] : buildEntityReservationLines(entity);
        lines.push(`${entity.id}["${escapeLabel(labelParts.join("\n"))}"]`);
        lines.push(`class ${entity.id} ahm_${entity.state};`);
        if (options.reservation?.classDef) lines.push(`class ${entity.id} ahm_card;`);
      }
      if (!bands) lines.push("end");
      i += 1;
    }
  } else {
    for (const entity of model.entities) {
      const customLabel = options.reservation?.entityLabels?.get(entity.id);
      const labelParts = customLabel ? [customLabel] : buildEntityReservationLines(entity);
      lines.push(`${entity.id}["${escapeLabel(labelParts.join("\n"))}"]`);
      lines.push(`class ${entity.id} ahm_${entity.state};`);
      if (options.reservation?.classDef) lines.push(`class ${entity.id} ahm_card;`);
    }
  }

  model.dependencies.forEach((dep, index) => {
    const connector = dep.dashed ? "-.->" : "-->";
    const label = dep.label ? `|"${escapeClassContent(dep.label)}"|` : "";
    lines.push(`${dep.from} ${connector} ${label}${dep.to}`.replace(/\s+/g, " ").trim());
    const srcEntity = entityById.get(dep.from);
    const color = palette.entity[srcEntity?.state ?? "unknown"].accent;
    lines.push(`linkStyle ${index} stroke:${color},stroke-width:2px;`);
  });

  if (bands) {
    // invisible links that lift a card onto its own level's row, chosen by the caller from a
    // measured layout; emitted after every real edge, so the linkStyle indices above stay valid
    for (const [anchor, id] of options.lanePins ?? []) lines.push(`${anchor} ~~~ ${id}`);
  }

  return {
    source: lines.join("\n"),
    diagnostics: [...model.diagnostics, ...laneDiagnostics],
    ...(bands ? { bands } : {}),
  };
}
