// Emits the native Draw.io artifacts: one `<mxfile>` per example plus the shape library.
//
// Every visual decision lives in the native mxGraphModel — there is no hand-authored SVG body.
// Colors come from `src/themes.mjs` (single source of truth), text boxes from `src/text.mjs`
// (the same headless-measured metrics the swimlane renderer uses), and example content from the
// live markdown via `src/extract.mjs` + `src/swimlane.mjs`, so the artifacts cannot drift from the
// sources they claim to mirror.
//
// The shipped `.drawio.svg` carries a minimal placeholder body; `visual/render-native.mjs --write`
// replaces it with Draw.io's own `xmlsvg` export — the same call the VS Code extension makes.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractBlocks } from "../../src/extract.mjs";
import { foldSignals, layout, parseGraph } from "../../src/swimlane.mjs";
import { textWidth, wrapText } from "../../src/text.mjs";
import { getTheme } from "../../src/themes.mjs";
import { loadPlugin } from "./load-plugin.mjs";

const root = resolve(import.meta.dirname, "..");
const repo = resolve(root, "..");
const theme = getTheme("portal");

const FONT = "Helvetica";
const EXAMPLES = ["hero", "kitchen-sink", "pills-stress"];
const LANE_LABELS = ["Workload root", "Business & user flows", "Application components"];
const TOKEN = {
  healthy: "healthy", degraded: "degraded", unhealthy: "unhealthy",
  unknown: "unknown", standby: "alt", signal: "signal",
};
const STATE_LABEL = {
  healthy: "Healthy", degraded: "Degraded", unhealthy: "Unhealthy",
  unknown: "Unknown", standby: "Standby",
};
// The simulator knows four states; Standby is an authored presentation of Unknown.
const SIM_STATE = { standby: "Unknown" };
// The five labels `presented()` can produce, and the theme token each one is drawn with. This is
// the state *shown* on a card, i.e. the rollup result, not the authored input.
export const PRESENTED_LABELS = ["Healthy", "Degraded", "Unhealthy", "Unknown", "Standby"];
const SHOWN_TOKEN = {
  Healthy: "healthy", Degraded: "degraded", Unhealthy: "unhealthy",
  Unknown: "unknown", Standby: "alt",
};
// The signal icon carries a glyph as well as a colour, so state never depends on colour alone.
// The key set is exactly the state set `src/swimlane.mjs` can produce for a signal row
// (`ROW_RE` accepts healthy|degraded|unhealthy|unknown) — Standby is an entity-level class, never a
// signal state, so it is rejected below instead of silently borrowing the Healthy glyph.
export const SIGNAL_GLYPH = {
  healthy: "\u2713", degraded: "!", unhealthy: "\u00d7", unknown: "?",
};
export const SIGNAL_STATES = Object.keys(SIGNAL_GLYPH);

// Public boundary for every signal-state lookup: glyph, word and theme token are resolved together
// so a state can never reach the canvas with one dimension defaulted and the others honoured.
export function signalState(state) {
  if (!Object.hasOwn(SIGNAL_GLYPH, state)) {
    throw new Error(`unsupported signal state "${state}" `
      + `(supported: ${SIGNAL_STATES.join(", ")}; Standby is an entity class, not a signal state)`);
  }
  return { glyph: SIGNAL_GLYPH[state], word: STATE_LABEL[state], token: theme.state[TOKEN[state]] };
}
// hero.md deliberately ships without a heading (see its own preamble), so extractBlocks falls back
// to the generic "diagram" slug; the figure's real name is supplied here instead.
const FALLBACK_TITLE = { hero: "AHM Diagrammo health model" };

const L = {
  margin: 40,
  titleY: 22, titleH: 26, subtitleH: 16, headerGap: 20,
  cardW: 224, colGap: 40,
  laneInset: 40, laneBand: 44, lanePadTop: 32, lanePadBottom: 32,
  laneGap: 240,
  // Vertical stagger applied per column, with a different scale per lane. Draw.io's orthogonal
  // router puts a connector's horizontal run at the midpoint between the two connection points, so
  // giving each lane a distinct stagger scale keeps those midpoints distinct and stops distinct
  // connectors from landing on one shared corridor. It is placement, not routing.
  // Every scale and every card/lane height is a multiple of `quantum`, so those midpoints fall on a
  // `quantum / 2` grid: at 16 the guaranteed horizontal separation is 8px, twice the 4px the old
  // 8px quantum could offer. `portMinGap` is the same floor for vertical runs.
  laneStagger: [0, 48, 32],
  portLo: 0.2, portHi: 0.8, portMinGap: 8, quantum: 16,
  cardPad: 12, cardArc: 10,
  titleFs: 13, titleLh: 18, qualFs: 9.5, qualH: 14, titleGap: 8,
  pillH: 20, pillFs: 10, pillDot: 10, pillDotX: 7, pillDotGap: 9, pillTailPad: 10,
  // Signals are a compact table inside the card, not nested cards: no row fill, no row border, a
  // 1px hairline between rows only, and three columns — state icon, label, right-aligned value.
  // A label is measured and wrapped into the label column, and the row grows to hold the extra
  // lines, so no authored length can reach the value column.
  rowH: 22, rowFs: 9.5, rowLh: 12, rowMaxLines: 3,
  iconD: 12, iconX: 0, rowTextX: 20, valueW: 36, rowGapAbove: 12,
  legendH: 52, legendFs: 11, legendDot: 10,
  edgeFs: 9.5,
};


