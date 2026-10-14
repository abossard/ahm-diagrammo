// AHM Diagrammo authoring plugin for Draw.io.
// Concatenated after ahm-health.js by sync-assets.mjs.
// Self-contained IIFE: uses only ui.editor.graph, mxGraph APIs, ahm* attribute vocabulary.
(function (root) {
  "use strict";

  function attr(value, name) {
    return value && typeof value.getAttribute === "function" ? value.getAttribute(name) : null;
  }

  function setAttr(value, name, val) {
    if (value && typeof value.setAttribute === "function") value.setAttribute(name, val);
  }

  function createValue() {
    return root.mxUtils.createXmlDocument().createElement("object");
  }

  function generateId() {
    // Unique enough for authoring sessions. No crypto dependency.
    return "ahm-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function collectAhmIds(model) {
    var ids = Object.create(null);
    Object.keys(model.cells || {}).forEach(function (key) {
      var cell = model.cells[key];
      var id = attr(cell.value, "ahmId");
      if (id) ids[id] = true;
    });
    return ids;
  }

  function uniqueAhmId(existingIds) {
    var id;
    do { id = generateId(); } while (existingIds[id]);
    existingIds[id] = true;
    return id;
  }

  // Re-ID inserted entity templates and descendants atomically.
  // Tags native entity-to-entity edges as standard dependencies.
  function installAuthoring(ui) {
    var AUTHORING_KEY = "ahmAuthoring$installed$v1";
    if (ui[AUTHORING_KEY]) return ui[AUTHORING_KEY];

    var graph = ui.editor.graph;
    var model = graph.getModel();

    // V-06: CELLS_ADDED handler to re-ID entities with duplicate/empty ahmId
    graph.addListener(root.mxEvent.CELLS_ADDED, function (sender, event) {
      var cells = event.getProperty("cells");
      if (!cells || !cells.length) return;

      var existingIds = collectAhmIds(model);
      var reIdMap = Object.create(null); // old ahmId -> new ahmId

      model.beginUpdate();
      try {
        // First pass: re-ID entities
        cells.forEach(function (cell) {
          var role = attr(cell.value, "ahmRole");
          if (role !== "entity") return;
          var currentId = attr(cell.value, "ahmId");
          if (!currentId || existingIds[currentId]) {
            var newId = uniqueAhmId(existingIds);
            if (currentId) reIdMap[currentId] = newId;
            var newValue = cell.value.cloneNode(true);
            newValue.setAttribute("ahmId", newId);
            model.setValue(cell, newValue);
          }
        });

        // Second pass: rewrite ahmOwner on imported cells and all descendants
        if (Object.keys(reIdMap).length > 0) {
          function rewriteOwner(cell) {
            var owner = attr(cell.value, "ahmOwner");
            if (owner && reIdMap[owner]) {
              var newValue = cell.value.cloneNode(true);
              newValue.setAttribute("ahmOwner", reIdMap[owner]);
              model.setValue(cell, newValue);
            }
            for (var i = 0; i < model.getChildCount(cell); i++) {
              rewriteOwner(model.getChildAt(cell, i));
            }
          }
          cells.forEach(function (cell) { rewriteOwner(cell); });
        }
      } finally {
        model.endUpdate();
      }
    });

    // V-13: Tag natively drawn entity-to-entity edges as dependencies
    graph.addListener(root.mxEvent.CELL_CONNECTED, function (sender, event) {
      var edge = event.getProperty("edge");
      var terminal = event.getProperty("terminal");
      var source = event.getProperty("source");
      if (!edge || !terminal) return;
      // Only act when target is set (source=false means target terminal connected)
      if (source) return;

      var sourceCell = model.getTerminal(edge, true);
      var targetCell = model.getTerminal(edge, false);
      if (!sourceCell || !targetCell) return;

      var sourceRole = attr(sourceCell.value, "ahmRole");
      var targetRole = attr(targetCell.value, "ahmRole");
      if (sourceRole !== "entity" || targetRole !== "entity") return;

      // Already tagged
      if (attr(edge.value, "ahmRole") === "dependency") return;

      model.beginUpdate();
      try {
        var edgeValue = edge.value;
        if (!edgeValue || typeof edgeValue.setAttribute !== "function") {
          edgeValue = createValue();
          edgeValue.setAttribute("label", "");
        } else {
          edgeValue = edgeValue.cloneNode(true);
        }
        edgeValue.setAttribute("ahmRole", "dependency");
        edgeValue.setAttribute("ahmImpact", "standard");
        model.setValue(edge, edgeValue);
      } finally {
        model.endUpdate();
      }
    });

    // Register authoring menu actions
    var actions = ui.actions;
    if (root.mxResources && typeof root.mxResources.parse === "function") {
      root.mxResources.parse([
        "ahmAddSignal=Add Signal",
        "ahmConnectSelection=Connect as Dependency"
      ].join("\n"));
    }

    actions.addAction("ahmAddSignal", function () {
      var parent = graph.getDefaultParent();
      var selected = graph.getSelectionCell();
      var ownerEntity = null;
      if (selected) {
        // Walk up to find the owning entity
        var cell = selected;
        while (cell) {
          if (attr(cell.value, "ahmRole") === "entity") {
            ownerEntity = cell;
            break;
          }
          cell = model.getParent(cell);
        }
      }
      if (!ownerEntity) {
        if (ui.handleError) ui.handleError(new Error("Select an entity first to add a signal."));
        return;
      }

      var ownerId = attr(ownerEntity.value, "ahmId");
      var geo = model.getGeometry(ownerEntity);
      var x = geo ? geo.x + geo.width + 20 : 100;
      var y = geo ? geo.y : 100;

      model.beginUpdate();
      try {
        var value = createValue();
        value.setAttribute("label", "New Signal");
        value.setAttribute("ahmRole", "signal");
        value.setAttribute("ahmOwner", ownerId);
        value.setAttribute("ahmState", "Healthy");
        var vertex = graph.insertVertex(parent, null, value, x, y, 120, 40,
          "rounded=1;whiteSpace=wrap;fillColor=#f2f8f2;strokeColor=#a0d8a0;");
      } finally {
        model.endUpdate();
      }
    });

    actions.addAction("ahmConnectSelection", function () {
      var cells = graph.getSelectionCells();
      if (!cells || cells.length < 2) {
        if (ui.handleError) ui.handleError(new Error("Select at least two entities to connect."));
        return;
      }
      var entities = cells.filter(function (c) { return attr(c.value, "ahmRole") === "entity"; });
      if (entities.length < 2) {
        if (ui.handleError) ui.handleError(new Error("Select at least two entities to connect."));
        return;
      }

      model.beginUpdate();
      try {
        for (var i = 0; i < entities.length - 1; i++) {
          var value = createValue();
          value.setAttribute("label", "");
          value.setAttribute("ahmRole", "dependency");
          value.setAttribute("ahmImpact", "standard");
          graph.insertEdge(graph.getDefaultParent(), null, value, entities[i], entities[i + 1],
            "edgeStyle=orthogonalEdgeStyle;");
        }
      } finally {
        model.endUpdate();
      }
    });

    // Add authoring submenu to AHM Health Model menu
    if (ui.menus) {
      var existingMenu = ui.menus.get && ui.menus.get("ahmHealthModel");
      if (existingMenu && existingMenu.funct) {
        var prevFunct = existingMenu.funct;
        existingMenu.funct = function (menu, parent) {
          prevFunct.apply(this, arguments);
          ui.menus.addMenuItems(menu, ["-", "ahmAddSignal", "ahmConnectSelection"], parent);
        };
      }
    }

    function showAuthoringPalette() {
      if (!ui.sidebar || !ui.sidebar.palettes || typeof ui.sidebar.showPalette !== "function") return;
      Object.keys(ui.sidebar.palettes).forEach(function (id) {
        if (id.indexOf("ahmDiagrammoLibrary.") !== 0) return;
        var palette = ui.sidebar.palettes[id];
        ui.sidebar.showPalette(id);
        if (palette && palette[0] && palette[1]
          && palette[1].style.display === "none"
          && typeof palette[0].click === "function") {
          palette[0].click();
        }
      });
    }
    showAuthoringPalette();
    if (root.setTimeout) {
      root.setTimeout(showAuthoringPalette, 0);
      root.setTimeout(showAuthoringPalette, 500);
    }

    var installed = { AUTHORING_KEY: AUTHORING_KEY };
    ui[AUTHORING_KEY] = installed;
    return installed;
  }

  if (root.Draw && typeof root.Draw.loadPlugin === "function") {
    root.Draw.loadPlugin(function (ui) { installAuthoring(ui); });
  }
  root.AhmAuthoringPluginFactory = installAuthoring;
}(typeof globalThis !== "undefined" ? globalThis : this));
