#!/usr/bin/env node
// V-05/V-06/V-07/V-08/V-13 proof: author a full AHM health model from a blank canvas
// using the real Draw.io runtime with the packaged plugin.
// Read-only by default; pass --write to record evidence files.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { withDrawio, loadModel, exportXmlSvg } from "../../visual/drawio-host.mjs";
import { readDrawioSvgSource } from "../../test/helpers/artifact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, "..");
const pluginPath = resolve(extRoot, "assets/plugin/ahm-diagrammo.plugin.js");
const libraryPath = resolve(extRoot, "assets/library/ahm-diagrammo.xml");
// `--evidence-dir <dir>` relocates the evidence output for tests only. Product runs use ./evidence.
const evidenceFlagIndex = process.argv.indexOf("--evidence-dir");
const evidenceDir = evidenceFlagIndex >= 0 && process.argv[evidenceFlagIndex + 1]
  ? resolve(process.argv[evidenceFlagIndex + 1])
  : resolve(extRoot, "evidence");
// `--skip-lane-legend` drops the lane and legend imports. It exists so the strengthened
// C-23.3 assertions can be shown failing red against a library regression.
const skipLaneLegend = process.argv.includes("--skip-lane-legend");

if (!existsSync(pluginPath)) {
  console.error("Run sync-assets first: missing " + pluginPath);
  process.exit(1);
}

const pluginSource = readFileSync(pluginPath, "utf8");
const libraryXml = readFileSync(libraryPath, "utf8");

const libraryJson = libraryXml.match(/<mxlibrary>([\s\S]*)<\/mxlibrary>/)?.[1];
if (!libraryJson) { console.error("Failed to parse library XML"); process.exit(1); }
const libraryEntries = JSON.parse(libraryJson);

const doWrite = process.argv.includes("--write");
const results = { v05: null, v06: null, v07: null, v08: null, v13: null, orientation: null, errors: [] };

function assert(cond, msg) {
  if (!cond) {
    results.errors.push(msg);
    throw new Error("ASSERTION FAILED: " + msg);
  }
}

// loadModel requires getChildCount > 0, so seed with a disposable cell
const SEED_XML =
  '<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>' +
  '<mxCell id="seed" value="." parent="1" vertex="1">' +
  '<mxGeometry x="0" y="0" width="1" height="1" as="geometry"/>' +
  '</mxCell></root></mxGraphModel>';

// Shared helper injected into page context via exposeFunction.
// Decoded from library XML using mxCodec, then imported via graph.importCells.
async function injectHelper(page) {
  await page.evaluate(() => {
    globalThis.importEntry = function (entries, idx, x, y) {
      var graph = editorUi.editor.graph;
      var parent = graph.getDefaultParent();
      var doc = mxUtils.parseXml(entries[idx].xml);
      var codec = new mxCodec(doc);
      var decoded = codec.decode(doc.documentElement);
      var layer = decoded.getChildAt(decoded.getRoot(), 0);
      var cells = [];
      for (var i = 0; i < decoded.getChildCount(layer); i++) cells.push(decoded.getChildAt(layer, i));
      return graph.importCells(cells, x, y, parent);
    };
  });
}