const round = (value) => Math.round(value * 100) / 100;

// ---------------------------------------------------------------- the shared pill contract
//
// One deterministic label -> geometry table for the five labels a card can present. It is derived
// here, once, from the same measured font metrics the swimlane renderer uses (`src/text.mjs`), and
// it is the *only* place a pill width comes from — the generator sizes its pills from it and the
// plugin ships the same numbers as a constant, pinned against this export by
// `test/plugin-adapter.test.mjs` exactly the way `TOKENS` is pinned against `getTheme("portal")`.
//
// Deriving a pill width from a runtime font metric (`mxUtils.getSizeForString`) is forbidden: it is
// 1px narrower on every label, so every pill moved and resized the moment a file was opened.
export const PILL = {
  fontSize: L.pillFs,
  height: L.pillH,
  dot: { x: L.pillDotX, size: L.pillDot, gap: L.pillDotGap },
  // Where the label starts inside the pill, and what stays free after it.
  textX: L.pillDotX + L.pillDot + L.pillDotGap,
  tailPad: L.pillTailPad,
  width: Object.fromEntries(PRESENTED_LABELS.map((label) => {
    // +2 is the rounding cushion: a measured width is a fraction, the cell it is given is an int.
    const labelWidth = Math.ceil(textWidth(label, L.pillFs)) + 2;
    return [label, {
      label: labelWidth,
      pill: L.pillDotX + L.pillDot + L.pillDotGap + labelWidth + L.pillTailPad,
    }];
  })),
};

// ---------------------------------------------------------------- the shared rollup
//
// The plugin owns `worstOf` / `rollup` / `contribution` and the impact matrix. The generator holds
// no second copy: it loads the shipped plugin through `scripts/load-plugin.mjs` and asks it for the
// very states it is about to emit, so a shipped artifact is a fixed point of the plugin's own
// rollup and opening one recomputes nothing.
let ahmPlugin = null;
function ahm() {
  if (!ahmPlugin) ahmPlugin = loadPlugin();
  return ahmPlugin;
}

// Projects a spec onto the plain-object diagram the plugin's simulator consumes, runs the real
// rollup, and returns the entities with the computed state and the label they are presented with.
// `authoredStates` is the negative-control lever only: it reverts the generator to the pre-C-14
// behaviour of shipping the authored state as the computed one, which the drift guard must catch.
function rolledUp(spec, { authoredStates = false } = {}) {
  const plugin = ahm();
  const local = (entity) => SIM_STATE[entity.state] || STATE_LABEL[entity.state];
  const diagram = {
    cells: [
      ...spec.entities.map((entity) => ({
        id: entity.id,
        role: "entity",
        ahmId: entity.id,
        localState: local(entity),
        authoredState: entity.state,
        impact: "standard",
        aggregation: "worstOf",
        style: "",
      })),
      ...spec.entities.flatMap((entity) => entity.signals.map((row, index) => ({
        id: `${entity.id}-signal-${index}`,
        role: "signal",
        owner: entity.id,
        state: signalState(row.state).word,
        style: "",
      }))),
      ...spec.edges.map((edge, index) => ({
        id: `edge-${index}`,
        role: "dependency",
        source: edge.source,
        target: edge.target,
        edgeImpact: edge.impact,
        style: "",
      })),
    ],
  };
  plugin.recalculate(diagram);
  const computed = new Map(diagram.cells
    .filter((cell) => cell.role === "entity").map((cell) => [cell.ahmId, cell.computedState]));
  return spec.entities.map((entity) => presentedEntity(
    entity, authoredStates ? local(entity) : computed.get(entity.id),
  ));
}

function presentedEntity(entity, computedState) {
  return {
    ...entity,
    computedState,
    shown: ahm().presented(computedState, entity.state),
  };
}

// XML attribute-value normalisation collapses a literal newline to a space, which would silently
// undo the measured title wrap, so line breaks are emitted as a character reference.
function esc(value) {
  return String(value)
    .replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/\n/g, "&#10;");
}

function xmlObject(attributes, markup) {
  const id = markup.match(/<mxCell id="([^"]+)"/)?.[1];
  if (id && attributes.id == null) {
    attributes = { id, ...attributes };
    markup = markup.replace(`<mxCell id="${id}"`, "<mxCell");
  }
  const attrs = Object.entries(attributes)
    .map(([key, value]) => ` ${key}="${esc(value)}"`).join("");
  return `<object${attrs}>${markup}</object>`;
}

function cell(id, style, parent, box, extra = "", inner = "") {
  const geometry = box
    ? `<mxGeometry x="${round(box.x)}" y="${round(box.y)}" width="${round(box.w)}" height="${round(box.h)}" as="geometry">${inner}</mxGeometry>`
    : `<mxGeometry relative="1" as="geometry">${inner}</mxGeometry>`;
  return `<mxCell id="${id}" style="${style}" parent="${parent}" ${extra}>${geometry}</mxCell>`;
}

