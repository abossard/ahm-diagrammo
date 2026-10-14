// Renders the *native* mxGraphModel embedded in a .drawio.svg with the bundled Draw.io build the
// VS Code extension loads, measures the real rendered geometry, exports through Draw.io's own
// `xmlsvg` path (the exact call the extension makes before it replaces the file), and writes
// honest screenshots.
//
// Nothing here reads a hand-authored SVG body. Every number comes from the live render.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { decodeEntities, inflateDiagrams, readDrawioSvg } from "../test/helpers/artifact.mjs";
import {
  agentSpan, contentAttribute, contentValue, rootTagSpan,
} from "./svg-embed.mjs";
import { modelDigest, driftReport } from "../test/helpers/canonical.mjs";
import { exportXmlSvg, loadModel, withDrawio } from "./drawio-host.mjs";

const root = resolve(import.meta.dirname, "..");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Same-directory temp file plus a rename: a reader either sees the previous artifact or the new
// one, never a half-written body, and a crash mid-run cannot leave a PNG bound to no model.
function writeAtomic(file, data) {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, data);
  renameSync(temporary, file);
}

// NC-33: what a shipped example, its PNG and the report have to agree on. Everything is recomputed
// from the bytes on disk — never from the in-memory render — so a stale file cannot pass.
export function artifactDigests(name, prefix = "native") {
  const artifact = resolve(root, `examples/${name}.drawio.svg`);
  const png = resolve(root, `visual/${prefix}-${name}.png`);
  return {
    artifactSha256: sha256(readFileSync(artifact)),
    pngSha256: existsSync(png) ? sha256(readFileSync(png)) : null,
    modelDigest: modelDigest(readDrawioSvg(artifact).model),
  };
}