try {
  await withDrawio(async (page) => {
    // ── V-05: plugin registration, menu, actions, library ──
    console.log("V-05: checking plugin registration...");

    const registration = await page.evaluate(() => {
      const healthInstalled = !!window.AhmHealthPluginFactory;
      const authoringInstalled = !!window.AhmAuthoringPluginFactory;
      if (healthInstalled) window.AhmHealthPluginFactory().install(editorUi);
      if (authoringInstalled) window.AhmAuthoringPluginFactory(editorUi);

      const actions = editorUi.actions;
      const healthActions = [
        "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
        "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed",
        "ahmRecalculate", "ahmValidate",
      ];
      const authoringActions = ["ahmAddSignal", "ahmConnectSelection"];
      const menu = editorUi.menus && editorUi.menus.get && editorUi.menus.get("ahmHealthModel");

      return {
        healthInstalled, authoringInstalled,
        healthActions: healthActions.filter(n => !!actions.get(n)),
        healthMissing: healthActions.filter(n => !actions.get(n)),
        authoringActions: authoringActions.filter(n => !!actions.get(n)),
        authoringMissing: authoringActions.filter(n => !actions.get(n)),
        menuPresent: !!menu,
      };
    });

    assert(registration.healthInstalled, "V-05: AhmHealthPluginFactory exists");
    assert(registration.authoringInstalled, "V-05: AhmAuthoringPluginFactory exists");
    assert(registration.menuPresent, "V-05: ahmHealthModel menu present");
    assert(registration.healthMissing.length === 0,
      "V-05: all health actions registered, missing: " + registration.healthMissing.join(", "));
    assert(registration.authoringActions.includes("ahmAddSignal"), "V-05: ahmAddSignal registered");
    assert(registration.authoringActions.includes("ahmConnectSelection"), "V-05: ahmConnectSelection registered");
    const libraryCoverage = {
      entity: libraryEntries.some((entry) => /ahmRole="entity"/.test(entry.xml)),
      signal: libraryEntries.some((entry) => /ahmRole="signal"/.test(entry.xml)),
      swimlane: libraryEntries.some((entry) => /ahmRole="lane"/.test(entry.xml)),
      legend: libraryEntries.some((entry) => /ahmRole="legend"/.test(entry.xml)),
    };
    assert(Object.values(libraryCoverage).every(Boolean),
      "V-05: packaged library coverage incomplete: " + JSON.stringify(libraryCoverage));

    results.v05 = { ...registration, libraryCoverage };
    console.log("V-05: PASS - menu, " + registration.healthActions.length + " health + " +
      registration.authoringActions.length + " authoring actions");

    // Load seed model so graph is initialised
    await loadModel(page, SEED_XML);
    await injectHelper(page);
    // Remove the seed cell
    await page.evaluate(() => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const seed = model.getCell("seed");
      if (seed) { model.beginUpdate(); try { model.remove(seed); } finally { model.endUpdate(); } }
      editorUi.editor.undoManager.clear();
    });

    // ── V-06: unique IDs on repeated library insertion ──
    console.log("V-06: testing unique IDs...");

    const v06result = await page.evaluate((entries) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const parent = graph.getDefaultParent();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }
      function snap(cells) {
        return cells.map(c => ({ id: c.id, ahmRole: attr(c.value, "ahmRole"), ahmId: attr(c.value, "ahmId"), ahmOwner: attr(c.value, "ahmOwner") }));
      }

      const e1 = snap(importEntry(entries, 0, 50, 50));
      const e2 = snap(importEntry(entries, 0, 50, 200));
      const e3 = snap(importEntry(entries, 0, 50, 350));
      const e4 = snap(importEntry(entries, 4, 350, 50));
      const e5 = snap(importEntry(entries, 4, 350, 300));

      const all = [...e1, ...e2, ...e3, ...e4, ...e5];
      const entities = all.filter(c => c.ahmRole === "entity");
      const ahmIds = entities.map(c => c.ahmId).filter(Boolean);
      const uniqueIds = [...new Set(ahmIds)];

      // Owner rewrite check: every ahmOwner must point to a valid ahmId
      const owned = all.filter(c => c.ahmOwner);
      const ownersValid = owned.every(c => ahmIds.includes(c.ahmOwner));

      // Undo all insertions - each importCells is one undo step
      let undoCount = 0;
      const mgr = editorUi.editor.undoManager;
      while (mgr.canUndo()) { editorUi.actions.get("undo").funct(); undoCount++; }
      const cellCountAfterUndo = model.getChildCount(parent);

      return { entityCount: entities.length, ahmIds, uniqueIdCount: uniqueIds.length, ownersValid, undoCount, cellCountAfterUndo };
    }, libraryEntries);

    assert(v06result.entityCount === 5, "V-06: 5 entities, got " + v06result.entityCount);
    assert(v06result.uniqueIdCount === 5, "V-06: 5 unique ahmIds, got " + v06result.uniqueIdCount);
    assert(v06result.ownersValid, "V-06: all ahmOwner references resolve");
    assert(v06result.cellCountAfterUndo === 0, "V-06: undo to empty, cells=" + v06result.cellCountAfterUndo);

    results.v06 = v06result;
    console.log("V-06: PASS - " + v06result.uniqueIdCount + " unique IDs, " + v06result.undoCount + " undos to empty");

    // ── V-13: edge tagging ──
    console.log("V-13: testing edge tagging...");

    // Clear undo history
    await page.evaluate(() => editorUi.editor.undoManager.clear());

    const v13result = await page.evaluate((entries) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const parent = graph.getDefaultParent();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }

      const e1 = importEntry(entries, 0, 50, 50);
      const e2 = importEntry(entries, 0, 350, 50);
      const ent1 = e1.find(c => attr(c.value, "ahmRole") === "entity");
      const ent2 = e2.find(c => attr(c.value, "ahmRole") === "entity");

      // Entity-to-entity edge
      model.beginUpdate();
      let edge;
      try { edge = graph.insertEdge(parent, null, "", ent1, ent2, "edgeStyle=orthogonalEdgeStyle;"); }
      finally { model.endUpdate(); }
      const edgeRole = attr(edge.value, "ahmRole");
      const edgeImpact = attr(edge.value, "ahmImpact");
      editorUi.actions.get("undo").funct();
      const goneAfterOneUndo = !model.getCell(edge.id);
      const entitiesSurviveUndo = !!model.getCell(ent1.id) && !!model.getCell(ent2.id);
      editorUi.actions.get("redo").funct();
      edge = model.getCell(edge.id);
      const restoredAfterOneRedo = attr(edge && edge.value, "ahmRole") === "dependency";

      // Entity-to-non-entity edge (negative case)
      model.beginUpdate();
      let rect, edge2;
      try {
        rect = graph.insertVertex(parent, null, "Box", 50, 300, 120, 40, "rounded=0;");
        edge2 = graph.insertEdge(parent, null, "", ent1, rect, "edgeStyle=orthogonalEdgeStyle;");
      } finally { model.endUpdate(); }
      const edge2Role = attr(edge2.value, "ahmRole");

      // Undo the negative-case transaction, then the one dependency transaction.
      editorUi.actions.get("undo").funct(); // remove rect+edge2
      editorUi.actions.get("undo").funct(); // remove entity-entity edge

      return {
        entityToEntity: { role: edgeRole, impact: edgeImpact },
        entityToNonEntity: { role: edge2Role },
        goneAfterOneUndo,
        entitiesSurviveUndo,
        restoredAfterOneRedo,
      };
    }, libraryEntries);

    assert(v13result.entityToEntity.role === "dependency",
      "V-13: entity-entity edge tagged dependency, got: " + v13result.entityToEntity.role);
    assert(v13result.entityToEntity.impact === "standard",
      "V-13: entity-entity edge impact=standard, got: " + v13result.entityToEntity.impact);
    assert(!v13result.entityToNonEntity.role,
      "V-13: entity-nonentity NOT tagged, got: " + v13result.entityToNonEntity.role);
    assert(v13result.goneAfterOneUndo && v13result.entitiesSurviveUndo && v13result.restoredAfterOneRedo,
      "V-13: dependency creation/tagging was not exactly one native Undo/Redo step");

    results.v13 = v13result;
    console.log("V-13: PASS - entity-entity tagged, entity-nonentity not tagged");

    // ── C-23.6(c): dependency orientation survives the public readDrawio seam ──
    console.log("orientation: testing dependency direction at readDrawio boundary...");

    const orientation = await page.evaluate((entries) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const parent = graph.getDefaultParent();
      const api = window.AhmHealthPluginFactory();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }

      const a = importEntry(entries, 0, 50, 50).find(c => attr(c.value, "ahmRole") === "entity");
      const b = importEntry(entries, 0, 350, 50).find(c => attr(c.value, "ahmRole") === "entity");

      function drawAndRead(from, to) {
        model.beginUpdate();
        let edge;
        try { edge = graph.insertEdge(parent, null, "", from, to, "edgeStyle=orthogonalEdgeStyle;"); }
        finally { model.endUpdate(); }
        const dep = api.readDrawio(graph).cells.find(c => c.role === "dependency" && c.id === String(edge.id));
        editorUi.actions.get("undo").funct();
        return { source: dep && dep.source, target: dep && dep.target };
      }

      const aToB = drawAndRead(a, b);
      const bToA = drawAndRead(b, a);
      editorUi.actions.get("undo").funct();
      editorUi.actions.get("undo").funct();
      return { aId: String(a.id), bId: String(b.id), aToB, bToA };
    }, libraryEntries);

    assert(orientation.aToB.source === orientation.aId && orientation.aToB.target === orientation.bId,
      "orientation: A->B recorded as " + JSON.stringify(orientation.aToB));
    assert(orientation.bToA.source === orientation.bId && orientation.bToA.target === orientation.aId,
      "orientation: B->A recorded as " + JSON.stringify(orientation.bToA));

    results.orientation = orientation;
    console.log("orientation: PASS - A->B and B->A read back with opposite source/target");

    // Clear canvas for V-07
    await page.evaluate(() => {
      const mgr = editorUi.editor.undoManager;
      while (mgr.canUndo()) editorUi.actions.get("undo").funct();
      mgr.clear();
    });

    // ── V-07: full model from blank ──
    console.log("V-07: building full model...");

    const v07result = await page.evaluate(({ entries, skip }) => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      const parent = graph.getDefaultParent();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }

      // Four healthy entities form the three-hop impact chain exercised by V-08.
      const e1 = importEntry(entries, 0, 50, 100);
      const e2 = importEntry(entries, 0, 350, 100);
      const e3 = importEntry(entries, 0, 650, 100);
      const e4 = importEntry(entries, 0, 950, 100);
      const e5 = importEntry(entries, 0, 50, 400);
      const e6 = importEntry(entries, 3, 350, 400);
      const ent1 = e1.find(c => attr(c.value, "ahmRole") === "entity");
      const ent2 = e2.find(c => attr(c.value, "ahmRole") === "entity");
      const ent3 = e3.find(c => attr(c.value, "ahmRole") === "entity");
      const ent4 = e4.find(c => attr(c.value, "ahmRole") === "entity");
      const ent5 = e5.find(c => attr(c.value, "ahmRole") === "entity");
      const ent6 = e6.find(c => attr(c.value, "ahmRole") === "entity");

      // 2 swimlanes + 1 legend
      if (!skip) {
        importEntry(entries, 5, 20, 650);
        importEntry(entries, 5, 20, 900);
        importEntry(entries, 6, 50, 1200);
      }

      // 2 signals via action
      graph.setSelectionCell(ent1);
      editorUi.actions.get("ahmAddSignal").funct();
      graph.setSelectionCell(ent2);
      editorUi.actions.get("ahmAddSignal").funct();

      // Native dependencies use standard, limited, and suppressed impacts in sequence.
      model.beginUpdate();
      let dep1, dep2, dep3, dep4;
      try {
        dep1 = graph.insertEdge(parent, null, "", ent1, ent2, "edgeStyle=orthogonalEdgeStyle;");
        dep2 = graph.insertEdge(parent, null, "", ent2, ent3, "edgeStyle=orthogonalEdgeStyle;");
        dep3 = graph.insertEdge(parent, null, "", ent3, ent4, "edgeStyle=orthogonalEdgeStyle;");
        dep4 = graph.insertEdge(parent, null, "", ent5, ent6, "edgeStyle=orthogonalEdgeStyle;");
      } finally { model.endUpdate(); }
      graph.setSelectionCell(dep2);
      editorUi.actions.get("ahmImpactLimited").funct();
      graph.setSelectionCell(dep3);
      editorUi.actions.get("ahmImpactSuppressed").funct();

      // Count roles (walk full tree)
      const counts = {};
      function walk(cell) {
        const r = attr(cell.value, "ahmRole");
        if (r) counts[r] = (counts[r] || 0) + 1;
        for (let i = 0; i < model.getChildCount(cell); i++) walk(model.getChildAt(cell, i));
      }
      walk(model.getRoot());

      return {
        counts,
        entityCount: counts.entity || 0,
        signalCount: counts.signal || 0,
        dependencyCount: counts.dependency || 0,
        laneCount: counts.lane || 0,
        legendCount: counts.legend || 0,
        chainIds: [ent1, ent2, ent3, ent4].map((entity) => attr(entity.value, "ahmId")),
        unknownFloorId: attr(ent6.value, "ahmId"),
      };
    }, { entries: libraryEntries, skip: skipLaneLegend });

    assert(v07result.entityCount >= 3, "V-07: >= 3 entities, got " + v07result.entityCount);
    assert(v07result.signalCount >= 2, "V-07: >= 2 signals, got " + v07result.signalCount);
    assert(v07result.dependencyCount >= 2, "V-07: >= 2 deps, got " + v07result.dependencyCount);
    assert(v07result.laneCount >= 2, "V-07: >= 2 lanes, got " + v07result.laneCount);
    assert(v07result.legendCount >= 1, "V-07: >= 1 legend, got " + v07result.legendCount);

    results.v07 = v07result;
    console.log("V-07: PASS - entities=" + v07result.entityCount + " signals=" +
      v07result.signalCount + " deps=" + v07result.dependencyCount +
      " lanes=" + v07result.laneCount + " legends=" + v07result.legendCount);

    // ── V-08: health/rollup/impact/undo/save-reopen ──
    console.log("V-08: testing rollup, impact, undo, save/reopen...");

    // V-08a: health state change triggers rollup recompute
    const v08a = await page.evaluate(() => {
      const graph = editorUi.editor.graph;
      const model = graph.getModel();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }
      const entities = [];
      function walk(cell) {
        if (attr(cell.value, "ahmRole") === "entity") {
          entities.push({
            id: cell.id,
            ahmId: attr(cell.value, "ahmId"),
            localState: attr(cell.value, "ahmLocalState"),
            computedState: attr(cell.value, "ahmComputedState"),
            impact: attr(cell.value, "ahmImpact"),
          });
        }
        for (let i = 0; i < model.getChildCount(cell); i++) walk(model.getChildAt(cell, i));
      }
      walk(model.getRoot());

      // Change entity 1 to Unhealthy - should propagate via dependencies
      const ent1Cell = model.getCell(entities[0].id);
      graph.setSelectionCell(ent1Cell);
      editorUi.actions.get("ahmSetUnhealthy").funct();

      // Re-read states
      const after = [];
      function walk2(cell) {
        if (attr(cell.value, "ahmRole") === "entity") {
          after.push({
            ahmId: attr(cell.value, "ahmId"),
            localState: attr(cell.value, "ahmLocalState"),
            computedState: attr(cell.value, "ahmComputedState"),
          });
        }
        for (let i = 0; i < model.getChildCount(cell); i++) walk2(model.getChildAt(cell, i));
      }
      walk2(model.getRoot());

      return { before: entities, after };
    });

    const statesById = Object.fromEntries(v08a.after.map((entity) => [
      entity.ahmId, entity.computedState,
    ]));
    const expectedStates = ["Unhealthy", "Unhealthy", "Degraded", "Healthy"];
    assert(v07result.chainIds.every((id, index) => statesById[id] === expectedStates[index]),
      "V-08a: standard/limited/suppressed chain mismatch: " + JSON.stringify(statesById));
    assert(statesById[v07result.unknownFloorId] === "Unknown",
      "V-08a: authored Unknown was overwritten by a Healthy child");

    // V-08b: validate action
    const v08b = await page.evaluate((chainIds) => {
      const reported = [];
      const originalHandleError = editorUi.handleError;
      editorUi.handleError = function (error) {
        reported.push(String(error && error.message || error));
      };
      try {
        editorUi.actions.get("ahmValidate").funct();
        editorUi.actions.get("ahmRecalculate").funct();
      } finally {
        editorUi.handleError = originalHandleError;
      }

      const api = window.AhmHealthPluginFactory();
      const graph = editorUi.editor.graph;
      const snapshot = api.readDrawio(graph);
      let invalidReference = "";
      const invalid = JSON.parse(JSON.stringify(snapshot));
      invalid.cells.find((cell) => cell.role === "dependency").source = "missing-cell";
      try { api.validate(invalid); } catch (error) { invalidReference = error.message; }
      let cycle = "";
      const cyclic = JSON.parse(JSON.stringify(snapshot));
      const first = cyclic.cells.find((cell) => cell.ahmId === chainIds[0]);
      const last = cyclic.cells.find((cell) => cell.ahmId === chainIds[chainIds.length - 1]);
      cyclic.cells.push({
        id: "cycle-edge",
        role: "dependency",
        source: last.id,
        target: first.id,
        edgeImpact: "standard",
      });
      try { api.validate(cyclic); } catch (error) { cycle = error.message; }
      return { reported, invalidReference, cycle };
    }, v07result.chainIds);
    assert(v08b.reported.length === 0,
      "V-08b: validate/recalculate reported errors: " + JSON.stringify(v08b.reported));
    assert(/missing endpoint/.test(v08b.invalidReference),
      "V-08b: invalid reference did not fail loudly: " + v08b.invalidReference);
    assert(/cycle/i.test(v08b.cycle),
      "V-08b: cycle did not fail loudly: " + v08b.cycle);

    // V-08c: undo/redo
    const v08c = await page.evaluate((chainIds) => {
      const mgr = editorUi.editor.undoManager;
      const model = editorUi.editor.graph.getModel();
      function attr(value, name) {
        return value && typeof value.getAttribute === "function" ? value.getAttribute(name) : null;
      }
      function chainStates() {
        const byId = {};
        Object.keys(model.cells || {}).forEach((key) => {
          const cell = model.cells[key];
          const id = attr(cell.value, "ahmId");
          if (chainIds.indexOf(id) >= 0) byId[id] = attr(cell.value, "ahmComputedState");
        });
        return chainIds.map((id) => byId[id]);
      }
      const beforeUndo = chainStates();
      const canUndo = mgr.canUndo();
      if (canUndo) editorUi.actions.get("undo").funct();
      const afterOneUndo = chainStates();
      const canRedo = mgr.canRedo();
      if (canRedo) editorUi.actions.get("redo").funct();
      const afterOneRedo = chainStates();
      return { canUndo, canRedo, beforeUndo, afterOneUndo, afterOneRedo };
    }, v07result.chainIds);

    // V-08d: save/reopen via the exact model embedded in Draw.io's exported SVG.
    const semanticsBeforeExport = await page.evaluate(() => {
      const cells = editorUi.editor.graph.getModel().cells || {};
      const rows = [];
      Object.keys(cells).sort().forEach((id) => {
        const value = cells[id].value;
        if (!value || !value.attributes) return;
        const attrs = {};
        Array.from(value.attributes).forEach((attribute) => {
          if (attribute.name.indexOf("ahm") === 0) attrs[attribute.name] = attribute.value;
        });
        if (Object.keys(attrs).length) rows.push({ id, attrs });
      });
      return rows;
    });
    const exported = await exportXmlSvg(page);
    assert(!/(?:\/Users\/|[A-Z]:\\)/.test(exported),
      "V-09: authored SVG contains an absolute machine path");
    const exportedModel = readDrawioSvgSource(exported, "V-08 export").model;
    assert((exportedModel.match(/ahmRole="dependency"/g) || []).length === v07result.dependencyCount,
      "V-08d: embedded model lost dependency semantics");

    await page.evaluate(() => {
      const graph = editorUi.editor.graph;
      graph.removeCells(graph.getChildCells(graph.getDefaultParent(), true, true));
    });
    await loadModel(page, exportedModel);
    const v08d = await page.evaluate(() => {
      const model = editorUi.editor.graph.getModel();
      function attr(v, n) { return v && typeof v.getAttribute === "function" ? v.getAttribute(n) : null; }
      let entityCount = 0, depCount = 0, signalCount = 0;
      const ahmIds = [];
      Object.keys(model.cells).forEach(k => {
        const r = attr(model.cells[k].value, "ahmRole");
        if (r === "entity") { entityCount++; ahmIds.push(attr(model.cells[k].value, "ahmId")); }
        if (r === "dependency") depCount++;
        if (r === "signal") signalCount++;
      });
      const semanticSnapshot = [];
      Object.keys(model.cells).sort().forEach((id) => {
        const value = model.cells[id].value;
        if (!value || !value.attributes) return;
        const attrs = {};
        Array.from(value.attributes).forEach((attribute) => {
          if (attribute.name.indexOf("ahm") === 0) attrs[attribute.name] = attribute.value;
        });
        if (Object.keys(attrs).length) semanticSnapshot.push({ id, attrs });
      });
      return { entityCount, depCount, signalCount, ahmIds, semanticSnapshot };
    });

    results.v08 = {
      a_stateChange: { before: v08a.before.length, after: v08a.after.length },
      b_actions: v08b,
      c_undoRedo: v08c,
      d_roundTrip: { reopened: v08d },
    };

    assert(v08a.after.length >= 3, "V-08a: entities present after state change");
    assert(v08c.canUndo, "V-08c: undo available");
    assert(v08c.canRedo, "V-08c: redo available after undo");
    assert(JSON.stringify(v08c.afterOneUndo) === JSON.stringify(["Healthy", "Healthy", "Healthy", "Healthy"]),
      "V-08c: one Undo did not reverse the complete AHM state action: " + JSON.stringify(v08c.afterOneUndo));
    assert(JSON.stringify(v08c.afterOneRedo) === JSON.stringify(expectedStates),
      "V-08c: one Redo did not restore the complete AHM state action: " + JSON.stringify(v08c.afterOneRedo));
    assert(v08d.entityCount === v07result.entityCount,
      "V-08d: entity count changed on reopen, got " + v08d.entityCount);
    assert(v08d.depCount === v07result.dependencyCount,
      "V-08d: dependency count changed on reopen, got " + v08d.depCount);
    assert(v08d.signalCount === v07result.signalCount,
      "V-08d: signal count changed on reopen, got " + v08d.signalCount);
    assert(JSON.stringify(v08d.semanticSnapshot) === JSON.stringify(semanticsBeforeExport),
      "V-08d: ahm* semantics changed on save/reopen");
    assert(v08d.ahmIds.every(id => id && id.startsWith("ahm-")),
      "V-08d: ahmIds survive reopen: " + JSON.stringify(v08d.ahmIds));

    console.log("V-08: PASS - rollup ok, validate/recalc ok, undo/redo ok, roundtrip " +
      v08d.entityCount + " entities " + v08d.depCount + " deps");

    // ── Write evidence (only with --write; the default run is read-only) ──
    if (!doWrite) {
      console.log("read-only: no evidence written (pass --write to record evidence)");
    } else {
      mkdirSync(evidenceDir, { recursive: true });
      writeFileSync(resolve(evidenceDir, "author-from-blank-report.json"),
        JSON.stringify(results, null, 2) + "\n");
      writeFileSync(resolve(evidenceDir, "authored-model.drawio.svg"), exported);

      // Render SVG to PNG via Puppeteer. A render failure is fatal: evidence must be complete.
      const shot = await page.browser().newPage();
      await shot.setViewport({ width: 1800, height: 1200, deviceScaleFactor: 2 });
      await shot.setContent(
        '<html><body style="margin:0;background:#fff">' +
        '<img id="art" src="data:image/svg+xml;base64,' +
        Buffer.from(exported).toString("base64") + '"></body></html>',
        { waitUntil: "load" },
      );
      await shot.waitForFunction(() => {
        const el = document.getElementById("art");
        return el && el.complete && el.naturalWidth > 0;
      }, { timeout: 5000 });
      await new Promise(r => setTimeout(r, 500));
      await (await shot.$("#art")).screenshot({ path: resolve(evidenceDir, "vsix-authored-model.png") });
      await shot.close();
      console.log("Evidence written to " + evidenceDir);
    }

  }, { plugin: pluginSource });

  console.log("\n=== SUMMARY ===");
  ["v05", "v06", "v07", "v08", "v13", "orientation"].forEach(k =>
    console.log(k.toUpperCase().replace("V0", "V-0").replace("V1", "V-1") +
      ": " + (results[k] ? "PASS" : "FAIL")));
  if (results.errors.length) {
    console.error("\nFailed assertions:");
    results.errors.forEach(e => console.error("  " + e));
    process.exit(1);
  }

} catch (err) {
  console.error("FATAL: " + err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
}