const base = `html=0;shadow=0;fontFamily=${FONT};`;
const text = (size, color, weight = 0) =>
  `text;${base}noLabel=0;align=left;verticalAlign=middle;overflow=visible;whiteSpace=nowrap;`
  + `fontSize=${size};fontColor=${color};${weight ? "fontStyle=1;" : ""}`;

// ---------------------------------------------------------------- source model

function readSpec(name, file = resolve(repo, `${name}.md`)) {
  const block = extractBlocks(readFileSync(file, "utf8"))[0];
  const graph = foldSignals(parseGraph(block.code));
  const lanes = layout(graph).lane;
  const entities = [...graph.nodes.values()].map((node) => ({
    id: node.id,
    label: node.lines[0],
    qualifier: node.lines.slice(1, -1).join(" ").replace(/[()]/g, ""),
    state: node.state === "alt" ? "standby" : node.state,
    lane: Math.min(lanes.get(node.id), 2),
    signals: (node.signals || []).map((row) => ({
      name: row.name, state: row.state, result: row.result,
    })),
  }));
  const edges = graph.edges.map((edge) => ({
    source: edge.from,
    target: edge.to,
    label: edge.label || "",
    impact: /limited/i.test(edge.label || "") ? "limited"
      : /suppressed/i.test(edge.label || "") ? "suppressed" : "standard",
  }));
  const heading = block.heading && block.heading !== "diagram" ? block.heading : null;
  return { name, title: heading || FALLBACK_TITLE[name] || name, entities, edges };
}

// ---------------------------------------------------------------- card geometry

// Bands never overlap and every child is inset by `cardPad`, which is >= the corner radius, so a
// child corner can never fall outside the rounded outline. mxGraph does not clip children to a
// parent, so this padding is the only containment mechanism available.
function cardLayout(entity, tuning = {}) {
  const { quantum } = { ...L, ...tuning };
  const inner = L.cardW - L.cardPad * 2;
  const wrapped = wrapText(entity.label, inner - 10, L.titleFs, { weight: 600, maxLines: 3 });
  const parts = {};
  let y = L.cardPad;
  parts.title = {
    x: L.cardPad, y, w: inner, h: wrapped.lines.length * L.titleLh, lines: wrapped.lines,
  };
  y += parts.title.h;
  if (entity.qualifier) {
    y += L.titleGap;
    parts.qualifier = { x: L.cardPad, y, w: inner, h: L.qualH };
    y += L.qualH;
  }
  y += 8;
  const label = entity.shown;
  const sized = PILL.width[label];
  if (!sized) throw new Error(`no pill contract entry for state label "${label}"`);
  const pillW = sized.pill;
  parts.pill = {
    x: L.cardW - L.cardPad - pillW, y, w: pillW, h: L.pillH, label,
    dot: { x: PILL.dot.x, y: (L.pillH - PILL.dot.size) / 2, w: PILL.dot.size, h: PILL.dot.size },
    text: { x: PILL.textX, y: 0, w: sized.label, h: L.pillH },
  };
  y += L.pillH;
  const tableTop = y + L.rowGapAbove;
  // The label column is fixed by the three-column grid; the *row* is what gives. Every label is
  // measured and wrapped into that column (`wrapText` hard-breaks an oversized word and ellipsizes
  // past `rowMaxLines`), so a rendered line can never be wider than the column and can never reach
  // the value column, whatever the authored length. The exact authored string stays on the cell.
  const labelColW = inner - L.rowTextX - L.valueW - 8;
  let rowY = tableTop;
  parts.rows = entity.signals.map((signal) => {
    const label = wrapText(signal.name, labelColW, L.rowFs, { maxLines: L.rowMaxLines });
    const h = Math.max(L.rowH, label.lines.length * L.rowLh + 10);
    const row = {
      signal, x: L.cardPad, y: rowY, w: inner, h,
      labelLines: label.lines, labelClipped: label.clipped, labelW: labelColW,
    };
    rowY += h;
    return row;
  });
  parts.dividers = parts.rows.slice(1)
    .map((row) => ({ x: L.cardPad, y: row.y, w: inner, h: 1 }));
  if (parts.rows.length) y = parts.rows.at(-1).y + parts.rows.at(-1).h;
  // Quantised so every card top and bottom sits on the same grid: Draw.io puts a connector's
  // horizontal run at the midpoint of the two connection points, so a quantised height forces those
  // midpoints onto a 4px grid instead of landing 0.5-3.5px apart.
  return { parts, height: Math.ceil((y + L.cardPad) / quantum) * quantum };
}

// ---------------------------------------------------------------- layout and ports
//
// Positions and connection points only. There is deliberately no router here: dependencies are
// drawn with Draw.io's built-in `orthogonalEdgeStyle`, so the editor re-routes them itself when an
// entity is dragged anywhere on the board. Nothing about a connector's path is persisted.
//
// Two placement rules do all the work of keeping the shipped canvas clean, and both survive any
// later move because neither is a path:
//   * one row per lane, so a connector's vertical run rises in its own column and its horizontal run
//     lands in a card-free lane gap;
//   * a per-column vertical stagger with a different scale per lane, so the midpoints the built-in
//     router picks are distinct and two connectors never share a corridor.