// The reopen boundary: Draw.io's own export string in, the model it embedded out. The `label` is
// kept for the caller's message, but the failure itself is the shared selector's named error — a
// consumer-local "missing embedded Draw.io content" message would hide *which* shape was wrong.
export function readDrawioSvgText(svg, label) {
  try {
    return { model: inflateDiagrams(decodeEntities(contentValue(svg))) };
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
}
export const EXAMPLES = ["hero", "kitchen-sink", "pills-stress"];

// --- NC-55 / NC-61 / NC-67: a byte comparison that survives a browser bump ----------------------
//
// Draw.io stamps the *exporting browser's* user agent into `<mxfile agent="…">`, so a Chrome
// version bump changes the saved bytes with no semantic cause whatsoever — that alone is what made
// the save/reopen proof read 107/108. Exactly that one attribute is normalised. The span it
// replaces is returned so a proof can assert what was tolerated, and everything else stays an exact
// byte comparison.
//
// The selector itself lives in `visual/svg-embed.mjs` since C-21 and is re-exported here unchanged
// (`D-C21-3`), so every carried `NC-61`/`NC-64` clause runs against the same function object every
// other extraction path uses. Keeping a second local copy here is what `F-C20-1` was.
export {
  AGENT_PLACEHOLDER, agentOf, agentSpan, contentValue, normaliseAgent, replaceAgent, rootTagSpan,
  splitAtAgent, svgOpenTagSpan,
} from "./svg-embed.mjs";

// Every maximal run of differing characters between two strings, so "these two differ only inside
// the agent attribute" is a measurement rather than an assumption.
export function diffRegions(left, right) {
  const regions = [];
  const longest = Math.max(left.length, right.length);
  let index = 0;
  while (index < longest) {
    if (left[index] === right[index]) { index += 1; continue; }
    const start = index;
    while (index < longest && left[index] !== right[index]) index += 1;
    regions.push({
      start, end: index, left: left.slice(start, index), right: right.slice(start, index),
    });
  }
  return regions;
}

// The three NC-55 corruption controls, each applied to a copy of the bytes in memory. Nothing here
// touches a file: a control that had to write an artifact to prove itself would be the very thing
// the criterion forbids.
const flipped = (character) => {
  if (/[0-9]/.test(character)) return String((Number(character) + 1) % 10);
  return character === "a" ? "b" : "a";
};

const flipAt = (text, index) => text.slice(0, index) + flipped(text[index]) + text.slice(index + 1);

export function corruptPayload(text) {
  const open = text.indexOf("&lt;diagram");
  const start = text.indexOf("&gt;", open) + "&gt;".length;
  const end = text.indexOf("&lt;/diagram&gt;", start);
  if (open < 0 || start < open || end < start) throw new Error("no deflated <diagram> payload found");
  const at = start + Math.floor((end - start) / 2);
  if (!/[A-Za-z0-9+/=]/.test(text[at])) throw new Error(`payload offset ${at} is not base64`);
  return { text: flipAt(text, at), at, was: text[at] };
}

export function corruptBody(text) {
  const { valueEnd } = contentAttribute(text);
  const at = text.slice(valueEnd).search(/[0-9]/) + valueEnd;
  if (at <= valueEnd) throw new Error("no rendered SVG body found after content=");
  return { text: flipAt(text, at), at, was: text[at] };
}

// NC-61 (iii): a byte inside the root open tag but outside `agent=…` — the `host=` value. The
// normalisation replaces one attribute, so everything else in the same tag must still be compared
// as a byte.
export function corruptRootAttribute(text) {
  const root = rootTagSpan(text);
  const agent = agentSpan(text);
  const at = root.start + text.slice(root.start, agent.start).search(/[0-9]/);
  if (at < root.start || at >= agent.start) {
    throw new Error("no non-agent byte inside the root &lt;mxfile open tag");
  }
  return { text: flipAt(text, at), at, was: text[at] };
}

// NC-61 (iii): the last byte of the file that can be flipped — the far tail, after `content="…"`
// has closed, so "only the agent is tolerated" is proved at both ends of the string.
export function corruptTail(text) {
  const { valueEnd } = contentAttribute(text);
  let at = text.length - 1;
  while (at > valueEnd && !/[0-9]/.test(text[at])) at -= 1;
  if (at <= valueEnd) throw new Error("no tail byte found after content=");
  return { text: flipAt(text, at), at, was: text[at] };
}


// Collected inside the page: every number below is read back from the rendered SVG DOM or from
// mxGraph's own view state, then converted into model coordinates.
function collect() {
  const graph = editorUi.editor.graph;
  const view = graph.view;
  const model = graph.getModel();
  const pane = view.getDrawPane();
  const inverse = pane.getScreenCTM().inverse();
  const scale = view.scale;
  const translate = { x: view.translate.x, y: view.translate.y };
  const svg = graph.container.querySelector("svg");

  const point = (x, y) => {
    const mapped = new DOMPoint(x, y).matrixTransform(inverse);
    return { x: mapped.x / scale - translate.x, y: mapped.y / scale - translate.y };
  };
  const clientBox = (node) => {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const a = point(rect.left, rect.top);
    const b = point(rect.right, rect.bottom);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };
  const viewBox = (state) => ({
    x: state.x / scale - translate.x,
    y: state.y / scale - translate.y,
    w: state.width / scale,
    h: state.height / scale,
  });
  // mxGraph paints a hidden 9px "pointer events" duplicate in front of every stroked shape; the
  // visible geometry is the first non-hidden node.
  const visibleNodes = (shape) => {
    if (!shape || !shape.node) return [];
    const node = shape.node;
    const all = ["path", "rect", "ellipse", "line"].includes(node.nodeName)
      ? [node]
      : [...node.querySelectorAll("path,rect,ellipse,line")];
    return all.filter((element) => element.getAttribute("visibility") !== "hidden");
  };
  const painted = (shape) => {
    const target = visibleNodes(shape)[0];
    if (!target) return null;
    const style = getComputedStyle(target);
    return {
      tag: target.nodeName,
      fill: target.getAttribute("fill"),
      stroke: target.getAttribute("stroke"),
      strokeWidth: target.getAttribute("stroke-width"),
      dasharray: target.getAttribute("stroke-dasharray"),
      filter: target.getAttribute("filter") || style.filter,
    };
  };
  const textOf = (state) => {
    if (!state.text || !state.text.node) return null;
    const node = state.text.node;
    const tspans = [...node.querySelectorAll("tspan")].map((span) => span.textContent);
    const texts = [...node.querySelectorAll("text")];
    const element = texts[0] || node;
    const style = getComputedStyle(element);
    return {
      box: clientBox(node),
      lines: tspans.length ? tspans : texts.map((text) => text.textContent),
      content: (tspans.length ? tspans : texts.map((text) => text.textContent)).join(" "),
      fontFamily: style.fontFamily,
      fontSize: style.fontSize,
      fill: element.getAttribute("fill") || style.fill,
    };
  };

  const cells = [];
  const edges = [];
  Object.keys(model.cells).forEach((key) => {
    const cell = model.cells[key];
    const state = view.getState(cell);
    if (!state) return;
    const attributes = {};
    if (cell.value && cell.value.attributes) {
      for (const attribute of cell.value.attributes) attributes[attribute.name] = attribute.value;
    }
    const entry = {
      id: String(cell.id),
      parent: cell.parent ? String(cell.parent.id) : null,
      edge: !!cell.edge,
      vertex: !!cell.vertex,
      // Draw.io's own answers, not a style regex: what the user can actually do to this cell.
      editable: graph.isCellEditable(cell),
      movable: graph.isCellMovable(cell),
      locked: graph.isCellLocked(cell),
      style: cell.style || "",
      label: typeof cell.value === "string" ? cell.value : (attributes.label ?? null),
      attributes,
      box: viewBox(state),
      shape: painted(state.shape),
      text: textOf(state),
    };
    if (cell.edge) {
      entry.points = (state.absolutePoints || []).filter(Boolean)
        .map((p) => ({ x: p.x / scale - translate.x, y: p.y / scale - translate.y }));
      // Saved waypoints, terminal identity and the literal rendered path: the three things NC-20 and
      // NC-21 need to tell "Draw.io routed this" from "we froze this".
      const geometry = model.getGeometry(cell);
      entry.userPoints = geometry && geometry.points ? geometry.points.length : 0;
      entry.terminals = {
        source: cell.source ? String(cell.source.id) : null,
        target: cell.target ? String(cell.target.id) : null,
      };
      // Only the routed stroke: skip the hidden hit path and the filled arrowhead triangle.
      const nodes = visibleNodes(state.shape)
        .filter((element) => element.nodeName === "path" && element.getAttribute("fill") === "none");
      const samples = [];
      nodes.forEach((path) => {
        const matrix = path.getScreenCTM();
        if (!matrix) return;
        const length = path.getTotalLength();
        if (!length) return;
        // 1px: the attribution metric (NC-18) compares distances of a few px, so a 4px stride
        // would carry more discretisation error than the margin it has to prove.
        for (let distance = 0; distance <= length; distance += 1) {
          const local = path.getPointAtLength(distance);
          const screen = new DOMPoint(local.x, local.y).matrixTransform(matrix);
          samples.push({ ...point(screen.x, screen.y), d: distance, length });
        }
      });
      entry.samples = samples;
      entry.pathData = nodes.map((path) => path.getAttribute("d")).join(" | ");
      edges.push(entry);
    }
    cells.push(entry);
  });

  const bounds = graph.getGraphBounds();
  return {
    graph: {
      cells: Object.keys(model.cells).length,
      width: Math.round(bounds.width / scale),
      height: Math.round(bounds.height / scale),
      shadowVisible: !!graph.shadowVisible,
      scale,
    },
    dom: {
      filterNodes: [...svg.querySelectorAll("[filter]")]
        .map((node) => `${node.nodeName}:${node.getAttribute("filter")}`),
      dropShadowNodes: [...svg.querySelectorAll("*")]
        .filter((node) => /drop-shadow/i.test(node.getAttribute("style") || "")
          || /drop-shadow/i.test(node.getAttribute("filter") || "")).length,
      fontFamilies: [...new Set([...svg.querySelectorAll("text")]
        .map((node) => getComputedStyle(node).fontFamily))],
      probe: (() => {
        const measure = (family) => {
          const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
          node.setAttribute("style", `font-family:${family};font-size:40px`);
          node.textContent = "Illegible Whimsy 1234";
          svg.appendChild(node);
          const width = node.getComputedTextLength();
          node.remove();
          return width;
        };
        return { sans: measure("Helvetica"), serif: measure("serif") };
      })(),
    },
    cells,
    edges,
  };
}

// Drags entities around the board with Draw.io's own `graph.moveCells` inside one model
// transaction, then re-reads the rendered geometry. Proves the built-in router re-routes.
export async function moveAndCollect(page, moves) {
  await page.evaluate((list) => {
    const graph = editorUi.editor.graph;
    const model = graph.getModel();
    model.beginUpdate();
    try {
      for (const move of list) {
        const cell = model.getCell(move.id);
        if (!cell) throw new Error(`cannot move missing cell ${move.id}`);
        graph.moveCells([cell], move.dx, move.dy);
      }
    } finally {
      model.endUpdate();
    }
    graph.refresh();
  }, moves);
  await new Promise((done) => setTimeout(done, 400));
  return page.evaluate(collect);
}

// Loads each example, records the shipped render, drags entities with Draw.io's own `moveCells`,
// records the re-routed render, then saves through the `xmlsvg` path and reopens it.
export async function moveExamples(moves, options = {}) {
  const { plugin = false } = options;
  const pluginSource = plugin ? readFileSync(resolve(root, "plugin/ahm-health.js"), "utf8") : null;
  const report = {};
  await withDrawio(async (page) => {
    for (const [name, list] of Object.entries(moves)) {
      const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
      await loadModel(page, model);
      const after = await moveAndCollect(page, list);
      const exported = await exportXmlSvg(page);
      const { model: reopenedModel } = readDrawioSvgText(exported, `${name} moved export`);
      await loadModel(page, reopenedModel);
      after.reopened = await page.evaluate(collect);
      report[name] = after;
    }
  }, { plugin: pluginSource });
  return report;
}

// Negative control for NC-24: pushes one real waypoint into the live model, then reports what the
// checker would see. Nothing is written to disk — this exists so the no-waypoint assertions are
// demonstrably discriminating rather than vacuous.
export async function injectWaypoint(name, edgeId, point) {
  return withDrawio(async (page) => {
    const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    await loadModel(page, model);
    const userPoints = await page.evaluate((id, where) => {
      const graph = editorUi.editor.graph;
      const graphModel = graph.getModel();
      const cell = graphModel.getCell(id);
      const geometry = graphModel.getGeometry(cell).clone();
      geometry.points = [new mxPoint(where.x, where.y)];
      graphModel.beginUpdate();
      try { graphModel.setGeometry(cell, geometry); } finally { graphModel.endUpdate(); }
      return graphModel.getGeometry(cell).points.length;
    }, edgeId, point);
    const exported = await exportXmlSvg(page);
    const { model: reopened } = readDrawioSvgText(exported, `${name} injected`);
    return {
      userPoints,
      exportedPointArrays: (reopened.match(/<Array as="points">/g) || []).length,
    };
  });
}

// --- C-14: the shipped install() path in the live runtime ---------------------------------------
//
// Everything below drives `window.AhmHealthPluginFactory().install(editorUi)` — the entry point the
// VS Code workspace actually loads — inside the bundled Draw.io build, and reads the editor's own
// state (`modified`, `undoManager.history`, `indexOfNextAdd`) *after* a wait longer than the
// plugin's recalculate debounce. Reading synchronously inside one `page.evaluate` is exactly what
// hid the Undo/Redo defect, so every measurement here is taken across a settle.

// Each ablation reverts exactly one of the roots this correction removed, applied to the shipped
// source in memory. Nothing is written to disk. An ablation that does not apply throws, so a
// negative control can never silently degrade into "the same plugin twice".
// The plugin's own hook-side self-suppression, reproduced verbatim so every ablation that pins the
// hook body keeps applying against the shipped source rather than against a stale copy of it.
const SELF_SUPPRESSION = "          // On every *successful* action the plugin's own closing "
  + "transaction re-enters this hook,\n"
  + "          // because `guarded` is released only after `model.endUpdate()` has finished dispatching.\n"
  + "          // Suppressing that is what stops the rollup from recomputing its own output. It is\n"
  + "          // counted here rather than at the guard: this call site is the plugin's own, so the\n"
  + "          // suppression is attributable by provenance instead of by timing.\n"
  + "          if (guarded) { stats.selfSuppressed++; return; }\n";

const ABLATIONS = {
  // Root 1: size the pill from the runtime font metric again (1px narrower on every label).
  runtimeMetric: [[
    "      var entry = PILL.width[shown];",
    "      var probe = root.mxUtils.getSizeForString(String(shown), PILL.fontSize, \"Helvetica\");\n"
    + "      var scaled = Math.ceil(probe.width) + 2;\n"
    + "      var entry = { label: scaled, pill: PILL.textX + scaled + PILL.tailPad };",
  ]],
  // Root 3: drop-and-re-append every style key, and compare styles as strings again.
  styleChurn: [
    [
      "          parts[index] = prefix + value;\n          return parts.join(\";\") + \";\";",
      "          parts.splice(index, 1);\n          break;",
    ],
    [
      "    function sameStyle(left, right) {\n      var a = styleMap(left);",
      "    function sameStyle(left, right) {\n      return String(left || \"\") === String(right || \"\");\n"
      + "      var a = styleMap(left);",
    ],
  ],
  // Root 4: react to every transaction again — the initial load included. This is also what makes
  // roots 1-3 observable on open at all.
  unfilteredListener: [[
    "          if (!relevantEdit(event && event.getProperty && event.getProperty(\"edit\"))) return;",
    "          void event;",
  ]],
  // NC-32's control, kept from C-13: the geometry update removed from the write path.
  resize: [[
    "      ops.push(geometryOp(model, pill, next.pill));\n"
    + "      ops.push(geometryOp(model, label, next.label));",
    "      void next;",
  ]],
  // C-15 root, control (a) for NC-40/NC-41/NC-37: the C-14 design restored — a *debounced*
  // recalculation from mxEvent.CHANGE, i.e. a second top-level transaction 100 ms later. The
  // relevance-filter line is reproduced verbatim so `unfilteredListener` still composes on top.
  changeListenerRecalc: [[
    "        hooked.addListener(root.mxEvent.END_UPDATE, function (sender, event) {\n"
    + "          // Nested `endUpdate()` calls fire END_UPDATE too — including the plugin's own, issued\n"
    + "          // from inside this handler — so only the outermost closing transaction is a user edit.\n"
    + "          if (hooked.updateLevel !== 0 || hooked.endingUpdate !== true) return;\n"
    + "          stats.hooks++;\n"
    + "          if (!relevantEdit(event && event.getProperty && event.getProperty(\"edit\"))) return;\n"
    + "          stats.relevant++;\n"
    + SELF_SUPPRESSION
    + "          run(recalculate);\n"
    + "        });",
    "        var recalculateTimer = null;\n"
    + "        var scheduled = function () {\n"
    + "          recalculateTimer = null;\n"
    + "          if (guarded) return;\n"
    + "          run(recalculate);\n"
    + "        };\n"
    + "        hooked.addListener(root.mxEvent.CHANGE, function (sender, event) {\n"
    + "          stats.hooks++;\n"
    + "          if (guarded) return;\n"
    + "          if (!relevantEdit(event && event.getProperty && event.getProperty(\"edit\"))) return;\n"
    + "          stats.relevant++;\n"
    + "          if (recalculateTimer != null) root.clearTimeout(recalculateTimer);\n"
    + "          recalculateTimer = root.setTimeout(scheduled, 100);\n"
    + "        });",
  ]],
  // NC-40 control (b): the join removed — the same synchronous recalculation, deferred out of the
  // originating transaction so it opens a top-level one of its own.
  separateTransactionRecalc: [[
    `          stats.relevant++;\n${SELF_SUPPRESSION}          run(recalculate);`,
    "          stats.relevant++;\n          root.setTimeout(function () { run(recalculate); }, 0);",
  ]],
  // NC-40 control (c) / NC-41 control (b) / NC-37 control (b): the derived write suppressed
  // entirely, so a plugin that stopped rolling up cannot pass by doing nothing.
  noJoin: [[
    `          stats.relevant++;\n${SELF_SUPPRESSION}          run(recalculate);`,
    "          stats.relevant++;",
  ]],
  // NC-42 control (b): the file-load filter removed. BEFORE_UNDO does fire on load, with
  // mxRootChange+mxRootChange.
  noRootChangeFilter: [[
    "        if (isChange(change, \"mxRootChange\")) return false;",
    "        void 0;",
  ]],
  // NC-38 control (b): the idempotence marker removed, so a second install() adds a second hook.
  noIdempotenceMarker: [[
    "      var already = ui[INSTALL_KEY];\n      if (already) return already;",
    "      void ui[INSTALL_KEY];",
  ]],
  // NC-42 control (a) / NC-59 control / NC-62 control: both halves of the re-entrancy guard removed
  // — the operation gate in `run()` and the hook-side self-suppression — so the plugin really does
  // re-enter.
  noReentrancyGuard: [
    [
      "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
      + "        operationInFlight = true;",
      "        operationInFlight = true;",
    ],
    [
      "          if (guarded) { stats.selfSuppressed++; return; }\n          run(recalculate);",
      "          run(recalculate);",
    ],
  ],
  // NC-65 control (a): the operation gate kept, its arming removed, everything else intact. Nothing
  // is ever in flight, so every nested entry runs — the state the shipped code blocks.
  noOperationGuard: [[
    "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
    + "        operationInFlight = true;",
    "        if (operationInFlight) { stats.blockedReentries++; return undefined; }",
  ]],
  // NC-69 control (a): the C-20 ordering restored — the plain-adapter route returns **above** the
  // gate, so nothing on that host is ever gated. This is the measured red baseline
  // (`P-C21-5`/`P-C21-6`): a nested action from the adapter's `ui.handleError` reaches depth 2, two
  // messages and `blockedReentries 0`.
  adapterBeforeGuard: [[
    "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
    + "        operationInFlight = true;",
    "        if (ui.diagram) return runPlain(operation);\n"
    + "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
    + "        operationInFlight = true;",
  ]],
  // NC-62 control (a): the C-18 ordering restored — no gate in `run()` at all, and the guard back
  // down inside `runDrawio`, so a read-only action entered re-entrantly from outside never reaches
  // a gate, runs a full extra validation and moves no counter.
  guardAfterReadOnlyRoute: [
    [
      "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
      + "        operationInFlight = true;",
      "        void 0;",
    ],
    [
      "        guarded = true;\n        stats.recalculations++;",
      "        if (guarded) { stats.blockedReentries++; return; }\n"
      + "        guarded = true;\n        stats.recalculations++;",
    ],
  ],
  // NC-65 control (c): the C-19 shape — the gate kept in `run()`, but the flag armed **inside**
  // `runDrawio` only. A mutating operation still blocks a nested entry (NC-65 (v) stays green) while
  // a top-level read-only validate arms nothing, so its error sink re-enters and runs a second full
  // validation (NC-65 (i) goes red). That difference is exactly what this correction adds.
  guardInsideRunDrawio: [
    [
      "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
      + "        operationInFlight = true;",
      "        if (operationInFlight) { stats.blockedReentries++; return undefined; }",
    ],
    [
      "        guarded = true;\n        stats.recalculations++;",
      "        guarded = true;\n        operationInFlight = true;\n        stats.recalculations++;",
    ],
  ],
  // NC-62 control (b): the hook's own self-suppression folded back into the public counter, so
  // "blockedReentries counts genuine external attempts, and only those" stops being true.
  foldSelfSuppressionIntoBlocked: [[
    "          if (guarded) { stats.selfSuppressed++; return; }",
    "          if (guarded) { stats.blockedReentries++; return; }",
  ]],
  // NC-43 control (a): a blanket silent catch on the derived write.
  swallowDerivedWrite: [[
    "          revertTransaction(edit, 0);\n          report(rollbackError(error));",
    "          revertTransaction(edit, 0);\n          void error;",
  ]],
  // NC-43 control (b): a failure raised *after* the derived write has already appended changes to
  // the originating edit, so "no partial entry" cannot be bought by failing before writing.
  failAfterWrite: [[
    "        group.ops.forEach(function (op) { applyOp(model, op); });\n        changed++;",
    "        group.ops.forEach(function (op) { applyOp(model, op); });\n        changed++;\n"
    + "        if (changed === 1) fail(\"injected failure after the derived write began\");",
  ]],
  // NC-46's usability clause: the same mid-write failure, injected exactly **once** per page, so the
  // editor's behaviour *after* a rolled-back transaction can be exercised with a genuinely valid
  // relevant edit rather than with a second failure.
  failAfterWriteOnce: [[
    "        group.ops.forEach(function (op) { applyOp(model, op); });\n        changed++;",
    "        group.ops.forEach(function (op) { applyOp(model, op); });\n        changed++;\n"
    + "        if (changed === 1 && !root.ahmInjectedFailureUsed) {\n"
    + "          root.ahmInjectedFailureUsed = true;\n"
    + "          fail(\"injected failure after the derived write began\");\n"
    + "        }",
  ]],
  // NC-45 control (b) / NC-47 control (b): the rollback removed, so a failed transaction commits
  // whatever it had already written — including the user's own change.
  noRollback: [[
    "          revertTransaction(edit, 0);\n          report(rollbackError(error));",
    "          report(rollbackError(error));",
  ]],
  // NC-47 control (a): the C-15 shape — the rollback narrowed back to the changes this plugin
  // appended, leaving the originating user change committed against a stale rollup.
  tailOnlyRollback: [
    [
      "        var edit = model.currentEdit;",
      "        var edit = model.currentEdit;\n"
      + "        var mark = edit && edit.changes ? edit.changes.length : 0;",
    ],
    [
      "          revertTransaction(edit, 0);",
      "          revertTransaction(edit, mark);",
    ],
  ],
  // NC-46 control (a): the same whole-transaction rollback, performed one event too late — after
  // Draw.io's `!currentEdit.isEmpty()` gate has already passed.
  rollbackAtBeforeUndo: [[
    "        hooked.addListener(root.mxEvent.END_UPDATE, function (sender, event) {\n"
    + "          // Nested `endUpdate()` calls fire END_UPDATE too — including the plugin's own, issued\n"
    + "          // from inside this handler — so only the outermost closing transaction is a user edit.\n"
    + "          if (hooked.updateLevel !== 0 || hooked.endingUpdate !== true) return;\n"
    + "          stats.hooks++;",
    "        hooked.addListener(root.mxEvent.BEFORE_UNDO, function (sender, event) {\n"
    + "          stats.hooks++;",
  ]],
  // NC-46 control (b): the same, plus `edit.ignoreEdit` — measured to clear only the dirty flag,
  // never the phantom entry.
  rollbackAtBeforeUndoIgnoreEdit: [
    [
      "        hooked.addListener(root.mxEvent.END_UPDATE, function (sender, event) {\n"
      + "          // Nested `endUpdate()` calls fire END_UPDATE too — including the plugin's own, issued\n"
      + "          // from inside this handler — so only the outermost closing transaction is a user edit.\n"
      + "          if (hooked.updateLevel !== 0 || hooked.endingUpdate !== true) return;\n"
      + "          stats.hooks++;",
      "        hooked.addListener(root.mxEvent.BEFORE_UNDO, function (sender, event) {\n"
      + "          stats.hooks++;",
    ],
    [
      "      edit.changes.length = floor;",
      "      edit.changes.length = floor;\n      edit.ignoreEdit = true;",
    ],
  ],
  // NC-48 control (c): the pre-C-16 factory-level API — one `api` object and one `stats` counter
  // set shared by every editor the same factory() installs on.
  sharedFactoryApi: [[
    "      var installed = { stats: stats, INSTALL_KEY: INSTALL_KEY, compatibility: compatibility, disabled: disabled };\n"
    + "      Object.keys(api).forEach(function (key) {\n"
    + "        if (!(key in installed)) installed[key] = api[key];\n"
    + "      });\n"
    + "      ui[INSTALL_KEY] = installed;\n"
    + "      return installed;",
    "      api.stats = stats;\n"
    + "      api.INSTALL_KEY = INSTALL_KEY;\n"
    + "      api.compatibility = compatibility;\n"
    + "      api.disabled = disabled;\n"
    + "      ui[INSTALL_KEY] = api;\n"
    + "      return api;",
  ]],
  // NC-52 control (a): the throwaway probe model's `endingUpdate` flag renamed away, so the outer
  // gate the whole rollback design depends on can never be observed. Applied to the *probe's* model
  // factory only — the active document is never touched by an ablation.
  hostNoEndingUpdate: [[
    "    function makeProbeModel(root) {\n      return new root.mxGraphModel();\n    }",
    "    function makeProbeModel(root) {\n"
    + "      var m = new root.mxGraphModel();\n"
    + "      Object.defineProperty(m, \"endingUpdate\", {\n"
    + "        get: function () { return undefined; }, set: function () {}, configurable: true,\n"
    + "      });\n"
    + "      return m;\n    }",
  ]],
  // NC-52 control (b): a host whose history gate fires BEFORE END_UPDATE, i.e. the one ordering that
  // silently turns the rollback into a phantom empty undo entry (measured as R2/R3 at C-16).
  hostGateBeforeEndUpdate: [[
    "    function makeProbeModel(root) {\n      return new root.mxGraphModel();\n    }",
    "    function makeProbeModel(root) {\n"
    + "      var m = new root.mxGraphModel();\n"
    + "      m.endUpdate = function () {\n"
    + "        this.updateLevel--;\n"
    + "        if (this.updateLevel === 0) this.fireEvent(new root.mxEventObject(root.mxEvent.END_EDIT));\n"
    + "        if (!this.endingUpdate) {\n"
    + "          this.endingUpdate = this.updateLevel === 0;\n"
    + "          try {\n"
    + "            if (this.endingUpdate && !this.currentEdit.isEmpty()) {\n"
    + "              this.fireEvent(new root.mxEventObject(root.mxEvent.BEFORE_UNDO, \"edit\", this.currentEdit));\n"
    + "              var a = this.currentEdit;\n"
    + "              this.currentEdit = this.createUndoableEdit();\n"
    + "              a.notify();\n"
    + "              this.fireEvent(new root.mxEventObject(root.mxEvent.UNDO, \"edit\", a));\n"
    + "            }\n"
    + "            this.fireEvent(new root.mxEventObject(root.mxEvent.END_UPDATE, \"edit\", this.currentEdit));\n"
    + "          } finally { this.endingUpdate = false; }\n"
    + "        }\n"
    + "      };\n"
    + "      return m;\n    }",
  ]],
  // NC-52 control (c): a host whose `currentEdit` carries no invertible change list, so a rollback
  // has nothing to re-execute in reverse.
  hostNoChangeList: [[
    "    function makeProbeModel(root) {\n      return new root.mxGraphModel();\n    }",
    "    function makeProbeModel(root) {\n"
    + "      var m = new root.mxGraphModel();\n"
    + "      m.beginUpdate = function () { this.updateLevel++; };\n"
    + "      Object.defineProperty(m.currentEdit, \"changes\", {\n"
    + "        get: function () { return { length: 0 }; }, set: function () {}, configurable: true,\n"
    + "      });\n"
    + "      return m;\n    }",
  ]],
  // NC-56's removal controls: each of the four *active-model* identity checks deleted on its own,
  // so the matching live per-instance patch must stop being detected. A check nobody can kill is
  // not proved by the case that passes with it in place.
  dropModelNotStockCheck: [[
    '        if (Object.getPrototypeOf(active) !== root.mxGraphModel.prototype) reasons.push("model-not-stock");',
    "        void active;",
  ]],
  dropEndUpdatePatchedCheck: [[
    '        if (active.endUpdate !== root.mxGraphModel.prototype.endUpdate) reasons.push("endUpdate-patched");',
    "        void active;",
  ]],
  dropEndingUpdateBooleanCheck: [[
    '        if (typeof active.endingUpdate !== "boolean") reasons.push("endingUpdate-not-boolean");',
    "        void active;",
  ]],
  dropCurrentEditChangesCheck: [[
    '        if (!Array.isArray(active.currentEdit && active.currentEdit.changes)) reasons.push("currentEdit-no-changes");',
    "        void active;",
  ]],
  // NC-58 control (a): the pre-C-18 routing restored — `run` tests `disabled` before `readOnly`, so
  // `ahmValidate` falls through to `runDrawio` on a compatible host and silently repairs.
  validateRoutedByDisabled: [[
    "        if (readOnly) return runReadOnly(operation);\n        if (disabled) return undefined;",
    "        if (disabled) return readOnly ? runReadOnly(operation) : undefined;",
  ]],
  // NC-58 control (b): the read-only path made silent, so "validate wrote nothing" could be bought
  // by validate reporting nothing.
  swallowValidationError: [[
    "        try { operation(readDrawio(ui.editor.graph)); } catch (error) { report(error); }",
    "        try { operation(readDrawio(ui.editor.graph)); } catch (error) { void error; }",
  ]],
  // NC-53 control (a): the pre-C-17 message — the bare validation text, with no word about the
  // other changes the same transaction lost.
  bareRollbackMessage: [[
    "          revertTransaction(edit, 0);\n          report(rollbackError(error));",
    "          revertTransaction(edit, 0);\n          report(error);",
  ]],
  // NC-53 control (b): the same message reported a second time, from the enclosing `endUpdate`.
  reportTwice: [
    [
      "        var edit = model.currentEdit;\n        model.beginUpdate();",
      "        var edit = model.currentEdit;\n        var reportAgain = null;\n        model.beginUpdate();",
    ],
    [
      "          revertTransaction(edit, 0);\n          report(rollbackError(error));",
      "          revertTransaction(edit, 0);\n          report(rollbackError(error));\n"
      + "          reportAgain = error;",
    ],
    [
      "          model.endUpdate();\n          guarded = false;",
      "          model.endUpdate();\n"
      + "          if (reportAgain) { report(rollbackError(reportAgain)); reportAgain = null; }\n"
      + "          guarded = false;",
    ],
  ],
};

export const PLUGIN_ABLATION_NAMES = Object.freeze(Object.keys(ABLATIONS));

export function ablatePlugin(names, source = readFileSync(resolve(root, "plugin/ahm-health.js"), "utf8")) {
  for (const name of names) {
    const patches = ABLATIONS[name];
    if (!patches) throw new Error(`unknown plugin ablation "${name}"`);
    for (const [from, to] of patches) {
      const occurrences = source.split(from).length - 1;
      if (occurrences !== 1) {
        const error = new Error(
          `plugin ablation "${name}": anchor ${occurrences === 0 ? "not found" : `occurs ${occurrences} times`}`,
        );
        error.name = "AblationAnchorError";
        throw error;
      }
      source = source.replace(from, to);
    }
  }
  return source;
}

// NC-56: the guard's four *active-model* identity checks read live per-instance state on the
// editor's own document, so an ablation applied to the plugin's throwaway probe model is a decoy
// applied to a seam the code under test never reads. Each patch below changes exactly one of the
// four facts, on the editor's own model, before `install()` reads it, and each is written to keep
// the model working afterwards — a patched host that could no longer record an edit would prove
// "the plugin wrote nothing" by breaking the editor instead of by disabling the plugin.
export const ACTIVE_MODEL_PATCHES = [
  "modelNotStock", "endUpdatePatched", "endingUpdateNotBoolean", "currentEditNoChanges",
];

async function armActiveModelPatches(page) {
  await page.evaluate(() => {
    window.ahmPatchActiveModel = (model, name) => {
      const patches = {
        // A subclass of the same global class: the prototype moves, every inherited behaviour stays.
        modelNotStock: () => {
          Object.setPrototypeOf(model, Object.create(window.mxGraphModel.prototype));
          return Object.getPrototypeOf(model) !== window.mxGraphModel.prototype;
        },
        // An own `endUpdate` that still delegates to the stock one, i.e. identical behaviour.
        endUpdatePatched: () => {
          const stock = window.mxGraphModel.prototype.endUpdate;
          model.endUpdate = function () { return stock.apply(this, arguments); };
          return model.endUpdate !== stock;
        },
        // The outer-transaction flag kept truthy but no longer a boolean.
        endingUpdateNotBoolean: () => {
          let flag = 0;
          Object.defineProperty(model, "endingUpdate", {
            get() { return flag; },
            set(value) { flag = value ? 1 : 0; },
            configurable: true,
          });
          return typeof model.endingUpdate !== "boolean";
        },
        // An array-*like* change list: `Array.isArray` is false, `push`/`length`/indexing still work.
        currentEditNoChanges: () => {
          const arrayLike = Object.create(Array.prototype);
          arrayLike.length = 0;
          model.currentEdit.changes = arrayLike;
          return !Array.isArray(model.currentEdit.changes);
        },
      };
      const patch = patches[name];
      if (!patch) throw new Error(`unknown active-model patch "${name}"`);
      return patch() === true;
    };
  });
}

// Calls the shipped entry point in the live page and reports what it registered, plus the model's
// own listener registry before and after each call. `mxEventSource` stores every listener as a
// name + funct pair, so one listener is two slots; the census counts pairs by event name.
async function installPlugin(page, enabled, times = 1) {
  return page.evaluate((run, count) => {
    window.ahmErrors = [];
    editorUi.handleError = function (error) {
      window.ahmErrors.push(String((error && error.message) || error));
    };
    const model = editorUi.editor.graph.getModel();
    const census = () => {
      const list = model.eventListeners || [];
      const byName = {};
      for (let index = 0; index < list.length; index += 2) {
        const key = String(list[index]);
        byName[key] = (byName[key] || 0) + 1;
      }
      return { slots: list.length, byName };
    };
    const listeners = [census()];
    if (run) {
      for (let call = 0; call < count; call++) {
        const api = window.AhmHealthPluginFactory().install(editorUi);
        if (call === 0) window.ahmApi = api;
        window.ahmApiLast = api;
        listeners.push(census());
      }
    }
    const names = [
      "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
      "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed",
      "ahmRecalculate", "ahmValidate",
    ];
    return {
      installed: !!run,
      installs: run ? count : 0,
      actions: names.filter((name) => !!editorUi.actions.get(name)),
      missing: names.filter((name) => !editorUi.actions.get(name)),
      menu: !!(editorUi.menus && editorUi.menus.get && editorUi.menus.get("ahmHealthModel")),
      listeners,
      sameApi: run ? window.ahmApi === window.ahmApiLast : null,
      marker: run ? !!editorUi[window.ahmApi.INSTALL_KEY] : null,
    };
  }, enabled, times);
}

// The page-side probe kit every C-15 driver shares. Installed once per session, after the model is
// loaded, so a load's own dispatches never pollute a recording.
//
//   ahm.classOf(change)  – the mxChange constructor, resolved against the bundled globals because
//                          app.min.js is minified and `constructor.name` is mangled.
//   ahm.record()         – arms CHANGE / END_UPDATE recorders that read the model *and* the
//                          rendered DOM synchronously inside the handler.
//   ahm.probe()          – undo state, model values, rendered pill/label/card, plugin counters.
async function armProbes(page, watch) {
  await page.evaluate((ids) => {
    // Draw.io keeps the same mxGraphModel across a load, so re-arming after a reopen must not
    // register the recorders twice — a doubly-recorded dispatch would look like two dispatches.
    if (window.ahm) {
      window.ahm.ids = ids;
      window.ahm.reset();
      return;
    }
    const graph = editorUi.editor.graph;
    const model = graph.getModel();
    const CLASSES = [
      "mxRootChange", "mxChildChange", "mxTerminalChange", "mxValueChange",
      "mxStyleChange", "mxGeometryChange", "mxCollapseChange", "mxVisibleChange",
    ];
    const round = (value) => (value == null ? null : Math.round(value * 10) / 10);
    const classOf = (change) => CLASSES.find((name) => typeof window[name] === "function"
      && change instanceof window[name]) || "unknown";
    const changesOf = (edit) => ((edit && edit.changes) || []).map(classOf);
    const attribute = (cell, name) => (cell && cell.value && cell.value.getAttribute
      ? cell.value.getAttribute(name) : null);
    // The painted geometry, not the model geometry: the first non-hidden shape node mxGraph drew,
    // converted back into model coordinates through the draw pane's own matrix so an undo that
    // scrolls the canvas cannot look like a geometry change.
    const toModel = (x, y) => {
      const view = graph.view;
      const mapped = new DOMPoint(x, y)
        .matrixTransform(view.getDrawPane().getScreenCTM().inverse());
      return {
        x: mapped.x / view.scale - view.translate.x,
        y: mapped.y / view.scale - view.translate.y,
      };
    };
    const paintedBox = (cell) => {
      const state = graph.view.getState(cell);
      const node = state && state.shape && state.shape.node;
      if (!node) return null;
      const target = [...node.querySelectorAll("rect,path,ellipse")]
        .find((element) => element.getAttribute("visibility") !== "hidden");
      if (!target) return null;
      const box = target.getBoundingClientRect();
      const a = toModel(box.left, box.top);
      const b = toModel(box.right, box.bottom);
      return {
        x: round(a.x), y: round(a.y), w: round(b.x - a.x), h: round(b.y - a.y),
        fill: target.getAttribute("fill"), stroke: target.getAttribute("stroke"),
      };
    };
    const renderedText = (cell) => {
      const state = graph.view.getState(cell);
      return state && state.text && state.text.node ? state.text.node.textContent : null;
    };
    const renderedOf = (id) => ({
      label: renderedText(model.getCell(`${id}-state-label`)),
      pill: paintedBox(model.getCell(`${id}-state`)),
      card: paintedBox(model.getCell(id)),
    });
    const modelOf = (id) => {
      const cell = model.getCell(id);
      const pill = model.getCell(`${id}-state`);
      const geometry = model.getGeometry(pill);
      return {
        local: attribute(cell, "ahmLocalState"),
        computed: attribute(cell, "ahmComputedState"),
        label: attribute(model.getCell(`${id}-state-label`), "label"),
        pillWidth: geometry.width,
        pillX: geometry.x,
        fill: (cell.style.match(/fillColor=([^;]*)/) || [])[1] || null,
      };
    };
    const pair = (id) => `${attribute(model.getCell(id), "ahmLocalState")}/`
      + `${attribute(model.getCell(id), "ahmComputedState")}`;
    const snapshot = () => Object.fromEntries(window.ahm.ids.map((id) => [id, pair(id)]));
    const renderedPairs = () => Object.fromEntries(window.ahm.ids.map((id) => [id,
      `${renderedText(model.getCell(`${id}-state-label`))}/${attribute(model.getCell(id), "ahmComputedState")}`]));
    const entries = () => editorUi.editor.undoManager.history.map(changesOf);
    // Every watched cell's model state at full fidelity: the health attributes, the *whole* style
    // string of the card, the pill and the dot, and the geometry of the card, the pill and the pill
    // label. A rollback that restores only `ahmLocalState` cannot pass against this.
    const cellOf = (id) => {
      const geometry = (key) => {
        const cell = model.getCell(key);
        const box = cell ? model.getGeometry(cell) : null;
        return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
      };
      const style = (key) => {
        const cell = model.getCell(key);
        return cell ? cell.style || null : null;
      };
      return {
        local: attribute(model.getCell(id), "ahmLocalState"),
        computed: attribute(model.getCell(id), "ahmComputedState"),
        label: attribute(model.getCell(`${id}-state-label`), "label"),
        style: style(id),
        pillStyle: style(`${id}-state`),
        dotStyle: style(`${id}-state-dot`),
        card: geometry(id),
        pill: geometry(`${id}-state`),
        pillLabel: geometry(`${id}-state-label`),
      };
    };

    window.ahm = {
      classOf, changesOf, entries, modelOf, cellOf, renderedOf, ids,
      log: { change: [], endUpdate: [], beforeUndo: [], undo: [], tape: [] },
      reset() {
        window.ahm.log = { change: [], endUpdate: [], beforeUndo: [], undo: [], tape: [] };
      },
      // NC-45's five boundaries in one reading: the live undo manager, `editor.modified`, the live
      // model (values, full styles, geometry, `currentEdit` and `updateLevel`), the painted boxes
      // and the collected errors.
      rollbackProbe(step) {
        return {
          step,
          modified: !!editorUi.editor.modified,
          historyLength: editorUi.editor.undoManager.history.length,
          indexOfNextAdd: editorUi.editor.undoManager.indexOfNextAdd,
          entries: entries(),
          currentEdit: ((model.currentEdit && model.currentEdit.changes) || []).length,
          updateLevel: model.updateLevel,
          errors: (window.ahmErrors || []).slice(),
          stats: window.ahmApi && window.ahmApi.stats ? { ...window.ahmApi.stats } : null,
          cells: Object.fromEntries(window.ahm.ids.map((id) => [id, cellOf(id)])),
          rendered: Object.fromEntries(window.ahm.ids.map((id) => [id, renderedOf(id)])),
        };
      },
      probe(step) {
        return {
          step,
          modified: !!editorUi.editor.modified,
          historyLength: editorUi.editor.undoManager.history.length,
          indexOfNextAdd: editorUi.editor.undoManager.indexOfNextAdd,
          entries: entries(),
          errors: (window.ahmErrors || []).slice(),
          stats: window.ahmApi && window.ahmApi.stats
            ? { ...window.ahmApi.stats } : null,
          // The API the *last* install() call returned: identical to `stats` when install() is
          // idempotent, a second independent counter when it is not.
          lastStats: window.ahmApiLast && window.ahmApiLast.stats
            ? { ...window.ahmApiLast.stats } : null,
          values: Object.fromEntries(window.ahm.ids.map((id) => [id, modelOf(id)])),
          rendered: Object.fromEntries(window.ahm.ids.map((id) => [id, renderedOf(id)])),
        };
      },
    };
    // mxGraph's own repaint listener is registered at construction, so it runs before this one:
    // what is read here is the frame the user would have seen for that dispatch.
    // Every recorder also appends to `log.tape`, the ordered event sequence NC-46 asserts against.
    const tape = (tag, event) => {
      const edit = event && event.getProperty ? event.getProperty("edit") : null;
      window.ahm.log.tape.push({
        tag,
        changes: changesOf(edit),
        updateLevel: model.updateLevel,
        endingUpdate: !!model.endingUpdate,
        history: editorUi.editor.undoManager.history.length,
      });
    };
    model.addListener(mxEvent.CHANGE, (sender, event) => {
      const edit = event.getProperty("edit");
      tape("CHANGE", event);
      window.ahm.log.change.push({
        changes: changesOf(edit),
        undone: !!edit.undone,
        redone: !!edit.redone,
        values: snapshot(),
        rendered: renderedPairs(),
        history: editorUi.editor.undoManager.history.length,
      });
    });
    model.addListener(mxEvent.BEFORE_UNDO, (sender, event) => {
      tape("BEFORE_UNDO", event);
      window.ahm.log.beforeUndo.push({
        changes: changesOf(event.getProperty("edit")),
        history: editorUi.editor.undoManager.history.length,
      });
    });
    model.addListener(mxEvent.UNDO, (sender, event) => {
      tape("UNDO", event);
      window.ahm.log.undo.push({
        changes: changesOf(event.getProperty("edit")),
        history: editorUi.editor.undoManager.history.length,
      });
    });
    // NC-54 clause 2: END_EDIT is armed too. `mxGraphModel.endUpdate` fires it at `updateLevel === 0`
    // *before* the `endingUpdate` block (`app.min.js` @481771), so no plugin listener can pre-empt
    // it and it cannot be suppressed without patching Draw.io. It is therefore recorded rather than
    // claimed absent, and the claim that survives is the one that protects observers: a rolled-back
    // transaction dispatches no CHANGE, no BEFORE_UNDO and no UNDO — no dispatch that carries an edit.
    model.addListener(mxEvent.END_EDIT, (sender, event) => {
      tape("END_EDIT", event);
    });
    // NC-40's measured boundary: END_UPDATE fires *before* BEFORE_UNDO, so a listener here
    // necessarily observes the model after the user's change and before the rollup. What that
    // window is reachable from is measured, not asserted away: the undo history, the rendered
    // frame and a synchronous serialisation of the model are all read from inside the handler.
    model.addListener(mxEvent.END_UPDATE, (sender, event) => {
      const edit = event.getProperty("edit");
      tape("END_UPDATE", event);
      let serialised = null;
      try {
        const node = editorUi.editor.getGraphXml();
        const xml = new XMLSerializer().serializeToString(node);
        const match = xml.match(/ahmId="db"[^>]*/);
        serialised = match ? [
          (match[0].match(/ahmLocalState="([^"]*)"/) || [])[1] || null,
          (match[0].match(/ahmComputedState="([^"]*)"/) || [])[1] || null,
        ].join("/") : null;
      } catch (error) {
        serialised = `error: ${error.message}`;
      }
      window.ahm.log.endUpdate.push({
        changes: changesOf(edit),
        updateLevel: model.updateLevel,
        endingUpdate: !!model.endingUpdate,
        values: snapshot(),
        rendered: renderedPairs(),
        history: editorUi.editor.undoManager.history.length,
        serialised,
      });
    });
  }, watch);
}

const probeStep = (page, step) => page.evaluate((label) => window.ahm.probe(label), step);
const readLog = (page) => page.evaluate(() => window.ahm.log);
const resetLog = (page) => page.evaluate(() => window.ahm.reset());

// One relevant semantic edit, exactly as a user makes it through Edit Data: one transaction that
// sets one health attribute on one cell.
const externalEdit = (page, id, attribute, value) => page.evaluate((cellId, name, next) => {
  const model = editorUi.editor.graph.getModel();
  const cell = model.getCell(cellId);
  const value2 = cell.value.cloneNode(true);
  value2.setAttribute(name, next);
  model.beginUpdate();
  try { model.setValue(cell, value2); } finally { model.endUpdate(); }
}, id, attribute, value);

// NC-40 / NC-41: one semantic edit through the shipped install(), every CHANGE dispatch recorded
// with the values and the rendered frame it carried, then three full undo -> redo cycles read both
// immediately and after a settle longer than any timer the plugin could still hold.
export async function pluginAtomicEdit(name, options = {}) {
  const {
    ablate = [], entity = "db", attribute = "ahmLocalState", value = "Unhealthy",
    wait = 700, cycles = 3, installs = 1,
    watch = ["db", "shop", "reporting", "root"],
  } = options;
  const source = ablatePlugin(ablate);
  const result = { registration: null, steps: [], log: null };
  await withDrawio(async (page) => {
    const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    result.registration = await installPlugin(page, true, installs);
    await loadModel(page, model);
    await settle(wait);
    await armProbes(page, watch);
    result.steps.push(await probeStep(page, "install + load + settle"));

    await resetLog(page);
    await externalEdit(page, entity, attribute, value);
    result.steps.push(await probeStep(page, "external edit (immediate)"));
    await settle(wait);
    // Read after the settle, so a design that dispatches a second, later transaction is recorded
    // in the same log rather than falling outside it.
    result.log = await readLog(page);
    result.steps.push(await probeStep(page, "external edit + settle"));

    for (let cycle = 1; cycle <= cycles; cycle++) {
      await page.evaluate(() => editorUi.actions.get("undo").funct());
      result.steps.push(await probeStep(page, `cycle ${cycle} undo (immediate)`));
      await settle(wait);
      result.steps.push(await probeStep(page, `cycle ${cycle} undo + settle`));
      await page.evaluate(() => editorUi.actions.get("redo").funct());
      result.steps.push(await probeStep(page, `cycle ${cycle} redo (immediate)`));
      await settle(wait);
      result.steps.push(await probeStep(page, `cycle ${cycle} redo + settle`));
    }
  }, { plugin: source });
  return result;
}

// NC-42: transaction granularity, irrelevant edits, load/export/reopen, a no-op recalculation and
// the plugin's own re-entrancy counter, all in one live session through install().
export async function pluginGranularity(name, options = {}) {
  const {
    ablate = [], wait = 700, moveId = "web",
    watch = ["db", "shop", "reporting", "root"],
  } = options;
  const source = ablatePlugin(ablate);
  const report = {};
  await withDrawio(async (page) => {
    const { model: loaded } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    report.registration = await installPlugin(page, true, 1);
    await loadModel(page, loaded);
    await settle(wait);
    await armProbes(page, watch);
    report.open = await probeStep(page, "open + settle");

    // Clause 4, before anything is edited: Draw.io's own xmlsvg export, reopened from those bytes.
    const exported = await exportXmlSvg(page);
    const { model: reopened } = readDrawioSvgText(exported, `${name} granularity export`);
    await loadModel(page, reopened);
    await settle(wait);
    await armProbes(page, watch);
    report.reopened = await probeStep(page, "export + reopen + settle");
    report.drift = driftReport(loaded, reopened);

    // Clause 5: a recalculation whose result equals the current model.
    const beforeNoop = await probeStep(page, "before no-op recalculate");
    await page.evaluate(() => editorUi.actions.get("ahmRecalculate").funct());
    await settle(wait);
    report.noop = {
      before: beforeNoop, after: await probeStep(page, "after no-op recalculate"),
    };

    // Clause 1: three health writes inside ONE beginUpdate/endUpdate.
    const beforeBatch = await probeStep(page, "before multi-cell transaction");
    await resetLog(page);
    await page.evaluate(() => {
      const model = editorUi.editor.graph.getModel();
      const write = (id, state) => {
        const cell = model.getCell(id);
        const value = cell.value.cloneNode(true);
        value.setAttribute("ahmLocalState", state);
        model.setValue(cell, value);
      };
      model.beginUpdate();
      try {
        write("db", "Degraded");
        write("cache", "Degraded");
        write("queue", "Degraded");
      } finally { model.endUpdate(); }
    });
    await settle(wait);
    report.batch = {
      before: beforeBatch, after: await probeStep(page, "one transaction, three writes"),
      log: await readLog(page),
    };

    // Clause 2: the same three writes as three separate transactions.
    const beforeBurst = await probeStep(page, "before burst");
    for (const [id, state] of [["db", "Unhealthy"], ["cache", "Unhealthy"], ["queue", "Unhealthy"]]) {
      await externalEdit(page, id, "ahmLocalState", state);
    }
    await settle(wait);
    report.burst = { before: beforeBurst, after: await probeStep(page, "three transactions") };

    // Clause 3: an irrelevant mutation — a pure card move.
    const beforeMove = await probeStep(page, "before move");
    await page.evaluate((id) => {
      const graph = editorUi.editor.graph;
      graph.moveCells([graph.getModel().getCell(id)], 8, 0);
    }, moveId);
    await settle(wait);
    report.move = { before: beforeMove, after: await probeStep(page, "move a card") };

    // The plugin's own top-level transaction: the registered action. Its derived write fires
    // BEFORE_UNDO again, and the re-entrancy guard is the only thing that stops the recalculation
    // from running a second time inside its own result.
    const beforeAction = await probeStep(page, "before action");
    await page.evaluate(() => {
      const graph = editorUi.editor.graph;
      graph.setSelectionCell(graph.getModel().getCell("db"));
      editorUi.actions.get("ahmSetHealthy").funct();
    });
    await settle(wait);
    report.action = { before: beforeAction, after: await probeStep(page, "ahmSetHealthy action") };

    // Clause 6: undo and redo must not re-enter the recalculation either.
    await page.evaluate(() => editorUi.actions.get("undo").funct());
    await settle(wait);
    report.undo = await probeStep(page, "undo");
    await page.evaluate(() => editorUi.actions.get("redo").funct());
    await settle(wait);
    report.redo = await probeStep(page, "redo");
  }, { plugin: source });
  return report;
}

const settle = (ms) => new Promise((done) => setTimeout(done, ms));

// --- C-16 / C-17: whole-transaction rollback ----------------------------------------------------
//
// One relevant user transaction that fails, driven through the shipped `install(editorUi)` in the
// live bundled build. The grid is {failure phase} x {transaction shape} x {path}, and the three axes
// are independent in the code rather than flattened into one list: the phase is chosen by the caller
// (a malformed model fails before the derived write; the `failAfterWrite` ablation fails part-way
// through it), and each case carries its own `{shape, path}` pair. A missing cell is therefore a
// missing combination, not a missing list entry.
//
// `path: "hook"` is a plain user transaction that reaches the model hook. `path: "action"` is the
// registered `ahmSetUnhealthy` entry. `selectedId()` reads exactly one selection cell, so an action
// can never author more than one semantic change by itself: "action x multi" and "action x compound"
// only exist at the transaction boundary, and they are constructed there — the action is invoked
// *inside* an outer user `beginUpdate`/`endUpdate` that already carries the other changes. That
// construction is what it says it is, and each such cell records what the outer transaction was
// carrying before the action ran so the cell cannot be silently degenerate.
//
// Every case is measured on both sides of the failure against a **clean** editor and again against
// an **already dirty** one, so "modified is unchanged" is proved in both directions rather than
// only where `false` happens to be the answer.

const rollbackProbe = (page, step) => page.evaluate((label) => window.ahm.rollbackProbe(label), step);

export const cellKey = ({ shape, path }) => `${path}/${shape}`;

// The three user transaction shapes on each of the two paths, each a single `beginUpdate`/`endUpdate`
// exactly as Draw.io itself brackets a user operation. Returns, for the action path, the evidence
// that the cell is non-degenerate: what the outer transaction had already appended before the action
// ran, and the plugin's own recalculation counter on both sides of the action call.
const failingTransaction = (page, shape, path, cells) => page.evaluate((kind, via, ids) => {
  const graph = editorUi.editor.graph;
  const model = graph.getModel();
  const write = (id, state) => {
    const cell = model.getCell(id);
    const value = cell.value.cloneNode(true);
    value.setAttribute("ahmLocalState", state);
    model.setValue(cell, value);
  };
  const move = (id) => {
    const cell = model.getCell(id);
    const geometry = model.getGeometry(cell).clone();
    geometry.x += 24;
    model.setGeometry(cell, geometry);
  };
  const invokeAction = () => {
    graph.setSelectionCell(model.getCell(ids.primary));
    editorUi.actions.get("ahmSetUnhealthy").funct();
  };
  const recalculations = () => (window.ahmApi && window.ahmApi.stats
    ? window.ahmApi.stats.recalculations : null);

  if (via === "action" && kind === "single") {
    // The plugin's own top-level transaction: nothing else is open.
    const before = recalculations();
    invokeAction();
    return { preActionChanges: [], recalcBefore: before, recalcAfter: recalculations() };
  }
  if (via === "action") {
    // The action inside an outer user transaction that already carries the other changes.
    let drive = null;
    model.beginUpdate();
    try {
      if (kind === "multi") {
        write(ids.extras[0], "Degraded");
        write(ids.extras[1], "Degraded");
      } else {
        write(ids.extras[0], "Degraded");
        move(ids.primary);
      }
      const preActionChanges = window.ahm.changesOf(model.currentEdit);
      const recalcBefore = recalculations();
      invokeAction();
      drive = { preActionChanges, recalcBefore, recalcAfter: recalculations() };
    } finally { model.endUpdate(); }
    return drive;
  }

  model.beginUpdate();
  try {
    if (kind === "single") {
      write(ids.primary, "Unhealthy");
    } else if (kind === "multi") {
      write(ids.primary, "Unhealthy");
      write(ids.extras[0], "Degraded");
      write(ids.extras[1], "Degraded");
    } else {
      // Compound: a semantic change and a geometry move in ONE user transaction, so the rollback
      // has to take back a change class the plugin never writes on its own.
      write(ids.primary, "Unhealthy");
      move(ids.primary);
    }
  } finally { model.endUpdate(); }
  return null;
}, shape, path, cells);

export async function pluginRollback(cases, options = {}) {
  const {
    name = "kitchen-sink", ablate = [], mutate = null, wait = 700,
    primary = "db", extras = ["cache", "queue"], moveId = "web", recoverWith = null,
    watch = ["db", "shop", "reporting", "root", "web", "cache", "queue"],
    dirtyPhase = !recoverWith,
  } = options;
  const source = ablatePlugin(ablate);
  const report = {};
  await withDrawio(async (page) => {
    const { model: loaded } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const fixture = mutate ? mutate(loaded) : loaded;
    if (mutate && fixture === loaded) throw new Error("the rollback fixture mutation did not apply");
    for (const cell of cases) {
      const { shape, path } = cell;
      await installPlugin(page, true);
      await loadModel(page, fixture);
      await settle(wait);
      await armProbes(page, watch);
      await page.evaluate(() => { window.ahmErrors = []; });

      const item = { shape, path, key: cellKey(cell), steps: [] };
      item.steps.push(await rollbackProbe(page, "loaded"));
      item.exportClean = sha256(await exportXmlSvg(page));

      // (1) the failing transaction against a clean editor.
      await resetLog(page);
      item.driveClean = await failingTransaction(page, shape, path, { primary, extras });
      item.steps.push(await rollbackProbe(page, "failed (immediate)"));
      await settle(wait);
      item.steps.push(await rollbackProbe(page, "failed + settle"));
      item.tapeClean = (await readLog(page)).tape;
      item.exportAfterClean = sha256(await exportXmlSvg(page));

      // (2) an unrelated, irrelevant transaction — a pure card move — so the editor is genuinely
      // dirty and carries an earlier undo entry the failure must not disturb.
      if (!dirtyPhase && !recoverWith) { report[item.key] = item; continue; }
      await page.evaluate((id) => {
        const graph = editorUi.editor.graph;
        graph.moveCells([graph.getModel().getCell(id)], 8, 0);
      }, moveId);
      await settle(wait);
      item.steps.push(await rollbackProbe(page, "after an unrelated move"));
      item.exportDirty = sha256(await exportXmlSvg(page));

      // (3) the same failing transaction against that dirty editor. Skipped for the recovery run,
      // whose injected failure is deliberately once-only.
      if (dirtyPhase) {
        await resetLog(page);
        item.driveDirty = await failingTransaction(page, shape, path, { primary, extras });
        await settle(wait);
        item.steps.push(await rollbackProbe(page, "failed while dirty + settle"));
        item.tapeDirty = (await readLog(page)).tape;
        item.exportAfterDirty = sha256(await exportXmlSvg(page));
      }

      // (4) NC-46's usability clause: with a once-only injected failure the next valid relevant
      // edit must record a normal entry and undo/redo by exactly one step.
      if (recoverWith) {
        await resetLog(page);
        await externalEdit(page, recoverWith, "ahmLocalState", "Unhealthy");
        await settle(wait);
        item.steps.push(await rollbackProbe(page, "next valid edit + settle"));
        item.tapeRecover = (await readLog(page)).tape;
        await page.evaluate(() => editorUi.actions.get("undo").funct());
        await settle(wait);
        item.steps.push(await rollbackProbe(page, "undo + settle"));
        await page.evaluate(() => editorUi.actions.get("redo").funct());
        await settle(wait);
        item.steps.push(await rollbackProbe(page, "redo + settle"));
      }
      report[item.key] = item;
    }
  }, { plugin: source });
  return report;
}

// NC-50 / NC-62: the re-entrancy guard under a genuine forced nested entry. A test-owned END_UPDATE
// listener fires one AHM action while an outer operation is still in flight — the action path opens
// a top-level transaction, so its inner writes dispatch END_UPDATE at `updateLevel > 0` while
// `guarded` is set. Without the guard the nested run proceeds; with it the attempt is blocked and
// counted, and no recalculation is added for it.
//
// `action` selects what the foreign listener fires (`ahmRecalculate` is the mutating case NC-59
// measured; `ahmValidate` is the read-only case NC-62 adds), `listenerOrder` puts that listener
// either side of the plugin's own hook — mxEventSource dispatches in registration order, so
// "blocked" must not depend on which listener Draw.io reaches first — `event` chooses which of the
// model's own dispatches the foreign listener rides in on, and `outer` chooses whether the
// enclosing transaction is a plugin operation at all, so the same driver can also show a nested
// validate fired outside any plugin operation running normally.
const armForeignNesting = (page, action, force, event) => page.evaluate((nested, forced, name) => {
  const model = editorUi.editor.graph.getModel();
  window.ahmForce = { armed: false, forced, action: nested, event: name, attempts: 0, reads: 0 };
  window.ahmForceHandler = function () {
    const state = window.ahmForce;
    if (!state.armed || !state.forced || state.attempts > 0) return;
    state.attempts++;
    // Counted at the live model, not at the plugin's return value: `readDrawio` is the only thing
    // that reaches `model.cells` inside this synchronous window, so a blocked entry reads zero and
    // an entry that actually ran reads at least once.
    const own = Object.getOwnPropertyDescriptor(model, "cells");
    let cells = model.cells;
    Object.defineProperty(model, "cells", {
      configurable: true,
      enumerable: true,
      get: function () { state.reads++; return cells; },
      set: function (next) { cells = next; },
    });
    try { editorUi.actions.get(state.action).funct(); }
    finally { Object.defineProperty(model, "cells", own); }
  };
  model.addListener(window.mxEvent[name], window.ahmForceHandler);
}, action, force, event);

export async function pluginForcedNesting(name, options = {}) {
  const {
    ablate = [], entity = "db", wait = 700, force = true, mutate = null,
    action = "ahmRecalculate", listenerOrder = "after", outer = "ahmSetUnhealthy",
    event = "END_UPDATE",
    outerAttribute = "ahmLocalState", outerValue = "Unhealthy",
    watch = ["db", "shop", "reporting", "root", "web", "cache", "queue"],
  } = options;
  const source = ablatePlugin(ablate);
  let report = null;
  await withDrawio(async (page) => {
    const { model: base } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const fixture = mutate ? mutate(base) : base;
    if (mutate && fixture === base) throw new Error("the forced-nesting fixture mutation did not apply");
    if (listenerOrder === "before") await armForeignNesting(page, action, force, event);
    await installPlugin(page, true);
    if (listenerOrder === "after") await armForeignNesting(page, action, force, event);
    await loadModel(page, fixture);
    await settle(wait);
    await page.evaluate(() => { window.ahmErrors = []; });
    const state = () => page.evaluate((watched) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const undo = editorUi.editor.undoManager;
      const attribute = (cell, key) => (cell && cell.value && cell.value.getAttribute
        ? cell.value.getAttribute(key) : null);
      const geometry = (key) => {
        const cell = model.getCell(key);
        const box = cell ? model.getGeometry(cell) : null;
        return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
      };
      const painted = (key) => {
        const pill = graph.view.getState(model.getCell(`${key}-state`));
        const label = graph.view.getState(model.getCell(`${key}-state-label`));
        return {
          stroke: pill && pill.style ? pill.style.strokeColor || null : null,
          text: label && label.text && label.text.node ? label.text.node.textContent : null,
        };
      };
      const cellOf = (key) => ({
        local: attribute(model.getCell(key), "ahmLocalState"),
        computed: attribute(model.getCell(key), "ahmComputedState"),
        style: (model.getCell(key) || {}).style || null,
        pillStyle: (model.getCell(`${key}-state`) || {}).style || null,
        card: geometry(key),
        pill: geometry(`${key}-state`),
        pillLabel: geometry(`${key}-state-label`),
      });
      return {
        history: undo.history.length,
        index: undo.indexOfNextAdd,
        modified: !!editorUi.editor.modified,
        updateLevel: model.updateLevel,
        currentEdit: ((model.currentEdit && model.currentEdit.changes) || []).length,
        cells: Object.fromEntries(watched.map((key) => [key, cellOf(key)])),
        painted: Object.fromEntries(watched.map((key) => [key, painted(key)])),
      };
    }, watch);

    report = { action, listenerOrder, outer, event };
    report.editorBefore = await state();
    report.exportBefore = sha256(await exportXmlSvg(page));
    Object.assign(report, await page.evaluate((id, outerAction, attribute, value) => {
      const api = window.ahmApi;
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const snapshot = () => JSON.parse(JSON.stringify(api.stats));
      const before = snapshot();
      window.ahmForce.armed = true;
      if (outerAction === "foreignEdit") {
        // No plugin operation in flight: a plain foreign transaction, so the nested action arrives
        // with `guarded` clear and must behave exactly like a top-level call.
        const cell = model.getCell(id);
        const next = cell.value.cloneNode(true);
        next.setAttribute(attribute, value);
        model.beginUpdate();
        try { model.setValue(cell, next); } finally { model.endUpdate(); }
      } else {
        graph.setSelectionCell(model.getCell(id));
        editorUi.actions.get(outerAction).funct();
      }
      window.ahmForce.armed = false;
      model.removeListener(window.ahmForceHandler, window.mxEvent[window.ahmForce.event]);
      return {
        before,
        after: snapshot(),
        nestedAttempts: window.ahmForce.attempts,
        nestedReads: window.ahmForce.reads,
        errors: (window.ahmErrors || []).slice(),
        history: editorUi.editor.undoManager.history.length,
        local: model.getCell(id).value.getAttribute("ahmLocalState"),
      };
    }, entity, outer, outerAttribute, outerValue));
    await settle(wait);
    report.editorAfter = await state();
    report.exportAfter = sha256(await exportXmlSvg(page));
    report.settled = await page.evaluate(() => JSON.parse(JSON.stringify(window.ahmApi.stats)));
    report.settledErrors = await page.evaluate(() => (window.ahmErrors || []).slice());
  }, { plugin: source });
  return report;
}

