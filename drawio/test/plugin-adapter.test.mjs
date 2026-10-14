import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { getTheme } from "../../src/themes.mjs";
import { PILL, PRESENTED_LABELS } from "../scripts/generate-artifacts.mjs";
import { ablatePlugin } from "../visual/render-native.mjs";
import { diagramFromModel, readDrawioSvg } from "./helpers/artifact.mjs";
import { PLUGIN_FILE, dependency, entity, loadPlugin, model } from "./helpers/plugin.mjs";

test("registered state actions persist every valid local and computed value", () => {
  const plugin = loadPlugin();
  for (const state of plugin.STATES) {
    const diagram = model([entity("selected"), entity("untouched", "Degraded")]);
    const actions = {};
    const ui = {
      diagram,
      selectedId: "selected",
      actions: { addAction(name, action) { actions[name] = action; } },
      menus: { addMenu() {}, get() { return { funct() {} }; } },
    };
    plugin.install(ui);
    actions[`ahmSet${state}`]();
    const selected = diagram.cells.find((cell) => cell.ahmId === "selected");
    const untouched = diagram.cells.find((cell) => cell.ahmId === "untouched");
    assert.equal(selected.localState, state);
    assert.equal(selected.computedState, state);
    assert.match(selected.style, new RegExp(plugin.TOKENS[state].fill.slice(1), "i"));
    assert.equal(untouched.localState, "Degraded");
  }
});

test("state action rejects wrong input without changing the saved model", () => {
  const plugin = loadPlugin();
  const diagram = model([entity("selected")]);
  const before = structuredClone(diagram);
  assert.throws(() => plugin.setHealth(diagram, "selected", "Standby"), /invalid state.*Standby/i);
  assert.deepEqual(diagram, before);
});

test("EARS-09 one action updates a four-level multi-parent DAG and converges", () => {
  const plugin = loadPlugin();
  const diagram = model([
    entity("leaf"),
    entity("branch-a"),
    entity("branch-b"),
    entity("middle"),
    entity("root"),
    dependency("leaf-a", "leaf", "branch-a"),
    dependency("leaf-b", "leaf", "branch-b"),
    dependency("a-middle", "branch-a", "middle"),
    dependency("b-middle", "branch-b", "middle"),
    dependency("middle-root", "middle", "root"),
  ]);
  const result = plugin.setHealth(diagram, "leaf", "Unhealthy");
  assert.ok(result.changes >= 5);
  assert.deepEqual(
    diagram.cells.filter((cell) => cell.role === "entity").map((cell) => [cell.ahmId, cell.computedState]),
    [
      ["leaf", "Unhealthy"],
      ["branch-a", "Unhealthy"],
      ["branch-b", "Unhealthy"],
      ["middle", "Unhealthy"],
      ["root", "Unhealthy"],
    ],
  );
  assert.equal(plugin.recalculate(diagram).changes, 0);
});

test("EARS-10 invalid topology reports involved cells and never mutates", () => {
  const plugin = loadPlugin();
  const duplicate = entity("duplicate-cell");
  duplicate.ahmId = "first";
  const cases = [
    {
      name: "directed cycle",
      cells: [
        entity("a"), entity("b"),
        dependency("a-b", "a", "b"), dependency("b-a", "b", "a"),
      ],
      error: /cycle.*a.*b/i,
    },
    {
      name: "duplicate ahmId",
      cells: [entity("first"), duplicate],
      error: /duplicate ahmId first.*first.*duplicate-cell/i,
    },
    {
      name: "missing endpoint",
      cells: [entity("a"), dependency("missing-edge", "a", "absent")],
      error: /missing-edge.*a->absent/i,
    },
    {
      name: "bad state",
      cells: [{ ...entity("a"), localState: "Standby" }],
      error: /invalid state Standby.*a/i,
    },
    {
      name: "bad impact",
      cells: [{ ...entity("a"), impact: "partial" }],
      error: /invalid impact partial.*a/i,
    },
    {
      name: "unsupported aggregation",
      cells: [{ ...entity("a"), aggregation: "healthyCount" }],
      error: /unsupported aggregation healthyCount.*a/i,
    },
  ];
  for (const fixture of cases) {
    const diagram = model(fixture.cells);
    const before = structuredClone(diagram);
    assert.throws(() => plugin.recalculate(diagram), fixture.error, fixture.name);
    assert.deepEqual(diagram, before, fixture.name);
  }
});