function plan(spec, tuning = {}) {
  const { laneStagger, portMinGap, quantum } = { ...L, ...tuning };
  const cards = new Map(spec.entities.map((entity) => [entity.id, cardLayout(entity, tuning)]));
  const members = [0, 1, 2].map((lane) => spec.entities.filter((entity) => entity.lane === lane));
  const columns = Math.max(1, ...members.map((group) => group.length));
  const gridW = columns * L.cardW + (columns - 1) * L.colGap;
  const laneW = L.laneInset * 2 + gridW + L.laneBand;
  const canvasW = laneW + L.margin * 2;
  const contentX = L.margin + L.laneInset;
  const columnX = (column) => contentX + column * (L.cardW + L.colGap);

  // A lane-skipping dependency has to cross the middle lane, so its target is parked in the same
  // column as its source when that column is free in between — the built-in router then draws one
  // straight vertical instead of a corridor across the lane.
  const laneOf = new Map(spec.entities.map((entity) => [entity.id, entity.lane]));
  const skipping = spec.edges.find((edge) => laneOf.get(edge.source) - laneOf.get(edge.target) > 1);
  const startColumn = [0, 1, 2].map((lane) => Math.floor((columns - members[lane].length) / 2));
  members.forEach((group, lane) => {
    group.forEach((entity, index) => { cards.get(entity.id).column = startColumn[lane] + index; });
  });
  if (skipping && members[0].length === 1) {
    const sourceColumn = cards.get(skipping.source).column;
    const busy = members[1].some((entity) => cards.get(entity.id).column === sourceColumn);
    if (!busy) cards.get(members[0][0].id).column = sourceColumn;
  }

  const lanes = [];
  let y = L.titleY + L.titleH + L.subtitleH + L.headerGap;
  members.forEach((group, lane) => {
    const stagger = (column) => column * laneStagger[lane];
    let bottom = y + L.lanePadTop;
    group.forEach((entity) => {
      const card = cards.get(entity.id);
      card.lane = lane;
      card.box = {
        x: columnX(card.column), y: y + L.lanePadTop + stagger(card.column),
        w: L.cardW, h: card.height,
      };
      bottom = Math.max(bottom, card.box.y + card.box.h);
    });
    // Quantised on the same grid as the card heights, so a lane's cards inherit the residue of the
    // lane above. Without it the router's midpoints in different lane pairs land off-grid and the
    // guaranteed separation collapses back to whatever the tallest card happened to measure.
    const laneH = Math.ceil(Math.max(
      bottom + L.lanePadBottom - y,
      Math.ceil(textWidth(LANE_LABELS[lane], L.titleFs, 600)) + 48,
    ) / quantum) * quantum;
    lanes.push({ x: L.margin, y, w: laneW, h: laneH, label: LANE_LABELS[lane] });
    y += laneH + L.laneGap;
  });

  // Port assignment: a distinct standard `exitX` per outgoing dependency and a distinct `entryX`
  // per incoming one, spread across the middle half of the card edge. This is Draw.io's own fixed
  // connection point — draggable and clearable in the editor — and it pins only where a connector
  // attaches, never how it gets there.
  const fanOut = new Map();
  const fanIn = new Map();
  spec.edges.forEach((edge, index) => {
    if (!fanOut.has(edge.source)) fanOut.set(edge.source, []);
    if (!fanIn.has(edge.target)) fanIn.set(edge.target, []);
    fanOut.get(edge.source).push(index);
    fanIn.get(edge.target).push(index);
  });
  const ports = new Map();
  const spread = (list, key, order) => {
    list.sort(order);
    list.forEach((index, position) => {
      ports.set(`${key}:${index}`,
        round(L.portLo + ((position + 1) / (list.length + 1)) * (L.portHi - L.portLo)));
    });
  };
  const columnOf = (id) => cards.get(id).column;
  fanOut.forEach((list) => spread(list, "exit",
    (a, b) => columnOf(spec.edges[a].target) - columnOf(spec.edges[b].target) || a - b));
  fanIn.forEach((list) => spread(list, "entry",
    (a, b) => columnOf(spec.edges[a].source) - columnOf(spec.edges[b].source) || a - b));

  // Two connection points on different cards can still land on the same absolute x, which would let
  // one connector's vertical run sit exactly on another's. Ports are nudged apart deterministically,
  // in document order, until every absolute x is at least `portMinGap` from every other.
  const taken = [];
  const nudge = (key, cardId) => {
    const card = cards.get(cardId);
    const base = ports.get(key);
    for (let step = 0; step <= 24; step++) {
      for (const direction of step === 0 ? [1] : [1, -1]) {
        const fraction = base + direction * step * (portMinGap / L.cardW);
        if (fraction < L.portLo || fraction > L.portHi) continue;
        const absolute = card.box.x + fraction * L.cardW;
        if (taken.every((other) => Math.abs(other - absolute) >= portMinGap)) {
          taken.push(absolute);
          ports.set(key, round(fraction));
          return;
        }
      }
    }
    taken.push(card.box.x + base * L.cardW);
  };
  spec.edges.forEach((edge, index) => nudge(`exit:${index}`, edge.source));
  spec.edges.forEach((edge, index) => nudge(`entry:${index}`, edge.target));

  return {
    cards, lanes, ports, legendY: y - L.laneGap + 46,
    geometry: { canvasW, laneW, columns },
  };
}