// NC-52: the host compatibility guard, measured on the EDITOR rather than on the guard's boolean.
// The tape and the before/after readings are taken around `install(editorUi)` itself, so "the probe
// touches nothing" is asserted rather than assumed.
export async function pluginHostGuard(name, options = {}) {
  const {
    ablate = [], mutate = null, wait = 700, entity = "db", patchActiveModel = null,
    watch = ["db", "shop", "reporting", "root", "web", "cache", "queue"],
  } = options;
  const source = ablatePlugin(ablate);
  let report = null;
  await withDrawio(async (page) => {
    const { model: base } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const fixture = mutate ? mutate(base) : base;
    if (mutate && fixture === base) throw new Error("the host-guard fixture mutation did not apply");
    await loadModel(page, fixture);
    await armActiveModelPatches(page);
    await settle(wait);
    report = await page.evaluate((watched, id, patchName) => {
      const ACTIONS = [
        "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
        "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed",
        "ahmRecalculate", "ahmValidate",
      ];
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const undo = editorUi.editor.undoManager;
      const census = () => {
        const list = model.eventListeners || [];
        const byName = {};
        for (let index = 0; index < list.length; index += 2) {
          const key = String(list[index]);
          byName[key] = (byName[key] || 0) + 1;
        }
        return { slots: list.length, byName };
      };
      const attribute = (cell, key) => (cell && cell.value && cell.value.getAttribute
        ? cell.value.getAttribute(key) : null);
      const cellOf = (key) => {
        const geometry = (name2) => {
          const cell = model.getCell(name2);
          const box = cell ? model.getGeometry(cell) : null;
          return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
        };
        const style = (name2) => {
          const cell = model.getCell(name2);
          return cell ? cell.style || null : null;
        };
        return {
          local: attribute(model.getCell(key), "ahmLocalState"),
          computed: attribute(model.getCell(key), "ahmComputedState"),
          label: attribute(model.getCell(`${key}-state-label`), "label"),
          style: style(key), pillStyle: style(`${key}-state`), dotStyle: style(`${key}-state-dot`),
          card: geometry(key), pill: geometry(`${key}-state`), pillLabel: geometry(`${key}-state-label`),
        };
      };
      const renderedOf = (key) => {
        const state = graph.view.getState(model.getCell(`${key}-state-label`));
        return state && state.text && state.text.node ? state.text.node.textContent : null;
      };
      const editorState = () => ({
        history: undo.history.length,
        index: undo.indexOfNextAdd,
        modified: !!editorUi.editor.modified,
        updateLevel: model.updateLevel,
        currentEdit: ((model.currentEdit && model.currentEdit.changes) || []).length,
        entries: undo.history.map((edit) => ((edit && edit.changes) || []).length),
        cells: Object.fromEntries(watched.map((key) => [key, cellOf(key)])),
        rendered: Object.fromEntries(watched.map((key) => [key, renderedOf(key)])),
      });

      // Armed BEFORE install(), so the probe's own dispatches on the active model — if it made any
      // — would be recorded here.
      const tape = [];
      const handlers = [];
      for (const eventName of ["END_EDIT", "END_UPDATE", "BEFORE_UNDO", "UNDO", "CHANGE", "NOTIFY"]) {
        const handler = () => tape.push(eventName);
        handlers.push([eventName, handler]);
        model.addListener(window.mxEvent[eventName], handler);
      }
      window.ahmErrors = [];
      editorUi.handleError = function (error) {
        window.ahmErrors.push(String((error && error.message) || error));
      };

      const censusBefore = census();
      const before = editorState();
      // NC-56: applied to the editor's own model, and only ever *after* the baseline is recorded,
      // so the verdict below is attributable to this one patch and to nothing the driver did.
      const patched = patchName ? window.ahmPatchActiveModel(model, patchName) : null;
      if (patchName && patched !== true) throw new Error(`active-model patch "${patchName}" did not apply`);
      const started = performance.now();
      const api = window.AhmHealthPluginFactory().install(editorUi);
      const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
      window.ahmApi = api;
      const probeTape = tape.slice();
      const afterInstall = editorState();
      const censusAfterInstall = census();
      const errorsAfterInstall = window.ahmErrors.slice();
      // Idempotence: a second install() must not re-probe or re-report.
      window.AhmHealthPluginFactory().install(editorUi);
      const errorsAfterSecondInstall = window.ahmErrors.slice();
      const censusAfterSecondInstall = census();

      // Every registered action, one at a time.
      const actionErrors = {};
      for (const action of ACTIONS) {
        const mark = window.ahmErrors.length;
        graph.setSelectionCell(model.getCell(id));
        let threw = null;
        try { editorUi.actions.get(action).funct(); } catch (error) { threw = String(error && error.message); }
        actionErrors[action] = { threw, added: window.ahmErrors.slice(mark) };
      }
      const afterActions = editorState();

      // A relevant model edit, exactly as Edit Data makes it.
      const cell = model.getCell(id);
      const value = cell.value.cloneNode(true);
      value.setAttribute("ahmLocalState", "Degraded");
      model.beginUpdate();
      try { model.setValue(cell, value); } finally { model.endUpdate(); }
      const afterEdit = editorState();

      for (const [eventName, handler] of handlers) {
        model.removeListener(handler, window.mxEvent[eventName]);
      }
      return {
        compatibility: api.compatibility, disabled: !!api.disabled, elapsedMs, patched,
        probeTape, before, afterInstall, afterActions, afterEdit,
        census: {
          before: censusBefore, afterInstall: censusAfterInstall,
          afterSecondInstall: censusAfterSecondInstall, afterAll: census(),
        },
        errorsAfterInstall, errorsAfterSecondInstall,
        errorsAfterActions: window.ahmErrors.slice(),
        actionErrors, stats: JSON.parse(JSON.stringify(api.stats)),
      };
    }, watch, entity, patchActiveModel);
    await settle(wait);
    report.afterSettle = await page.evaluate(() => ({
      errors: (window.ahmErrors || []).slice(),
      history: editorUi.editor.undoManager.history.length,
      modified: !!editorUi.editor.modified,
      stats: JSON.parse(JSON.stringify(window.ahmApi.stats)),
    }));
  }, { plugin: source });
  return report;
}