test("EARS-11 a menu action is one atomic undo and redo", () => {
  const plugin = loadPlugin();
  const diagram = model([
    entity("child"),
    entity("parent"),
    dependency("child-parent", "child", "parent"),
  ]);
  const history = [];
  let transactions = 0;
  diagram.beginUpdate = () => { transactions++; };
  diagram.endUpdate = () => {};
  diagram.recordEdit = (before, after) => history.push({ before, after });
  diagram.undo = () => { diagram.cells = structuredClone(history.at(-1).before); };
  diagram.redo = () => { diagram.cells = structuredClone(history.at(-1).after); };

  const before = structuredClone(diagram.cells);
  plugin.setHealth(diagram, "child", "Unhealthy");
  const after = structuredClone(diagram.cells);
  assert.equal(transactions, 1);
  assert.equal(history.length, 1);
  assert.match(after.find((cell) => cell.ahmId === "parent").style, /fillColor=#faeceb/i);

  diagram.undo();
  assert.deepEqual(diagram.cells, before);
  diagram.redo();
  assert.deepEqual(diagram.cells, after);
});

test("plugin state tokens are the portal theme, not a drifting second palette", () => {
  const plugin = loadPlugin();
  const theme = getTheme("portal");
  const expected = {
    Healthy: theme.state.healthy, Degraded: theme.state.degraded,
    Unhealthy: theme.state.unhealthy, Unknown: theme.state.unknown, Standby: theme.state.alt,
  };
  for (const [state, token] of Object.entries(expected)) {
    assert.equal(plugin.TOKENS[state].fill.toLowerCase(), token.fill.toLowerCase(), `${state} fill`);
    assert.equal(plugin.TOKENS[state].stroke.toLowerCase(), token.border.toLowerCase(), `${state} stroke`);
    assert.equal(plugin.TOKENS[state].dot.toLowerCase(), token.dot.toLowerCase(), `${state} dot`);
  }
  assert.deepEqual(Object.keys(plugin.TOKENS).sort(), Object.keys(expected).sort());
});

test("NC-12 recalculating the shipped kitchen-sink never turns authored Unknown/Standby green", () => {
  const plugin = loadPlugin();
  const artifact = readDrawioSvg(resolve(import.meta.dirname, "../examples/kitchen-sink.drawio.svg"));
  const diagram = diagramFromModel(artifact.model);
  const authored = diagram.cells.filter((cell) => cell.role === "entity"
    && ["unknown", "standby"].includes(cell.authoredState)).map((cell) => cell.ahmId);
  assert.deepEqual(authored.sort(), ["account", "auth", "secondary"]);

  const result = plugin.recalculate(diagram);
  const state = (id) => diagram.cells.find((cell) => cell.ahmId === id).computedState;
  assert.equal(state("auth"), "Unknown", "auth has three Healthy signals and must stay Unknown");
  assert.equal(state("account"), "Unknown", "account rolls up a Healthy child and must stay Unknown");
  assert.equal(state("secondary"), "Unknown", "standby is Unknown in the simulator");
  assert.equal(plugin.presented("Unknown", "standby"), "Standby");
  assert.equal(plugin.presented("Unknown", "unknown"), "Unknown");
  assert.equal(state("root"), "Degraded", "the rest of the rollup is unaffected");
  assert.ok(result.changes >= 0);

  // The floor is scoped to an authored declaration: without one, Unknown stays neutral.
  assert.equal(plugin.rollup({ localState: "Unknown" }, ["Healthy"]), "Healthy");
  assert.equal(plugin.rollup({ localState: "Unknown", authoredState: "unknown" }, ["Healthy"]), "Unknown");
  assert.equal(plugin.rollup({ localState: "Unknown", authoredState: "unknown" }, ["Unhealthy"]), "Unhealthy");
  // Wrong input: an authored presentation is not a simulator state and must still be rejected.
  assert.throws(
    () => plugin.recalculate(model([{ ...entity("secondary", "Standby"), authoredState: "standby" }])),
    /invalid state Standby.*secondary/i,
  );
});

// --- NC-32 / NC-35: the pill geometry arithmetic and the shared contract, pinned in Node --------
// The criteria themselves are proved in the live Draw.io runtime (`NC-32`, `NC-35` in
// native-render.test.mjs). This pins the pure arithmetic and the shared numbers, including the
// wrong-input cases, so a regression is named here before it has to be rendered to be seen.

// The geometry every shipped card carries: a 73px Healthy pill, its 10px dot at x=7 and its 37px
// label at x=26 — i.e. a 9px dot-to-text gap and a 10px trailing pad.
const SHIPPED_PILL = { x: 139, y: 60, width: 73, height: 20 };
const SHIPPED_LABEL = { x: 26, y: 0, width: 37, height: 20 };
const SHIPPED_DOT = { x: 7, y: 5, width: 10, height: 10 };

test("NC-35 the plugin's pill contract is the generator's, not a second width table", () => {
  const plugin = loadPlugin();
  // Same pinning pattern as TOKENS against getTheme("portal"): Draw.io loads the plugin as a plain
  // browser script and cannot import the generator, so the values are shipped and asserted equal.
  assert.deepEqual(plugin.PILL.width, PILL.width);
  assert.equal(plugin.PILL.textX, PILL.textX);
  assert.equal(plugin.PILL.tailPad, PILL.tailPad);
  assert.equal(plugin.PILL.fontSize, PILL.fontSize);
  assert.deepEqual(Object.keys(plugin.PILL.width).sort(), [...PRESENTED_LABELS].sort());
  // And the contract is the *generator's* metric, not the runtime's 1px-narrower measurement.
  assert.deepEqual(
    PRESENTED_LABELS.map((label) => plugin.PILL.width[label].pill),
    [73, 83, 84, 81, 76],
  );
  // Every label `presented()` can produce is covered; nothing else is.
  for (const label of PRESENTED_LABELS) assert.ok(plugin.sizedPill(label).pill > 0, label);
  assert.throws(() => plugin.sizedPill("Nope"), /no pill contract entry for state label "Nope"/);
});

test("NC-32 pill geometry keeps the right edge and takes every number from the contract", () => {
  const plugin = loadPlugin();
  const cases = [
    // grows for a wider label, shrinks for a narrower one, right edge fixed at 212 either way
    { name: "Degraded", width: 83, x: 129, labelWidth: 47 },
    { name: "Unhealthy", width: 84, x: 128, labelWidth: 48 },
    { name: "Standby", width: 76, x: 136, labelWidth: 40 },
    { name: "Healthy", width: 73, x: 139, labelWidth: 37 },
  ];
  for (const item of cases) {
    const next = plugin.pillGeometry(
      SHIPPED_PILL, SHIPPED_LABEL, SHIPPED_DOT, plugin.sizedPill(item.name),
    );
    assert.equal(next.pill.width, item.width, `${item.name} pill width`);
    assert.equal(next.pill.x, item.x, `${item.name} pill x`);
    assert.equal(next.label.width, item.labelWidth, `${item.name} label width`);
    assert.equal(next.label.x, plugin.PILL.textX, `${item.name} label x`);
    // right edge preserved, tail pad preserved, dot gap preserved
    assert.equal(next.pill.x + next.pill.width, SHIPPED_PILL.x + SHIPPED_PILL.width, `${item.name} right edge`);
    assert.equal(next.pill.width - next.label.x - next.label.width, 10, `${item.name} tail pad`);
    assert.ok(next.label.x - (SHIPPED_DOT.x + SHIPPED_DOT.width) >= plugin.PILL_GAP_MIN,
      `${item.name} dot gap`);
  }
  // Idempotent against the geometry the generator emits: re-applying the shipped label moves nothing.
  const same = plugin.pillGeometry(SHIPPED_PILL, SHIPPED_LABEL, SHIPPED_DOT, plugin.sizedPill("Healthy"));
  assert.deepEqual(same.pill, { x: SHIPPED_PILL.x, width: SHIPPED_PILL.width });
  assert.deepEqual(same.label, { x: SHIPPED_LABEL.x, width: SHIPPED_LABEL.width });
});

test("NC-35 malformed pill input fails loudly instead of silently returning", () => {
  const plugin = loadPlugin();
  for (const missing of [null, undefined, {}, { pill: 0, label: 10 }, { pill: 73, label: Number.NaN }]) {
    assert.throws(
      () => plugin.pillGeometry(SHIPPED_PILL, SHIPPED_LABEL, SHIPPED_DOT, missing),
      /no pill contract entry available for the state pill/,
      `contract entry ${JSON.stringify(missing)}`,
    );
  }
  assert.throws(
    () => plugin.pillGeometry(null, SHIPPED_LABEL, SHIPPED_DOT, plugin.sizedPill("Healthy")),
    /state pill is missing its container or label cell/,
  );
  // A dot that crowds the contract's fixed text origin is a malformed card, not a nudge to absorb.
  assert.throws(
    () => plugin.pillGeometry(
      SHIPPED_PILL, SHIPPED_LABEL, { x: 7, y: 5, width: 14, height: 10 }, plugin.sizedPill("Healthy"),
    ),
    /state pill dot leaves 5px before the label/,
  );
});

test("NC-34 a style is compared as a set of key/value pairs, not as a string", () => {
  const plugin = loadPlugin();
  const cases = [
    { name: "identical", a: "a=1;b=2;", b: "a=1;b=2;", same: true },
    { name: "reordered", a: "a=1;b=2;", b: "b=2;a=1;", same: true },
    { name: "bare flag reordered", a: "ellipse;a=1;", b: "a=1;ellipse;", same: true },
    { name: "changed value", a: "a=1;b=2;", b: "a=1;b=3;", same: false },
    { name: "extra key", a: "a=1;", b: "a=1;b=2;", same: false },
    { name: "missing flag", a: "ellipse;a=1;", b: "a=1;", same: false },
  ];
  for (const item of cases) {
    assert.equal(plugin.sameStyle(item.a, item.b), item.same, item.name);
  }
  // And rewriting an unchanged value produces the identical string, key order included.
  const style = "rounded=1;fillColor=#f2f8f2;strokeColor=#a0d8a0;dashed=0;";
  assert.equal(plugin.sameStyle(style, style), true);
});


// --- NC-42: change classification, pinned against real mxChange constructor identity ------------
//
// Draw.io dispatches mxChange *instances* and the plugin classifies them with `instanceof` against
// the globals the bundled build publishes. The vm sandbox has none, so the same names are declared
// on the sandbox the plugin is handed as its `root`; the shipped `relevantEdit` is then exercised
// on real instances rather than on a re-implementation of the rule.
const CHANGE_CLASSES = [
  "mxRootChange", "mxChildChange", "mxTerminalChange", "mxValueChange",
  "mxStyleChange", "mxGeometryChange",
];

function classifier() {
  const sandbox = { console };
  for (const name of CHANGE_CLASSES) {
    sandbox[name] = function Change(fields) { Object.assign(this, fields ?? {}); };
  }
  const plugin = loadPlugin(undefined, sandbox);
  const node = (attributes) => ({
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
  });
  const make = (name, fields) => new sandbox[name](fields);
  return { plugin, node, make };
}

const HEALTH = { ahmRole: "entity", ahmId: "db", ahmLocalState: "Healthy", ahmComputedState: "Healthy" };
const EDGE = { ahmRole: "dependency", ahmId: "db-shop", ahmImpact: "standard" };

test("NC-42 an edit is relevant only when it carries health meaning", () => {
  const { plugin, node, make } = classifier();
  const value = (attributes) => node(attributes);
  const cases = [
    {
      name: "a health value change on an AHM entity",
      changes: [make("mxValueChange", {
        cell: {}, value: value({ ...HEALTH, ahmLocalState: "Unhealthy" }), previous: value(HEALTH),
      })],
      relevant: true,
    },
    {
      name: "a label-only value change on an AHM entity",
      changes: [make("mxValueChange", {
        cell: {}, value: value({ ...HEALTH, label: "Renamed" }), previous: value({ ...HEALTH, label: "Old" }),
      })],
      relevant: false,
    },
    {
      name: "a value change on a cell that is not part of the model",
      changes: [make("mxValueChange", {
        cell: {}, value: value({ label: "Note" }), previous: value({ label: "Old" }),
      })],
      relevant: false,
    },
    {
      name: "a new dependency edge added to the model",
      changes: [make("mxChildChange", { child: { value: value(EDGE) } })],
      relevant: true,
    },
    {
      name: "a dependency edge retargeted",
      changes: [make("mxTerminalChange", { cell: { value: value(EDGE) } })],
      relevant: true,
    },
    {
      name: "a plain cell added that carries no role",
      changes: [make("mxChildChange", { child: { value: value({ label: "Sticky" }) } })],
      relevant: false,
    },
    {
      name: "a card moved and recoloured",
      changes: [make("mxGeometryChange", { cell: {} }), make("mxStyleChange", { cell: {} })],
      relevant: false,
    },
    { name: "a file load", changes: [make("mxRootChange", {}), make("mxRootChange", {})], relevant: false },
    {
      // The load filter, at the only boundary where it is load-bearing: a transaction that swaps
      // the root *and* carries an AHM value change is still a load, never a user edit.
      name: "a root swap carrying an AHM value change",
      changes: [
        make("mxRootChange", {}),
        make("mxValueChange", {
          cell: {}, value: value({ ...HEALTH, ahmLocalState: "Unhealthy" }), previous: value(HEALTH),
        }),
      ],
      relevant: false,
    },
    { name: "an empty edit", changes: [], relevant: false },
  ];
  for (const item of cases) {
    assert.equal(plugin.relevantEdit({ changes: item.changes }), item.relevant, item.name);
  }
  // A replay carries the same changes a recalculation would produce and must never trigger one.
  const semantic = [make("mxValueChange", {
    cell: {}, value: value({ ...HEALTH, ahmLocalState: "Unhealthy" }), previous: value(HEALTH),
  })];
  assert.equal(plugin.relevantEdit({ changes: semantic }), true);
  assert.equal(plugin.relevantEdit({ changes: semantic, undone: true }), false);
  assert.equal(plugin.relevantEdit({ changes: semantic, redone: true }), false);
  // Wrong input: no edit at all is not a reason to recalculate.
  for (const wrong of [null, undefined, {}, { changes: null }]) {
    assert.equal(plugin.relevantEdit(wrong), false, JSON.stringify(wrong));
  }
});

test("NC-48 install() is per editor instance at the plain-adapter boundary", () => {
  const plugin = loadPlugin();
  const makeUi = () => {
    const registered = [];
    const menus = [];
    return {
      registered,
      menus,
      ui: {
        diagram: model([entity("selected")]),
        selectedId: "selected",
        actions: { addAction(name, action) { registered.push(name); this[name] = action; } },
        menus: { addMenu(name) { menus.push(name); }, get() { return { funct() {} }; } },
      },
    };
  };
  const a = makeUi();
  const first = plugin.install(a.ui);
  const second = plugin.install(a.ui);
  assert.equal(first, second, "a second install() returned a different API");
  assert.equal(a.registered.length, 9);
  assert.deepEqual([...new Set(a.registered)].length, 9, "install() registered a duplicate action");
  assert.deepEqual(a.menus, ["ahmHealthModel"], "a second install() re-registered the menu");
  assert.equal(a.ui[first.INSTALL_KEY], first, "install() stored no marker on the editor");

  // A genuinely fresh editor object — built from scratch, carrying no INSTALL_KEY — is a different
  // installation: its own API object, its own counters and its own registration.
  const b = makeUi();
  assert.equal(b.ui[first.INSTALL_KEY], undefined, "the fresh editor already carried an install marker");
  const other = plugin.install(b.ui);
  assert.notEqual(other, first, "two editors were handed the same API object");
  assert.notEqual(other.stats, first.stats, "two editors were handed the same stats object");
  assert.deepEqual(other.stats, STATS_KEYS_ZERO);
  assert.equal(b.registered.length, 9);
  assert.deepEqual(b.menus, ["ahmHealthModel"]);
  // The factory's own API is not an installation and owns no counters.
  assert.equal(plugin.stats, undefined, "factory() exposed installation state");

  // A spread copy of an installed editor copies INSTALL_KEY with it, so it *is* that installation.
  // Asserted as the aliasing it is — deliberately, not as a fresh instance.
  const copy = { ...a.ui, actions: { addAction() {} }, menus: { addMenu() {}, get() { return {}; } } };
  assert.equal(plugin.install(copy), first,
    "a spread copy of an installed editor carries the marker and is the same installation");
});

// --- C-17: the counter, the message and the incompatible-host boundary --------------------------
//
// `stats` is asserted as an exact key set, not as a subset: the tautological `reentries` counter
// F-C16-1 found (unreachable because `if (guarded) return;` precedes `depth++`) must not survive as
// a dead name that other proofs still read as `0`, and since C-18 the plugin's own expected
// self-re-entry is a counter of its own rather than a silent contribution to `blockedReentries`.
const STATS_KEYS = ["hooks", "relevant", "recalculations", "blockedReentries", "selfSuppressed"];
const STATS_KEYS_ZERO = {
  hooks: 0, relevant: 0, recalculations: 0, blockedReentries: 0, selfSuppressed: 0,
};
const ACTION_NAMES = [
  "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
  "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed",
  "ahmRecalculate", "ahmValidate",
];
// The exact user-facing sentence NC-53 requires, written here as the literal it is. The plugin
// exports the same string and drawio/README.md documents it; all three are compared below, so the
// wording cannot drift between the code, the proof and the documentation.
const ROLLBACK_NOTE = "The entire edit was rolled back, including other changes in the same transaction.";

test("NC-59 an installation's counter set is exactly the five counters, and reentries is gone", () => {
  const plugin = loadPlugin();
  const ui = {
    diagram: model([entity("selected")]),
    selectedId: "selected",
    actions: { addAction(name, action) { this[name] = action; } },
    menus: { addMenu() {}, get() { return { funct() {} }; } },
  };
  const installed = plugin.install(ui);
  console.log(`NC-59 stats keys ${JSON.stringify(Object.keys(installed.stats))}`);
  assert.deepEqual(Object.keys(installed.stats).sort(), [...STATS_KEYS].sort(),
    "the installed stats object is not exactly the five counters");
  assert.deepEqual(installed.stats, STATS_KEYS_ZERO);
  assert.equal("reentries" in installed.stats, false, "the unreachable reentries counter survived");
});

test("NC-53 the rollback wording is one string shared by the plugin, the proofs and the README", () => {
  const plugin = loadPlugin();
  const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
  console.log(`NC-53 note ${JSON.stringify(plugin.ROLLBACK_NOTE)}`);
  assert.equal(plugin.ROLLBACK_NOTE, ROLLBACK_NOTE,
    "the plugin's rollback sentence is not the literal the proofs assert");
  assert.ok(readme.includes(ROLLBACK_NOTE),
    "drawio/README.md does not document the exact rollback sentence the plugin emits");
  assert.ok(readme.includes(plugin.SUPPORTED_RUNTIME),
    "drawio/README.md does not name the supported runtime the guard reports");
  // The message is a wrapper, not a replacement: the original validation text survives verbatim.
  const original = "AHM validation: invalid state Sideways in db";
  assert.equal(`${original}. ${ROLLBACK_NOTE}`,
    `AHM validation: invalid state Sideways in db. ${ROLLBACK_NOTE}`);
});

// NC-52 clause 5: a fabricated host at the plain-adapter boundary. `install()` must survive a host
// whose model carries none of the transaction semantics — no mxGraphModel class, no mxEvent — and
// must disable itself rather than write into it.
function incompatibleHost() {
  const registered = [];
  const errors = [];
  const listeners = [];
  const writes = [];
  const cells = {
    db: {
      id: "db",
      value: {
        getAttribute(name) {
          return { ahmRole: "entity", ahmId: "db", ahmLocalState: "Healthy", ahmComputedState: "Healthy", ahmImpact: "standard", ahmAggregation: "worstOf" }[name] || null;
        },
      },
      style: "",
    },
  };
  const graph = {
    getSelectionCell() { return cells.db; },
    getModel() {
      return {
        cells,
        updateLevel: 0,
        currentEdit: { changes: [] },
        addListener(...args) { listeners.push(args); },
        beginUpdate() { writes.push("beginUpdate"); },
        endUpdate() { writes.push("endUpdate"); },
        setValue(...args) { writes.push(["setValue", ...args]); },
        setStyle(...args) { writes.push(["setStyle", ...args]); },
        getCell(id) { return cells[id]; },
      };
    },
  };
  return {
    registered,
    errors,
    listeners,
    writes,
    ui: {
      editor: { graph },
      actions: { addAction(name, action) { registered.push(name); this[name] = action; } },
      menus: { addMenu() {}, get() { return { funct() {} }; } },
      handleError(error) { errors.push(String((error && error.message) || error)); },
    },
  };
}

test("NC-52 a fabricated incompatible host disables the plugin once and is never written to", () => {
  const plugin = loadPlugin();
  const host = incompatibleHost();
  const installed = plugin.install(host.ui);
  console.log(`NC-52 fabricated host compatible=${installed.compatibility.compatible} `
    + `reasons=${JSON.stringify(installed.compatibility.reasons)} `
    + `errors=${host.errors.length} listeners=${host.listeners.length} writes=${host.writes.length}`);
  assert.equal(installed.compatibility.compatible, false, "the fabricated host was accepted");
  assert.equal(installed.disabled, true);
  assert.deepEqual(installed.compatibility.reasons, ["mxGraphModel-missing", "mxEvent-missing"]);
  // No throw, no listener, exactly one message, and the message names the supported runtime.
  assert.equal(host.errors.length, 1, `expected one message, got ${JSON.stringify(host.errors)}`);
  assert.ok(host.errors[0].includes(plugin.SUPPORTED_RUNTIME));
  assert.ok(host.errors[0].includes("mxGraphModel-missing, mxEvent-missing"));
  assert.deepEqual(host.listeners, [], "the guard registered a model listener on an unsupported host");
  assert.deepEqual(host.writes, [], "install() wrote into an unsupported host's model");
  // The actions are still registered — a disabled plugin must not break the host's menu.
  assert.deepEqual(host.registered, ACTION_NAMES);

  // NC-52 clause 6: every mutating action is a no-op, and read-only validate still runs.
  for (const name of ACTION_NAMES) {
    assert.doesNotThrow(() => host.ui.actions[name](), `${name} threw on an incompatible host`);
  }
  console.log(`NC-52 after nine actions errors=${JSON.stringify(host.errors)} `
    + `writes=${JSON.stringify(host.writes)} stats=${JSON.stringify(installed.stats)}`);
  assert.deepEqual(host.writes, [], "an action wrote into an unsupported host's model");
  assert.equal(host.errors.length, 1, "an action added a second message");
  assert.deepEqual(installed.stats, STATS_KEYS_ZERO, "a disabled action still counted a recalculation");

  // A second install() on the same host runs no second probe and emits no second message.
  assert.equal(plugin.install(host.ui), installed);
  assert.equal(host.errors.length, 1, "a second install() emitted a second message");
});

test("NC-52 read-only validate still reports its own findings on an incompatible host", () => {
  const plugin = loadPlugin();
  const host = incompatibleHost();
  // The same fabricated host, with one entity carrying a state the model does not define.
  host.ui.editor.graph.getModel().cells.db.value.getAttribute = (name) => ({
    ahmRole: "entity", ahmId: "db", ahmLocalState: "Sideways",
    ahmComputedState: "Healthy", ahmImpact: "standard", ahmAggregation: "worstOf",
  }[name] || null);
  plugin.install(host.ui);
  assert.equal(host.errors.length, 1);
  host.ui.actions.ahmSetUnhealthy();
  assert.equal(host.errors.length, 1, "a mutating action reported on a disabled host");
  host.ui.actions.ahmValidate();
  console.log(`NC-52 validate on a disabled host ${JSON.stringify(host.errors.slice(1))}`);
  assert.equal(host.errors.length, 2, "read-only validate stopped reporting on a disabled host");
  assert.match(host.errors[1], /invalid state Sideways in db/);
  assert.deepEqual(host.writes, [], "validate wrote into the model");
});

// NC-58 clause (iv) plus the documentation parity the criterion requires: the disabled/read-only
// split is unchanged by C-18's routing reorder, and the README sentence that promises it is
// compared against the measured behaviour rather than left as prose.
test("NC-58 the read-only split is a property of the operation, on every host", () => {
  const plugin = loadPlugin();
  const readme = readFileSync(resolve(import.meta.dirname, "../README.md"), "utf8");
  const host = incompatibleHost();
  host.ui.editor.graph.getModel().cells.db.value.getAttribute = (name) => ({
    ahmRole: "entity", ahmId: "db", ahmLocalState: "Sideways",
    ahmComputedState: "Healthy", ahmImpact: "standard", ahmAggregation: "worstOf",
  }[name] || null);
  const installed = plugin.install(host.ui);
  for (const name of ACTION_NAMES) host.ui.actions[name]();
  const validationErrors = host.errors.slice(1);
  console.log(`NC-58 nine actions on a disabled host writes=${JSON.stringify(host.writes)} `
    + `messages=${JSON.stringify(validationErrors)} stats=${JSON.stringify(installed.stats)}`);
  // The eight mutating actions add nothing; only validate speaks, and it never opens a transaction.
  assert.deepEqual(host.writes, [], "an action wrote into the model");
  assert.deepEqual(validationErrors, ["AHM validation: invalid state Sideways in db"],
    "the read-only split changed on a disabled host");
  assert.deepEqual(installed.stats, STATS_KEYS_ZERO, "a read-only action counted a recalculation");
  // Documentation parity: the promise and the measurement are the same statement.
  assert.ok(readme.includes("**Validate** keeps working, because it writes\nnothing."),
    "drawio/README.md no longer carries the sentence this behaviour keeps");
});

// --- C-21 / NC-69: the operation gate covers every route, the plain adapter included -------------
//
// C-20 armed the gate in `run()` but left `if (ui.diagram) return runPlain(operation);` above it, so
// the whole plain-adapter route ran ungated: a nested action fired from `ui.handleError` while a
// top-level action was reporting ran a second full calculation (measured as `P-C21-5`/`P-C21-6`:
// depth 2, two messages, four `cells` reads, `blockedReentries 0`). Everything below is observed
// through the **registered public actions** and the installed `stats`; no internal flag is read.
//
// `cells` is a getter, so "did a second calculation run" is a counted read of the adapter's own
// diagram rather than a claim about the plugin's internals.
function countingAdapter({ nested = null, handleError = true } = {}) {
  const cells = model([entity("a"), entity("db", "Sideways")]).cells;
  const counters = { reads: 0, depth: 0, maxDepth: 0, nestedCalls: 0 };
  const messages = [];
  const diagram = { get cells() { counters.reads += 1; return cells; } };
  const ui = {
    diagram,
    selectedId: "a",
    actions: {
      addAction(name, action) {
        // Depth is measured around the *registered* action, so a blocked re-entry is still counted
        // as an attempt that reached the public boundary.
        this[name] = function () {
          counters.depth += 1;
          counters.maxDepth = Math.max(counters.maxDepth, counters.depth);
          try { return action.apply(this, arguments); } finally { counters.depth -= 1; }
        };
      },
    },
    menus: { addMenu() {}, get() { return { funct() {} }; } },
  };
  if (handleError) {
    ui.handleError = function (error) {
      messages.push(String((error && error.message) || error));
      if (nested && counters.nestedCalls === 0) {
        counters.nestedCalls += 1;
        ui.actions[nested]();
      }
    };
  }
  return { ui, cells, counters, messages };
}

const NESTED_ACTIONS = [
  { nested: "ahmValidate", readOnly: true, label: "nested read-only validate" },
  { nested: "ahmSetUnhealthy", readOnly: false, label: "nested mutating setUnhealthy" },
];

// One driver, so the shipped plugin and an ablated one are observed through exactly the same
// public sequence: install, one top-level `ahmValidate` on an invalid diagram, a sink that fires
// `nested` once.
function driveNestedFromErrorSink(plugin, nested) {
  // The same top-level operation with a sink that does *not* re-enter: the number of reads and
  // messages one operation costs, measured rather than hardcoded.
  const solo = countingAdapter({});
  plugin.install(solo.ui);
  solo.ui.actions.ahmValidate();

  const host = countingAdapter({ nested });
  const installed = plugin.install(host.ui);
  const before = structuredClone(host.cells);
  host.ui.actions.ahmValidate();
  return {
    host,
    installed,
    before,
    soloReads: solo.counters.reads,
    soloMessages: solo.messages.length,
  };
}

test("NC-69 (i) a nested adapter action from the error sink is blocked once, read-only or mutating", () => {
  for (const { nested, readOnly, label } of NESTED_ACTIONS) {
    const plugin = loadPlugin();
    const { host, installed, before, soloReads, soloMessages } = driveNestedFromErrorSink(plugin, nested);
    console.log(`NC-69 ${label}: maxDepth=${host.counters.maxDepth} `
      + `messages=${host.messages.length} reads=${host.counters.reads} (solo ${soloReads}) `
      + `stats=${JSON.stringify(installed.stats)}`);
    assert.equal(host.counters.nestedCalls, 1, `${label}: the sink never fired the nested action`);
    assert.equal(host.counters.maxDepth, 2, `${label}: the nested action never reached the boundary`);
    assert.equal(installed.stats.blockedReentries, 1,
      `${label}: the nested action was not blocked exactly once`);
    assert.equal(host.messages.length, soloMessages,
      `${label}: the nested action produced a second message ${JSON.stringify(host.messages)}`);
    assert.equal(host.counters.reads, soloReads,
      `${label}: the nested action ran a second calculation (${host.counters.reads} reads)`);
    assert.equal(installed.stats.selfSuppressed, 0,
      `${label}: a route with no hook counted a self-suppression`);
    if (readOnly) {
      assert.deepEqual(host.cells, before, `${label}: a read-only re-entry changed the diagram`);
    } else {
      assert.equal(host.cells.find((cell) => cell.ahmId === "a").localState, "Healthy",
        `${label}: the blocked mutating re-entry still wrote`);
    }
  }
});

test("NC-69 (ii) the gate clears after a normal return and after a throw", () => {
  const plugin = loadPlugin();
  const host = countingAdapter({ nested: "ahmValidate" });
  const installed = plugin.install(host.ui);
  host.ui.actions.ahmValidate();
  assert.equal(installed.stats.blockedReentries, 1);
  const afterBlocked = host.messages.length;
  host.ui.actions.ahmValidate();
  console.log(`NC-69 (ii) second top-level validate messages ${host.messages.length - afterBlocked} `
    + `stats=${JSON.stringify(installed.stats)}`);
  assert.equal(host.messages.length, afterBlocked + 1,
    "a second top-level validate after a blocked re-entry reported nothing");
  assert.equal(installed.stats.blockedReentries, 1,
    "the second top-level validate was blocked by a gate that never released");

  // No `handleError`: `report` re-throws out of `runPlain`, so the operation leaves through the
  // `finally` rather than through a normal return. The next top-level action must still run.
  const throwing = countingAdapter({ handleError: false });
  const thrown = plugin.install(throwing.ui);
  assert.throws(() => throwing.ui.actions.ahmValidate(), /invalid state Sideways in db/);
  assert.throws(() => throwing.ui.actions.ahmValidate(), /invalid state Sideways in db/);
  console.log(`NC-69 (ii) after two throws stats=${JSON.stringify(thrown.stats)}`);
  assert.equal(thrown.stats.blockedReentries, 0,
    "a throw left the gate armed, so the next top-level action was blocked");
});

test("NC-69 (iii) top-level adapter behaviour is unchanged by the gate", () => {
  const plugin = loadPlugin();
  const host = countingAdapter({});
  // A valid diagram, so every one of the nine registered actions is a genuine top-level operation.
  host.cells.splice(0, host.cells.length, ...model([entity("a"), entity("b")]).cells);
  const installed = plugin.install(host.ui);
  for (const name of ACTION_NAMES) {
    assert.doesNotThrow(() => host.ui.actions[name](), `${name} threw on the plain adapter`);
  }
  console.log(`NC-69 (iii) nine actions messages=${JSON.stringify(host.messages)} `
    + `stats=${JSON.stringify(installed.stats)} a=${host.cells[0].localState}/${host.cells[0].impact}`);
  assert.deepEqual(host.messages, [], "a top-level action reported on a valid adapter diagram");
  assert.deepEqual(Object.keys(installed.stats).sort(), [...STATS_KEYS].sort(),
    "the counter key set changed");
  assert.deepEqual(installed.stats, STATS_KEYS_ZERO,
    "a top-level adapter action moved a counter");
  // The last state action wins and the last impact action wins: the actions really ran.
  assert.equal(host.cells[0].localState, "Unknown", "ahmSetUnknown did not reach the diagram");
  assert.equal(host.cells[0].impact, "suppressed", "ahmImpactSuppressed did not reach the diagram");

  // NC-48 isolation still holds while a gate exists: a second editor is its own installation.
  const other = countingAdapter({});
  const otherInstalled = plugin.install(other.ui);
  assert.notEqual(otherInstalled, installed, "two adapters were handed the same API object");
  assert.notEqual(otherInstalled.stats, installed.stats, "two adapters share one stats object");
  assert.deepEqual(otherInstalled.stats, STATS_KEYS_ZERO);
});

// NC-69 (v): the kill control is a transform of the **shipped** plugin source, not a hand-written
// alternative. `adapterBeforeGuard` puts `if (ui.diagram) return runPlain(operation);` back above
// the gate — the exact C-20 ordering — and must reproduce the measured red baseline through the
// same public driver. `ablatePlugin` throws when a patch no longer applies, so a rename can never
// turn this control into a silent no-op.
test("NC-69 (v) adapterBeforeGuard reproduces the C-20 red baseline through the public actions", () => {
  const ablated = ablatePlugin(["adapterBeforeGuard"]);
  assert.notEqual(ablated, readFileSync(PLUGIN_FILE, "utf8"), "the ablation did not change the source");
  assert.throws(() => ablatePlugin(["adapterBeforeGuard"], "no gate in this source"),
    /adapterBeforeGuard".*not found/, "the ablation tolerated a source it does not match");
  for (const { nested, label } of NESTED_ACTIONS) {
    const { host, installed, soloReads, soloMessages } = driveNestedFromErrorSink(
      loadPlugin(ablated), nested,
    );
    console.log(`NC-69 (v) adapterBeforeGuard ${label}: maxDepth=${host.counters.maxDepth} `
      + `messages=${host.messages.length} reads=${host.counters.reads} (solo ${soloReads}) `
      + `stats=${JSON.stringify(installed.stats)}`);
    assert.equal(host.counters.maxDepth, 2, `${label}: the control never nested`);
    assert.equal(host.messages.length, soloMessages + 1,
      `${label}: the control did not produce the second message the baseline measured`);
    assert.equal(host.counters.reads, soloReads * 2,
      `${label}: the control did not run the second calculation the baseline measured`);
    assert.equal(installed.stats.blockedReentries, 0,
      `${label}: the control still blocked, so it is not the control`);
  }
});

// --- C-22 / NC-71: per-editor isolation — cross-editor independent, same-editor nesting blocked --
test("NC-71 operationInFlight is per editor: cross-editor succeeds, same-editor nesting blocked", () => {
  const plugin = loadPlugin();

  // Two distinct ui objects, each with their own diagrams, messages, and counters.
  const cells1 = model([entity("a"), entity("db", "Sideways")]).cells;
  const cells2 = model([entity("x"), entity("y", "Sideways")]).cells;
  const messages1 = [];
  const messages2 = [];
  const counters1 = { reads: 0, nestedCalls: 0 };
  const counters2 = { reads: 0 };

  const ui1 = {
    diagram: { get cells() { counters1.reads++; return cells1; } },
    selectedId: "a",
    actions: { addAction(name, action) { this[name] = action; } },
    menus: { addMenu() {}, get() { return { funct() {} }; } },
    handleError(error) {
      messages1.push(String((error && error.message) || error));
      // While ui1 is handling a top-level validation error, invoke ui2's action and
      // attempt a nested ui1 action.
      if (counters1.nestedCalls === 0) {
        counters1.nestedCalls++;
        // Cross-editor: invoke ui2's action while ui1's operation is in flight.
        ui2.actions.ahmValidate();
        // Same-editor: attempt nested action on ui1 (should be blocked).
        ui1.actions.ahmValidate();
      }
    },
  };

  const ui2 = {
    diagram: { get cells() { counters2.reads++; return cells2; } },
    selectedId: "x",
    actions: { addAction(name, action) { this[name] = action; } },
    menus: { addMenu() {}, get() { return { funct() {} }; } },
    handleError(error) {
      messages2.push(String((error && error.message) || error));
    },
  };

  // Install on both editors — two distinct installations.
  const installed1 = plugin.install(ui1);
  const installed2 = plugin.install(ui2);
  assert.notEqual(installed1, installed2, "two distinct ui objects returned the same installation");
  assert.notEqual(installed1.stats, installed2.stats, "two installations share one stats object");

  // Idempotence: same ui installed again returns the same instance.
  const again1 = plugin.install(ui1);
  assert.equal(again1, installed1, "reinstalling the same ui did not return the cached instance");

  // Trigger: top-level ahmValidate on ui1 with an invalid diagram triggers handleError,
  // which fires ui2.ahmRecalculate (cross-editor) and ui1.ahmValidate (same-editor nested).
  ui1.actions.ahmValidate();

  console.log(`NC-71 messages1=${JSON.stringify(messages1)} messages2=${JSON.stringify(messages2)} `
    + `stats1=${JSON.stringify(installed1.stats)} stats2=${JSON.stringify(installed2.stats)} `
    + `reads1=${counters1.reads} reads2=${counters2.reads}`);

  // Cross-editor ui2 action succeeded independently (it read its own cells and reported to ui2).
  assert.ok(counters2.reads > 0, "cross-editor ui2 action never read its diagram");
  // Same-editor ui1 nesting was blocked exactly once.
  assert.equal(installed1.stats.blockedReentries, 1,
    "same-editor nested action was not blocked exactly once");
  // Cross-editor ui2 was NOT blocked.
  assert.equal(installed2.stats.blockedReentries, 0,
    "cross-editor ui2 action was incorrectly blocked");
  assert.deepEqual(messages1, ["AHM validation: invalid state Sideways in db"],
    "ui1 did not receive exactly its own validation error");
  assert.deepEqual(messages2, ["AHM validation: invalid state Sideways in y"],
    "ui2 did not receive exactly its own validation error");
});