// ---------------------------------------------------------------- cells

function cardCells(entity, card, parent, box) {
  const token = theme.state[SHOWN_TOKEN[entity.shown]];
  const parts = card.parts;
  const cells = [];
  cells.push(xmlObject({
    label: entity.label,
    ahmRole: "entity",
    ahmId: entity.id,
    ahmLocalState: SIM_STATE[entity.state] || STATE_LABEL[entity.state],
    ahmComputedState: entity.computedState,
    ahmAuthoredState: entity.state,
    ahmImpact: "standard",
    ahmAggregation: "worstOf",
    ...(entity.lane != null ? { ahmLane: entity.lane } : {}),
    ...(entity.qualifier ? { ahmQualifier: entity.qualifier } : {}),
  }, cell(
    entity.id,
    `rounded=1;absoluteArcSize=1;arcSize=${L.cardArc};${base}noLabel=1;verticalAlign=top;`
    + `fillColor=${token.fill};strokeColor=${token.border};strokeWidth=2;`
    + `dashed=${token.dash ? 1 : 0};${token.dash ? `dashPattern=${token.dash};` : ""}`,
    parent, box, 'vertex="1" connectable="1"',
  )));
  cells.push(xmlObject({ label: parts.title.lines.join("\n"), ahmPart: "title" }, cell(
    `${entity.id}-title`,
    `${text(L.titleFs, theme.ink, 1)}verticalAlign=top;`,
    entity.id, parts.title, 'vertex="1" connectable="0"',
  )));
  if (parts.qualifier) {
    cells.push(xmlObject({ label: entity.qualifier, ahmPart: "qualifier" }, cell(
      `${entity.id}-qualifier`, text(L.qualFs, theme.muted),
      entity.id, parts.qualifier, 'vertex="1" connectable="0"',
    )));
  }
  cells.push(xmlObject({ label: "", ahmPart: "state" }, cell(
    `${entity.id}-state`,
    `rounded=1;absoluteArcSize=1;arcSize=${L.pillH / 2};${base}noLabel=1;`
    + `fillColor=${theme.pillFill};strokeColor=${token.border};strokeWidth=1;`,
    entity.id, parts.pill, 'vertex="1" connectable="0"',
  )));
  cells.push(xmlObject({ label: "", ahmPart: "state-dot" }, cell(
    `${entity.id}-state-dot`,
    `ellipse;${base}noLabel=1;fillColor=${token.dot};strokeColor=none;`,
    `${entity.id}-state`, parts.pill.dot, 'vertex="1" connectable="0"',
  )));
  cells.push(xmlObject({ label: parts.pill.label, ahmPart: "state-label" }, cell(
    `${entity.id}-state-label`, text(L.pillFs, theme.ink),
    `${entity.id}-state`, parts.pill.text, 'vertex="1" connectable="0"',
  )));
  parts.rows.forEach((row, index) => {
    const state = signalState(row.signal.state);
    const id = `${entity.id}-signal-${index}`;
    // The row itself is the semantic carrier and nothing else: no fill, no border, no card surface.
    cells.push(xmlObject({
      label: row.signal.name,
      ahmRole: "signal",
      ahmOwner: entity.id,
      ahmState: state.word,
      ahmResult: String(row.signal.result ?? ""),
    }, cell(
      id, `rounded=0;${base}noLabel=1;fillColor=none;strokeColor=none;`,
      entity.id, row, 'vertex="1" connectable="0"',
    )));
    cells.push(xmlObject({
      label: state.glyph,
      ahmPart: "signal-icon",
      ahmState: state.word,
    }, cell(
      `${id}-icon`,
      `ellipse;${base}noLabel=0;align=center;verticalAlign=middle;overflow=visible;`
      + `fontSize=8;fontStyle=1;fontColor=${theme.pillFill};`
      + `fillColor=${state.token.dot};strokeColor=none;`,
      id, { x: L.iconX, y: (row.h - L.iconD) / 2, w: L.iconD, h: L.iconD },
      'vertex="1" connectable="0"',
    )));
    // The rendered text is the measured wrap; `ahmLabel` keeps the authored string byte-exact even
    // when the wrap had to ellipsize, so no data is lost to the containment.
    cells.push(xmlObject({
      label: row.labelLines.join("\n"),
      ahmPart: "signal-label",
      ahmLabel: row.signal.name,
      ...(row.labelClipped ? { ahmLabelClipped: "1" } : {}),
    }, cell(
      `${id}-label`, text(L.rowFs, theme.ink), id,
      { x: L.rowTextX, y: 0, w: row.labelW, h: row.h },
      'vertex="1" connectable="0"',
    )));
    cells.push(xmlObject({ label: String(row.signal.result ?? ""), ahmPart: "signal-result" }, cell(
      `${id}-result`,
      `${text(L.rowFs, row.signal.state === "healthy" ? theme.muted : state.token.dot,
        row.signal.state === "healthy" ? 0 : 1)}align=right;`,
      id, { x: row.w - L.valueW, y: 0, w: L.valueW, h: row.h }, 'vertex="1" connectable="0"',
    )));
  });
  // A hairline between rows — never around them, and never after the last one.
  parts.dividers.forEach((divider, index) => {
    cells.push(xmlObject({ label: "", ahmPart: "signal-divider" }, cell(
      `${entity.id}-divider-${index}`,
      `line;${base}noLabel=1;strokeColor=${theme.hair};strokeWidth=1;fillColor=none;`,
      entity.id, divider, 'vertex="1" connectable="0"',
    )));
  });
  return cells;
}