// NC-48 / NC-57: two genuinely independent `EditorUi` instances in one live page, served by one
// `factory()`. The first UI is captured by reference before the second is constructed, because
// constructing an EditorUi reassigns the page's global `editorUi` (measured, probe R9); the global
// is restored afterwards so the harness's embed protocol keeps addressing the first editor.
//
// Each editor gets its **own** error sink: on one shared array "editor b got the message and editor
// a did not" is not expressible at all, so per-editor message isolation could not be observed even
// in principle. `sharedSink` restores the single shared array as the negative control for exactly
// that. `patch` applies one active-model patch per editor, immediately before *that* editor's
// install, and `order` decides which editor is installed first, so a mixed compatible/incompatible
// pair can be driven in both arrangements.
export async function pluginEditorIsolation(name, options = {}) {
  const {
    ablate = [], entity = "db", patch = {}, order = ["a", "b"], sharedSink = false,
  } = options;
  const source = ablatePlugin(ablate);
  let report = null;
  await withDrawio(async (page) => {
    await loadModel(page, readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`)).model);
    await armActiveModelPatches(page);
    report = await page.evaluate((id, patches, installOrder, shareSink) => {
      const out = { error: null };
      const ACTIONS = [
        "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
        "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed",
        "ahmRecalculate", "ahmValidate",
      ];
      const census = (model) => {
        const list = model.eventListeners || [];
        const byName = {};
        for (let index = 0; index < list.length; index += 2) {
          const key = String(list[index]);
          byName[key] = (byName[key] || 0) + 1;
        }
        return { slots: list.length, byName };
      };
      try {
        const first = editorUi;
        const firstModel = first.editor.graph.getModel();
        const container = document.createElement("div");
        container.style.width = "1200px";
        container.style.height = "900px";
        document.body.appendChild(container);
        const second = new EditorUi(new Editor(false, null, null, null, null), container, true);
        out.globalMoved = window.editorUi !== first;
        window.editorUi = first;
        const secondModel = second.editor.graph.getModel();
        // Independent before the plugin is anywhere near them.
        out.distinctEditor = second.editor !== first.editor;
        out.distinctGraph = second.editor.graph !== first.editor.graph;
        out.distinctModel = secondModel !== firstModel;
        out.distinctUndoManager = second.editor.undoManager !== first.editor.undoManager;
        // The same shipped model, decoded into the second editor through Draw.io's own
        // `Editor.setGraphXml`, from the first editor's own encoded graph.
        second.editor.setGraphXml(first.editor.getGraphXml());
        second.editor.graph.refresh();
        const uis = { a: first, b: second };
        const models = { a: firstModel, b: secondModel };
        const shared = [];
        const sinks = { a: shareSink ? shared : [], b: shareSink ? shared : [] };
        for (const key of ["a", "b"]) {
          uis[key].editor.undoManager.clear();
          uis[key].editor.modified = false;
          uis[key].handleError = (error) => sinks[key].push(String((error && error.message) || error));
        }
        window.ahmErrors = shared;
        out.sharedSink = sinks.a === sinks.b;

        // The isolated probe builds one throwaway `new mxGraphModel()`, so counting constructions
        // across an install is a direct reading of "did this install run the probe again".
        const probesDuring = (call) => {
          const stock = window.mxGraphModel;
          let constructed = 0;
          const counted = function (...args) { constructed++; return new stock(...args); };
          counted.prototype = stock.prototype;
          window.mxGraphModel = counted;
          try { return { value: call(), constructed }; } finally { window.mxGraphModel = stock; }
        };
        const applyPatch = (key) => {
          if (!patches[key]) return null;
          if (window.ahmPatchActiveModel(models[key], patches[key]) !== true) {
            throw new Error(`active-model patch "${patches[key]}" did not apply to ${key}`);
          }
          return patches[key];
        };

        const factory = window.AhmHealthPluginFactory();
        const [firstKey, secondKey] = installOrder;
        const both = () => ({ a: census(firstModel), b: census(secondModel) });
        const installed = {};
        out.patched = { a: null, b: null };
        const before = both();
        out.patched[firstKey] = applyPatch(firstKey);
        const firstRun = probesDuring(() => factory.install(uis[firstKey]));
        installed[firstKey] = firstRun.value;
        const afterFirst = both();
        const firstAgain = factory.install(uis[firstKey]);
        const afterFirstTwice = both();
        out.patched[secondKey] = applyPatch(secondKey);
        const secondRun = probesDuring(() => factory.install(uis[secondKey]));
        installed[secondKey] = secondRun.value;
        const afterSecond = both();
        out.messagesAfterInstalls = { a: sinks.a.slice(), b: sinks.b.slice() };
        // Clause (iv): the same editor installed a second time — no second message, no second probe.
        const secondAgain = probesDuring(() => factory.install(uis[secondKey]));
        const afterSecondTwice = both();
        out.messagesAfterRepeat = { a: sinks.a.slice(), b: sinks.b.slice() };
        out.probeRuns = {
          firstInstall: firstRun.constructed,
          secondInstall: secondRun.constructed,
          secondInstallRepeat: secondAgain.constructed,
        };
        out.repeatSameApi = secondAgain.value === installed[secondKey];
        out.installOrder = [firstKey, secondKey];

        const a1 = installed.a;
        const b1 = installed.b;
        out.census = { before, afterFirst, afterFirstTwice, afterSecond, afterSecondTwice };
        out.sameEditorSameApi = firstAgain === installed[firstKey];
        out.distinctEditorSameApi = a1 === b1;
        out.sameStatsObject = a1.stats === b1.stats;
        out.compatibilityA = a1.compatibility;
        out.compatibilityB = b1.compatibility;
        out.disabledA = !!a1.disabled;
        out.disabledB = !!b1.disabled;
        out.markerA = first[a1.INSTALL_KEY] === a1;
        out.markerB = second[a1.INSTALL_KEY] === b1;
        out.actionsA = ACTIONS.filter((action) => !!first.actions.get(action));
        out.actionsB = ACTIONS.filter((action) => !!second.actions.get(action));
        out.menuA = !!(first.menus && first.menus.get && first.menus.get("ahmHealthModel"));
        out.menuB = !!(second.menus && second.menus.get && second.menus.get("ahmHealthModel"));
        // A spread copy carries `INSTALL_KEY`, so it *is* the first installation. Measured and
        // reported as such rather than presented as a fresh instance.
        const copy = { ...first };
        out.spreadCopyReturnsFirst = factory.install(copy) === a1;
        // A second factory() on an editor that already has an installation still returns that
        // installation: the marker lives on the editor, not on the factory.
        out.secondFactorySameApi = window.AhmHealthPluginFactory().install(second) === b1;

        const pair = (model) => {
          const cell = model.getCell(id);
          return `${cell.value.getAttribute("ahmLocalState")}/${cell.value.getAttribute("ahmComputedState")}`;
        };
        const snap = () => ({
          statsA: { ...a1.stats }, statsB: { ...b1.stats },
          historyA: first.editor.undoManager.history.length,
          historyB: second.editor.undoManager.history.length,
          modifiedA: !!first.editor.modified, modifiedB: !!second.editor.modified,
          valueA: pair(firstModel), valueB: pair(secondModel),
        });
        const edit = (ui, state) => {
          const model = ui.editor.graph.getModel();
          const cell = model.getCell(id);
          const value = cell.value.cloneNode(true);
          value.setAttribute("ahmLocalState", state);
          model.beginUpdate();
          try { model.setValue(cell, value); } finally { model.endUpdate(); }
        };
        out.beforeEdits = snap();
        edit(second, "Unhealthy");
        out.afterEditInSecond = snap();
        edit(first, "Degraded");
        out.afterEditInFirst = snap();
        out.errorsA = sinks.a.slice();
        out.errorsB = sinks.b.slice();
        out.errors = shareSink ? shared.slice() : [...sinks.a, ...sinks.b];
      } catch (error) {
        out.error = String((error && error.stack) || error).slice(0, 600);
      }
      return out;
    }, entity, patch, order, sharedSink);
  }, { plugin: source });
  return report;
}

// NC-58: `ahmValidate` on a live, **compatible** host. Validate is documented to write nothing, so
// the reading that matters is the editor's own state taken immediately before and after the action
// — around a deliberately stale derived style, which is exactly the input that made the pre-C-18
// routing repair, dirty and record. `ahmRecalculate` runs in the same session as the positive
// control, so "validate wrote nothing" can never be bought by a plugin that writes nothing at all.
export async function pluginValidate(name, options = {}) {
  const {
    ablate = [], mutate = null, wait = 700, entity = "db",
    watch = ["db", "shop", "reporting", "root", "web", "cache", "queue"],
  } = options;
  const source = ablatePlugin(ablate);
  const report = {};
  await withDrawio(async (page) => {
    const { model: base } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const fixture = mutate ? mutate(base) : base;
    if (mutate && fixture === base) throw new Error("the validate fixture mutation did not apply");
    await installPlugin(page, true);
    await loadModel(page, fixture);
    await settle(wait);
    await page.evaluate(() => { window.ahmErrors = []; });
    const state = () => page.evaluate((watched) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const undo = editorUi.editor.undoManager;
      const painted = (key) => {
        const pill = graph.view.getState(model.getCell(`${key}-state`));
        const label = graph.view.getState(model.getCell(`${key}-state-label`));
        return {
          stroke: pill && pill.style ? pill.style.strokeColor || null : null,
          text: label && label.text && label.text.node ? label.text.node.textContent : null,
        };
      };
      const styleOf = (key) => {
        const cell = model.getCell(key);
        return cell ? cell.style || null : null;
      };
      return {
        history: undo.history.length,
        index: undo.indexOfNextAdd,
        modified: !!editorUi.editor.modified,
        updateLevel: model.updateLevel,
        currentEdit: ((model.currentEdit && model.currentEdit.changes) || []).length,
        stats: JSON.parse(JSON.stringify(window.ahmApi.stats)),
        styles: Object.fromEntries(watched.map((key) => [key, styleOf(`${key}-state`)])),
        painted: Object.fromEntries(watched.map((key) => [key, painted(key)])),
        computed: Object.fromEntries(watched.map((key) => {
          const cell = model.getCell(key);
          return [key, cell && cell.value.getAttribute ? cell.value.getAttribute("ahmComputedState") : null];
        })),
      };
    }, watch);
    const invoke = (action) => page.evaluate((name2) => {
      const mark = window.ahmErrors.length;
      let threw = null;
      try { editorUi.actions.get(name2).funct(); } catch (error) { threw = String(error && error.message); }
      return { threw, errors: window.ahmErrors.slice(mark) };
    }, action);

    // (iii) the clean case: a settled model, validate, nothing at all happens.
    report.clean = { before: await state(), exportBefore: sha256(await exportXmlSvg(page)) };
    report.clean.outcome = await invoke("ahmValidate");
    report.clean.after = await state();
    report.clean.exportAfter = sha256(await exportXmlSvg(page));

    // One derived pill style made stale by a *foreign* edit — an mxStyleChange carries no health
    // meaning, so the hook filters it out and the staleness survives. The undo manager is cleared
    // afterwards so anything validate writes shows up against a pristine {0, 0, false} editor.
    report.staleApplied = await page.evaluate((id) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const pill = model.getCell(`${id}-state`);
      const before = pill.style;
      model.beginUpdate();
      try { model.setStyle(pill, before.replace(/strokeColor=[^;]*/, "strokeColor=#ff0000")); }
      finally { model.endUpdate(); }
      editorUi.editor.undoManager.clear();
      editorUi.editor.modified = false;
      window.ahmErrors = [];
      return { before, after: model.getCell(`${id}-state`).style };
    }, entity);
    if (report.staleApplied.before === report.staleApplied.after) {
      throw new Error("the stale-style fixture did not apply");
    }

    // (i) the stale case: the input that used to be silently repaired.
    report.stale = { before: await state(), exportBefore: sha256(await exportXmlSvg(page)) };
    report.stale.outcome = await invoke("ahmValidate");
    report.stale.after = await state();
    report.stale.exportAfter = sha256(await exportXmlSvg(page));

    // (v) the positive control, same run, same host: recalculate still writes, dirties and records.
    report.recalculated = { before: await state() };
    report.recalculated.outcome = await invoke("ahmRecalculate");
    await settle(wait);
    report.recalculated.after = await state();
    report.recalculated.exportAfter = sha256(await exportXmlSvg(page));
    report.compatibility = await page.evaluate(() => ({
      compatible: window.ahmApi.compatibility.compatible,
      reasons: window.ahmApi.compatibility.reasons,
      disabled: !!window.ahmApi.disabled,
    }));
  }, { plugin: source });
  return report;
}
// NC-65: the path C-19 never drove — a **top-level** read-only `ahmValidate` whose own error sink
// re-enters the plugin. `report` hands the finding to `ui.handleError` (`plugin/ahm-health.js:742`),
// so the host's error handler runs *inside* the operation; with the flag armed only in `runDrawio`
// nothing was in flight, and the nested action ran a second full validation — two messages, 288
// model reads, `blockedReentries 0` (C-19 inspect, re-traced as `P-C20-9`).
//
// `nested` chooses what the sink fires (read-only `ahmValidate` or mutating `ahmSetUnhealthy`),
// `force` gives the unforced control that makes every count attributable, `dropHandler` removes
// `ui.handleError` entirely so `report` re-throws out of the action — the run that proves the
// release is in a `finally` — and `patchActiveModel` drives the same re-entry on a host the
// compatibility guard disabled. Every reading is taken off the live editor.
export async function pluginErrorSinkReentry(name, options = {}) {
  const {
    ablate = [], mutate = null, wait = 700, entity = "db", force = true,
    nested = "ahmValidate", dropHandler = false, patchActiveModel = null,
    watch = ["db", "shop", "reporting", "root", "web", "cache", "queue"],
  } = options;
  const source = ablatePlugin(ablate);
  const report = { nested, force, dropHandler, patchActiveModel };
  await withDrawio(async (page) => {
    const { model: base } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const fixture = mutate ? mutate(base) : base;
    if (mutate && fixture === base) throw new Error("the error-sink fixture mutation did not apply");
    await loadModel(page, fixture);
    await armActiveModelPatches(page);
    if (patchActiveModel) {
      const patched = await page.evaluate((patchName) => window.ahmPatchActiveModel(
        editorUi.editor.graph.getModel(), patchName,
      ), patchActiveModel);
      if (patched !== true) throw new Error(`active-model patch "${patchActiveModel}" did not apply`);
    }
    await installPlugin(page, true);
    await settle(wait);
    const state = () => page.evaluate((watched) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const undo = editorUi.editor.undoManager;
      const attribute = (cell, key) => (cell && cell.value && cell.value.getAttribute
        ? cell.value.getAttribute(key) : null);
      const geometry = (key) => {
        const cell = model.getCell(key);
        const box = cell ? model.getGeometry(cell) : null;
        return box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;
      };
      const painted = (key) => {
        const pill = graph.view.getState(model.getCell(`${key}-state`));
        const label = graph.view.getState(model.getCell(`${key}-state-label`));
        return {
          stroke: pill && pill.style ? pill.style.strokeColor || null : null,
          text: label && label.text && label.text.node ? label.text.node.textContent : null,
        };
      };
      const cellOf = (key) => ({
        local: attribute(model.getCell(key), "ahmLocalState"),
        computed: attribute(model.getCell(key), "ahmComputedState"),
        style: (model.getCell(key) || {}).style || null,
        pillStyle: (model.getCell(`${key}-state`) || {}).style || null,
        card: geometry(key),
        pill: geometry(`${key}-state`),
        pillLabel: geometry(`${key}-state-label`),
      });
      return {
        history: undo.history.length,
        index: undo.indexOfNextAdd,
        modified: !!editorUi.editor.modified,
        updateLevel: model.updateLevel,
        currentEdit: ((model.currentEdit && model.currentEdit.changes) || []).length,
        cells: Object.fromEntries(watched.map((key) => [key, cellOf(key)])),
        painted: Object.fromEntries(watched.map((key) => [key, painted(key)])),
      };
    }, watch);

    // The re-entering sink replaces the recorder `installPlugin` put in place. `install()` reads
    // `ui.handleError` at report time, so this is the editor's own error sink, not a seam the
    // plugin does not use.
    await page.evaluate((nestedAction, forced, id, drop) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      window.ahmSink = { armed: false, forced, action: nestedAction, attempts: 0, reads: 0 };
      if (drop) { editorUi.handleError = null; return; }
      editorUi.handleError = function (error) {
        window.ahmErrors.push(String((error && error.message) || error));
        const sink = window.ahmSink;
        if (!sink.armed || !sink.forced || sink.attempts > 0) return;
        sink.attempts++;
        // Selected before the counting window opens: `model.getCell` reads `model.cells`, and this
        // driver's own bookkeeping must not show up as a read the plugin made.
        graph.setSelectionCell(model.getCell(id));
        const own = Object.getOwnPropertyDescriptor(model, "cells");
        let cells = model.cells;
        Object.defineProperty(model, "cells", {
          configurable: true,
          enumerable: true,
          get: function () { sink.reads++; return cells; },
          set: function (next) { cells = next; },
        });
        try { editorUi.actions.get(sink.action).funct(); }
        finally { Object.defineProperty(model, "cells", own); }
      };
    }, nested, force, entity, dropHandler);
    await page.evaluate(() => { window.ahmErrors = []; });

    report.editorBefore = await state();
    report.exportBefore = sha256(await exportXmlSvg(page));
    const validate = (armed) => page.evaluate((arm) => {
      const api = window.ahmApi;
      const snapshot = () => JSON.parse(JSON.stringify(api.stats));
      const before = snapshot();
      const mark = window.ahmErrors.length;
      window.ahmSink.armed = arm;
      let threw = null;
      try { editorUi.actions.get("ahmValidate").funct(); }
      catch (error) { threw = String((error && error.message) || error); }
      window.ahmSink.armed = false;
      return {
        before,
        after: snapshot(),
        threw,
        errors: window.ahmErrors.slice(mark),
        nestedAttempts: window.ahmSink.attempts,
        nestedReads: window.ahmSink.reads,
      };
    }, armed);

    Object.assign(report, await validate(true));
    await settle(wait);
    report.editorAfter = await state();
    report.exportAfter = sha256(await exportXmlSvg(page));
    // (iii)/(iv): the same top-level action again, on the same editor. A flag released anywhere but
    // in a `finally` leaves this one blocked.
    report.second = await validate(false);
    await settle(wait);
    report.editorSecond = await state();
    report.exportSecond = sha256(await exportXmlSvg(page));
    report.settled = await page.evaluate(() => JSON.parse(JSON.stringify(window.ahmApi.stats)));
    report.compatibility = await page.evaluate(() => ({
      compatible: window.ahmApi.compatibility.compatible,
      reasons: window.ahmApi.compatibility.reasons,
      disabled: !!window.ahmApi.disabled,
    }));
  }, { plugin: source });
  return report;
}

const editorState = (page) => page.evaluate(() => ({
  modified: !!editorUi.editor.modified,
  historyLength: editorUi.editor.undoManager.history.length,
  indexOfNextAdd: editorUi.editor.undoManager.indexOfNextAdd,
  errors: (window.ahmErrors || []).slice(),
  stats: window.ahmApi && window.ahmApi.stats ? { ...window.ahmApi.stats } : null,
}));

// NC-34 / NC-38: install the shipped plugin, open a shipped example, wait longer than the debounce,
// and report what the editor thinks happened plus the drift of Draw.io's own export against the
// model that was loaded.
export async function pluginOpenStability(names, options = {}) {
  const {
    ablate = [], installOrder = "before", install = true, models = null, wait = 400,
  } = options;
  const source = ablatePlugin(ablate);
  const report = {};
  await withDrawio(async (page) => {
    for (const name of names) {
      const loaded = models
        ? models[name]
        : readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`)).model;
      let registration = null;
      if (installOrder === "before") registration = await installPlugin(page, install);
      await loadModel(page, loaded);
      if (installOrder === "after") registration = await installPlugin(page, install);
      // Longer than the 100 ms debounce: whatever the listener was going to do, it has done it.
      await settle(wait);
      const state = await editorState(page);
      const exported = await exportXmlSvg(page);
      const { model: reopened } = readDrawioSvgText(exported, `${name} install export`);
      const drift = driftReport(loaded, reopened);
      report[name] = {
        ...state,
        registration,
        driftLines: drift.length,
        driftedCells: new Set(drift.map((line) => line.split(":")[0])).size,
        drift: drift.slice(0, 12),
        exportBytes: Buffer.byteLength(exported),
      };
    }
  }, { plugin: source });
  return report;
}

