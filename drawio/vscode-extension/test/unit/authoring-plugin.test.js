// Authoring plugin unit tests (C-23.5, V-06 re-ID logic).
// The plugin source is evaluated in a node:vm context holding minimal mxGraph stand-ins,
// then its CELLS_ADDED listener is fired with real duplicate-id input.
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("vm");
const fs = require("fs");
const path = require("path");

function makeElement(tag) {
  var attrs = {};
  return {
    tagName: tag,
    setAttribute: function (k, v) { attrs[k] = String(v); },
    getAttribute: function (k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    cloneNode: function () {
      var clone = makeElement(tag);
      Object.keys(attrs).forEach(function (k) { clone.setAttribute(k, attrs[k]); });
      return clone;
    }
  };
}

function loadAuthoringPlugin() {
  var code = fs.readFileSync(path.join(__dirname, "..", "..", "plugin-src", "ahm-authoring.js"), "utf8");
  var context = {
    mxEvent: { CELLS_ADDED: "cellsAdded", CELL_CONNECTED: "cellConnected" },
    mxUtils: { createXmlDocument: function () { return { createElement: makeElement }; } },
    mxResources: { parse: function () {} }
  };
  vm.runInNewContext(code, context);
  return context.AhmAuthoringPluginFactory;
}

function cell(id, attributes, children) {
  var value = makeElement("object");
  Object.keys(attributes).forEach(function (k) { value.setAttribute(k, attributes[k]); });
  return { id: id, value: value, children: children || [] };
}

// Minimal mxGraph stand-in: only the surface the authoring plugin actually uses.
function makeUi(cells) {
  var listeners = {};
  var byId = {};
  (function index(list) {
    list.forEach(function (c) { byId[c.id] = c; index(c.children); });
  }(cells));

  var transactions = 0;
  var openTransactions = 0;
  var model = {
    cells: byId,
    beginUpdate: function () { openTransactions++; if (openTransactions === 1) transactions++; },
    endUpdate: function () { openTransactions--; },
    setValue: function (c, value) { c.value = value; },
    getChildCount: function (c) { return c.children ? c.children.length : 0; },
    getChildAt: function (c, i) { return c.children[i]; },
    getParent: function () { return null; },
    getTerminal: function () { return null; }
  };
  var graph = {
    getModel: function () { return model; },
    getDefaultParent: function () { return { id: "1", children: cells }; },
    getSelectionCell: function () { return null; },
    getSelectionCells: function () { return []; },
    addListener: function (event, fn) { (listeners[event] = listeners[event] || []).push(fn); },
    insertVertex: function () { return null; },
    insertEdge: function () { return null; }
  };
  var actions = {};
  var ui = {
    editor: { graph: graph },
    actions: { addAction: function (name, fn) { actions[name] = fn; }, get: function (n) { return actions[n]; } }
  };
  return {
    ui: ui,
    actions: actions,
    fire: function (event, props) {
      (listeners[event] || []).forEach(function (fn) {
        fn(graph, { getProperty: function (name) { return props[name]; } });
      });
    },
    transactionCount: function () { return transactions; }
  };
}

function ahm(c, name) { return c.value.getAttribute(name); }

describe("ahm-authoring plugin", function () {
  it("exports AhmAuthoringPluginFactory", function () {
    assert.equal(typeof loadAuthoringPlugin(), "function");
  });

  // Each library drag-drop is one CELLS_ADDED event, which is how the live harness exercises V-06.
  it("re-IDs entities that share the library template's hardcoded ahmId", function () {
    var factory = loadAuthoringPlugin();
    var signalA = cell("s1", { ahmRole: "signal", ahmOwner: "entity" });
    var signalB = cell("s2", { ahmRole: "signal", ahmOwner: "entity" });
    var entityA = cell("e1", { ahmRole: "entity", ahmId: "entity" }, [signalA]);
    var entityB = cell("e2", { ahmRole: "entity", ahmId: "entity" }, [signalB]);
    var harness = makeUi([entityA, entityB]);

    factory(harness.ui);
    harness.fire("cellsAdded", { cells: [entityA] });
    harness.fire("cellsAdded", { cells: [entityB] });

    var idA = ahm(entityA, "ahmId");
    var idB = ahm(entityB, "ahmId");
    assert.ok(idA && idB, "both entities keep an ahmId");
    assert.notEqual(idA, "entity", "template ahmId survived insertion");
    assert.notEqual(idA, idB, "duplicate template ahmId was not made unique: " + idA + " / " + idB);
    assert.equal(ahm(signalA, "ahmOwner"), idA, "descendant signal still points at a stale owner");
    assert.equal(ahm(signalB, "ahmOwner"), idB, "descendant signal still points at a stale owner");
    assert.equal(harness.transactionCount(), 2, "each insertion must be exactly one model transaction");
  });

  it("leaves an entity already present in the model untouched", function () {
    var factory = loadAuthoringPlugin();
    var existing = cell("e0", { ahmRole: "entity", ahmId: "ahm-existing" });
    var added = cell("e1", { ahmRole: "entity", ahmId: "ahm-existing" });
    var harness = makeUi([existing, added]);

    factory(harness.ui);
    harness.fire("cellsAdded", { cells: [added] });

    assert.equal(ahm(existing, "ahmId"), "ahm-existing", "pre-existing entity was re-IDed");
    assert.notEqual(ahm(added, "ahmId"), "ahm-existing", "colliding new entity kept the duplicate id");
  });

  it("does not touch cells that are not AHM entities", function () {
    var factory = loadAuthoringPlugin();
    var plain = cell("r1", { label: "Box" });
    var harness = makeUi([plain]);

    factory(harness.ui);
    harness.fire("cellsAdded", { cells: [plain] });

    assert.equal(ahm(plain, "ahmId"), null);
  });

  it("registers the authoring actions on the host ui", function () {
    var factory = loadAuthoringPlugin();
    var harness = makeUi([]);
    factory(harness.ui);
    assert.deepEqual(Object.keys(harness.actions).sort(), ["ahmAddSignal", "ahmConnectSelection"]);
  });
});
