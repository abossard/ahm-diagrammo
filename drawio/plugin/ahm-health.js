(function (root) {
  function factory() {
    "use strict";

    var STATES = ["Healthy", "Degraded", "Unhealthy", "Unknown"];
    var IMPACTS = ["standard", "limited", "suppressed"];
    // Draw.io loads this file as a plain browser script, so it cannot import src/themes.mjs.
    // drawio/test/plugin-adapter.test.mjs pins every value below against getTheme("portal").
    var TOKENS = {
      Healthy: { stroke: "#a0d8a0", fill: "#f2f8f2", dot: "#4c9a2a", dashed: "0" },
      Degraded: { stroke: "#db7500", fill: "#fbf2e7", dot: "#c26a00", dashed: "0" },
      Unhealthy: { stroke: "#ba0d16", fill: "#faeceb", dot: "#c50f18", dashed: "0" },
      Unknown: { stroke: "#c8c6c4", fill: "#f6f6f5", dot: "#8a8886", dashed: "1", dash: "4 3" },
      Standby: { stroke: "#8661c5", fill: "#f4f0fb", dot: "#8661c5", dashed: "0" },
    };
    // Standby is an authored presentation of the simulator's Unknown; it is not a fifth state.
    var AUTHORED_UNKNOWN = ["unknown", "standby"];
    var PRESENTATION = { standby: "Standby" };
    var rank = { Healthy: 0, Degraded: 1, Unhealthy: 2 };

    function fail(message) {
      throw new Error("AHM validation: " + message);
    }

    function clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    function normalizeCell(cell) {
      return {
        id: String(cell.id),
        role: cell.role,
        ahmId: cell.ahmId,
        localState: cell.localState,
        computedState: cell.computedState,
        impact: cell.impact,
        aggregation: cell.aggregation,
        authoredState: cell.authoredState,
        owner: cell.owner,
        state: cell.state,
        edgeImpact: cell.edgeImpact || (cell.role === "dependency" ? cell.impact : null),
        source: cell.source && String(typeof cell.source === "object" ? cell.source.id : cell.source),
        target: cell.target && String(typeof cell.target === "object" ? cell.target.id : cell.target),
        style: cell.style || "",
      };
    }

    function validate(diagram) {
      if (!diagram || !Array.isArray(diagram.cells)) fail("diagram.cells must be an array");
      var cells = diagram.cells.map(normalizeCell);
      var entities = cells.filter(function (cell) { return cell.role === "entity"; });
      var ids = Object.create(null);
      var cellIds = Object.create(null);
      cells.forEach(function (cell) { cellIds[cell.id] = cell; });
      entities.forEach(function (cell) {
        if (!cell.ahmId) fail("entity " + cell.id + " is missing ahmId");
        if (ids[cell.ahmId]) fail("duplicate ahmId " + cell.ahmId + " in " + ids[cell.ahmId].id + "," + cell.id);
        ids[cell.ahmId] = cell;
        if (STATES.indexOf(cell.localState) < 0) fail("invalid state " + cell.localState + " in " + cell.ahmId);
        if (cell.computedState != null && STATES.indexOf(cell.computedState) < 0) {
          fail("invalid computed state " + cell.computedState + " in " + cell.ahmId);
        }
        if (IMPACTS.indexOf(cell.impact) < 0) fail("invalid impact " + cell.impact + " in " + cell.ahmId);
        if (cell.aggregation !== "worstOf") fail("unsupported aggregation " + cell.aggregation + " in " + cell.ahmId);
      });
      cells.filter(function (cell) { return cell.role === "signal"; }).forEach(function (cell) {
        if (!cell.owner || !ids[cell.owner]) fail("signal " + cell.id + " has missing owner " + cell.owner);
        if (STATES.indexOf(cell.state) < 0) fail("invalid state " + cell.state + " in signal " + cell.id);
      });
      var dependencies = cells.filter(function (cell) { return cell.role === "dependency"; });
      dependencies.forEach(function (cell) {
        if (!cell.source || !cell.target || !cellIds[cell.source] || !cellIds[cell.target]) {
          fail("dependency " + cell.id + " has missing endpoint " + (cell.source || "?") + "->" + (cell.target || "?"));
        }
        if (cellIds[cell.source].role !== "entity" || cellIds[cell.target].role !== "entity") {
          fail("dependency " + cell.id + " endpoint is not an entity");
        }
        if (cell.edgeImpact != null && IMPACTS.indexOf(cell.edgeImpact) < 0) {
          fail("invalid impact " + cell.edgeImpact + " in dependency " + cell.id);
        }
      });

      var outgoing = Object.create(null);
      entities.forEach(function (cell) { outgoing[cell.id] = []; });
      dependencies.forEach(function (edge) { outgoing[edge.source].push(edge.target); });
      var visiting = Object.create(null);
      var visited = Object.create(null);
      function walk(id, path) {
        if (visiting[id]) fail("directed cycle " + path.concat(id).join(" -> "));
        if (visited[id]) return;
        visiting[id] = true;
        outgoing[id].forEach(function (next) { walk(next, path.concat(id)); });
        visiting[id] = false;
        visited[id] = true;
      }
      entities.forEach(function (cell) { walk(cell.id, []); });
      return { cells: cells, entities: entities, dependencies: dependencies, byAhmId: ids, byCellId: cellIds };
    }

    // Aggregates *inputs* (signals and child contributions). Unknown carries no information here,
    // so it is skipped whenever a known input exists; an all-Unknown input set stays Unknown.
    function worstOf(states) {
      var known = states.filter(function (state) { return state !== "Unknown"; });
      if (!known.length) return "Unknown";
      return known.reduce(function (worst, state) {
        return rank[state] > rank[worst] ? state : worst;
      }, "Healthy");
    }

    // An entity whose state was *authored* as Unknown/Standby has declared that its own health is
    // not known. Healthy inputs must not silently overwrite that declaration; only worse evidence
    // (Degraded/Unhealthy) may. Entities without an authored state keep the plain worstOf result,
    // so the propagation matrix is unchanged.
    function rollup(entity, inputs) {
      var worst = worstOf([entity.localState].concat(inputs));
      var authored = entity.authoredState;
      if (authored && AUTHORED_UNKNOWN.indexOf(authored) >= 0 && rank[worst] < rank.Degraded) {
        return "Unknown";
      }
      return worst;
    }

    // The label and colors an entity is presented with; authored Standby keeps its purple token.
    function presented(state, authoredState) {
      return state === "Unknown" && PRESENTATION[authoredState]
        ? PRESENTATION[authoredState]
        : state;
    }

    function contribution(state, impact) {
      if (impact === "suppressed") return "Healthy";
      if (impact === "limited") {
        if (state === "Unhealthy") return "Degraded";
        if (state === "Unknown") return "Unknown";
        return "Healthy";
      }
      return state;
    }

    function replaceStyle(style, key, value) {
      var parts = String(style || "").split(";").filter(Boolean);
      var prefix = key + "=";
      for (var index = 0; index < parts.length; index++) {
        if (parts[index].slice(0, prefix.length) === prefix) {
          // Replaced in place, never dropped and re-appended: re-writing an unchanged value has to
          // produce the identical string, or a no-op recalculation dirties every style it touches.
          parts[index] = prefix + value;
          return parts.join(";") + ";";
        }
      }
      parts.push(prefix + value);
      return parts.join(";") + ";";
    }

    // A style is an unordered set of `key=value` pairs plus bare shape flags. Draw.io re-emits them
    // in its own order on every save, so "did this style change?" is a question about the set, not
    // about the string.
    function styleMap(style) {
      var map = Object.create(null);
      String(style || "").split(";").forEach(function (part) {
        if (!part) return;
        var index = part.indexOf("=");
        if (index < 0) map["\u0000" + part] = "";
        else map[part.slice(0, index)] = part.slice(index + 1);
      });
      return map;
    }

    function sameStyle(left, right) {
      var a = styleMap(left);
      var b = styleMap(right);
      var keys = Object.keys(a);
      if (keys.length !== Object.keys(b).length) return false;
      return keys.every(function (key) { return a[key] === b[key]; });
    }

    function stateStyle(style, state, authoredState) {
      var token = TOKENS[presented(state, authoredState)];
      style = replaceStyle(style, "fillColor", token.fill);
      style = replaceStyle(style, "strokeColor", token.stroke);
      style = replaceStyle(style, "dashed", token.dashed);
      if (token.dash) style = replaceStyle(style, "dashPattern", token.dash);
      style = replaceStyle(style, "fontFamily", "Helvetica");
      return style;
    }

    function evaluated(diagram) {
      var checked = validate(diagram);
      var next = clone(diagram);
      var nextById = Object.create(null);
      next.cells.forEach(function (cell) { nextById[String(cell.id)] = cell; });
      var children = Object.create(null);
      var signals = Object.create(null);
      checked.entities.forEach(function (entity) {
        children[entity.id] = [];
        signals[entity.ahmId] = [];
      });
      checked.dependencies.forEach(function (edge) { children[edge.target].push(edge); });
      checked.cells.filter(function (cell) { return cell.role === "signal"; }).forEach(function (cell) {
        signals[cell.owner].push(cell.state);
      });
      var done = Object.create(null);
      function calculate(id) {
        if (done[id]) return nextById[id].computedState;
        var source = checked.byCellId[id];
        var childStates = children[id].map(function (edge) {
          var child = checked.byCellId[edge.source];
          return contribution(calculate(edge.source), edge.edgeImpact || child.impact);
        });
        var state = rollup(source, signals[source.ahmId].concat(childStates));
        nextById[id].computedState = state;
        nextById[id].style = stateStyle(nextById[id].style, state, source.authoredState);
        done[id] = true;
        return state;
      }
      checked.entities.slice().sort(function (a, b) { return a.id.localeCompare(b.id); }).forEach(function (entity) {
        calculate(entity.id);
      });
      return next;
    }

    function commit(diagram, next) {
      var before = JSON.stringify(diagram.cells);
      var after = JSON.stringify(next.cells);
      if (before === after) return { model: diagram, changes: 0 };
      if (typeof diagram.beginUpdate === "function") diagram.beginUpdate();
      try {
        diagram.cells.splice(0, diagram.cells.length);
        next.cells.forEach(function (cell) { diagram.cells.push(cell); });
      } finally {
        if (typeof diagram.endUpdate === "function") diagram.endUpdate();
      }
      var previous = JSON.parse(before);
      if (typeof diagram.recordEdit === "function") diagram.recordEdit(previous, clone(diagram.cells));
      return { model: diagram, changes: next.cells.reduce(function (count, cell, index) {
        return count + (JSON.stringify(cell) === JSON.stringify(previous[index]) ? 0 : 1);
      }, 0) };
    }

    function recalculate(diagram) {
      return commit(diagram, evaluated(diagram));
    }

    function setHealth(diagram, ahmId, state) {
      if (STATES.indexOf(state) < 0) fail("invalid state " + state);
      validate(diagram);
      var next = clone(diagram);
      var selected = next.cells.find(function (cell) {
        return cell.role === "entity" && (cell.ahmId === ahmId || String(cell.id) === String(ahmId));
      });
      if (!selected) fail("entity " + ahmId + " not found");
      selected.localState = state;
      return commit(diagram, evaluated(next));
    }

    function setImpact(diagram, ahmId, impact) {
      if (IMPACTS.indexOf(impact) < 0) fail("invalid impact " + impact);
      validate(diagram);
      var next = clone(diagram);
      var selected = next.cells.find(function (cell) {
        return (cell.role === "dependency" && String(cell.id) === String(ahmId))
          || (cell.role === "entity" && (cell.ahmId === ahmId || String(cell.id) === String(ahmId)));
      });
      if (!selected) fail("entity or dependency " + ahmId + " not found");
      if (selected.role === "dependency") selected.edgeImpact = impact;
      else selected.impact = impact;
      return commit(diagram, evaluated(next));
    }

    // The pill is three native cells: the rounded container, a dot child and a label child.
    // A state change rewrites the label, so the container and the label cell have to be resized to
    // the new text or the longer word runs straight through the pill's right edge — the defect the
    // user reported.
    //
    // The sizes come from ONE deterministic contract shared with the generator, keyed by the label
    // that is presented. Draw.io loads this file as a plain browser script, so it cannot import
    // `scripts/generate-artifacts.mjs`; `drawio/test/plugin-adapter.test.mjs` pins every number
    // below against that module's exported `PILL`, the same way `TOKENS` is pinned against
    // `getTheme("portal")`.
    //
    // Measuring the label at runtime (`mxUtils.getSizeForString`) is deliberately *not* done any
    // more: it answers 1px narrower than the generator's own font metrics on all five labels, so
    // every pill on every card moved and resized the instant a shipped file was opened.
    var PILL = {
      fontSize: 10,
      textX: 26,
      tailPad: 10,
      width: {
        Healthy: { label: 37, pill: 73 },
        Degraded: { label: 47, pill: 83 },
        Unhealthy: { label: 48, pill: 84 },
        Unknown: { label: 45, pill: 81 },
        Standby: { label: 40, pill: 76 },
      },
    };

    // Floors, not layout: whatever the contract says, a pill can never fall below these.
    var PILL_TAIL_MIN = 6;
    var PILL_GAP_MIN = 8;

    function styleValue(style, key) {
      var parts = String(style || "").split(";");
      for (var index = 0; index < parts.length; index++) {
        if (parts[index].slice(0, key.length + 1) === key + "=") {
          return parts[index].slice(key.length + 1);
        }
      }
      return null;
    }

    // The contract entry for a presented label. An unsupported label is a malformed model, not a
    // reason to leave a Healthy-sized pill around a longer word: it fails loudly.
    function sizedPill(shown) {
      var entry = PILL.width[shown];
      if (!entry) fail("no pill contract entry for state label \"" + shown + "\"");
      return entry;
    }

    // Pure geometry. `pill`, `label` and `dot` are the current `mxGeometry` values; `sized` is the
    // shared contract entry for the new label. The pill's right edge is preserved, so a generated
    // pill lands exactly back on the coordinates the generator emitted.
    function pillGeometry(pill, label, dot, sized) {
      if (!pill || !label) fail("state pill is missing its container or label cell");
      if (!sized || !(isFinite(sized.pill) && sized.pill > 0)
        || !(isFinite(sized.label) && sized.label > 0)) {
        fail("no pill contract entry available for the state pill");
      }
      var labelX = PILL.textX;
      if (dot && labelX - (dot.x + dot.width) < PILL_GAP_MIN) {
        fail("state pill dot leaves " + (labelX - (dot.x + dot.width)) + "px before the label");
      }
      var tail = sized.pill - labelX - sized.label;
      if (tail < PILL_TAIL_MIN) fail("pill contract leaves " + tail + "px of trailing pad");
      return {
        pill: { x: pill.x + pill.width - sized.pill, width: sized.pill },
        label: { x: labelX, width: sized.label },
        tail: tail,
      };
    }

    function geometryOf(model, cell) {
      var geometry = model.getGeometry ? model.getGeometry(cell) : cell.geometry;
      return geometry || null;
    }

    // Every write below is *planned* before any of it is applied. A plan entry is a plain
    // description of one model write; producing one never touches the model, so every validation
    // failure happens while the model is still untouched. See writeDrawio for why that matters.
    function geometryOp(model, cell, next) {
      var geometry = geometryOf(model, cell);
      if (!geometry) fail("cell " + cell.id + " has no geometry");
      // mxGraphModel.setGeometry compares by reference, so writing an identical clone still records
      // an undoable edit and dirties the file. A no-op has to stay a no-op.
      if ((next.x == null || geometry.x === next.x)
        && (next.width == null || geometry.width === next.width)) return null;
      var updated = typeof geometry.clone === "function" ? geometry.clone() : {
        x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
      };
      if (next.x != null) updated.x = next.x;
      if (next.width != null) updated.width = next.width;
      return { kind: "geometry", cell: cell, geometry: updated };
    }

    function styleOp(cell, style) {
      if (sameStyle(cell.style, style)) return null;
      return { kind: "style", cell: cell, style: style };
    }

    function valueOp(cell, attributes) {
      var names = Object.keys(attributes);
      // A write that would restore identical values is skipped: mxGraphModel.setValue compares by
      // reference, so re-writing a cloned node records an undoable edit and marks the file dirty
      // even when nothing actually changed.
      if (!names.some(function (name) { return attr(cell.value, name) !== String(attributes[name]); })) {
        return null;
      }
      var value = cell.value.cloneNode(true);
      names.forEach(function (name) { value.setAttribute(name, attributes[name]); });
      return { kind: "value", cell: cell, value: value };
    }

    function applyOp(model, op) {
      if (op.kind === "value") {
        if (model.setValue) model.setValue(op.cell, op.value); else op.cell.value = op.value;
      } else if (op.kind === "style") {
        if (model.setStyle) model.setStyle(op.cell, op.style); else op.cell.style = op.style;
      } else if (model.setGeometry) {
        model.setGeometry(op.cell, op.geometry);
      } else {
        op.cell.geometry = op.geometry;
      }
    }

    function planPill(model, pill, shown, token) {
      var dot = null;
      var label = null;
      Object.keys(model.cells || {}).forEach(function (key) {
        var child = model.cells[key];
        if (child.parent !== pill) return;
        var part = attr(child.value, "ahmPart");
        if (part === "state-dot") dot = child;
        else if (part === "state-label") label = child;
      });
      var ops = [];
      if (dot) ops.push(styleOp(dot, replaceStyle(dot.style, "fillColor", token.dot)));
      if (!label || !label.value || !label.value.cloneNode) {
        fail("state pill " + pill.id + " has no state-label child to write");
      }
      ops.push(valueOp(label, { label: shown }));

      // The label cell must be the one the contract was derived for. A different font size means the
      // shared width no longer describes what will be painted, so it is reported, never assumed.
      var fontSize = Number(styleValue(label.style, "fontSize"));
      var fontFamily = styleValue(label.style, "fontFamily");
      if (!(fontSize > 0) || !fontFamily) fail("state label carries no font style");
      if (fontSize !== PILL.fontSize) {
        fail("state label font size " + fontSize + " is not the pill contract's " + PILL.fontSize);
      }
      var next = pillGeometry(
        geometryOf(model, pill), geometryOf(model, label), dot && geometryOf(model, dot),
        sizedPill(shown),
      );
      ops.push(geometryOp(model, pill, next.pill));
      ops.push(geometryOp(model, label, next.label));
      return ops;
    }

    function attr(value, name) {
      return value && typeof value.getAttribute === "function" ? value.getAttribute(name) : null;
    }

    // ---------------------------------------------------------------- change classification
    //
    // Everything below is read off the objects the bundled Draw.io build actually dispatches, probed
    // against `js/app.min.js` before it was relied on:
    //
    //   mxEvent.END_UPDATE  -> property {edit}; fired at every nesting level, and at the outermost
    //                          one (updateLevel 0, endingUpdate true) the edit *is* model.currentEdit
    //                          and Draw.io has not yet decided whether to record it
    //   mxEvent.BEFORE_UNDO -> property {edit}; the edit *is* model.currentEdit, but the history
    //                          gate has already been passed
    //   mxEvent.CHANGE      -> properties {edit, changes}; the edit is already swapped out
    //   edit keys       ["source","changes","significant","notify"] and, once replayed,
    //                   "undone" / "redone"
    //   file load       edit.changes = [mxRootChange, mxRootChange]      (the model was replaced)
    //   data edit       edit.changes = [mxValueChange]   keys model/cell/value/previous
    //   card move       edit.changes = [mxGeometryChange] keys model/cell/geometry/previous
    //   undo / redo     dispatch CHANGE only — no END_UPDATE, no BEFORE_UNDO, no UNDO
    //   view change     dispatches no model event at all
    //
    // A replay carries the same changes the rollup would recompute, so recomputing over it is what
    // made Undo/Redo never settle. Because Undo and Redo never reach END_UPDATE at all, the hook
    // below is replay-immune by construction. A root change is a file load, not an edit.

    // The attributes the rollup reads. A value change that leaves all of them alone (a renamed
    // label, an edited tooltip) carries no health meaning.
    var HEALTH_ATTRIBUTES = [
      "ahmRole", "ahmId", "ahmLocalState", "ahmComputedState", "ahmImpact",
      "ahmAggregation", "ahmAuthoredState", "ahmOwner", "ahmState",
    ];

    function healthValueChanged(change) {
      var cell = change.cell;
      if (!cell) return false;
      if (!attr(change.value, "ahmRole") && !attr(change.previous, "ahmRole")) return false;
      return HEALTH_ATTRIBUTES.some(function (name) {
        return attr(change.value, name) !== attr(change.previous, name);
      });
    }

    function isChange(change, name) {
      return typeof root[name] === "function" && change instanceof root[name];
    }

    function relevantEdit(edit) {
      if (!edit || !edit.changes || !edit.changes.length) return false;
      // Undo and Redo replay the very changes a recalculation would produce.
      if (edit.undone || edit.redone) return false;
      var relevant = false;
      for (var index = 0; index < edit.changes.length; index++) {
        var change = edit.changes[index];
        // The whole root was swapped: a file load or a page switch, never a user edit.
        if (isChange(change, "mxRootChange")) return false;
        if (isChange(change, "mxValueChange")) {
          if (healthValueChanged(change)) relevant = true;
        } else if (isChange(change, "mxChildChange")) {
          if (attr(change.child && change.child.value, "ahmRole")) relevant = true;
        } else if (isChange(change, "mxTerminalChange")) {
          if (attr(change.cell && change.cell.value, "ahmRole")) relevant = true;
        }
        // mxStyleChange and mxGeometryChange carry no health meaning: a recolour or a card move
        // must never schedule a recalculation.
      }
      return relevant;
    }

    function readDrawio(graph) {
      var model = graph.getModel();
      var cells = [];
      Object.keys(model.cells || {}).forEach(function (key) {
        var cell = model.cells[key];
        var role = attr(cell.value, "ahmRole");
        if (!role) return;
        cells.push({
          id: String(cell.id),
          role: role,
          ahmId: attr(cell.value, "ahmId"),
          localState: attr(cell.value, "ahmLocalState"),
          computedState: attr(cell.value, "ahmComputedState"),
          impact: attr(cell.value, "ahmImpact"),
          aggregation: attr(cell.value, "ahmAggregation"),
          authoredState: attr(cell.value, "ahmAuthoredState"),
          owner: attr(cell.value, "ahmOwner"),
          state: attr(cell.value, "ahmState"),
          edgeImpact: role === "dependency" ? attr(cell.value, "ahmImpact") : null,
          source: cell.source && String(cell.source.id),
          target: cell.target && String(cell.target.id),
          style: cell.style || "",
        });
      });
      return { cells: cells };
    }

    function planWrites(model, next) {
      var plan = [];
      next.cells.forEach(function (data) {
        var cell = model.getCell ? model.getCell(data.id) : model.cells[data.id];
        if (!cell) return;
        var ops = [];
        if (data.role === "entity") {
          var authored = attr(cell.value, "ahmAuthoredState");
          var shown = presented(data.computedState, authored);
          var token = TOKENS[shown];
          if (!token) fail("entity " + data.id + " presents unsupported state \"" + shown + "\"");
          ops.push(valueOp(cell, {
            ahmLocalState: data.localState,
            ahmComputedState: data.computedState,
            ahmImpact: data.impact,
          }));
          var pills = 0;
          Object.keys(model.cells || {}).forEach(function (key) {
            var partCell = model.cells[key];
            if (partCell.parent !== cell) return;
            if (attr(partCell.value, "ahmPart") !== "state") return;
            pills++;
            ops.push(styleOp(partCell, replaceStyle(partCell.style, "strokeColor", token.stroke)));
            planPill(model, partCell, shown, token).forEach(function (op) { ops.push(op); });
          });
          if (!pills) fail("entity " + data.id + " has no state pill to write");
        }
        if (data.role === "dependency" && data.edgeImpact) {
          ops.push(valueOp(cell, { ahmImpact: data.edgeImpact }));
        }
        ops.push(styleOp(cell, data.style));
        plan.push({ id: data.id, ops: ops.filter(Boolean) });
      });
      return plan;
    }

    function applyWrites(model, plan) {
      var changed = 0;
      plan.forEach(function (group) {
        if (!group.ops.length) return;
        group.ops.forEach(function (op) { applyOp(model, op); });
        changed++;
      });
      return changed;
    }

    // mxGraph has no transaction rollback: `mxGraphModel.endUpdate` commits `currentEdit` as soon as
    // `!currentEdit.isEmpty()` holds (`app.min.js` @481771). The rollup runs inside the *user's*
    // still-open transaction, so a failure — raised before the derived write or part-way through it
    // — takes the **whole** originating transaction back, not just the changes this plugin
    // appended: every change in the edit is re-executed in reverse (`mxChange.execute()` is its own
    // inverse) and the edit is emptied, so Draw.io's own history gate finds nothing and records
    // nothing.
    //
    // This is a narrow *pre-commit* exception. `model.currentEdit` has not been handed to
    // `mxUndoManager` yet, so nothing already recorded is mutated; `undoManager.history[...]` stays
    // untouched.
    function revertTransaction(edit, floor) {
      if (!edit || !edit.changes) return;
      for (var index = edit.changes.length - 1; index >= floor; index--) {
        var change = edit.changes[index];
        if (change && typeof change.execute === "function") change.execute();
      }
      edit.changes.length = floor;
    }

    function writeDrawio(graph, next) {
      var model = graph.getModel();
      var changed = 0;
      model.beginUpdate();
      try {
        // Planned in full first: a malformed model fails here, with nothing written yet.
        changed = applyWrites(model, planWrites(model, next));
      } finally {
        model.endUpdate();
      }
      return changed;
    }

    // ---------------------------------------------------------------- host compatibility guard
    //
    // Every rollback in this plugin rests on two facts about the *bundled* mxGraph build that no
    // documented API promises: `model.endingUpdate === true` at the outermost `END_UPDATE`, and
    // Draw.io's own `!currentEdit.isEmpty()` history gate running **after** that dispatch. On a host
    // where either moves, appending derived changes to the user's edit and emptying it on failure is
    // no longer safe, so nothing may be written at all.
    //
    // The check is behavioural, never a source or version comparison: `app.min.js` is minified, so a
    // source-shape check would falsely reject a re-minified but behaviourally identical build. It has
    // two halves.
    //
    //   (1) four read-only identity checks against the *active* model, because an isolated probe
    //       cannot see a host that subclasses or per-instance patches only the live document;
    //   (2) one isolated behavioural probe on a throwaway `new mxGraphModel()` — measured to run the
    //       same implementation as the user's document and to dispatch nothing on it — carrying its
    //       own positive control: a second transaction with the emptying handler **disarmed**, which
    //       must commit. Without that control a host that never records anything would pass, because
    //       "the edit vanished" is also what a host that records nothing looks like.
    function makeProbeModel(root) {
      return new root.mxGraphModel();
    }

    function probeHost(root, active) {
      var reasons = [];
      var seen = {};
      try {
        if (typeof root.mxGraphModel !== "function") reasons.push("mxGraphModel-missing");
        if (!root.mxEvent || !root.mxEvent.END_UPDATE) reasons.push("mxEvent-missing");
        if (!active) reasons.push("model-missing");
        if (reasons.length) return { compatible: false, reasons: reasons, seen: seen };
        // (1) the active document, read-only: no call, no write, no listener.
        if (Object.getPrototypeOf(active) !== root.mxGraphModel.prototype) reasons.push("model-not-stock");
        if (active.endUpdate !== root.mxGraphModel.prototype.endUpdate) reasons.push("endUpdate-patched");
        if (typeof active.endingUpdate !== "boolean") reasons.push("endingUpdate-not-boolean");
        if (!Array.isArray(active.currentEdit && active.currentEdit.changes)) reasons.push("currentEdit-no-changes");
        // (2) the isolated behavioural probe, on a model the user's document never sees.
        var probe = makeProbeModel(root);
        var tape = [];
        var armed = true;
        probe.addListener(root.mxEvent.BEFORE_UNDO, function () { tape.push("BEFORE_UNDO"); });
        probe.addListener(root.mxEvent.UNDO, function () { tape.push("UNDO"); });
        probe.addListener(root.mxEvent.CHANGE, function () { tape.push("CHANGE"); });
        probe.addListener(root.mxEvent.END_UPDATE, function (sender, event) {
          if (!armed || probe.updateLevel !== 0 || probe.endingUpdate !== true) return;
          var probeEdit = event && event.getProperty && event.getProperty("edit");
          seen.editIsCurrentEdit = probeEdit === probe.currentEdit;
          seen.changesIsArray = Array.isArray(probeEdit && probeEdit.changes);
          seen.changeCount = ((probeEdit && probeEdit.changes) || []).length;
          seen.changeHasExecute = !!(probeEdit && probeEdit.changes && probeEdit.changes[0]
            && typeof probeEdit.changes[0].execute === "function");
          if (!seen.changesIsArray || !seen.changeCount || !seen.changeHasExecute) return;
          revertTransaction(probeEdit, 0);
          seen.emptied = true;
        });
        var cell = probe.getRoot().getChildAt(0);
        var before = probe.getValue(cell);
        probe.beginUpdate();
        try { probe.setValue(cell, "ahm-probe"); } finally { probe.endUpdate(); }
        seen.rolledBackTape = tape.slice();
        seen.valueRestored = probe.getValue(cell) === before;
        seen.currentEditAfter = probe.currentEdit.changes.length;
        // The positive control: the same model, the handler disarmed, and the transaction must now
        // reach BEFORE_UNDO and UNDO. A probe without it passes vacuously.
        armed = false;
        tape.length = 0;
        probe.beginUpdate();
        try { probe.setValue(cell, "ahm-probe-control"); } finally { probe.endUpdate(); }
        seen.controlTape = tape.slice();

        if (seen.emptied !== true) reasons.push("outer-end-update-not-observed");
        if (seen.editIsCurrentEdit !== true) reasons.push("end-update-edit-is-not-currentEdit");
        if (seen.valueRestored !== true) reasons.push("change-not-invertible");
        if (seen.rolledBackTape.length !== 0) reasons.push("gate-runs-before-end-update");
        if (seen.currentEditAfter !== 0) reasons.push("currentEdit-not-emptied");
        if (seen.controlTape.indexOf("BEFORE_UNDO") < 0 || seen.controlTape.indexOf("UNDO") < 0) {
          reasons.push("positive-control-did-not-commit");
        }
      } catch (error) {
        reasons.push("probe-threw:" + String((error && error.message) || error));
      }
      return { compatible: reasons.length === 0, reasons: reasons, seen: seen };
    }

    // Named in the message, never used as the gate.
    var SUPPORTED_RUNTIME = "Draw.io Integration 1.9.0 (bundled draw.io webapp)";
    var INCOMPATIBLE_MESSAGE = "AHM Health Model: this Draw.io runtime does not support the "
      + "transaction semantics the health rollup needs, so automatic recalculation and every "
      + "AHM Health Model change have been disabled to protect your document. Supported runtime: "
      + SUPPORTED_RUNTIME + ". Validate still works. Reasons: ";

    // Appended to the original validation text on every rolled-back transaction. A rollback takes
    // back the *whole* originating transaction, so a user whose card move and state change were one
    // operation has to be told the move went back too.
    var ROLLBACK_NOTE = "The entire edit was rolled back, including other changes in the same transaction.";

    function rollbackError(error) {
      var original = String((error && error.message) || error);
      var wrapped = new Error(original + ". " + ROLLBACK_NOTE);
      wrapped.ahmOriginal = original;
      return wrapped;
    }

    // One editor instance may be handed to `install()` more than once — plugin bootstrap re-runs on
    // reload, and VSIX packaging is expected to call it again. The marker is namespaced so it
    // cannot collide with Draw.io's or another plugin's own properties, and a second call is a
    // no-op that hands back the first call's API.
    var INSTALL_KEY = "ahmHealthModel$installed$v1";

    function install(ui) {
      var already = ui[INSTALL_KEY];
      if (already) return already;
      var actions = ui.actions;
      var guarded = false;
      // Two flags with disjoint meanings. `operationInFlight` is true for **any** installed
      // operation — read-only or mutating — and is the re-entry gate; `guarded` is true only for a
      // transaction this plugin owns, and is what lets the model hook recognise the plugin's own
      // closing re-entry by provenance instead of by timing (`D-C18-5`, `D-C20-5`).
      var operationInFlight = false;
      // Read by the runtime proofs: how often the model hook fired, how often it decided the edit
      // was relevant, how often a recalculation actually ran, how often one was *blocked* because
      // another operation was still in flight, and how often the plugin suppressed its own expected
      // re-entry. The last two are deliberately separate counters. `blockedReentries` is counted at
      // the operation gate and only ever reaches it from outside this plugin's own hook, so it means
      // exactly what it says; `selfSuppressed` is counted at the hook, where the re-entry is
      // provably the plugin's own closing transaction.
      var stats = {
        hooks: 0, relevant: 0, recalculations: 0, blockedReentries: 0, selfSuppressed: 0,
      };
      if (root.mxResources && typeof root.mxResources.parse === "function") {
        root.mxResources.parse([
          "ahmHealthModel=AHM Health Model",
          "ahmSetHealthy=Set Healthy",
          "ahmSetDegraded=Set Degraded",
          "ahmSetUnhealthy=Set Unhealthy",
          "ahmSetUnknown=Set Unknown",
          "ahmImpactStandard=Impact: Standard",
          "ahmImpactLimited=Impact: Limited",
          "ahmImpactSuppressed=Impact: Suppressed",
          "ahmRecalculate=Recalculate",
          "ahmValidate=Validate",
        ].join("\n"));
      }
      function report(error) {
        if (ui.handleError) ui.handleError(error);
        else throw error;
      }
      // The Draw.io host is the only path that mutates a live mxGraphModel, so it is the only path
      // the guard applies to; the plain adapter carries its own diagram object and no transaction.
      var drawioHost = !ui.diagram;
      var compatibility = drawioHost
        ? probeHost(root, ui.editor && ui.editor.graph && ui.editor.graph.getModel())
        : { compatible: true, reasons: [], seen: {} };
      var disabled = !compatibility.compatible;
      if (disabled) report(new Error(INCOMPATIBLE_MESSAGE + compatibility.reasons.join(", ")));
      function selectedId() {
        if (ui.diagram) return ui.selectedId;
        var cell = ui.editor.graph.getSelectionCell();
        return cell && (attr(cell.value, "ahmId") || cell.id);
      }
      function runPlain(operation) {
        try { operation(ui.diagram); } catch (error) { report(error); }
      }
      // `ahmValidate` writes nothing on **any** host: it reads a snapshot, reports what is wrong
      // with it, and never opens a transaction. That is why it keeps working on a host the guard
      // rejected — the user still gets their findings, they just get no automatic repair — and it
      // is also why a compatible host must reach this path too. Routing it through `runDrawio`
      // instead made validate silently *repair* a stale derived style, adding an undo entry and a
      // dirty flag to a read-only command (measured as `P-C18-2`).
      function runReadOnly(operation) {
        try { operation(readDrawio(ui.editor.graph)); } catch (error) { report(error); }
      }
      function runDrawio(operation) {
        guarded = true;
        stats.recalculations++;
        var graph = ui.editor.graph;
        var model = graph.getModel();
        // The transaction the failure has to take back. On the hook path this is the user's own
        // still-open edit; on the action path it is empty, so the same rollback is exactly the
        // plugin's own transaction.
        var edit = model.currentEdit;
        model.beginUpdate();
        try {
          var snapshot = readDrawio(graph);
          operation(snapshot);
          writeDrawio(graph, snapshot);
        } catch (error) {
          // Before `endUpdate`, so a rolled-back transaction never reaches Draw.io's history gate.
          revertTransaction(edit, 0);
          report(rollbackError(error));
        } finally {
          model.endUpdate();
          guarded = false;
        }
      }
      function route(operation, readOnly) {
        // Read-only next, and deliberately before `disabled`: a read-only operation is safe on
        // every host, so the routing is a property of the operation, not of the verdict.
        if (readOnly) return runReadOnly(operation);
        if (disabled) return undefined;
        return runDrawio(operation);
      }
      function run(operation, readOnly) {
        // The gate is an *operation* gate, tested above every routing decision — including the
        // plain-adapter route, which C-20 left above it. `if (ui.diagram) return runPlain(operation);`
        // stood here and returned before the gate was ever reached, so a nested action fired from
        // the adapter's `ui.handleError` ran a second full calculation: depth 2, two messages, four
        // `cells` reads, `blockedReentries 0` (measured as `P-C21-5`/`P-C21-6`). The host is a
        // property of *where* the work runs, the gate a property of *when* the call arrives, so the
        // host choice now happens below the gate, inside the same `try`.
        //
        // Re-entrancy is a property of *when* a call arrives, not of what it asks for, and not of
        // which route the enclosing call took. With the flag armed one level down inside
        // `runDrawio`, a
        // **top-level** `ahmValidate` armed nothing: a nested `ahmValidate` fired from
        // `ui.handleError` while that validation was reporting ran a second full validation — two
        // messages, 288 model reads, `blockedReentries 0` (measured at C-19 inspect, re-traced as
        // `P-C20-9`). A foreign listener firing an AHM action during the plugin's own closing
        // `END_UPDATE` window had the same shape one correction earlier.
        //
        // Everything that reaches this line while an operation is in flight came from outside the
        // plugin's own hook — a foreign listener firing an AHM action, an error sink re-entering, or
        // a nested action — so this counter means exactly "a genuine external attempt was blocked".
        // The plugin's *own* expected re-entry is stopped one level earlier, at the hook, where its
        // provenance is certain and it is counted as `selfSuppressed`; a `closing` flag around
        // `model.endUpdate()` was measured and rejected, because a foreign listener firing during
        // that same dispatch is indistinguishable by timing alone (`D-C18-5`). A rolled-back action
        // never reaches either: the edit is empty by then, so the hook's relevance filter returns
        // first.
        if (operationInFlight) { stats.blockedReentries++; return undefined; }
        operationInFlight = true;
        try {
          return ui.diagram ? runPlain(operation) : route(operation, readOnly);
        } finally {
          // `report` re-throws when a host carries no `handleError`, so a top-level validate on a
          // defective model leaves through this frame. Releasing anywhere but in a `finally` would
          // wedge every later action behind one failed operation (`NC-65` clause (iv)).
          operationInFlight = false;
        }
      }
      STATES.forEach(function (state) {
        actions.addAction("ahmSet" + state, function () {
          run(function (diagram) { setHealth(diagram, selectedId(), state); });
        });
      });
      IMPACTS.forEach(function (impact) {
        var name = impact.charAt(0).toUpperCase() + impact.slice(1);
        actions.addAction("ahmImpact" + name, function () {
          run(function (diagram) { setImpact(diagram, selectedId(), impact); });
        });
      });
      actions.addAction("ahmRecalculate", function () { run(recalculate); });
      actions.addAction("ahmValidate", function () { run(validate, true); });

      if (ui.menus) {
        var healthMenu = function (menu, parent) {
          ui.menus.addMenuItems(menu, [
            "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown", "-",
            "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed", "-",
            "ahmRecalculate", "ahmValidate",
          ], parent);
        };
        if (typeof ui.menus.put === "function" && typeof root.Menu === "function") {
          ui.menus.put("ahmHealthModel", new root.Menu(healthMenu));
        } else if (typeof ui.menus.addMenu === "function") {
          ui.menus.addMenu("ahmHealthModel", healthMenu);
        }
        var attachToExtras = function () {
          var extras = ui.menus.get && ui.menus.get("extras");
          if (extras && extras.funct && !extras.ahmHealthModelAttached) {
            var previous = extras.funct;
            extras.funct = function (menu, parent) {
              previous.apply(this, arguments);
              ui.menus.addSubmenu("ahmHealthModel", menu, parent);
            };
            extras.ahmHealthModelAttached = true;
          }
        };
        attachToExtras();
        if (root.setTimeout) {
          root.setTimeout(attachToExtras, 0);
          root.setTimeout(attachToExtras, 500);
        }
      }
      if (!disabled && !ui.diagram && root.mxEvent && ui.editor.graph.getModel().addListener) {
        // The rollup joins the transaction that caused it instead of opening one of its own, and it
        // joins it at the last moment before Draw.io decides whether that transaction exists at
        // all. `mxGraphModel.endUpdate` fires END_UPDATE, *then* asks `!currentEdit.isEmpty()`, and
        // only then creates the undo entry, repaints and records (`app.min.js` @481771). So every
        // derived mxValueChange / mxStyleChange / mxGeometryChange written here is appended to the
        // originating edit — one user operation is one undo entry, `mxGraph` repaints once from the
        // single CHANGE dispatch that follows, and no card's local state and rolled-up state ever
        // disagree in a painted frame — and a failed transaction can still be emptied before the
        // gate, leaving no entry, no `modified`, no dispatch and no byte.
        //
        // The alternatives were measured, not argued away. BEFORE_UNDO runs *after* the gate: a
        // rollback there restores the model and the bytes but still records a phantom empty undo
        // entry, and `edit.ignoreEdit` clears only the dirty flag, never the entry. Recalculating
        // from mxEvent.CHANGE leaves the derived changes dangling in `currentEdit` and welds them
        // onto the next unrelated transaction. Merging into an already-recorded `mxUndoManager`
        // entry has no API that is not private array mutation.
        var hooked = ui.editor.graph.getModel();
        hooked.addListener(root.mxEvent.END_UPDATE, function (sender, event) {
          // Nested `endUpdate()` calls fire END_UPDATE too — including the plugin's own, issued
          // from inside this handler — so only the outermost closing transaction is a user edit.
          if (hooked.updateLevel !== 0 || hooked.endingUpdate !== true) return;
          stats.hooks++;
          if (!relevantEdit(event && event.getProperty && event.getProperty("edit"))) return;
          stats.relevant++;
          // On every *successful* action the plugin's own closing transaction re-enters this hook,
          // because `guarded` is released only after `model.endUpdate()` has finished dispatching.
          // Suppressing that is what stops the rollup from recomputing its own output. It is
          // counted here rather than at the guard: this call site is the plugin's own, so the
          // suppression is attributable by provenance instead of by timing.
          if (guarded) { stats.selfSuppressed++; return; }
          run(recalculate);
        });
      }
      // One installation owns one API, one counter set and one model hook: two editors served by
      // the same `factory()` must not share `stats`, an API object or each other's registration.
      // The guard's verdict rides along so a caller can read it without re-running the probe.
      var installed = { stats: stats, INSTALL_KEY: INSTALL_KEY, compatibility: compatibility, disabled: disabled };
      Object.keys(api).forEach(function (key) {
        if (!(key in installed)) installed[key] = api[key];
      });
      ui[INSTALL_KEY] = installed;
      return installed;
    }

    var api = {
      STATES: STATES,
      IMPACTS: IMPACTS,
      TOKENS: TOKENS,
      validate: validate,
      worstOf: worstOf,
      rollup: rollup,
      presented: presented,
      contribution: contribution,
      recalculate: recalculate,
      setHealth: setHealth,
      setImpact: setImpact,
      install: install,
      probeHost: probeHost,
      // The user-facing wording, exported so `drawio/README.md` and the asserted literals are
      // compared against one string instead of three copies.
      ROLLBACK_NOTE: ROLLBACK_NOTE,
      SUPPORTED_RUNTIME: SUPPORTED_RUNTIME,
      INCOMPATIBLE_MESSAGE: INCOMPATIBLE_MESSAGE,
      readDrawio: readDrawio,
      writeDrawio: writeDrawio,
      // Pill geometry and the contract it reads, exposed so the arithmetic and the shared numbers
      // can be pinned in Node; the criterion itself is proved in the live Draw.io runtime.
      pillGeometry: pillGeometry,
      sizedPill: sizedPill,
      PILL: PILL,
      // Change classification, exposed so the Undo/Redo and load filters can be pinned against
      // synthetic edits as well as observed in the runtime.
      relevantEdit: relevantEdit,
      sameStyle: sameStyle,
      PILL_TAIL_MIN: PILL_TAIL_MIN,
      PILL_GAP_MIN: PILL_GAP_MIN,
    };
    return api;
  }

  root.AhmHealthPluginFactory = factory;
  if (root.Draw && typeof root.Draw.loadPlugin === "function") {
    root.Draw.loadPlugin(function (ui) { factory().install(ui); });
  }
}(typeof globalThis !== "undefined" ? globalThis : this));