// NC-37 / NC-32: the full external-edit -> undo -> redo -> move sequence through `install()`, with a
// wait longer than the debounce after every single step and the undo history read after each wait.
export async function pluginEditSequence(name, options = {}) {
  const {
    ablate = [], entity = "cache", state = "Healthy", wait = 700, moveId = "web",
    watch = ["cache", "shop", "root"], undos = 2, redos = 2,
  } = options;
  const source = ablatePlugin(ablate);
  const steps = [];
  await withDrawio(async (page) => {
    const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    await installPlugin(page, true);
    await loadModel(page, model);
    await settle(wait);

    // Everything a step has to report: the editor's undo state plus the values the rollup owns.
    const probe = async (label) => {
      const editor = await editorState(page);
      const values = await page.evaluate((ids) => {
        const model = editorUi.editor.graph.getModel();
        const read = (id) => {
          const cell = model.getCell(id);
          return {
            local: cell.value.getAttribute("ahmLocalState"),
            computed: cell.value.getAttribute("ahmComputedState"),
            label: model.getCell(id + "-state-label").value.getAttribute("label"),
            pillWidth: model.getGeometry(model.getCell(id + "-state")).width,
            pillX: model.getGeometry(model.getCell(id + "-state")).x,
            fill: (cell.style.match(/fillColor=([^;]*)/) || [])[1] || null,
          };
        };
        return Object.fromEntries(ids.map((id) => [id, read(id)]));
      }, watch);
      steps.push({ step: label, ...editor, values });
      return editor;
    };

    await probe("install + load + wait");
    // A *relevant external* mutation: the same edit a user makes through Edit Data.
    await externalEdit(page, entity, "ahmLocalState", state);
    await settle(wait);
    await probe("external edit + wait");
    await settle(wait);
    await probe("+ wait again");

    // Literal counts, never derived from what the run happened to produce: under C-15 one semantic
    // operation is one entry, so the second undo and the second redo must be no-ops. A design that
    // records two entries shows up as a first undo that only half-reverts.
    for (let step = 0; step < undos; step++) {
      await page.evaluate(() => editorUi.actions.get("undo").funct());
      await settle(wait);
      await probe(`undo ${step + 1} + wait`);
    }
    for (let step = 0; step < redos; step++) {
      await page.evaluate(() => editorUi.actions.get("redo").funct());
      await settle(wait);
      await probe(`redo ${step + 1} + wait`);
    }
    // An irrelevant mutation: a pure card move must not schedule a recalculation.
    await page.evaluate((id) => {
      const graph = editorUi.editor.graph;
      graph.moveCells([graph.getModel().getCell(id)], 8, 0);
    }, moveId);
    await settle(wait);
    await probe("move a card + wait");
  }, { plugin: source });
  return steps;
}