function laneStyle(index) {
  const fill = index % 2 ? theme.band : theme.bg;
  return `swimlane;horizontal=0;flipH=1;startSize=${L.laneBand};container=1;collapsible=0;`
    + `swimlaneLine=0;rounded=0;${base}whiteSpace=nowrap;overflow=visible;`
    + `fontSize=${L.titleFs};fontStyle=1;fontColor=${theme.laneLabel};`
    + `fillColor=${fill};swimlaneFillColor=${fill};strokeColor=${theme.hair};`;
}

function legendCells(origin, parent = "1", id = "legend") {
  const items = [
    ["Healthy", theme.state.healthy.dot],
    ["Degraded", theme.state.degraded.dot],
    ["Unhealthy", theme.state.unhealthy.dot],
    ["Unknown", theme.state.unknown.dot],
    ["Standby", theme.state.alt.dot],
  ];
  const titleW = Math.ceil(textWidth("Legend", L.legendFs, 600)) + 4;
  let cursor = 18 + titleW + 22;
  const placed = items.map(([label, color]) => {
    const width = Math.ceil(textWidth(label, L.legendFs)) + 4;
    const item = { label, color, dotX: cursor, textX: cursor + L.legendDot + 8, textW: width };
    cursor += L.legendDot + 8 + width + 26;
    return item;
  });
  const barX = cursor;
  const metricW = Math.ceil(textWidth("Metric", L.legendFs)) + 4;
  const width = barX + 28 + 8 + metricW + 18;
  const centred = (height) => (L.legendH - height) / 2;
  const cells = [xmlObject({ label: "", ahmRole: "legend" }, cell(
    id, `group;${base}noLabel=1;`, parent,
    { ...origin, w: width, h: L.legendH }, 'vertex="1" connectable="0"',
  ))];
  cells.push(xmlObject({ label: "", ahmPart: "legend-panel" }, cell(
    `${id}-panel`,
    `rounded=1;absoluteArcSize=1;arcSize=8;${base}noLabel=1;`
    + `fillColor=${theme.pillFill};strokeColor=${theme.hair};strokeWidth=1;`,
    id, { x: 0, y: 0, w: width, h: L.legendH }, 'vertex="1" connectable="0"',
  )));
  cells.push(xmlObject({ label: "Legend", ahmPart: "legend-title" }, cell(
    `${id}-title`, text(L.legendFs, theme.ink, 1),
    id, { x: 18, y: centred(20), w: titleW, h: 20 }, 'vertex="1" connectable="0"',
  )));
  placed.forEach((item, index) => {
    cells.push(xmlObject({ label: "", ahmPart: "legend-dot" }, cell(
      `${id}-dot-${index}`, `ellipse;${base}noLabel=1;fillColor=${item.color};strokeColor=none;`,
      id, { x: item.dotX, y: centred(L.legendDot), w: L.legendDot, h: L.legendDot },
      'vertex="1" connectable="0"',
    )));
    cells.push(xmlObject({ label: item.label, ahmPart: "legend-item" }, cell(
      `${id}-item-${index}`, text(L.legendFs, theme.ink),
      id, { x: item.textX, y: centred(20), w: item.textW, h: 20 }, 'vertex="1" connectable="0"',
    )));
  });
  cells.push(xmlObject({ label: "", ahmPart: "legend-bar" }, cell(
    `${id}-bar`,
    `rounded=1;absoluteArcSize=1;arcSize=4;${base}noLabel=1;`
    + `fillColor=${theme.metricBars[1]};strokeColor=none;`,
    id, { x: barX, y: centred(8), w: 28, h: 8 }, 'vertex="1" connectable="0"',
  )));
  cells.push(xmlObject({ label: "Metric", ahmPart: "legend-item" }, cell(
    `${id}-item-metric`, text(L.legendFs, theme.ink),
    id, { x: barX + 28 + 8, y: centred(20), w: metricW, h: 20 }, 'vertex="1" connectable="0"',
  )));
  return { cells, width };
}

// ---------------------------------------------------------------- model emitter

function makeModel(spec, tuning = {}) {
  // The states the cards carry are the plugin's rollup, not the authored inputs: a shipped artifact
  // has to already be what an open with the plugin installed would compute.
  if (!spec.entities.every((entity) => entity.shown)) {
    spec = { ...spec, entities: rolledUp(spec, tuning) };
  }
  const layoutPlan = plan(spec, tuning);
  const { cards, lanes, ports, geometry } = layoutPlan;
  const canvasW = geometry.canvasW;
  const cells = [
    '<mxCell id="0"/><mxCell id="1" parent="0"/>',
    xmlObject({ label: spec.title, ahmPart: "diagram-title" }, cell(
      "diagram-title", text(18, theme.ink, 1), "1",
      { x: L.margin, y: L.titleY, w: canvasW - L.margin * 2, h: L.titleH },
      'vertex="1" connectable="0"',
    )),
    xmlObject({ label: "Explicit local health · worstOf rollup", ahmPart: "diagram-subtitle" }, cell(
      "diagram-subtitle", text(11, theme.muted), "1",
      { x: L.margin, y: L.titleY + L.titleH, w: canvasW - L.margin * 2, h: L.subtitleH },
      'vertex="1" connectable="0"',
    )),
  ];
  lanes.forEach((lane, index) => {
    cells.push(xmlObject(
      { label: lane.label, ahmRole: "lane", ahmLaneIndex: index },
      cell(`lane-${index}`, laneStyle(index), "1", lane, 'vertex="1" connectable="0"'),
    ));
  });
  spec.entities.forEach((entity) => {
    const card = cards.get(entity.id);
    const lane = lanes[entity.lane];
    cells.push(...cardCells(entity, card, `lane-${entity.lane}`, {
      x: card.box.x - lane.x, y: card.box.y - lane.y, w: card.box.w, h: card.box.h,
    }));
  });
  // Native `edgeLabel` relative positions, spread deterministically along each connector so labels
  // on a crowded fan-in do not all pile onto the same stretch. `relative=1` means Draw.io keeps
  // recomputing the point from the live route, so the label still follows any move.
  // Anchored near the source end of each connector, where neighbouring runs are a whole column apart
  // instead of one corridor apart. Labels on connectors leaving the *same* card would otherwise
  // bunch at the same distance, so those are stepped apart — still a native `edgeLabel` relative
  // position, so every label keeps following its own route on any move.
  const labelPositions = new Map();
  const perSource = new Map();
  spec.edges.forEach((edge, index) => {
    if (!edge.label) return;
    const order = perSource.get(edge.source) || 0;
    perSource.set(edge.source, order + 1);
    labelPositions.set(index, round(-0.85 + order * 0.18));
  });

  spec.edges.forEach((edge, index) => {
    const source = spec.entities.find((entity) => entity.id === edge.source);
    const token = theme.state[SHOWN_TOKEN[source.shown]];
    const dash = edge.impact === "limited" ? "8 5" : edge.impact === "suppressed" ? "2 4" : null;
    // Draw.io's own orthogonal router. The only thing declared is where the connector attaches
    // (standard fixed connection points); the path itself is recomputed by the editor on every
    // move, and no geometry is stored for it.
    const style = `edgeStyle=orthogonalEdgeStyle;rounded=1;orthogonalLoop=1;jettySize=auto;`
      + `${base}noLabel=1;strokeColor=${token.dot};strokeWidth=2;`
      + `endArrow=block;endFill=1;endSize=6;`
      + `exitX=${ports.get(`exit:${index}`)};exitY=0;entryX=${ports.get(`entry:${index}`)};entryY=1;`
      + `dashed=${dash ? 1 : 0};${dash ? `dashPattern=${dash};` : ""}`;
    cells.push(xmlObject({
      label: edge.label,
      ahmRole: "dependency",
      ahmImpact: edge.impact,
      ahmSource: edge.source,
      ahmTarget: edge.target,
    }, `<mxCell id="edge-${index}" style="${style}" parent="1" source="${edge.source}"`
      + ` target="${edge.target}" edge="1"><mxGeometry relative="1" as="geometry"/></mxCell>`));
    if (edge.label) {
      // A native `edgeLabel` child with relative geometry: Draw.io keeps it on the connector, so it
      // travels with the edge when either endpoint moves.
      cells.push(xmlObject({
        label: edge.label,
        ahmRole: "dependency-label",
        ahmEdge: `edge-${index}`,
        ahmImpact: edge.impact,
        ahmSource: edge.source,
        ahmTarget: edge.target,
      }, `<mxCell id="edge-${index}-label" style="edgeLabel;${base}noLabel=0;align=center;`
        + `verticalAlign=middle;resizable=0;whiteSpace=nowrap;fontSize=${L.edgeFs};`
        + `fontColor=${theme.muted};labelBackgroundColor=${theme.pillFill};`
        + `labelBorderColor=${theme.pillStroke};"`
        + ` parent="edge-${index}" vertex="1" connectable="0">`
        + `<mxGeometry relative="1" x="${labelPositions.get(index)}" as="geometry">`
        + '<mxPoint as="offset"/></mxGeometry></mxCell>'));
    }
  });
  cells.push(...legendCells({ x: L.margin, y: layoutPlan.legendY }).cells);
  const model = '<mxfile host="Electron" agent="AHM Diagrammo" version="24.7.17">'
    + `<diagram id="ahm-${spec.name}" name="Page-1">`
    + '<mxGraphModel dx="1400" dy="1000" grid="1" gridSize="10" guides="1" tooltips="1" connect="1"'
    + ` arrows="1" fold="1" page="0" math="0" shadow="0" background="${theme.bg}"><root>`
    + cells.join("")
    + "</root></mxGraphModel></diagram></mxfile>";
  return {
    model, width: canvasW, height: layoutPlan.legendY + L.legendH + L.margin,
    routed: spec.edges, spec,
  };
}