// NC-35 / NC-37 / NC-43: malformed models and forced failures reaching `ui.handleError` through the
// shipped action and through the derived-write hook, with the undo history read on both sides of
// each failure so a partially committed rollup would be visible. `mutate` is applied to the model
// XML before load.
export async function pluginFailurePaths(cases, options = {}) {
  const {
    name = "kitchen-sink", trigger = "db", wait = 400, ablate = [],
    watch = ["db", "shop", "reporting", "root", "web"],
  } = options;
  const source = ablatePlugin(ablate);
  const report = {};
  await withDrawio(async (page) => {
    const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const history = () => page.evaluate(() => ({
      length: editorUi.editor.undoManager.history.length,
      index: editorUi.editor.undoManager.indexOfNextAdd,
      entries: editorUi.editor.undoManager.history.map((edit) => window.ahm.changesOf(edit)),
    }));
    for (const item of cases) {
      const mutated = item.mutate(model);
      if (mutated === model) throw new Error(`failure fixture "${item.name}" did not apply`);
      await installPlugin(page, true);
      await loadModel(page, mutated);
      await settle(wait);
      await armProbes(page, watch);
      // NC-45's five boundaries around each of the five documented validation messages: the whole
      // editor, and Draw.io's own exported bytes, read before and after each failure path.
      const probeBefore = await rollbackProbe(page, `${item.name} before`);
      const exportBefore = sha256(await exportXmlSvg(page));
      // Through the registered action, i.e. the same path the menu entry drives.
      const beforeAction = await history();
      const viaAction = await page.evaluate(() => {
        window.ahmErrors = [];
        editorUi.actions.get("ahmRecalculate").funct();
        return window.ahmErrors.slice();
      });
      await settle(wait);
      const afterAction = await history();
      const probeAfterAction = await rollbackProbe(page, `${item.name} after action`);
      const exportAfterAction = sha256(await exportXmlSvg(page));
      // And through the derived-write hook, i.e. the path joined to the user's own transaction.
      await page.evaluate(() => { window.ahmErrors = []; });
      await externalEdit(page, item.trigger ?? trigger, "ahmLocalState", "Degraded");
      await settle(wait);
      report[item.name] = {
        viaAction,
        viaListener: await page.evaluate(() => window.ahmErrors.slice()),
        beforeAction,
        afterAction,
        beforeListener: afterAction,
        afterListener: await history(),
        state: await editorState(page),
        probeBefore,
        probeAfterAction,
        probeAfterListener: await rollbackProbe(page, `${item.name} after hook`),
        exportBefore,
        exportAfterAction,
        exportAfterListener: sha256(await exportXmlSvg(page)),
      };
    }
  }, { plugin: source });
  return report;
}