// A deliberately minimal, non-deceptive body. Draw.io replaces the whole file with its own
// `xmlsvg` export on first save; `visual/render-native.mjs --write` performs that same export
// offline so the shipped body is always Draw.io-generated.
function placeholderSvg(model, width, height, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"`
    + ` viewBox="0 0 ${width} ${height}" content="${esc(model)}">`
    + `<rect width="100%" height="100%" fill="${theme.bg}"/>`
    + `<text x="${L.margin}" y="${L.titleY + 20}" font-family="${FONT},Arial,sans-serif"`
    + ` font-size="18" font-weight="600" fill="${theme.ink}">${esc(title)}</text>`
    + `<text x="${L.margin}" y="${L.titleY + 44}" font-family="${FONT},Arial,sans-serif"`
    + ` font-size="12" fill="${theme.muted}">Native Draw.io model — open with the Draw.io editor to render.</text>`
    + "</svg>";
}

// ---------------------------------------------------------------- library

function libraryEntry(title, cells, w, h) {
  return {
    xml: '<mxGraphModel grid="1" page="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/>'
      + `${cells}</root></mxGraphModel>`,
    w, h, title,
  };
}

function librarySpecimen(title, label, state, signals = []) {
  // A specimen has no dependencies, so its rollup is its own local state; it still goes through the
  // plugin's `presented()` so the library and the examples share one label vocabulary.
  const entity = presentedEntity(
    { id: "entity", label, qualifier: "", state, lane: null, signals },
    SIM_STATE[state] || STATE_LABEL[state],
  );
  const card = cardLayout(entity);
  const cells = cardCells(entity, card, "1", { x: 0, y: 0, w: L.cardW, h: card.height });
  return libraryEntry(title, cells.join(""), L.cardW, card.height);
}

// ---------------------------------------------------------------- run

// Public build boundary. Tests drive the *real* generator through this — with its layout levers
// ablated, or against an authored fixture inventory — and render the emitted model in the actual
// Draw.io runtime. Nothing here touches disk until it is called, so importing stays side-effect
// free (the run block below is the only writer).
export { readSpec, L as LAYOUT };

export function buildModel(spec, tuning = {}) {
  return makeModel(spec, tuning);
}

export function buildExample(name, tuning = {}, file) {
  const spec = readSpec(name, file);
  return { spec, ...makeModel(spec, tuning) };
}
// The shape library, built exactly as it ships. Draw.io never rewrites `library/ahm-diagrammo.xml`
// (it is loaded, not saved), so the drift guard compares this against the file byte for byte.
export function buildLibrary() {
  const specimens = [
    librarySpecimen("Healthy entity", "Healthy", "healthy"),
    librarySpecimen("Degraded entity", "Degraded", "degraded"),
    librarySpecimen("Unhealthy entity", "Unhealthy", "unhealthy"),
    librarySpecimen("Unknown entity", "Unknown", "unknown"),
    // The deepest specimen carries one row per supported signal state, so the library ships the
    // same glyph/colour inventory the examples do — including the states no example authors.
    librarySpecimen("Entity with metrics", "Entity with metrics", "degraded", [
      { name: "P95 latency", state: "degraded", result: "230" },
      { name: "Error rate", state: "unhealthy", result: "4 %" },
      { name: "Freshness", state: "unknown", result: "n/a" },
      { name: "Availability", state: "healthy", result: "99" },
    ]),
  ];
  specimens.push(libraryEntry("AHM swimlane", xmlObject(
    { label: "Application components", ahmRole: "lane", ahmLaneIndex: "2" },
    cell("lane", laneStyle(1), "1", { x: 0, y: 0, w: 360, h: 220 }, 'vertex="1" connectable="0"'),
  ), 360, 220));
  const legend = legendCells({ x: 0, y: 0 });
  specimens.push(libraryEntry("AHM legend", legend.cells.join(""), legend.width, L.legendH));

  const libraryJson = JSON.stringify(specimens)
    .replace(/&/g, "\\u0026").replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  return { specimens, text: `<mxlibrary>${libraryJson}</mxlibrary>` };
}

// Importing this module must have no side effects — the test suite imports SIGNAL_GLYPH from
// it — so everything that touches disk runs only when the file is executed directly.
// Named examples may be passed on the command line, so a regeneration can be scoped to exactly the
// artifacts a drift report named instead of rewriting every shipped file for no measured reason.
if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(resolve(root, "examples"), { recursive: true });
  mkdirSync(resolve(root, "library"), { recursive: true });

  const selected = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  for (const name of selected.length ? selected : EXAMPLES) {
    if (!EXAMPLES.includes(name)) throw new Error(`unknown example "${name}"`);
    const spec = readSpec(name);
    const built = makeModel(spec);
    writeFileSync(
      resolve(root, `examples/${name}.drawio.svg`),
      placeholderSvg(built.model, built.width, built.height, spec.title),
    );
    console.log(`${name}: ${spec.entities.length} entities, ${spec.edges.length} dependencies, `
      + `${built.routed.length} routed edges, ${built.width}x${built.height}`);
  }

  const library = buildLibrary();
  writeFileSync(resolve(root, "library/ahm-diagrammo.xml"), library.text);
  console.log(`library: ${library.specimens.length} native mxGraphModel entries`);
}