// Reads only the rendered boxes the pill clauses need — entity card, pill, dot and label — in the
// same model coordinates `collect()` reports, without its 1px edge sampling. Cheap enough to be
// taken after the transition, after the undo and after the redo of every step.
function collectPills(ids) {
  const graph = editorUi.editor.graph;
  const view = graph.view;
  const model = graph.getModel();
  const inverse = view.getDrawPane().getScreenCTM().inverse();
  const scale = view.scale;
  const translate = { x: view.translate.x, y: view.translate.y };
  const point = (x, y) => {
    const mapped = new DOMPoint(x, y).matrixTransform(inverse);
    return { x: mapped.x / scale - translate.x, y: mapped.y / scale - translate.y };
  };
  const clientBox = (node) => {
    const rect = node.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    const a = point(rect.left, rect.top);
    const b = point(rect.right, rect.bottom);
    return { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  };
  const cells = [];
  const push = (id) => {
    const cell = model.getCell(id);
    const state = cell && view.getState(cell);
    if (!state) return;
    const text = state.text && state.text.node ? state.text.node : null;
    cells.push({
      id: String(cell.id),
      parent: cell.parent ? String(cell.parent.id) : null,
      style: cell.style || "",
      box: {
        x: state.x / scale - translate.x, y: state.y / scale - translate.y,
        w: state.width / scale, h: state.height / scale,
      },
      text: text ? { box: clientBox(text), content: text.textContent } : null,
    });
  };
  ids.forEach((id) => {
    push(id);
    push(`${id}-state`);
    push(`${id}-state-dot`);
    push(`${id}-state-label`);
  });
  return { cells };
}

// Drives the plugin through the menu action `install(editorUi)` registered, inside the live Draw.io
// editor, with the real `plugin/ahm-health.js` injected by `drawio-host.mjs` exactly as the VS Code
// workspace loads it.
//
// Every step reports the *rendered* pill, dot and label boxes three times — after the transition,
// after one undo and after one redo — each read after a settle longer than any timer the plugin
// could hold, because the synchronous read is exactly what let the Undo/Redo defect through at
// C-13. With `ablateResize` the geometry update is removed from the injected source, which is the
// negative control.
export async function pluginPillTransitions(name, plan, options = {}) {
  const { ablateResize = false, wait = 700 } = options;
  const source = ablatePlugin(ablateResize ? ["resize"] : []);
  const ids = [...new Set(plan.map((step) => step.pill ?? step.entity))];
  const steps = [];
  let reopened = null;
  let exportBytes = 0;
  await withDrawio(async (page) => {
    const { model } = readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`));
    const registration = await installPlugin(page, true);
    if (registration.missing.length) {
      throw new Error(`install() registered no ${registration.missing.join(", ")}`);
    }
    await loadModel(page, model);
    await settle(wait);
    const measure = () => page.evaluate(collectPills, ids);
    for (const step of plan) {
      const pillId = `${step.pill ?? step.entity}-state`;
      const snapshot = () => page.evaluate((id) => {
        const model = editorUi.editor.graph.getModel();
        const read = (cellId) => {
          const cell = model.getCell(cellId);
          const geometry = model.getGeometry(cell);
          return {
            x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
            label: cell.value && cell.value.getAttribute ? cell.value.getAttribute("label") : null,
          };
        };
        return {
          pill: read(id),
          label: read(`${id}-label`),
          history: editorUi.editor.undoManager.history.length,
          index: editorUi.editor.undoManager.indexOfNextAdd,
          errors: (window.ahmErrors || []).slice(),
        };
      }, pillId);

      const before = await snapshot();
      // The shipped path: select the card, then fire the action `install()` registered.
      await page.evaluate((entityId, action) => {
        const graph = editorUi.editor.graph;
        graph.setSelectionCell(graph.getModel().getCell(entityId));
        editorUi.actions.get(action).funct();
      }, step.entity, `ahmSet${step.state}`);
      await settle(wait);
      const after = await snapshot();
      const measured = await measure();

      await page.evaluate(() => editorUi.actions.get("undo").funct());
      await settle(wait);
      const undone = await snapshot();
      const measuredUndone = await measure();

      await page.evaluate(() => editorUi.actions.get("redo").funct());
      await settle(wait);
      const redone = await snapshot();
      const measuredRedone = await measure();

      await page.evaluate(() => editorUi.editor.graph.refresh());
      steps.push({
        ...step,
        transaction: {
          before, after, undone, redone,
          recorded: after.history - before.history,
        },
        measured,
        measuredUndone,
        measuredRedone,
      });
    }
    const exported = await exportXmlSvg(page);
    exportBytes = Buffer.byteLength(exported);
    const { model: reopenedModel } = readDrawioSvgText(exported, `${name} plugin export`);
    await loadModel(page, reopenedModel);
    reopened = await measure();
  }, { plugin: source });
  return { steps, reopened, exportBytes };
}


// Renders arbitrary model XML — an in-memory generator build, an authored fixture or a decoded
// library entry — instead of reading a shipped artifact. Same boot, same `collect()`, same
// live Draw.io DOM. With `roundTrip` each model is also exported through Draw.io's own `xmlsvg`
// call and reopened from those bytes. Nothing is written to disk.
export async function renderModels(models, options = {}) {
  const { plugin = false, roundTrip = false } = options;
  const pluginSource = plugin ? readFileSync(resolve(root, "plugin/ahm-health.js"), "utf8") : null;
  const report = {};
  await withDrawio(async (page) => {
    for (const [name, xml] of Object.entries(models)) {
      await loadModel(page, xml);
      const measured = await page.evaluate(collect);
      if (roundTrip) {
        const exported = await exportXmlSvg(page);
        const { model: reopenedModel } = readDrawioSvgText(exported, `${name} export`);
        await loadModel(page, reopenedModel);
        measured.reopened = await page.evaluate(collect);
        measured.exportBytes = Buffer.byteLength(exported);
      }
      report[name] = measured;
    }
  }, { plugin: pluginSource });
  return report;
}

export async function renderExamples(names = EXAMPLES, options = {}) {
  const {
    write = false, plugin = false, prefix = "native", roundTrip = false,
  } = options;
  // Only `--write` may touch the tree. Without it the run measures and prints, and leaves every
  // PNG, report and artifact exactly as it found them.
  const screenshot = options.screenshot ?? write;
  const pluginSource = plugin
    ? readFileSync(resolve(root, "plugin/ahm-health.js"), "utf8")
    : null;
  const report = {};
  await withDrawio(async (page, context) => {
    const shot = await page.browser().newPage();
    for (const name of names) {
      const file = resolve(root, `examples/${name}.drawio.svg`);
      const { model } = readDrawioSvg(file);
      await loadModel(page, model);
      const measured = await page.evaluate(collect);
      const exported = await exportXmlSvg(page);
      // Order matters: the artifact goes down first, then the PNG rendered from those exact bytes,
      // so the PNG can never belong to a model the artifact no longer carries.
      if (write) writeAtomic(file, exported);
      let image = null;
      if (screenshot) {
        image = resolve(root, `visual/${prefix}-${name}.png`);
        await shot.setViewport({ width: 1800, height: 1500, deviceScaleFactor: 2 });
        await shot.setContent(
          `<html><body style="margin:0;background:#ffffff">`
          + `<img id="art" src="data:image/svg+xml;base64,${Buffer.from(exported).toString("base64")}">`
          + `</body></html>`,
          { waitUntil: "load" },
        );
        await shot.waitForFunction(() => {
          const element = document.getElementById("art");
          return element && element.complete && element.naturalWidth > 0;
        });
        await new Promise((done) => setTimeout(done, 250));
        await (await shot.$("#art")).screenshot({ path: `${image}.tmp` });
        renameSync(`${image}.tmp`, image);
      }
      let reopened = null;
      let reexported = null;
      if (roundTrip) {
        // NC-13 / NC-13a: reopen exactly the bytes Draw.io wrote — compressed `content=` and all —
        // measure that, then save a second time to show the save→reopen→save cycle is stable.
        const { model: exportedModel } = readDrawioSvgText(exported, `${name} export`);
        await loadModel(page, exportedModel);
        reopened = await page.evaluate(collect);
        reexported = await exportXmlSvg(page);
      }
      report[name] = {
        ...measured, name, image, exportBytes: Buffer.byteLength(exported),
        exported, reopened, reexported,
      };
    }
    await shot.close();
    report.escaped = context.escaped;
  }, { plugin: pluginSource });
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const write = process.argv.includes("--write");
  const plugin = process.argv.includes("--plugin");
  const prefix = plugin ? "plugin" : "native";
  // Named examples may be passed on the command line so a regeneration can be scoped to exactly the
  // artifacts a drift report named; the report keeps every example it already carried.
  const selected = process.argv.slice(2).filter((argument) => !argument.startsWith("-"));
  const names = selected.length ? selected : EXAMPLES;
  for (const name of names) {
    if (!EXAMPLES.includes(name)) throw new Error(`unknown example "${name}"`);
  }
  const report = await renderExamples(names, { write, plugin, prefix });
  const summary = {};
  for (const name of names) {
    const item = report[name];
    summary[name] = {
      cells: item.graph.cells,
      size: `${item.graph.width}x${item.graph.height}`,
      shadowVisible: item.graph.shadowVisible,
      filterNodes: item.dom.filterNodes.length,
      fonts: item.dom.fontFamilies,
      edgeStrokes: [...new Set(item.edges.map((edge) => edge.shape && edge.shape.stroke))],
      image: item.image,
      exportBytes: item.exportBytes,
      // Recomputed from the bytes now on disk — after the artifact and the PNG were written, so the
      // three digests describe one consistent set of files rather than three separate moments.
      ...artifactDigests(name, prefix),
    };
    console.log(`${name}: ${JSON.stringify(summary[name])}`);
  }
  if (write) {
    // Untouched examples keep the digests the previous run recorded, recomputed from disk so a
    // scoped regeneration can never leave the report claiming bytes that no longer exist.
    for (const name of EXAMPLES) {
      if (summary[name]) continue;
      const reportFile = resolve(root, `visual/${prefix}-report.json`);
      const previous = existsSync(reportFile)
        ? JSON.parse(readFileSync(reportFile, "utf8")).summary[name]
        : null;
      if (previous) summary[name] = { ...previous, ...artifactDigests(name, prefix) };
    }
    // Written last: a report can only ever claim digests that already exist on disk.
    writeAtomic(
      resolve(root, `visual/${prefix}-report.json`),
      `${JSON.stringify({
        generated: new Date().toISOString(),
        summary: Object.fromEntries(EXAMPLES.filter((name) => summary[name])
          .map((name) => [name, summary[name]])),
      }, null, 2)}\n`,
    );
  } else {
    console.log("read-only run: no file written (pass --write to regenerate artifacts and PNGs)");
  }
  if (report.escaped.length) console.log(`blocked off-host requests: ${report.escaped.length}`);
}
