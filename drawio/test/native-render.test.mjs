import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { extractBlocks } from "../../src/extract.mjs";
import { foldSignals, parseGraph } from "../../src/swimlane.mjs";
import { getTheme } from "../../src/themes.mjs";
import {
  LAYOUT, SIGNAL_GLYPH, SIGNAL_STATES, buildExample, buildModel, signalState,
} from "../scripts/generate-artifacts.mjs";
import {
  ACTIVE_MODEL_PATCHES, AGENT_PLACEHOLDER, EXAMPLES, PLUGIN_ABLATION_NAMES, ablatePlugin,
  agentOf, agentSpan,
  artifactDigests, cellKey,
  corruptBody, corruptPayload, corruptRootAttribute, corruptTail, diffRegions, injectWaypoint,
  moveExamples, normaliseAgent,
  pluginAtomicEdit, pluginEditSequence, pluginEditorIsolation, pluginErrorSinkReentry,
  pluginFailurePaths,
  pluginForcedNesting, pluginGranularity, pluginHostGuard, pluginOpenStability,
  pluginPillTransitions, pluginRollback, pluginValidate, readDrawioSvgText, renderExamples,
  renderModels, replaceAgent, rootTagSpan, sha256, splitAtAgent,
} from "../visual/render-native.mjs";
import { assertEmbeddedModelPresent } from "../visual/drawio-host.mjs";
import { contentValue } from "../visual/svg-embed.mjs";
import {
  decodeEntities, inflateDiagrams, readDrawioSvg, readDrawioSvgSource,
} from "./helpers/artifact.mjs";
import { modelDigest } from "./helpers/canonical.mjs";

const root = resolve(import.meta.dirname, "..");
const theme = getTheme("portal");
const TOKEN = {
  Healthy: "healthy", Degraded: "degraded", Unhealthy: "unhealthy",
  Unknown: "unknown", Standby: "alt",
};
const AUTHORED = {
  healthy: "healthy", degraded: "degraded", unhealthy: "unhealthy",
  unknown: "unknown", standby: "alt",
};
// A card is drawn with the state it *presents* — the rollup result, with authored Standby keeping
// its purple token. Since C-14 the generator emits that state, so this is what every colour and
// every pill width on a shipped card is measured against.
const shownOf = (cell) => (cell.attributes.ahmComputedState === "Unknown"
  && cell.attributes.ahmAuthoredState === "standby" ? "Standby" : cell.attributes.ahmComputedState);
const shownToken = (cell) => theme.state[TOKEN[shownOf(cell)]];
const PAD = 8;

// Draw.io normalises hex literals to lower case on the way into the SVG, so colors are compared
// as normalised values — still exact value equality, never a tolerance.
const color = (value) => (value == null ? value : String(value).toLowerCase());
const round1 = (value) => Math.round(value * 10) / 10;

// One browser session renders all three examples with the bundled Draw.io build the VS Code
// extension loads, then reopens Draw.io's own `xmlsvg` export for the round-trip criterion.
const report = await renderExamples(EXAMPLES, { screenshot: false, roundTrip: true });
// A second session loads drawio/plugin/ahm-health.js exactly like the VS Code workspace does, so
// the auto-recalculate listener runs against the shipped artifact — the path that turned authored
// Unknown/Standby green in the user's canvas.
const withPlugin = await renderExamples(["kitchen-sink"], {
  screenshot: false, plugin: true, prefix: "plugin",
});
const sources = Object.fromEntries(EXAMPLES.map((name) => [
  name, readDrawioSvg(resolve(root, `examples/${name}.drawio.svg`)),
]));

// --- C-12 boundary material -------------------------------------------------------------------
// Everything the three shipped inventories cannot reach, rendered in one further Draw.io session:
//   * the real generator run with its three layout levers ablated — NC-22's negative control,
//   * two authored fixtures (all four signal states; labels far past the label column),
//   * every decoded `<mxlibrary>` entry, plus one deliberately flattened variant of one of them.
// Nothing here is written to disk and no shipped inventory is edited.
const ABLATION = { laneStagger: [0, 0, 0], portMinGap: 0, quantum: 1 };
const FIXTURES = { states: "signal-states", labels: "long-labels" };
const fixtureFile = (slug) => resolve(root, `test/fixtures/${slug}.md`);

// Public reopen boundary for the shape library: `<mxlibrary>` wrapper, JSON array, one native
// `mxGraphModel` per entry. Throws rather than returning a partial list.
function decodeLibrary(text) {
  const body = text.match(/^<mxlibrary>([\s\S]*)<\/mxlibrary>\s*$/);
  if (!body) throw new Error("missing <mxlibrary> wrapper");
  const entries = JSON.parse(body[1]);
  if (!Array.isArray(entries) || !entries.length) throw new Error("library holds no entries");
  for (const entry of entries) {
    if (!entry || typeof entry.xml !== "string" || !/<mxGraphModel[\s>]/.test(entry.xml)) {
      throw new Error(`library entry ${entry && entry.title} carries no mxGraphModel`);
    }
  }
  return entries;
}

const libraryText = readFileSync(resolve(root, "library/ahm-diagrammo.xml"), "utf8");
const libraryEntries = decodeLibrary(libraryText);
const metricsEntry = libraryEntries.find((entry) => entry.title === "Entity with metrics");
const ablatedBuilds = Object.fromEntries(EXAMPLES.map((name) => [name, buildExample(name, ABLATION)]));
const fixtureBuilds = Object.fromEntries(Object.entries(FIXTURES)
  .map(([key, slug]) => [key, buildExample(slug, {}, fixtureFile(slug))]));
const extra = await renderModels({
  ...Object.fromEntries(EXAMPLES.map((name) => [`ablated-${name}`, ablatedBuilds[name].model])),
  ...Object.fromEntries(Object.entries(fixtureBuilds).map(([key, b]) => [`fixture-${key}`, b.model])),
  ...Object.fromEntries(libraryEntries.map((entry, index) => [`library-${index}`, entry.xml])),
  // Runtime negative control for NC-30: the same entry with a filled, stroked, rounded row card
  // put back — exactly the surface C-11 removed.
  "library-flattened": metricsEntry.xml.replace(
    /rounded=0;([^"]*?)fillColor=none;strokeColor=none;/g,
    "rounded=1;$1fillColor=#eaeaea;strokeColor=#cccccc;",
  ),
}, { roundTrip: true });

const right = (box) => box.x + box.w;
const bottom = (box) => box.y + box.h;
const centreY = (box) => box.y + box.h / 2;

// --- C-13 boundary material: the plugin's runtime pill path ------------------------------------
// Two more live Draw.io sessions with `plugin/ahm-health.js` injected by `visual/drawio-host.mjs`
// exactly as the VS Code workspace loads it. The plan walks every presented label the plugin can
// produce — Healthy, Degraded, Unhealthy, Unknown and Standby — through its own public path
// (`AhmHealthPluginFactory()` → `readDrawio` → `setHealth` → `writeDrawio`). `web` has Healthy
// signals, so its Unknown rolls up to Healthy; `auth` is authored Unknown and `secondary` authored
// Standby, which is how those two labels are reached by a real transition rather than by fiat.
const PILL_PLAN = [
  { entity: "web", state: "Degraded" },
  { entity: "web", state: "Unhealthy" },
  // Unhealthy -> Healthy shrinks the label: the fix must not be "always grow".
  { entity: "web", state: "Healthy" },
  { entity: "auth", state: "Unhealthy" },
  { entity: "auth", state: "Unknown" },
  { entity: "secondary", state: "Unhealthy" },
  { entity: "secondary", state: "Unknown" },
];
const pillRuntime = await pluginPillTransitions("kitchen-sink", PILL_PLAN);
// Negative control: the same run with the geometry update removed from the injected source, i.e.
// exactly the `restylePill` that shipped before C-13.
const pillAblated = await pluginPillTransitions("kitchen-sink", PILL_PLAN, { ablateResize: true });

// --- C-14 boundary material: the shipped install() path in the live runtime ---------------------
//
// Every run below calls `window.AhmHealthPluginFactory().install(editorUi)` in the bundled Draw.io
// build and reads the editor's own state after a wait longer than the 100 ms recalculate debounce.
// The three roots C-14 removed are reverted one at a time against the shipped source in memory, so
// each is proved load-bearing rather than asserted to be.
//
// `unfilteredListener` accompanies every single-root control: with the load/replay filter in place
// a shipped open schedules no recalculation at all, so a root's write cannot be observed on open
// without it. Its own run (`openUnfiltered`) is therefore the discriminator — it recalculates the
// whole model on load and still writes nothing.
// C-15 moved the recalculation off mxEvent.CHANGE, so reproducing the pre-C-14 plugin now needs
// that design restored as well: `changeListenerRecalc` first (it rewrites the whole hook), then the
// filter and the two write-path roots.
const PRE_C14 = ["changeListenerRecalc", "unfilteredListener", "runtimeMetric", "styleChurn"];
const openBefore = await pluginOpenStability(EXAMPLES, {});
const openAfter = await pluginOpenStability(EXAMPLES, { installOrder: "after" });
const openNoInstall = await pluginOpenStability(["kitchen-sink"], { install: false });
const openPreC14 = await pluginOpenStability(EXAMPLES, { ablate: PRE_C14 });
const openUnfiltered = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["changeListenerRecalc", "unfilteredListener"],
});
const openMetric = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["changeListenerRecalc", "unfilteredListener", "runtimeMetric"],
});
const openStyle = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["changeListenerRecalc", "unfilteredListener", "styleChurn"],
});
// The generator-side root, reverted through the generator's own `authoredStates` lever: a model
// that ships the authored state instead of the plugin's rollup. Nothing is written to disk.
const STALE_ROLLUP = buildExample("kitchen-sink", { authoredStates: true }).model;
const openAuthored = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["changeListenerRecalc", "unfilteredListener"],
  models: { "kitchen-sink": STALE_ROLLUP },
});

// `db` is Healthy with only Healthy signals and feeds `shop` and `reporting`, which both feed
// `root` — so one external edit to its local state has to move three other cards. An entity whose
// own signals pin its state would make a broken propagation look like a legitimate no-op.
const EDIT = { entity: "db", state: "Unhealthy", watch: ["db", "shop", "reporting", "root"] };
const editSequence = await pluginEditSequence("kitchen-sink", EDIT);
const editPreC14 = await pluginEditSequence("kitchen-sink", { ...EDIT, ablate: PRE_C14 });

// Malformed models, each loaded into the live editor and then driven through both failure paths:
// the registered `ahmRecalculate` action and the debounced listener.
const DB_LABEL = /<object label="Healthy" ahmPart="state-label" id="db-state-label"><mxCell style="([^"]*)"([^>]*)><mxGeometry([^>]*)\/><\/mxCell><\/object>/;
const relabel = (style, rest, geometry) => '<object label="Healthy" ahmPart="state-label" '
  + `id="db-state-label"><mxCell style="${style}"${rest}><mxGeometry${geometry}/></mxCell></object>`;
const FAILURE_CASES = [
  { name: "no state-label child", mutate: (model) => model.replace(DB_LABEL, "") },
  {
    name: "state-label with no font style",
    mutate: (model) => model.replace(DB_LABEL, (all, style, rest, geometry) => relabel(
      style.replace("fontSize=10;", "").replace("fontFamily=Helvetica;", ""), rest, geometry,
    )),
  },
  {
    name: "state-label at a font size the contract was not derived for",
    mutate: (model) => model.replace(DB_LABEL, (all, style, rest, geometry) => relabel(
      style.replace("fontSize=10;", "fontSize=14;"), rest, geometry,
    )),
  },
  {
    name: "state cell with no geometry",
    mutate: (model) => model.replace(
      /(<object label="" ahmPart="state" id="db-state"><mxCell style="[^"]*"[^>]*>)<mxGeometry[^>]*\/>/,
      "$1",
    ),
  },
  {
    // `web` is Healthy, so the trigger edit really changes a health attribute; `db` stays the
    // malformed cell the rollup trips over.
    name: "entity carrying a state the model does not define",
    trigger: "web",
    mutate: (model) => model.replace(/(ahmId="db"[^>]*?)ahmLocalState="Healthy"/,
      '$1ahmLocalState="Sideways"'),
  },
];
const failurePaths = await pluginFailurePaths(FAILURE_CASES);

// --- C-15 boundary material: one semantic edit is one undo entry -------------------------------
//
// Every run below drives the shipped `install(editorUi)` in the bundled Draw.io build and reads the
// live undo manager, every mxEvent.CHANGE / mxEvent.END_UPDATE dispatch (with the model values and
// the rendered frame each one carried) and the rendered pill/card boxes, immediately *and* after a
// 700 ms settle — longer than any timer the plugin could still hold, so a re-introduced debounce
// would be caught rather than out-run.
const atomic = await pluginAtomicEdit("kitchen-sink", { cycles: 3 });
const atomicTwice = await pluginAtomicEdit("kitchen-sink", { cycles: 1, installs: 2 });
// Controls, each applied on its own so no result depends on another ablation being present.
const atomicNoIdempotence = await pluginAtomicEdit("kitchen-sink", {
  cycles: 1, installs: 2, ablate: ["noIdempotenceMarker"],
});
const atomicChangeListener = await pluginAtomicEdit("kitchen-sink", {
  cycles: 1, ablate: ["changeListenerRecalc"],
});
const atomicSeparate = await pluginAtomicEdit("kitchen-sink", {
  cycles: 1, ablate: ["separateTransactionRecalc"],
});
const atomicNoJoin = await pluginAtomicEdit("kitchen-sink", { cycles: 1, ablate: ["noJoin"] });

const granularity = await pluginGranularity("kitchen-sink");
const granularityNoGuard = await pluginGranularity("kitchen-sink", { ablate: ["noReentrancyGuard"] });

// The relevance filter, proved in isolation. A *settled* artifact cannot show it — a recalculation
// on load writes nothing there — so the discriminating model is one whose stored rollup is stale,
// which is exactly what the filter exists to leave alone.
const openStale = await pluginOpenStability(["kitchen-sink"], { models: { "kitchen-sink": STALE_ROLLUP } });
const openStaleUnfiltered = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["unfilteredListener"], models: { "kitchen-sink": STALE_ROLLUP },
});
const openStaleNoRootFilter = await pluginOpenStability(["kitchen-sink"], {
  ablate: ["noRootChangeFilter"], models: { "kitchen-sink": STALE_ROLLUP },
});

// NC-43: the same five malformed fixtures with the error swallowed, plus a *well-formed* model with
// a failure injected after the derived write has already appended changes to the user's own edit.
const failureSwallowed = await pluginFailurePaths(FAILURE_CASES, { ablate: ["swallowDerivedWrite"] });

// --- C-16 / C-17 boundary material: the whole originating transaction is rolled back -------------
//
// The grid NC-45 declared and NC-51 completes: {failure phase} x {transaction shape} x {path}. The
// phase is chosen by the run — a malformed model fails *before* the derived write, the
// `failAfterWrite` ablation fails part-way *through* it — and the shape and the path are two
// independent axes of each case rather than one flattened list, which is what C-16 measured (eight
// of twelve cells: `action` was treated as a fourth *shape*, so the action path only ever ran with a
// single change).
//
// `path: "hook"` is a plain user transaction that reaches the model hook; `path: "action"` is the
// registered `ahmSetUnhealthy` entry. Because `selectedId()` reads one selection cell, the action
// can never author more than one semantic change by itself, so `action x {multi, compound}` is
// constructed at the only boundary where it exists: the action invoked *inside* an outer user
// transaction that already carries the other changes.
//
// Every run measures both directions of the `modified` clause: the same failing transaction against
// a clean editor and again against one already dirtied by an unrelated card move.
// C-17: the three axes are independent here too, so the twelve cells are a product rather than a
// hand-written list and a missing combination cannot hide as a missing entry.
const ROLLBACK_SHAPE_AXIS = ["single", "multi", "compound"];
const ROLLBACK_PATH_AXIS = ["hook", "action"];
const ROLLBACK_CELLS = ROLLBACK_PATH_AXIS
  .flatMap((path) => ROLLBACK_SHAPE_AXIS.map((shape) => ({ shape, path })));
const MID_WRITE = { ablate: ["failAfterWrite"], primary: "db", extras: ["cache", "queue"], moveId: "web" };
// `db` carries a state the model does not define, so validation fails before anything is planned.
// The transactions therefore drive `web`, which is well formed — a failing edit, not a repairing one.
const PRE_WRITE = {
  mutate: (model) => model.replace(/(ahmId="db"[^>]*?)ahmLocalState="Healthy"/, '$1ahmLocalState="Sideways"'),
  primary: "web", extras: ["cache", "queue"], moveId: "api",
};
const rollbackMidWrite = await pluginRollback(ROLLBACK_CELLS, MID_WRITE);
const rollbackPreWrite = await pluginRollback(ROLLBACK_CELLS, PRE_WRITE);
// NC-46 clause 4: the same mid-write failure injected once, so the *next* valid relevant edit is a
// genuine success rather than a second failure.
const rollbackRecovery = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...MID_WRITE, ablate: ["failAfterWriteOnce"], recoverWith: "db",
});
// The controls. `failAfterWrite` is the shared *fixture* — the failure every one of them needs to
// have something to roll back, and the one the shipped plugin is green on above. Exactly one
// control name is added on top of it per run, so no result can be attributed to a second ablation.
const CONTROL = { ...MID_WRITE, dirtyPhase: false };
const rollbackTailOnly = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...CONTROL, ablate: ["failAfterWrite", "tailOnlyRollback"],
});
const rollbackRemoved = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...CONTROL, ablate: ["failAfterWrite", "noRollback"],
});
const rollbackSwallowed = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...CONTROL, ablate: ["failAfterWrite", "swallowDerivedWrite"],
});
const rollbackLate = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...CONTROL, ablate: ["failAfterWrite", "rollbackAtBeforeUndo"],
});
const rollbackLateIgnored = await pluginRollback([{ shape: "single", path: "hook" }], {
  ...CONTROL, ablate: ["failAfterWrite", "rollbackAtBeforeUndoIgnoreEdit"],
});

// NC-51's two isolated controls on the four cells C-16 never ran: the action inside an outer user
// transaction, where a tail-only rollback leaves the *foreign* changes committed and no rollback at
// all leaves the derived tail inside the user's own entry.
const NEW_CELLS = [{ shape: "multi", path: "action" }, { shape: "compound", path: "action" }];
const newCellsTailOnly = await pluginRollback(NEW_CELLS, {
  ...CONTROL, ablate: ["failAfterWrite", "tailOnlyRollback"],
});
const newCellsNoRollback = await pluginRollback(NEW_CELLS, {
  ...CONTROL, ablate: ["failAfterWrite", "noRollback"],
});

// NC-53's two isolated controls: the pre-C-17 bare message, and the same message reported twice.
const MESSAGE_CELL = [{ shape: "compound", path: "hook" }];
const rollbackBareMessage = await pluginRollback(MESSAGE_CELL, {
  ...CONTROL, ablate: ["failAfterWrite", "bareRollbackMessage"],
});
const rollbackReportedTwice = await pluginRollback(MESSAGE_CELL, {
  ...CONTROL, ablate: ["failAfterWrite", "reportTwice"],
});

// NC-50: the re-entrancy guard under a genuine forced nested entry, with its own negative control
// (the same run with nothing nested) and the `noReentrancyGuard` ablation for the opposite signature.
const nestingForced = await pluginForcedNesting("kitchen-sink");
const nestingUnforced = await pluginForcedNesting("kitchen-sink", { force: false });
const nestingUnguarded = await pluginForcedNesting("kitchen-sink", { ablate: ["noReentrancyGuard"] });

// NC-52: the host compatibility guard, on the bundled build and against three live per-instance
// ablations of the probe's own throwaway model — never of the active document.
const hostGuardHealthy = await pluginHostGuard("kitchen-sink");
const HOST_ABLATIONS = ["hostNoEndingUpdate", "hostGateBeforeEndUpdate", "hostNoChangeList"];
const hostGuardAblated = {};
for (const ablation of HOST_ABLATIONS) {
  hostGuardAblated[ablation] = await pluginHostGuard("kitchen-sink", { ablate: [ablation] });
}
// The split NC-52 clause 6 asserts explicitly: on the same disabled host, the eight mutating actions
// stay silent while read-only `ahmValidate` still reports the model's own defect.
const hostGuardValidate = await pluginHostGuard("kitchen-sink", {
  ablate: ["hostNoEndingUpdate"],
  mutate: (model) => model.replace(/(ahmId="db"[^>]*?)ahmLocalState="Healthy"/, '$1ahmLocalState="Sideways"'),
});

// NC-48: two genuinely independent `EditorUi` instances in one live page, one `factory()`.
const isolation = await pluginEditorIsolation("kitchen-sink");
const isolationShared = await pluginEditorIsolation("kitchen-sink", { ablate: ["sharedFactoryApi"] });

// NC-56: the four *active-model* identity checks, each ablated alone on the live editor's own model
// before `install()` reads it, plus the removal control for each — the check deleted from the
// plugin source, which must make its own patch stop being detected.
const ACTIVE_MODEL_REASONS = {
  modelNotStock: "model-not-stock",
  endUpdatePatched: "endUpdate-patched",
  endingUpdateNotBoolean: "endingUpdate-not-boolean",
  currentEditNoChanges: "currentEdit-no-changes",
};
const DROPPED_CHECK = {
  modelNotStock: "dropModelNotStockCheck",
  endUpdatePatched: "dropEndUpdatePatchedCheck",
  endingUpdateNotBoolean: "dropEndingUpdateBooleanCheck",
  currentEditNoChanges: "dropCurrentEditChangesCheck",
};
const hostGuardPatched = {};
const hostGuardCheckRemoved = {};
for (const patch of ACTIVE_MODEL_PATCHES) {
  hostGuardPatched[patch] = await pluginHostGuard("kitchen-sink", { patchActiveModel: patch });
  hostGuardCheckRemoved[patch] = await pluginHostGuard("kitchen-sink", {
    patchActiveModel: patch, ablate: [DROPPED_CHECK[patch]],
  });
}

// NC-57: one compatible and one incompatible editor in one live page, in both install orders, each
// with its own error sink — plus the shared-sink control, on which isolation is unassertable.
const MIXED_PATCH = "endUpdatePatched";
const isolationMixed = {
  "a-then-b": await pluginEditorIsolation("kitchen-sink", { patch: { b: MIXED_PATCH } }),
  "b-then-a": await pluginEditorIsolation("kitchen-sink", {
    patch: { a: MIXED_PATCH }, order: ["b", "a"],
  }),
};
const isolationSharedSink = await pluginEditorIsolation("kitchen-sink", {
  patch: { b: MIXED_PATCH }, sharedSink: true,
});

// NC-58: `ahmValidate` on a live compatible host, against a deliberately stale derived style, with
// `ahmRecalculate` in the same session as the positive control and both kill controls.
const SIDEWAYS = (model) => model
  .replace(/(ahmId="db"[^>]*?)ahmLocalState="Healthy"/, '$1ahmLocalState="Sideways"');
const validateRun = await pluginValidate("kitchen-sink");
const validatePreC18 = await pluginValidate("kitchen-sink", { ablate: ["validateRoutedByDisabled"] });
const validateReports = await pluginValidate("kitchen-sink", { mutate: SIDEWAYS });
const validateSwallowed = await pluginValidate("kitchen-sink", {
  mutate: SIDEWAYS, ablate: ["swallowValidationError"],
});

// NC-62: the same forced nesting driven with a **read-only** action — the state C-18 never drove.
// The `Sideways` fixture is what makes the discriminator visible: the nested validate has something
// to say, so an entry that is not blocked shows up as a second message rather than as nothing.
const NESTED_VALIDATE = { action: "ahmValidate", mutate: SIDEWAYS };
const nestedValidate = {};
for (const order of ["after", "before"]) {
  nestedValidate[order] = {
    forced: await pluginForcedNesting("kitchen-sink", { ...NESTED_VALIDATE, listenerOrder: order }),
    control: await pluginForcedNesting("kitchen-sink", {
      ...NESTED_VALIDATE, listenerOrder: order, force: false,
    }),
  };
}
// (v) the kill control, and (a) the C-18 ordering restored: both must show the nested validate
// actually running.
const nestedValidateUnguarded = await pluginForcedNesting("kitchen-sink", {
  ...NESTED_VALIDATE, ablate: ["noReentrancyGuard"],
});
const nestedValidatePreC19 = await pluginForcedNesting("kitchen-sink", {
  ...NESTED_VALIDATE, ablate: ["guardAfterReadOnlyRoute"],
});
// The same pair on the clean model, where the outer operation *succeeds*: the blocked entry must
// leave the write it encloses completely undisturbed.
const nestedValidateClean = {
  forced: await pluginForcedNesting("kitchen-sink", { action: "ahmValidate" }),
  control: await pluginForcedNesting("kitchen-sink", { action: "ahmValidate", force: false }),
};
// (vii) a nested `ahmValidate` fired from a foreign transaction that is *not* a plugin operation:
// the enclosing edit carries no health attribute, so the hook filters it out, nothing is in flight,
// and the validate must run exactly as a top-level one.
const nestedValidateOutside = await pluginForcedNesting("kitchen-sink", {
  action: "ahmValidate", outer: "foreignEdit", outerAttribute: "ahmNote", outerValue: "foreign",
  mutate: SIDEWAYS,
});
// (b) the hook's own self-suppression folded back into the public counter.
const nestingFolded = await pluginForcedNesting("kitchen-sink", {
  force: false, ablate: ["foldSelfSuppressionIntoBlocked"],
});
// NC-65 (v): the same forced nesting ridden in on the model's other dispatches, so "blocked" is not
// a property of END_UPDATE. Both are fired while the plugin's own mutating operation is in flight.
const nestedValidateEvents = {};
for (const event of ["EXECUTED", "BEFORE_UNDO"]) {
  nestedValidateEvents[event] = {
    forced: await pluginForcedNesting("kitchen-sink", { action: "ahmValidate", event }),
    control: await pluginForcedNesting("kitchen-sink", { action: "ahmValidate", event, force: false }),
  };
}

// NC-65: the path C-19 never drove. `ahmValidate` is a **top-level read-only** operation, and its
// own findings go out through `ui.handleError` — inside the operation. A sink that re-enters the
// plugin from there ran a second full validation on the C-19 shape: two messages, 288 model reads,
// `blockedReentries 0`. Each pair below is forced/unforced on the same driver, so every count is
// attributable to the forcing.
const SINK = { mutate: SIDEWAYS };
const sinkValidate = {
  forced: await pluginErrorSinkReentry("kitchen-sink", SINK),
  control: await pluginErrorSinkReentry("kitchen-sink", { ...SINK, force: false }),
};
const sinkMutating = {
  forced: await pluginErrorSinkReentry("kitchen-sink", { ...SINK, nested: "ahmSetUnhealthy" }),
  // The same nested mutating action with the guard's arming removed: it writes, so "no write" above
  // is a measurement against a fixture that can move rather than against a no-op.
  unguarded: await pluginErrorSinkReentry("kitchen-sink", {
    ...SINK, nested: "ahmSetUnhealthy", ablate: ["noOperationGuard"],
  }),
};
// (iv) no `ui.handleError` at all, so `report` re-throws out of the action.
const sinkThrows = await pluginErrorSinkReentry("kitchen-sink", { ...SINK, dropHandler: true });
// (viii) the same re-entry on a host the compatibility guard disabled.
const DISABLED_HOST = { ...SINK, patchActiveModel: "endUpdatePatched" };
const sinkDisabled = {
  forced: await pluginErrorSinkReentry("kitchen-sink", DISABLED_HOST),
  control: await pluginErrorSinkReentry("kitchen-sink", { ...DISABLED_HOST, force: false }),
};
// (vii) the kill control, and (c) the C-19 shape — the shared flag armed inside `runDrawio` only.
const sinkUnguarded = await pluginErrorSinkReentry("kitchen-sink", {
  ...SINK, ablate: ["noOperationGuard"],
});
const sinkGuardInDrawio = await pluginErrorSinkReentry("kitchen-sink", {
  ...SINK, ablate: ["guardInsideRunDrawio"],
});
// ...and the same C-19 shape on the *mutating* path, which it still blocks. That asymmetry is the
// discrimination NC-65 adds over NC-62.
const nestedValidateGuardInDrawio = await pluginForcedNesting("kitchen-sink", {
  ...NESTED_VALIDATE, ablate: ["guardInsideRunDrawio"],
});

function overlaps(a, b, tolerance = 0) {
  return a.x < right(b) - tolerance && right(a) > b.x + tolerance
    && a.y < bottom(b) - tolerance && bottom(a) > b.y + tolerance;
}

function inside(point, box, tolerance = 0) {
  return point.x > box.x + tolerance && point.x < right(box) - tolerance
    && point.y > box.y + tolerance && point.y < bottom(box) - tolerance;
}

// --- NC-16 / NC-17 geometry -------------------------------------------------------------------
// Everything below reads the *rendered* polyline (mxGraph's own `state.absolutePoints`) and the
// *rendered* label boxes, never generator input.

const STROKE_WIDTH = 2;
// 8px of *model* space. Connectors are painted at `strokeWidth 2`, so the visible gap is
// `separation - strokeWidth`: 6px here, ~2.6 device px at the ~0.43x zoom-to-fit of the widest
// example. The old 4px floor painted 2px, i.e. under one device pixel at that zoom — a value that
// measured as a pass while reading as one line. NC-15 re-derives this from the shipped canvas size.
const PARALLEL_MIN_SEPARATION = 8;
const PARALLEL_MIN_RUN = 20;
const LABEL_PADDING = 3;

// Decomposes a rendered polyline into axis-parallel segments. Rounded corners only shorten the
// straight portions, so this is a conservative view of what is actually painted.
function axisSegments(points) {
  const segments = [];
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1];
    const b = points[index];
    const dx = Math.abs(a.x - b.x);
    const dy = Math.abs(a.y - b.y);
    if (dy <= 0.5 && dx > 0.5) {
      segments.push({ axis: "h", at: (a.y + b.y) / 2, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
    } else if (dx <= 0.5 && dy > 0.5) {
      segments.push({ axis: "v", at: (a.x + b.x) / 2, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
    }
  }
  return segments;
}

function parallelRuns(edges) {
  const worst = { separation: Infinity, run: 0, pair: null };
  const violations = [];
  let crossings = 0;
  const all = edges.map((edge) => ({ id: edge.id, segments: axisSegments(edge.points) }));
  for (let left = 0; left < all.length; left++) {
    for (let right = left + 1; right < all.length; right++) {
      for (const a of all[left].segments) {
        for (const b of all[right].segments) {
          if (a.axis !== b.axis) {
            const [h, v] = a.axis === "h" ? [a, b] : [b, a];
            if (v.at >= h.lo && v.at <= h.hi && h.at >= v.lo && h.at <= v.hi) crossings++;
            continue;
          }
          const overlap = Math.min(a.hi, b.hi) - Math.max(a.lo, b.lo);
          if (overlap <= 0) continue;
          const separation = Math.abs(a.at - b.at);
          if (overlap > PARALLEL_MIN_RUN && separation < worst.separation) {
            worst.separation = separation;
            worst.run = overlap;
            worst.pair = `${all[left].id} || ${all[right].id}`;
          }
          if (overlap > PARALLEL_MIN_RUN && separation < PARALLEL_MIN_SEPARATION) {
            violations.push(
              `${all[left].id} || ${all[right].id} ${a.axis} run ${overlap.toFixed(0)}px sep ${separation.toFixed(2)}px`,
            );
          }
        }
      }
    }
  }
  return { violations, worst, crossings };
}

// Dependency labels are accepted in either representation: the old inline `edgeLabel` child or the
// new off-line `ahmRole="dependency-label"` capsule. The count is pinned to the source markdown so
// a label can never be dropped to satisfy the criterion.
function dependencyLabels(data) {
  return data.cells.filter((cell) => cell.attributes.ahmRole === "dependency-label"
    || cell.attributes.ahmPart === "edge-label");
}

// Rebuilds `source→target ⇒ label` straight from the example markdown so NC-19 compares text
// values, not counts. `parseGraph` normalises an authored `<br/>` to a single space — the same
// normalisation the repo's own swimlane renderer applies — so word content and order are exact and
// only the authored line break is dropped.
function sourceLabels(name) {
  const block = extractBlocks(readFileSync(resolve(root, `../${name}.md`), "utf8"))[0];
  const graph = foldSignals(parseGraph(block.code));
  return new Map(graph.edges.filter((edge) => (edge.label || "").length > 0)
    .map((edge) => [`${edge.from}→${edge.to}`, edge.label]));
}

function centreOf(box) {
  return { x: box.x + box.w / 2, y: box.y + box.h / 2 };
}

function labelBox(cell) {
  const box = (cell.text && cell.text.box) || cell.box;
  return {
    x: box.x - LABEL_PADDING, y: box.y - LABEL_PADDING,
    w: box.w + LABEL_PADDING * 2, h: box.h + LABEL_PADDING * 2,
  };
}

// --- C-11 signal table ------------------------------------------------------------------------
const TRANSPARENT = new Set([null, "none", "transparent", ""]);

// `owner ⇒ [{label, value}]` straight from example or fixture markdown, in authored order.
function sourceSignals(file) {
  const block = extractBlocks(readFileSync(file, "utf8"))[0];
  const graph = foldSignals(parseGraph(block.code));
  const out = new Map();
  for (const node of graph.nodes.values()) {
    if (!node.signals || !node.signals.length) continue;
    out.set(node.id, node.signals.map((row) => ({
      label: row.name, value: String(row.result ?? ""), state: row.state,
    })));
  }
  return out;
}
const exampleFile = (name) => resolve(root, `../${name}.md`);

function signalTable(data) {
  const childrenOf = (id) => data.cells.filter((cell) => cell.parent === id);
  return data.cells.filter((cell) => cell.attributes.ahmRole === "signal").map((row) => {
    const children = childrenOf(row.id);
    const pick = (part) => children.find((cell) => cell.attributes.ahmPart === part);
    return {
      row,
      owner: row.attributes.ahmOwner,
      children,
      icon: pick("signal-icon") || pick("signal-dot"),
      label: pick("signal-label"),
      value: pick("signal-result"),
    };
  });
}

// Every clause NC-27 asserts about one rendered signal table, as a pure function of a render, so
// the shipped examples, the long-label fixture and its save/reopen all go through one checker.
function tableViolations(name, data) {
  const byId = new Map(data.cells.map((cell) => [cell.id, cell]));
  const violations = [];
  const perCard = new Map();
  const table = signalTable(data);
  for (const entry of table) {
    const { row, icon, label, value } = entry;
    if (!icon || !label || !value) {
      violations.push(`${name}/${row.id} missing a column cell`);
      continue;
    }
    if (entry.children.length !== 3) {
      violations.push(`${name}/${row.id} has ${entry.children.length} content children, expected 3`);
    }
    const card = byId.get(row.parent);
    const gapIcon = label.box.x - (icon.box.x + icon.box.w);
    const gapValue = value.box.x - (label.box.x + label.box.w);
    if (gapIcon < 8) violations.push(`${name}/${row.id} icon→label gap ${gapIcon.toFixed(1)}`);
    if (gapValue < 8) violations.push(`${name}/${row.id} label→value gap ${gapValue.toFixed(1)}`);
    for (const [part, cell] of [["icon", icon], ["label", label], ["value", value]]) {
      if (Math.abs(centreOf(cell.box).y - centreOf(row.box).y) > 1.5) {
        violations.push(`${name}/${row.id} ${part} not vertically centred`);
      }
      if (!(cell.box.x - card.box.x >= 8 && card.box.x + card.box.w - (cell.box.x + cell.box.w) >= 8)) {
        violations.push(`${name}/${row.id} ${part} not inside the card with 8px clearance`);
      }
    }
    // The rendered glyphs, not the declared cell width: this is the clause a long authored label
    // used to be able to break, and the only one no shipped inventory exercises.
    if (label.text) {
      const textRight = label.text.box.x + label.text.box.w;
      if (value.box.x < textRight) {
        violations.push(`${name}/${row.id} label text enters the value column `
          + `(text right ${textRight.toFixed(1)} > value left ${value.box.x.toFixed(1)})`);
      }
      if (textRight > card.box.x + card.box.w - 8) {
        violations.push(`${name}/${row.id} label text leaves the card `
          + `(text right ${textRight.toFixed(1)})`);
      }
      if (label.text.box.y < row.box.y - 0.5 || label.text.box.y + label.text.box.h > row.box.y + row.box.h + 0.5) {
        violations.push(`${name}/${row.id} label text leaves its row`);
      }
    }
    if (!/align=right/.test(value.style)) violations.push(`${name}/${row.id} value not right-aligned`);
    const key = row.attributes.ahmOwner;
    const columns = `${round1(icon.box.x)}|${round1(label.box.x)}|${round1(value.box.x + value.box.w)}`;
    if (!perCard.has(key)) perCard.set(key, columns);
    else if (perCard.get(key) !== columns) {
      violations.push(`${name}/${key} column x drift: ${columns} vs ${perCard.get(key)}`);
    }
  }
  return { violations, rows: table.length };
}

function view(name) {
  const data = report[name];
  const byId = new Map(data.cells.map((cell) => [cell.id, cell]));
  const role = (value) => data.cells.filter((cell) => cell.attributes.ahmRole === value);
  const part = (value) => data.cells.filter((cell) => cell.attributes.ahmPart === value);
  return { name, data, byId, role, part };
}

const views = EXAMPLES.map(view);

test("geometry predicates flag a real violation (guards the checkers below)", () => {
  const card = { x: 0, y: 0, w: 100, h: 50 };
  assert.equal(overlaps({ x: 90, y: 40, w: 30, h: 30 }, card, 2), true, "overlapping boxes");
  assert.equal(overlaps({ x: 101, y: 0, w: 30, h: 30 }, card, 2), false, "disjoint boxes");
  assert.equal(inside({ x: 50, y: 25 }, card, 2), true, "interior point");
  assert.equal(inside({ x: 0, y: 25 }, card, 2), false, "boundary point");
});

test("NC-01 zero shadows in the model source and in the real render", () => {
  for (const { name, data } of views) {
    assert.match(sources[name].model, /<mxGraphModel[^>]*shadow="0"/, `${name} model shadow`);
    assert.equal((sources[name].model.match(/shadow=1/g) || []).length, 0, `${name} shadow=1`);
    assert.equal(data.graph.shadowVisible, false, `${name} shadowVisible`);
    assert.deepEqual(data.dom.filterNodes, [], `${name} filter nodes`);
    assert.equal(data.dom.dropShadowNodes, 0, `${name} drop-shadow nodes`);
  }
});

test("NC-02 every signal row stays inside its card with padding and rounded-corner clearance", () => {
  const violations = [];
  for (const { name, role, byId } of views) {
    const cards = new Map(role("entity").map((cell) => [cell.attributes.ahmId, cell]));
    for (const row of role("signal")) {
      const card = cards.get(row.attributes.ahmOwner);
      assert.ok(card, `${name}/${row.id} has no owner card`);
      const clearance = {
        left: row.box.x - card.box.x,
        right: right(card.box) - right(row.box),
        top: row.box.y - card.box.y,
        bottom: bottom(card.box) - bottom(row.box),
      };
      for (const [side, value] of Object.entries(clearance)) {
        if (value < PAD) violations.push(`${name}/${row.id} ${side}=${value.toFixed(2)}`);
      }
      // Rounded outline test: a corner inside the arc quadrant must lie inside the arc circle.
      const arc = 10;
      for (const corner of [
        { x: row.box.x, y: row.box.y }, { x: right(row.box), y: row.box.y },
        { x: row.box.x, y: bottom(row.box) }, { x: right(row.box), y: bottom(row.box) },
      ]) {
        const cx = corner.x < card.box.x + arc ? card.box.x + arc
          : corner.x > right(card.box) - arc ? right(card.box) - arc : corner.x;
        const cy = corner.y < card.box.y + arc ? card.box.y + arc
          : corner.y > bottom(card.box) - arc ? bottom(card.box) - arc : corner.y;
        if (Math.hypot(corner.x - cx, corner.y - cy) > arc) {
          violations.push(`${name}/${row.id} corner ${corner.x},${corner.y} outside arc`);
        }
      }
      assert.equal(byId.get(row.parent).id, card.id, `${name}/${row.id} parent`);
    }
  }
  assert.deepEqual(violations, []);
});

test("NC-19 label text is provably the authored text, keyed by dependency", () => {
  for (const { name, data } of views) {
    const authored = sourceLabels(name);
    const rendered = new Map(dependencyLabels(data).map((cell) => [
      `${cell.attributes.ahmSource}→${cell.attributes.ahmTarget}`,
      (cell.text && cell.text.content) || cell.attributes.label,
    ]));
    assert.deepEqual([...rendered.keys()].sort(), [...authored.keys()].sort(), `${name} label keys`);
    for (const [key, text] of authored) {
      assert.equal(rendered.get(key), text, `${name} label text for ${key}`);
    }
    // A `<br/>` in the source is normalised to one space; words and order must survive exactly.
    for (const text of rendered.values()) {
      assert.doesNotMatch(text, /<br\s*\/?>/i, `${name} unnormalised markup in a label`);
      assert.equal(text, text.trim().replace(/\s+/g, " "), `${name} label not normalised`);
    }
  }
});

test("NC-20 no custom routing survives anywhere", () => {
  const generator = readFileSync(resolve(root, "scripts/generate-artifacts.mjs"), "utf8");
  assert.doesNotMatch(generator, /Array as="points"/, "generator still emits a waypoint array");
  assert.doesNotMatch(generator, /trackOffset|corridorFor|labelCentreX|exitTrack|entryTrack/,
    "generator still carries a track or label-slot allocator");
  for (const { name, data } of views) {
    const { model } = sources[name];
    assert.doesNotMatch(model, /<Array as="points">/, `${name} persists waypoints`);
    const edgeCells = [...model.matchAll(/<mxCell[^>]*edge="1"[^>]*>([\s\S]*?)<\/mxCell>/g)];
    assert.equal(edgeCells.length, data.edges.length, `${name} edge count`);
    for (const [, body] of edgeCells) {
      assert.doesNotMatch(body, /<mxPoint/, `${name} edge geometry holds a manual point`);
    }
    for (const edge of data.edges) {
      assert.match(edge.style, /edgeStyle=orthogonalEdgeStyle/, `${name}/${edge.id} edge style`);
      assert.equal(edge.userPoints, 0, `${name}/${edge.id} carries ${edge.userPoints} saved points`);
    }
    // Labels are edgeLabel children of their own edge, never detached top-level vertices.
    const labels = dependencyLabels(data);
    const edgeIds = new Set(data.edges.map((edge) => edge.id));
    for (const label of labels) {
      assert.ok(edgeIds.has(label.parent),
        `${name}/${label.id} is parented to ${label.parent}, not to its edge`);
      assert.equal(label.parent, label.attributes.ahmEdge, `${name}/${label.id} ahmEdge mismatch`);
      assert.match(label.style, /^edgeLabel;/, `${name}/${label.id} is not a native edge label`);
      assert.notEqual(label.parent, "1", `${name}/${label.id} is a detached capsule`);
    }
  }

});

test("NC-21 edges and labels follow their entities around the board", async () => {
  const moves = {
    "kitchen-sink": [
      { id: "web", dx: 980, dy: -430 },
      { id: "secondary", dx: -1180, dy: 620 },
      { id: "root", dx: -430, dy: 260 },
      { id: "cache", dx: -620, dy: 300 },
    ],
    "pills-stress": [
      { id: "a", dx: 1120, dy: -380 },
      { id: "root", dx: 520, dy: 240 },
      { id: "shared", dx: -700, dy: -520 },
      { id: "other", dx: -380, dy: 420 },
    ],
  };
  const result = await moveExamples(moves);
  for (const [name, after] of Object.entries(result)) {
    const before = report[name];
    const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
    const moved = new Set(moves[name].map((move) => move.id));
    let rerouted = 0;
    for (const edge of after.edges) {
      const previous = beforeEdges.get(edge.id);
      assert.ok(previous, `${name}/${edge.id} disappeared`);
      assert.equal(edge.attributes.ahmSource, previous.attributes.ahmSource, `${name}/${edge.id} source`);
      assert.equal(edge.attributes.ahmTarget, previous.attributes.ahmTarget, `${name}/${edge.id} target`);
      assert.ok(edge.terminals.source && edge.terminals.target,
        `${name}/${edge.id} lost a terminal: ${JSON.stringify(edge.terminals)}`);
      assert.equal(edge.terminals.source, previous.terminals.source, `${name}/${edge.id} source id`);
      assert.equal(edge.terminals.target, previous.terminals.target, `${name}/${edge.id} target id`);
      assert.ok(edge.samples.length > 0, `${name}/${edge.id} has no rendered path`);
      assert.equal(edge.userPoints, 0, `${name}/${edge.id} gained saved waypoints`);
      const touches = moved.has(edge.attributes.ahmSource) || moved.has(edge.attributes.ahmTarget);
      if (touches) {
        assert.notEqual(edge.pathData, previous.pathData,
          `${name}/${edge.id} did not re-route although a terminal moved`);
        rerouted++;
      }
    }
    assert.ok(rerouted >= 4, `${name} only re-routed ${rerouted} connectors`);
    // The comparison must discriminate: connectors whose terminals did not move keep their path.
    const untouched = after.edges.filter((edge) => !moved.has(edge.attributes.ahmSource)
      && !moved.has(edge.attributes.ahmTarget));
    assert.ok(untouched.some((edge) => edge.pathData === beforeEdges.get(edge.id).pathData),
      `${name} every path changed, so the re-route assertion proves nothing`);

    const beforeLabels = new Map(dependencyLabels(before).map((cell) => [cell.id, cell]));
    let travelled = 0;
    for (const label of dependencyLabels(after)) {
      const previous = beforeLabels.get(label.id);
      assert.ok(previous, `${name}/${label.id} disappeared`);
      assert.equal(label.parent, label.attributes.ahmEdge, `${name}/${label.id} detached from its edge`);
      assert.ok(label.text && label.text.content.length > 0, `${name}/${label.id} lost its text`);
      const owner = after.edges.find((edge) => edge.id === label.parent);
      assert.ok(owner, `${name}/${label.id} has no edge`);
      const centre = centreOf(label.box);
      const onEdge = Math.min(...owner.samples
        .map((sample) => Math.hypot(sample.x - centre.x, sample.y - centre.y)));
      // Riding the connector, allowing for the rounded-corner arc and 1px path sampling. The
      // detached capsules this correction removed measured 16.0-78.0px off their edge, so 6px
      // still fails anything that is not actually attached.
      assert.ok(onEdge <= 6, `${name}/${label.id} sits ${onEdge.toFixed(1)}px off its own edge`);
      if (Math.hypot(centre.x - centreOf(previous.box).x, centre.y - centreOf(previous.box).y) > 20) {
        travelled++;
      }
    }
    assert.ok(travelled >= 1, `${name} no label travelled with its edge`);

    // Draw.io's own save path, then reopen: the moved geometry and the native routing survive.
    const reopened = after.reopened;
    assert.ok(reopened, `${name} move round trip missing`);
    assert.equal(reopened.graph.cells, after.graph.cells, `${name} cells after reopen`);
    const boxes = (source) => source.cells
      .filter((cell) => cell.attributes.ahmRole === "entity")
      .map((cell) => `${cell.attributes.ahmId}:${cell.box.x},${cell.box.y}`).sort();
    assert.deepEqual(boxes(reopened), boxes(after), `${name} moved geometry after reopen`);
    for (const edge of reopened.edges) {
      assert.equal(edge.userPoints, 0, `${name}/${edge.id} gained waypoints on save`);
      assert.match(edge.style, /edgeStyle=orthogonalEdgeStyle/, `${name}/${edge.id} style after reopen`);
    }
    assert.equal(dependencyLabels(reopened).length, dependencyLabels(after).length,
      `${name} labels after reopen`);
  }
});

test("NC-22 the shipped layout keeps every connector 8px clear of every other connector", () => {
  const measure = (edges) => {
    const result = parallelRuns(edges);
    return {
      minSeparation: Number.isFinite(result.worst.separation)
        ? Number(result.worst.separation.toFixed(2)) : null,
      longestRunAtMin: Math.round(result.worst.run),
      worstPair: result.worst.pair,
      orthogonalCrossings: result.crossings,
      violations: result.violations,
    };
  };
  const violations = [];
  const metrics = {};
  for (const { name, data } of views) {
    const { violations: found, ...rest } = measure(data.edges);
    metrics[name] = rest;
    violations.push(...found.map((entry) => `${name}/${entry}`));
  }
  console.log(`NC-22 parallel runs ${JSON.stringify(metrics)}`);
  assert.deepEqual(violations, []);

  // Negative control: the *real generator*, re-run with its three layout levers ablated, rendered
  // through this same Draw.io harness and read by this same checker. No rounded copies of an
  // already-passing measurement, no synthetic edge arrays.
  const ablated = {};
  for (const name of EXAMPLES) {
    assert.notEqual(ablatedBuilds[name].model, buildExample(name).model,
      `${name} ablation changed no geometry — the levers are not wired to the layout`);
    const { violations: found, ...rest } = measure(extra[`ablated-${name}`].edges);
    ablated[name] = { ...rest, violations: found.length };
  }
  console.log("NC-22 ablation (laneStagger [0,0,0] · portMinGap 0 · quantum 1) "
    + JSON.stringify(ablated));
  for (const name of EXAMPLES) {
    assert.ok(ablated[name].violations > 0,
      `${name} still passes with the layout levers ablated — the criterion measures nothing`);
  }
});

test("NC-23 the shipped layout draws no connector through visible content", () => {
  const violations = [];
  const report23 = {};
  for (const { name, data, role, part } of views) {
    const owner = (cell) => cell.attributes.ahmId || cell.attributes.ahmOwner
      || (cell.attributes.ahmEdge ? null : undefined);
    const contentOf = (cells, ownerOf) => cells.filter((cell) => cell.text && cell.text.box)
      .map((cell) => ({ id: cell.id, box: cell.text.box, own: ownerOf(cell) }));
    const ownerOfPart = (cell) => {
      let current = cell;
      while (current) {
        if (current.attributes.ahmRole === "entity") return current.attributes.ahmId;
        current = data.cells.find((other) => other.id === current.parent);
      }
      return null;
    };
    const content = [
      ...contentOf(part("title"), ownerOfPart),
      ...contentOf(part("qualifier"), ownerOfPart),
      ...contentOf(part("state-label"), ownerOfPart),
      ...contentOf(part("signal-label"), ownerOfPart),
      ...contentOf(part("signal-result"), ownerOfPart),
      ...part("state").map((cell) => ({ id: cell.id, box: cell.box, own: ownerOfPart(cell) })),
      ...part("state-dot").map((cell) => ({ id: cell.id, box: cell.box, own: ownerOfPart(cell) })),
      ...role("signal").map((cell) => ({ id: cell.id, box: cell.box, own: cell.attributes.ahmOwner })),
      ...role("lane").filter((lane) => lane.text)
        .map((lane, index) => ({ id: `lane-title-${index}`, box: lane.text.box, own: null })),
      ...data.cells.filter((cell) => /^legend-(panel|item|dot|bar|title)$/
        .test(cell.attributes.ahmPart || "")).map((cell) => ({ id: cell.id, box: cell.box, own: null })),
      // A native edgeLabel rides its own connector by design, so only *foreign* connectors are
      // checked against a label box; `ownEdge` carries that exemption.
      ...dependencyLabels(data).map((cell) => ({
        id: cell.id, box: labelBox(cell), own: null, ownEdge: cell.attributes.ahmEdge,
      })),
    ];
    let incidents = 0;
    for (const edge of data.edges) {
      const skip = new Set([edge.attributes.ahmSource, edge.attributes.ahmTarget]);
      const hit = new Set();
      for (const sample of edge.samples) {
        for (const target of content) {
          if (target.own && skip.has(target.own)) continue;
          if (target.ownEdge === edge.id) continue;
          if (inside(sample, target.box, 1)) hit.add(target.id);
        }
      }
      for (const id of hit) {
        incidents++;
        violations.push(`${name}/${edge.id} over ${id}`);
      }
    }
    // Card bodies are reported separately: the box metric, not the content metric.
    const cards = role("entity");
    let bodyIncidents = 0;
    for (const edge of data.edges) {
      const skip = new Set([edge.attributes.ahmSource, edge.attributes.ahmTarget]);
      for (const card of cards) {
        if (skip.has(card.attributes.ahmId)) continue;
        if (edge.samples.some((sample) => inside(sample, card.box, 2))) bodyIncidents++;
      }
    }
    report23[name] = { contentIncidents: incidents, cardBodyIncidents: bodyIncidents };

    // Labels collide with nothing.
    const labels = dependencyLabels(data).map((cell) => ({ id: cell.id, box: labelBox(cell) }));
    const obstacles = [
      ...cards.map((cell) => ({ id: cell.id, box: cell.box })),
      ...role("signal").map((cell) => ({ id: cell.id, box: cell.box })),
    ];
    for (let a = 0; a < labels.length; a++) {
      for (let b = a + 1; b < labels.length; b++) {
        if (overlaps(labels[a].box, labels[b].box)) {
          violations.push(`${name}/${labels[a].id} ∩ ${labels[b].id}`);
        }
      }
      for (const obstacle of obstacles) {
        if (overlaps(labels[a].box, obstacle.box)) {
          violations.push(`${name}/${labels[a].id} ∩ ${obstacle.id}`);
        }
      }
    }
  }
  console.log(`NC-23 intrusions ${JSON.stringify(report23)}`);
  assert.deepEqual([...new Set(violations)], []);
});

test("NC-24 cleanliness comes from ports and placement, never from a path", async () => {
  for (const { name, data } of views) {
    const { model } = sources[name];
    assert.doesNotMatch(model, /<Array as="points">/, `${name} persists waypoints`);
    const edgeCells = [...model.matchAll(/<mxCell[^>]*edge="1"[^>]*>([\s\S]*?)<\/mxCell>/g)];
    for (const [, body] of edgeCells) {
      assert.doesNotMatch(body, /<mxPoint/, `${name} edge geometry holds a manual point`);
    }
    for (const edge of data.edges) {
      assert.equal(edge.userPoints, 0, `${name}/${edge.id} carries saved points`);
      // Connectors declare where they attach and how they look — never where they go.
      const keys = edge.style.split(";").filter(Boolean).map((part) => part.split("=")[0]);
      const allowed = new Set([
        "edgeStyle", "rounded", "orthogonalLoop", "jettySize", "html", "shadow", "fontFamily",
        "noLabel", "strokeColor", "strokeWidth", "endArrow", "endFill", "endSize",
        "exitX", "exitY", "entryX", "entryY", "dashed", "dashPattern",
      ]);
      for (const key of keys) assert.ok(allowed.has(key), `${name}/${edge.id} style key ${key}`);
      assert.equal(edge.style.match(/edgeStyle=([^;]+)/)[1], "orthogonalEdgeStyle",
        `${name}/${edge.id} edge style`);
    }
  }
  const generator = readFileSync(resolve(root, "scripts/generate-artifacts.mjs"), "utf8");
  assert.doesNotMatch(generator, /Array as="points"/, "generator emits a waypoint array");
  assert.doesNotMatch(generator, /trackOffset|corridorFor|labelCentreX|exitTrack|entryTrack/,
    "generator carries a track or label-slot allocator");

  // Real negative control: inject one waypoint through the live model and re-measure. This runs the
  // checker, unlike the string-literal guard it replaces.
  const injected = await injectWaypoint("hero", "edge-0", { x: 500, y: 500 });
  assert.equal(injected.userPoints, 1, "injection did not take");
  assert.ok(injected.exportedPointArrays > 0,
    "a waypoint survived into the export but the checker did not see it");
});

test("NC-25 the read-only render command is read-only", () => {
  const watched = [
    ...EXAMPLES.map((name) => `examples/${name}.drawio.svg`),
    ...EXAMPLES.map((name) => `visual/native-${name}.png`),
    "visual/native-report.json",
  ].map((relative) => resolve(root, relative));
  // `report` above came from a bare `renderExamples(...)` with no `write`, i.e. the same path
  // `node visual/render-native.mjs` takes. Nothing it touched may have changed.
  for (const file of watched) {
    assert.ok(existsSync(file), `${file} missing`);
  }
  for (const name of EXAMPLES) {
    assert.equal(report[name].image, null, `${name} wrote a PNG during a read-only run`);
  }
  const source = readFileSync(resolve(root, "visual/render-native.mjs"), "utf8");
  assert.match(source, /const screenshot = options\.screenshot \?\? write;/,
    "screenshots are not gated on --write");
  assert.match(source, /if \(write\) writeAtomic\(file, exported\);/,
    "the artifact write is not gated on --write");
  assert.match(source, /if \(write\) \{[\s\S]*?writeAtomic\(\s*\n?\s*resolve\(root, `visual\/\$\{prefix\}-report\.json`\)/,
    "the report is not gated on --write");
});

test("NC-26 signal rows carry no card surface of their own", () => {
  const violations = [];
  for (const { name, data, role, part, byId } of views) {
    for (const row of role("signal")) {
      if (!TRANSPARENT.has(row.shape && row.shape.fill)) {
        violations.push(`${name}/${row.id} fill ${row.shape.fill}`);
      }
      if (!TRANSPARENT.has(row.shape && row.shape.stroke)) {
        violations.push(`${name}/${row.id} stroke ${row.shape.stroke}`);
      }
      for (const child of data.cells.filter((cell) => cell.parent === row.id)) {
        if (child.shape && child.shape.tag === "path" && !TRANSPARENT.has(child.shape.fill)
          && /rounded=1/.test(child.style)) {
          violations.push(`${name}/${child.id} is a filled rounded background`);
        }
      }
    }
    assert.equal(part("signal-bar").length, 0, `${name} still emits metric bars in rows`);
    const dividers = part("signal-divider");
    const perCard = new Map();
    for (const row of role("signal")) {
      perCard.set(row.attributes.ahmOwner, (perCard.get(row.attributes.ahmOwner) || 0) + 1);
    }
    const dividersPerCard = new Map();
    for (const divider of dividers) {
      const owner = byId.get(divider.parent).attributes.ahmId;
      dividersPerCard.set(owner, (dividersPerCard.get(owner) || 0) + 1);
      if (color(divider.shape.stroke) !== color(theme.hair)) {
        violations.push(`${name}/${divider.id} stroke ${divider.shape.stroke} != ${theme.hair}`);
      }
    }
    for (const [owner, rows] of perCard) {
      const expected = rows - 1;
      const actual = dividersPerCard.get(owner) || 0;
      if (actual !== expected) violations.push(`${name}/${owner} ${actual} dividers, expected ${expected}`);
    }
  }
  assert.deepEqual(violations, []);
});

test("NC-27 a signal label can never enter the value column, at any authored length", () => {
  const violations = [];
  const counted = {};
  for (const { name, data } of views) {
    const result = tableViolations(name, data);
    counted[name] = result.rows;
    violations.push(...result.violations);
  }
  console.log(`NC-27 rows measured ${JSON.stringify(counted)}`);
  assert.deepEqual(violations, []);
  assert.deepEqual(counted, { hero: 18, "kitchen-sink": 35, "pills-stress": 14 });

  // Boundary fixture: authored labels past the 136px label column — one just over it, one needing
  // three lines, one unbreakable token, one long enough to be ellipsized. Fixture-only; no shipped
  // inventory gains an invented label (NC-29 keeps that honest).
  const fixture = extra["fixture-labels"];
  const fixtureRows = signalTable(fixture);
  const authored = [...sourceSignals(fixtureFile(FIXTURES.labels)).values()].flat();
  assert.equal(fixtureRows.length, authored.length, "long-label fixture rendered no rows");

  const measured = fixtureRows.map((entry, index) => ({
    stored: entry.label.attributes.ahmLabel,
    authored: authored[index].label,
    rendered: entry.label.text.content,
    lines: entry.label.text.lines.length,
    clipped: entry.label.attributes.ahmLabelClipped === "1",
    authoredWidth: Number(entry.label.text.box.w.toFixed(1)),
    valueLeft: Number(entry.value.box.x.toFixed(1)),
    rowH: Number(entry.row.box.h.toFixed(1)),
  }));
  console.log(`NC-27 long-label fixture ${JSON.stringify(measured)}`);

  // Structural containment, measured on the render, then again on Draw.io's own saved bytes.
  assert.deepEqual(tableViolations("fixture-labels", fixture).violations, []);
  assert.deepEqual(tableViolations("fixture-labels/reopened", fixture.reopened).violations, []);

  // The model keeps the exact authored string even where the render had to wrap or ellipsize.
  for (const row of measured) assert.equal(row.stored, row.authored, "stored label is not authored");
  assert.deepEqual(
    signalTable(fixture.reopened).map((entry) => entry.label.attributes.ahmLabel),
    authored.map((row) => row.label),
    "save/reopen lost an authored label",
  );
  // The fixture has to actually exercise the containment, or it proves nothing.
  assert.ok(measured.some((row) => row.lines > 1), "no fixture label wrapped");
  assert.ok(measured.some((row) => row.clipped), "no fixture label was ellipsized");
  assert.ok(measured.some((row) => row.rendered !== row.authored),
    "every fixture label fitted unchanged — the fixture is not past the column");
  // Growth is in the row, not in the card width: a wider card would shrink the whole canvas at
  // fit-zoom, which is the readability defect NC-22 is spending pixels on.
  const cards = new Map(fixture.cells.map((cell) => [cell.id, cell]));
  for (const entry of fixtureRows) {
    assert.equal(round1(cards.get(entry.row.parent).box.w), round1(LAYOUT.cardW),
      "the fixture widened its card");
  }
  assert.ok(measured.some((row) => row.rowH > LAYOUT.rowH), "no row grew to hold a wrapped label");
});

// Glyph and colour are two independent dimensions of the same rendered icon. This checker reads
// each of them separately so a mutation in either one is caught on its own.
function glyphColourViolations(pairs) {
  const violations = [];
  const byGlyph = new Map();
  const byFill = new Map();
  for (const pair of pairs) {
    const token = theme.state[TOKEN[pair.state]];
    if (!token) { violations.push(`${pair.key} unknown state ${pair.state}`); continue; }
    if (!pair.glyph) violations.push(`${pair.key} icon has no glyph`);
    if (color(pair.fill) !== color(token.dot)) {
      violations.push(`${pair.key} fill ${pair.fill} != ${token.dot} for ${pair.state}`);
    }
    if (byGlyph.has(pair.glyph) && byGlyph.get(pair.glyph) !== pair.state) {
      violations.push(`${pair.key} glyph ${pair.glyph} shared by ${byGlyph.get(pair.glyph)} and ${pair.state}`);
    }
    byGlyph.set(pair.glyph, pair.state);
    if (byFill.has(color(pair.fill)) && byFill.get(color(pair.fill)) !== pair.state) {
      violations.push(`${pair.key} fill ${pair.fill} shared by ${byFill.get(color(pair.fill))} and ${pair.state}`);
    }
    byFill.set(color(pair.fill), pair.state);
  }
  return violations;
}

function iconPairs(name, data) {
  return signalTable(data).map((entry) => ({
    key: `${name}/${entry.row.id}`,
    state: entry.row.attributes.ahmState,
    glyph: entry.icon && entry.icon.text && entry.icon.text.content,
    fill: entry.icon && entry.icon.shape && entry.icon.shape.fill,
  }));
}

test("NC-28 every signal state is rendered with its own glyph and its own theme colour", () => {
  const pairs = [
    ...views.flatMap(({ name, data }) => iconPairs(name, data)),
    ...iconPairs("fixture-states", extra["fixture-states"]),
  ];
  const inventory = {};
  for (const pair of pairs) {
    inventory[`${pair.glyph} ${color(pair.fill)}`] = (inventory[`${pair.glyph} ${color(pair.fill)}`] || 0) + 1;
  }
  console.log(`NC-28 rendered glyph/fill inventory ${JSON.stringify(inventory)}`);
  assert.deepEqual(glyphColourViolations(pairs), []);

  // Every state the parser can produce reaches the canvas at least once, `unknown` included.
  const rendered = new Map(pairs.map((pair) => [TOKEN[pair.state], pair]));
  for (const state of SIGNAL_STATES) {
    const seen = rendered.get(AUTHORED[state]);
    assert.ok(seen, `state ${state} is never rendered`);
    assert.equal(seen.glyph, SIGNAL_GLYPH[state], `state ${state} rendered the wrong glyph`);
    assert.equal(color(seen.fill), color(theme.state[AUTHORED[state]].dot),
      `state ${state} rendered the wrong colour`);
  }
  assert.equal(new Set(pairs.map((pair) => pair.glyph)).size, SIGNAL_STATES.length);
  assert.equal(new Set(pairs.map((pair) => color(pair.fill))).size, SIGNAL_STATES.length);

  // Mutation controls, one per dimension: collapsing the glyphs must be caught by the glyph clause
  // alone, and collapsing the fills by the colour clause alone. Neither hides behind the other.
  const glyphCollapsed = pairs.map((pair) => ({ ...pair, glyph: SIGNAL_GLYPH.healthy }));
  const fillCollapsed = pairs.map((pair) => ({ ...pair, fill: theme.state.healthy.dot }));
  const glyphFailures = glyphColourViolations(glyphCollapsed);
  const fillFailures = glyphColourViolations(fillCollapsed);
  assert.ok(glyphFailures.some((line) => /glyph .* shared by/.test(line)), "glyph collision undetected");
  assert.ok(fillFailures.some((line) => / != /.test(line)), "wrong colour undetected");
  assert.ok(glyphFailures.every((line) => !/ != /.test(line)),
    "the glyph mutation also tripped the colour clause — the dimensions are not independent");

  // Standby is an entity class, never a signal state: `src/swimlane.mjs` ROW_RE accepts only the
  // four states above, so an authored `(standby)` is not a state at all. The generator rejects it
  // explicitly at its public boundary instead of silently borrowing the Healthy glyph.
  const authoredStandby = foldSignals(parseGraph(
    'flowchart BT\n  s["Failover = ready (standby)"] --> a["A<br/>healthy"]\n'
    + "  classDef blue fill:#eff6fc,stroke:#0078D4;\n  class s blue;\n  class a green;\n",
  ));
  const parsedRow = [...authoredStandby.nodes.values()].find((node) => node.signals)?.signals[0];
  assert.equal(parsedRow.state, "healthy", "the parser gained a standby signal state");
  assert.equal(parsedRow.name, "Failover = ready (standby)",
    "the parser silently consumed an unsupported state word");
  assert.throws(() => signalState("standby"), /unsupported signal state "standby"/);
  assert.throws(() => buildModel({
    name: "standby-probe", title: "Standby probe", edges: [],
    entities: [{
      id: "a", label: "A", qualifier: "", state: "healthy", lane: 0,
      signals: [{ name: "Failover", state: "standby", result: "ready" }],
    }],
  }), /unsupported signal state "standby"/);
  const generator = readFileSync(resolve(root, "scripts/generate-artifacts.mjs"), "utf8");
  assert.doesNotMatch(generator, /\|\| SIGNAL_GLYPH\.healthy/, "the glyph fallback is back");
  assert.doesNotMatch(generator, /\|\| theme\.state\.healthy/, "the colour fallback is back");
  assert.doesNotMatch(generator, /\|\| "Healthy"/, "the state-word fallback is back");
});

// Every clause NC-30 asserts about one rendered library entry, as a pure function of a render, so
// the shipped entries and the deliberately flattened control run through one checker.
function libraryViolations(name, data, xml) {
  const violations = [...tableViolations(name, data).violations];
  const semantic = data.cells.filter((cell) => Object.keys(cell.attributes).length > 0);
  if (!semantic.length) violations.push(`${name} rendered no semantic cells`);
  for (const cell of semantic) {
    if (!cell.vertex && !cell.edge) violations.push(`${name}/${cell.id} is neither vertex nor edge`);
    if (cell.locked) violations.push(`${name}/${cell.id} is locked`);
    if (!cell.editable) violations.push(`${name}/${cell.id} is not editable`);
  }
  for (const row of data.cells.filter((cell) => cell.attributes.ahmRole === "signal")) {
    if (!TRANSPARENT.has(row.shape && row.shape.fill)) {
      violations.push(`${name}/${row.id} row fill ${row.shape.fill}`);
    }
    if (!TRANSPARENT.has(row.shape && row.shape.stroke)) {
      violations.push(`${name}/${row.id} row stroke ${row.shape.stroke}`);
    }
    if (/rounded=1/.test(row.style)) violations.push(`${name}/${row.id} row is a rounded card`);
  }
  if (data.cells.some((cell) => cell.attributes.ahmPart === "signal-bar")) {
    violations.push(`${name} still emits metric bars in rows`);
  }
  violations.push(...glyphColourViolations(iconPairs(name, data)));
  if (xml != null) {
    if (/<image\b|<foreignObject\b|data:image/i.test(xml)) violations.push(`${name} carries non-native content`);
    if (/locked="1"|editable="0"/.test(xml)) violations.push(`${name} declares a locked cell`);
    if (!/<mxCell id="0"\/>/.test(xml) || !/<mxCell id="1" parent="0"\/>/.test(xml)) {
      violations.push(`${name} has no native mxGraphModel root`);
    }
    const declared = (xml.match(/<mxCell\b/g) || []).length - 2;
    if (declared !== data.cells.filter((cell) => cell.vertex || cell.edge).length) {
      violations.push(`${name} declares ${declared} mxCells but rendered `
        + `${data.cells.filter((cell) => cell.vertex || cell.edge).length}`);
    }
  }
  return violations;
}

test("NC-30 every shape-library entry renders as a native editable model in Draw.io", () => {
  const violations = [];
  const summary = {};
  libraryEntries.forEach((entry, index) => {
    const data = extra[`library-${index}`];
    assert.ok(data, `library entry ${entry.title} never rendered`);
    summary[entry.title] = {
      cells: data.cells.length,
      rows: signalTable(data).length,
      declared: `${entry.w}x${entry.h}`,
    };
    violations.push(...libraryViolations(entry.title, data, entry.xml));
    // Draw.io's own saved bytes, reopened: an entry that only survives in memory is not shipped.
    violations.push(...libraryViolations(`${entry.title}/reopened`, data.reopened));
    if (data.reopened.cells.length !== data.cells.length) {
      violations.push(`${entry.title} lost cells across save/reopen`);
    }
  });
  console.log(`NC-30 library entries ${JSON.stringify(summary)}`);
  assert.deepEqual(violations, []);
  assert.ok(libraryEntries.some((entry) => /metrics/i.test(entry.title)),
    "no library entry carries a signal table");
  assert.ok(Object.values(summary).some((entry) => entry.rows > 0),
    "no library entry rendered a signal row");

  // Runtime negative control: the same entry, regenerated with a filled, stroked, rounded row card
  // put back, rendered through the same harness and read by this same checker.
  const flattened = libraryViolations("library-flattened", extra["library-flattened"]);
  console.log(`NC-30 flattened control ${JSON.stringify(flattened.slice(0, 4))}`);
  assert.ok(flattened.length > 0, "a flattened row card renders clean — the checker measures nothing");

  // Malformed input is rejected at the public reopen boundary, not silently half-loaded.
  assert.throws(() => decodeLibrary("[]"), /missing <mxlibrary> wrapper/);
  assert.throws(() => decodeLibrary("<mxlibrary>[]</mxlibrary>"), /library holds no entries/);
  assert.throws(
    () => decodeLibrary('<mxlibrary>[{"title":"x","xml":"<svg/>"}]</mxlibrary>'),
    /carries no mxGraphModel/,
  );
  assert.throws(() => decodeLibrary("<mxlibrary>{ nope </mxlibrary>"), SyntaxError);
});

test("NC-29 signal labels and values are still exactly the authored data", () => {
  for (const { name, data } of views) {
    const authored = sourceSignals(exampleFile(name));
    const rendered = new Map();
    for (const entry of signalTable(data)) {
      if (!rendered.has(entry.owner)) rendered.set(entry.owner, []);
      rendered.get(entry.owner).push({
        label: entry.label.text.content,
        value: entry.value.text ? entry.value.text.content : "",
      });
    }
    assert.deepEqual([...rendered.keys()].sort(), [...authored.keys()].sort(), `${name} signal owners`);
    for (const [owner, rows] of authored) {
      assert.deepEqual(
        rendered.get(owner),
        rows.map((row) => ({ label: row.label, value: row.value })),
        `${name}/${owner} signal rows`,
      );
    }
  }
});

test("NC-04 every state pill is aligned, legible and contained", () => {
  const violations = [];
  let pills = 0;
  for (const { name, role, part, byId } of views) {
    const cards = new Map(role("entity").map((cell) => [cell.attributes.ahmId, cell]));
    for (const pill of part("state")) {
      pills++;
      const card = byId.get(pill.parent);
      const dot = part("state-dot").find((cell) => cell.parent === pill.id);
      const label = part("state-label").find((cell) => cell.parent === pill.id);
      const textBox = label.text.box;
      const gap = textBox.x - right(dot.box);
      const record = (condition, message) => {
        if (!condition) violations.push(`${name}/${pill.id} ${message}`);
      };
      record(gap >= 6, `dot-to-text gap ${gap.toFixed(2)}`);
      record(Math.abs(centreY(dot.box) - centreY(pill.box)) <= 1, "dot not vertically centred");
      record(Math.abs(centreY(textBox) - centreY(pill.box)) <= 1.5, "text not vertically centred");
      record(right(textBox) <= right(pill.box) - 6, "text overruns the pill");
      record(pill.box.x - card.box.x >= PAD && right(card.box) - right(pill.box) >= PAD
        && pill.box.y - card.box.y >= PAD && bottom(card.box) - bottom(pill.box) >= PAD,
      "pill not inside card with 8px clearance");
      for (const other of [
        ...part("title"), ...part("qualifier"), ...role("signal"),
      ].filter((cell) => cell.parent === card.id)) {
        record(!overlaps(pill.box, other.box, 0), `overlaps ${other.id}`);
      }
      assert.ok(cards.has(card.attributes.ahmId), `${name} pill owner is an entity`);
    }
  }
  assert.deepEqual(violations, []);
  assert.ok(pills >= 36, `expected all pills measured, got ${pills}`);
});

// --- NC-32: the same guarantee on the *runtime* surface ----------------------------------------
// NC-04 above proves the generated pills. This proves the pills the plugin produces when a state
// changes in the live editor — the path that recreated the user's "text touches the circle" defect
// after C-12 had fixed the generated one.

const PILL_TAIL_FLOOR = 6;
const PILL_GAP_FLOOR = 8;

function pillClauses(step, key = "measured") {
  const id = step.pill ?? step.entity;
  const byId = new Map(step[key].cells.map((cell) => [cell.id, cell]));
  const pill = byId.get(`${id}-state`);
  const dot = byId.get(`${id}-state-dot`);
  const label = byId.get(`${id}-state-label`);
  const card = byId.get(pill.parent);
  const text = label.text.box;
  return {
    shown: label.text.content,
    trailingPad: round1(right(pill.box) - right(text)),
    dotGap: round1(text.x - right(dot.box)),
    dotOffset: round1(Math.abs(centreY(dot.box) - centreY(pill.box))),
    textOffset: round1(Math.abs(centreY(text) - centreY(pill.box))),
    contained: pill.box.x - card.box.x >= PAD && right(card.box) - right(pill.box) >= PAD
      && pill.box.y - card.box.y >= PAD && bottom(card.box) - bottom(pill.box) >= PAD,
    pillWidth: round1(pill.box.w),
  };
}

function pillViolations(run, key = "measured") {
  const violations = [];
  for (const step of run.steps) {
    const clause = pillClauses(step, key);
    const where = `${step.entity}->${step.state}${key === "measured" ? "" : ` ${key}`} (${clause.shown})`;
    if (!(clause.trailingPad >= PILL_TAIL_FLOOR)) {
      violations.push(`${where} trailing pad ${clause.trailingPad}`);
    }
    if (!(clause.dotGap >= PILL_GAP_FLOOR)) violations.push(`${where} dot-to-text gap ${clause.dotGap}`);
    if (!(clause.dotOffset <= 1)) violations.push(`${where} dot not vertically centred`);
    if (!(clause.textOffset <= 1.5)) violations.push(`${where} text not vertically centred`);
    if (!clause.contained) violations.push(`${where} pill not inside card with 8px clearance`);
  }
  return violations;
}

test("NC-32 a runtime state change leaves the pill correctly sized, aligned and contained", () => {
  const clauses = pillRuntime.steps.map((item) => pillClauses(item));
  console.log(`NC-32 runtime pill clauses ${JSON.stringify(clauses)}`);
  assert.deepEqual(pillViolations(pillRuntime), []);
  // Every presented label the plugin can produce, reached by a real transition in the live editor.
  assert.deepEqual([...new Set(clauses.map((clause) => clause.shown))].sort(),
    ["Degraded", "Healthy", "Standby", "Unhealthy", "Unknown"]);

  // The same four clauses, re-read from the rendered pill after one undo and after one redo — each
  // taken after a settle longer than any timer the plugin could hold.
  console.log(`NC-32 rendered after undo ${JSON.stringify(pillRuntime.steps.map((s) => pillClauses(s, "measuredUndone")))}`);
  console.log(`NC-32 rendered after redo ${JSON.stringify(pillRuntime.steps.map((s) => pillClauses(s, "measuredRedone")))}`);
  assert.deepEqual(pillViolations(pillRuntime, "measuredUndone"), []);
  assert.deepEqual(pillViolations(pillRuntime, "measuredRedone"), []);
  // A redo returns the transitioned label; an undo returns the one before it.
  for (const step of pillRuntime.steps) {
    assert.equal(pillClauses(step, "measuredRedone").shown, pillClauses(step).shown,
      `${step.entity}->${step.state} redo label`);
    assert.equal(pillClauses(step, "measuredRedone").pillWidth, pillClauses(step).pillWidth,
      `${step.entity}->${step.state} redo pill width`);
  }

  for (const step of pillRuntime.steps) {
    const where = `${step.entity}->${step.state}`;
    const { before, after, undone, redone, recorded } = step.transaction;
    // One transaction, including every transitive rollup the transition caused.
    assert.equal(recorded, 1, `${where} recorded ${recorded} undoable edits`);
    // One undo restores the previous label *and* the previous pill/label geometry together.
    assert.equal(undone.label.label, before.label.label, `${where} undo label`);
    assert.equal(undone.pill.width, before.pill.width, `${where} undo pill width`);
    assert.equal(undone.pill.x, before.pill.x, `${where} undo pill x`);
    assert.equal(undone.label.width, before.label.width, `${where} undo label width`);
    assert.equal(redone.pill.width, after.pill.width, `${where} redo pill width`);
    assert.equal(redone.label.label, after.label.label, `${where} redo label`);
  }

  // The transitioned geometry survives Draw.io's own xmlsvg export and a reopen.
  const reopened = new Map(pillRuntime.reopened.cells.map((cell) => [cell.id, cell]));
  const final = new Map(pillRuntime.steps.at(-1).measured.cells.map((cell) => [cell.id, cell]));
  for (const id of ["web-state", "auth-state", "secondary-state"]) {
    assert.equal(round1(reopened.get(id).box.w), round1(final.get(id).box.w), `${id} width after reopen`);
    assert.equal(round1(reopened.get(id).box.x), round1(final.get(id).box.x), `${id} x after reopen`);
    assert.equal(reopened.get(`${id}-label`).text.content, final.get(`${id}-label`).text.content,
      `${id} label after reopen`);
  }
  assert.ok(pillRuntime.exportBytes > 40000, "the plugin export produced no real bytes");
});

test("NC-32 negative control: without the geometry update the same run reports the overrun", () => {
  const violations = pillViolations(pillAblated);
  const clauses = pillAblated.steps.map((item) => pillClauses(item));
  console.log(`NC-32 ablated pill clauses ${JSON.stringify(clauses)}`);
  assert.notDeepEqual(violations, [], "the ablated plugin must fail the same check");
  // The exact value the shipped plugin produced before C-13, on the user's own case.
  assert.ok(violations.some((line) => /web->Degraded \(Degraded\) trailing pad 1\.1/.test(line)),
    `expected the 1.08px Degraded overrun, got ${JSON.stringify(violations)}`);
  assert.ok(violations.some((line) => /Unhealthy\) trailing pad (-|0)/.test(line)),
    `expected the Unhealthy overrun, got ${JSON.stringify(violations)}`);
  // And the ablated run never restores geometry on undo, because it never changed any.
  assert.ok(pillAblated.steps.every((step) => step.transaction.after.pill.width
    === step.transaction.before.pill.width), "the ablation still resized the pill");
});

test("NC-32 negative control: a shrinking transition does not leave an oversized pill", () => {
  // Unhealthy -> Healthy. The pill may keep at most the tail pad the card already carries (10px in
  // every shipped card) plus the generator's own 2px rounding cushion.
  const shrink = pillRuntime.steps.find((step) => step.entity === "web" && step.state === "Healthy");
  const clause = pillClauses(shrink);
  const grew = pillRuntime.steps.find((step) => step.entity === "web" && step.state === "Unhealthy");
  console.log(`NC-32 shrink ${JSON.stringify({ from: pillClauses(grew), to: clause })}`);
  assert.ok(clause.pillWidth < pillClauses(grew).pillWidth, "the pill did not shrink with its label");
  assert.ok(clause.trailingPad <= 13,
    `Healthy pill keeps ${clause.trailingPad}px of trailing pad — wider than the text needs`);
});


test("NC-05 every rendered color is byte-identical to src/themes.mjs", () => {
  const violations = [];
  const generator = readFileSync(resolve(root, "scripts/generate-artifacts.mjs"), "utf8");
  assert.doesNotMatch(generator, /["'`]#[0-9a-fA-F]{3,8}["'`]/, "generator holds a palette literal");
  for (const { name, role, part, byId } of views) {
    for (const card of role("entity")) {
      const token = shownToken(card);
      if (color(card.shape.fill) !== color(token.fill)) {
        violations.push(`${name}/${card.id} fill ${card.shape.fill} != ${token.fill}`);
      }
      if (color(card.shape.stroke) !== color(token.border)) {
        violations.push(`${name}/${card.id} stroke ${card.shape.stroke} != ${token.border}`);
      }
    }
    for (const dot of part("state-dot")) {
      const card = byId.get(byId.get(dot.parent).parent);
      const token = shownToken(card);
      if (color(dot.shape.fill) !== color(token.dot)) {
        violations.push(`${name}/${dot.id} dot ${dot.shape.fill} != ${token.dot}`);
      }
    }
    // Signal rows carry no surface of their own (NC-26); the state colour lives on the row icon and
    // the separator on the hairline, and both are checked against the theme here.
    for (const icon of part("signal-icon")) {
      const row = byId.get(icon.parent);
      const token = theme.state[TOKEN[row.attributes.ahmState]];
      if (color(icon.shape.fill) !== color(token.dot)) {
        violations.push(`${name}/${icon.id} signal icon ${icon.shape.fill} != ${token.dot}`);
      }
    }
    for (const divider of part("signal-divider")) {
      if (color(divider.shape.stroke) !== color(theme.hair)) {
        violations.push(`${name}/${divider.id} divider ${divider.shape.stroke} != ${theme.hair}`);
      }
    }
  }
  assert.deepEqual(violations, []);
  assert.ok(views.some(({ role }) => role("entity")
    .some((cell) => cell.attributes.ahmAuthoredState === "standby")), "Standby is exercised");
});

test("NC-06 dependency edges carry the source state color and impact styling", () => {
  const violations = [];
  const patterns = new Map();
  for (const { name, data, role } of views) {
    const shown = new Map(role("entity").map((cell) => [cell.attributes.ahmId, shownOf(cell)]));
    for (const edge of data.edges) {
      const token = theme.state[TOKEN[shown.get(edge.attributes.ahmSource)]];
      if (color(edge.shape.stroke) !== color(token.dot)) {
        violations.push(`${name}/${edge.id} stroke ${edge.shape.stroke} != ${token.dot}`);
      }
      const dash = edge.shape.dasharray;
      if (edge.attributes.ahmImpact === "standard") {
        if (dash) violations.push(`${name}/${edge.id} standard edge is dashed (${dash})`);
      } else {
        if (!dash) violations.push(`${name}/${edge.id} ${edge.attributes.ahmImpact} is not dashed`);
        patterns.set(edge.attributes.ahmImpact, dash);
      }
      // Draw.io's own router decides the shape; the model stores none of it (see NC-20).
      if (edge.points.length < 2) {
        violations.push(`${name}/${edge.id} rendered ${edge.points.length} route points`);
      }
    }
    const edgeCells = [...sources[name].model.matchAll(/<mxCell[^>]*edge="1"[^>]*>([\s\S]*?)<\/mxCell>/g)];
    assert.equal(edgeCells.length, data.edges.length, `${name} edge cell count`);
  }
  assert.deepEqual(violations, []);
  assert.equal(patterns.size, 2, "limited and suppressed both observed");
  assert.notEqual(patterns.get("limited"), patterns.get("suppressed"), "impact dashes differ");
});

test("NC-07 exactly one native grouped legend footer, ordered, with dots and a metric bar", () => {
  const expected = ["Healthy", "Degraded", "Unhealthy", "Unknown", "Standby", "Metric"];
  const dots = [
    theme.state.healthy.dot, theme.state.degraded.dot, theme.state.unhealthy.dot,
    theme.state.unknown.dot, theme.state.alt.dot,
  ].map(color);
  for (const { name, role, part, byId } of views) {
    const containers = role("legend");
    assert.equal(containers.length, 1, `${name} legend containers`);
    const legend = containers[0];
    assert.equal(legend.text, null, `${name} legend container renders its own label`);
    assert.match(legend.style, /^group;/, `${name} legend is not a native group`);
    const items = part("legend-item").sort((a, b) => a.box.x - b.box.x);
    assert.deepEqual(items.map((cell) => cell.text.content), expected, `${name} legend order`);
    assert.deepEqual(
      part("legend-dot").sort((a, b) => a.box.x - b.box.x).map((cell) => color(cell.shape.fill)),
      dots, `${name} legend dot colors`,
    );
    assert.equal(part("legend-bar").length, 1, `${name} legend metric bar`);
    assert.equal(part("legend-title").length, 1, `${name} legend title`);
    const panel = part("legend-panel")[0];
    const texts = [...items, ...part("legend-title")];
    for (const cell of texts) {
      const box = cell.text.box;
      assert.ok(box.x >= panel.box.x && right(box) <= right(panel.box)
        && box.y >= panel.box.y && bottom(box) <= bottom(panel.box), `${name}/${cell.id} in panel`);
    }
    for (let a = 0; a < texts.length; a++) {
      for (let b = a + 1; b < texts.length; b++) {
        assert.equal(overlaps(texts[a].text.box, texts[b].text.box), false,
          `${name} legend text ${texts[a].id}/${texts[b].id} overlap`);
      }
    }
    assert.equal(byId.get(part("legend-panel")[0].parent).id, legend.id, `${name} panel parent`);
  }
});

test("NC-08 every swimlane title renders in full inside its title band", () => {
  for (const { name, role } of views) {
    const lanes = role("lane");
    assert.equal(lanes.length, 3, `${name} lanes`);
    for (const lane of lanes) {
      assert.ok(lane.text, `${name}/${lane.id} has no rendered title`);
      assert.equal(lane.text.content, lane.attributes.label, `${name}/${lane.id} title text`);
      const band = {
        x: right(lane.box) - 44, y: lane.box.y, w: 44, h: lane.box.h,
      };
      const box = lane.text.box;
      assert.ok(box.x >= band.x - 1 && right(box) <= right(band) + 1,
        `${name}/${lane.id} title outside the band horizontally`);
      assert.ok(box.y - band.y >= 4 && bottom(band) - bottom(box) >= 4,
        `${name}/${lane.id} title clipped vertically`);
    }
  }
});

test("NC-09 card title and qualifier are disjoint, contained and complete", () => {
  const violations = [];
  for (const { name, role, part, byId } of views) {
    const cards = new Map(role("entity").map((cell) => [cell.id, cell]));
    for (const title of part("title")) {
      const card = cards.get(title.parent);
      const qualifier = part("qualifier").find((cell) => cell.parent === card.id);
      const box = title.text.box;
      const authored = card.attributes.label;
      if (title.text.lines.join(" ") !== authored) {
        violations.push(`${name}/${title.id} "${title.text.lines.join(" ")}" != "${authored}"`);
      }
      if (!(box.x - card.box.x >= 6 && right(card.box) - right(box) >= 6
        && box.y - card.box.y >= 6 && bottom(card.box) - bottom(box) >= 6)) {
        violations.push(`${name}/${title.id} title not contained with 6px clearance`);
      }
      if (qualifier) {
        if (overlaps(box, qualifier.text.box)) violations.push(`${name}/${title.id} title∩qualifier`);
        if (qualifier.text.content !== card.attributes.ahmQualifier) {
          violations.push(`${name}/${qualifier.id} qualifier text`);
        }
        const qbox = qualifier.text.box;
        if (!(qbox.x - card.box.x >= 6 && right(card.box) - right(qbox) >= 6
          && bottom(card.box) - bottom(qbox) >= 6)) {
          violations.push(`${name}/${qualifier.id} qualifier not contained`);
        }
      }
      assert.ok(byId.has(card.id));
    }
  }
  assert.deepEqual(violations, []);
});

test("NC-10 all native text resolves to the intended sans-serif family", () => {
  for (const { name, data } of views) {
    assert.deepEqual(data.dom.fontFamilies, ["Helvetica"], `${name} font families`);
    assert.notEqual(data.dom.probe.sans, data.dom.probe.serif,
      `${name} sans and serif measure identically — the family did not resolve`);
  }
});

test("NC-13 Draw.io's own xmlsvg export reopens with identical semantics and geometry", () => {
  for (const { name, data } of views) {
    const reopened = report[name].reopened;
    assert.ok(reopened, `${name} round trip missing`);
    assert.equal(reopened.graph.cells, data.graph.cells, `${name} cell count`);
    assert.equal(reopened.graph.shadowVisible, false, `${name} shadow after reopen`);
    assert.deepEqual(reopened.dom.filterNodes, [], `${name} filters after reopen`);
    assert.deepEqual(reopened.dom.fontFamilies, ["Helvetica"], `${name} fonts after reopen`);
    const attributesOf = (source) => source.cells
      .filter((cell) => cell.attributes.ahmRole)
      .map((cell) => JSON.stringify([cell.id, cell.attributes]))
      .sort();
    assert.deepEqual(attributesOf(reopened), attributesOf(data), `${name} ahm attributes`);
    const geometryOf = (source) => source.cells
      .map((cell) => `${cell.id}:${cell.box.x},${cell.box.y},${cell.box.w},${cell.box.h}`).sort();
    assert.deepEqual(geometryOf(reopened), geometryOf(data), `${name} geometry`);
    const pointsOf = (source) => source.edges
      .map((edge) => `${edge.id}:${edge.points.map((p) => `${p.x},${p.y}`).join("|")}`).sort();
    assert.deepEqual(pointsOf(reopened), pointsOf(data), `${name} routed waypoints`);
  }
});

test("NC-12 the loaded plugin never recalculates authored Unknown/Standby into Healthy", () => {
  const data = withPlugin["kitchen-sink"];
  const entities = new Map(data.cells.filter((cell) => cell.attributes.ahmRole === "entity")
    .map((cell) => [cell.attributes.ahmId, cell]));
  const labels = new Map(data.cells.filter((cell) => cell.attributes.ahmPart === "state-label")
    .map((cell) => [cell.parent, cell.text.content]));
  for (const id of ["account", "auth"]) {
    assert.equal(entities.get(id).attributes.ahmComputedState, "Unknown", `${id} state`);
    assert.equal(color(entities.get(id).shape.stroke), color(theme.state.unknown.border), `${id} stroke`);
    assert.equal(labels.get(`${id}-state`), "Unknown", `${id} pill label`);
  }
  assert.equal(entities.get("secondary").attributes.ahmComputedState, "Unknown");
  assert.equal(color(entities.get("secondary").shape.stroke), color(theme.state.alt.border));
  assert.equal(labels.get("secondary-state"), "Standby");
  // The rest of the rollup still moves: worse evidence must still win.
  assert.equal(entities.get("root").attributes.ahmComputedState, "Degraded");
  assert.equal(entities.get("cache").attributes.ahmComputedState, "Unhealthy");
});

// NC-55 / NC-61: Draw.io stamps the exporting browser's user agent into `<mxfile agent="…">`, so a
// Chrome bump moves the saved bytes with no semantic cause. Exactly the **root** `<mxfile>` agent is
// normalised; every other byte, including anything else in the string that looks like an agent
// attribute, is still compared as a byte.
// The `NC-13a` payload read, re-pointed at the shared exact selector and shared with `NC-67`
// (ii), so the save/reopen proof and the decoy proof read the embed through the same code.
const payloadOf = (text) => decodeEntities(contentValue(text));
const SHARED_URL = "../visual/svg-embed.mjs";

const outsideAgent = (left, right) => {
  const a = splitAtAgent(left);
  const b = splitAtAgent(right);
  return [...diffRegions(a.head, b.head), ...diffRegions(a.tail, b.tail)];
};

// D-C20-4: the independent locator shares **no scanning assumption** with the production selector.
// Production scans the `<svg>` opening tag for the name `content` at a whitespace boundary; this
// tokenises the same opening tag into attribute name/value pairs and picks the pair whose name
// **is** `content`. The C-19 form was `text.indexOf('content="')` followed by
// `text.indexOf("&lt;mxfile", valueAt)` — the two steps the production selector used, so it agreed
// with the selector precisely on the inputs where the selector was wrong (`F-C19-1`).
const SPACE = /[ \t\r\n]/;
function svgAttributePairs(text) {
  const open = text.indexOf("<svg");
  if (open < 0) throw new Error("independent locator: no <svg> opening tag");
  const pairs = [];
  let index = open + "<svg".length;
  for (;;) {
    while (index < text.length && SPACE.test(text[index])) index += 1;
    if (index >= text.length) throw new Error("independent locator: unterminated <svg> opening tag");
    if (text[index] === ">" || (text[index] === "/" && text[index + 1] === ">")) return pairs;
    let nameEnd = index;
    while (nameEnd < text.length && !"= \t\r\n>".includes(text[nameEnd])) nameEnd += 1;
    const name = text.slice(index, nameEnd);
    if (text[nameEnd] !== "=") { index = nameEnd; continue; }
    const quote = text[nameEnd + 1];
    if (quote !== '"' && quote !== "'") {
      throw new Error("independent locator: attribute value is not quoted");
    }
    const valueAt = nameEnd + 2;
    const valueEnd = text.indexOf(quote, valueAt);
    if (valueEnd < 0) throw new Error("independent locator: unterminated attribute value");
    pairs.push({ name, valueAt, valueEnd });
    index = valueEnd + 1;
  }
}
const AGENT_TOKEN = /(?<=[ \t\r\n])agent=&quot;[^&]*&quot;/g;
function rootTagByHand(text) {
  const content = svgAttributePairs(text).filter((pair) => pair.name === "content");
  if (content.length !== 1) {
    throw new Error(`independent locator: ${content.length} attributes named content`);
  }
  const { valueAt, valueEnd } = content[0];
  const value = text.slice(valueAt, valueEnd);
  if (!value.startsWith("&lt;mxfile")) {
    throw new Error("independent locator: the content value does not begin with the escaped root");
  }
  const end = text.indexOf("&gt;", valueAt);
  const inside = text.slice(valueAt, end);
  const tokens = inside.match(AGENT_TOKEN) || [];
  return {
    start: valueAt, end, tokens, valueEnd,
    agentAt: valueAt + inside.search(/(?<=[ \t\r\n])agent=&quot;/),
  };
}
// A second `agent=&quot;…&quot;`, injected into an SVG attribute of the root `<svg>` element —
// i.e. *before* `content="` and outside it, exactly where a first-match-anywhere selector picks it
// up instead of the real one.
const DECOY = 'agent=&quot;DECOY&quot;';
const DECOY_ATTRIBUTE = ` data-ahm-decoy="${DECOY}"`;
const withDecoy = (text) => text.replace('version="1.1"', `version="1.1"${DECOY_ATTRIBUTE}`);
// The root agent replaced at hand-derived offsets, so "an arbitrary real root agent still passes"
// is driven through the container rather than through the selector under test.
const OTHER_AGENT = "Totally/9.9 (Some Other Browser) Definitely/1.0";
function replaceRootAgentByHand(text, agent) {
  const root = rootTagByHand(text);
  return text.slice(0, root.agentAt) + `agent=&quot;${agent}&quot;`
    + text.slice(root.agentAt + root.tokens[0].length);
}

test("NC-13a the save/reopen proof uses Draw.io's real saved bytes", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const raw = payloadOf(svg);
    // The shipped payload is exactly what Draw.io's embed export writes: a deflated <diagram>.
    // If this ever becomes plain XML again the harness has started rewriting content= once more.
    assert.doesNotMatch(raw, /<mxGraphModel\b/, `${name} content= is not Draw.io's own compressed form`);
    assert.match(raw, /<diagram[^>]*>[A-Za-z0-9+/=]+<\/diagram>/, `${name} deflated diagram payload`);
    assert.match(inflateDiagrams(raw), /<mxGraphModel[^>]*shadow="0"/, `${name} inflates to the model`);
    // save -> reopen -> save: the second export of the reopened model is byte-identical, and
    // deliberately without any normalisation — both come from the same browser.
    assert.equal(report[name].reexported, report[name].exported, `${name} second save drifted`);

    // (iv) the observed user agents, printed on both sides, so a browser bump is visible in the log
    // rather than silent.
    const exported = report[name].exported;
    console.log(`NC-13a ${name} diskAgent=${agentOf(svg)}`);
    console.log(`NC-13a ${name} liveAgent=${agentOf(exported)}`);
    // (ii)/(v) the normaliser is narrow, and the assertion says so **without** deriving both of its
    // sides from the selector under test: the span it replaces starts at the offset of the one
    // `agent=&quot;` token inside the independently located root open tag, lies strictly inside that
    // tag, and every byte on either side of it is untouched. The C-18 form
    // `parts.agent === \`agent=&quot;${agentOf(svg)}&quot;\`` is gone — it evaluates true on a decoy
    // span too (measured, `P-C19-4`).
    const parts = splitAtAgent(svg);
    const span = agentSpan(svg);
    const rootTag = rootTagByHand(svg);
    console.log(`NC-13a ${name} rootOpen=${rootTag.start} rootClose=${rootTag.end} `
      + `rootAgentTokens=${rootTag.tokens.length} independentAgentAt=${rootTag.agentAt} `
      + `selected=[${span.start},${span.end})`);
    assert.equal(rootTag.tokens.length, 1, `${name} the root <mxfile> tag does not carry exactly one agent`);
    assert.equal(span.start, rootTag.agentAt, `${name} the selected span is not the root <mxfile> agent`);
    assert.ok(span.start > rootTag.start && span.end < rootTag.end,
      `${name} the selected span lies outside the root <mxfile> open tag`);
    assert.equal(normaliseAgent(svg), parts.head + AGENT_PLACEHOLDER + parts.tail,
      `${name} normaliser changed something outside agent="…"`);
    assert.equal(normaliseAgent(exported),
      splitAtAgent(exported).head + AGENT_PLACEHOLDER + splitAtAgent(exported).tail);
    // ...and the two inputs differ *only* there: zero differing regions outside the attribute.
    const regions = outsideAgent(svg, exported);
    console.log(`NC-13a ${name} differing regions outside agent=${JSON.stringify(regions)}`);
    assert.deepEqual(regions, [], `${name} differs outside <mxfile agent="…">`);
    // The Draw.io build stamp sits next to the agent and is *not* normalised.
    assert.equal(svg.match(/\bversion=&quot;[^&]*&quot;/)[0],
      exported.match(/\bversion=&quot;[^&]*&quot;/)[0], `${name} Draw.io build version moved`);
    // (i) full string equality, with the one attribute normalised on both sides.
    assert.equal(normaliseAgent(exported), normaliseAgent(svg),
      `${name} on-disk bytes differ from the export outside the agent attribute`);
  }
});

// NC-55's corruption controls plus NC-61 clause (iii), each applied alone to a copy of the bytes in
// memory. The four corruptions must stay red — the normalisation must not tolerate a difference
// anywhere else, at either end of the string or inside the root tag it anchors on — and (e) must be
// green, so the one thing that *is* tolerated is proved to be exactly the root agent.
const BYTE_CONTROLS = [
  {
    label: "(a) a flipped character inside the deflated <diagram> payload",
    corrupt: corruptPayload, equalAfterNormalise: false,
  },
  {
    label: "(b) a flipped character in the rendered SVG body, outside content=",
    corrupt: corruptBody, equalAfterNormalise: false,
  },
  {
    label: "(c) a flipped character inside the root <mxfile> tag, outside agent=",
    corrupt: corruptRootAttribute, equalAfterNormalise: false,
  },
  {
    label: "(d) a flipped character in the tail, after content= has closed",
    corrupt: corruptTail, equalAfterNormalise: false,
  },
  {
    label: "(e) an unrelated user agent",
    corrupt: (text) => replaceAgent(text, OTHER_AGENT),
    equalAfterNormalise: true,
  },
];

test("NC-55/NC-61 (iii) negative controls: only the root <mxfile> agent is tolerated", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    for (const { label, corrupt, equalAfterNormalise } of BYTE_CONTROLS) {
      const applied = corrupt(svg);
      const outside = outsideAgent(applied.text, svg).length;
      console.log(`NC-55 ${name} ${label}: at=${applied.at} was=${JSON.stringify(applied.was)} `
        + `regionsOutsideAgent=${outside} `
        + `equalAfterNormalise=${normaliseAgent(applied.text) === normaliseAgent(svg)}`);
      assert.notEqual(applied.text, svg, `${name} ${label} changed nothing`);
      assert.equal(normaliseAgent(applied.text) === normaliseAgent(svg), equalAfterNormalise,
        `${name} ${label} did not behave as its control requires`);
      assert.equal(outside > 0, !equalAfterNormalise,
        `${name} ${label} was not applied where the control claims`);
    }
    // Nothing above touched the file: the controls are string surgery on a copy.
    assert.equal(readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8"), svg,
      `${name} was rewritten by a negative control`);
  }
});

// NC-61 (i): the selection is anchored on the container, so a decoy that arrives first in the byte
// stream is never selected and never tolerated.
test("NC-61 (i) the tolerated span is the root <mxfile> agent, not the first one in the string", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const decoyed = withDecoy(svg);
    const decoyAt = decoyed.indexOf(DECOY);
    const insertAt = decoyed.indexOf(DECOY_ATTRIBUTE);
    const rootByHand = rootTagByHand(decoyed);
    assert.notEqual(decoyed, svg, `${name} the decoy fixture did not apply`);
    assert.ok(decoyAt >= 0 && decoyAt < rootByHand.start,
      `${name} the decoy is not before the root <mxfile> open tag`);
    assert.equal(rootByHand.tokens.length, 1,
      `${name} the decoy leaked into the root <mxfile> open tag`);

    const span = agentSpan(decoyed);
    console.log(`NC-61 ${name} decoyAt=${decoyAt} rootOpen=${rootByHand.start} `
      + `rootClose=${rootByHand.end} selected=[${span.start},${span.end}) `
      + `selectedIsDecoy=${span.text.includes("DECOY")}`);
    assert.equal(span.start, rootByHand.agentAt, `${name} the decoy was selected`);
    assert.ok(span.start > rootByHand.start && span.end < rootByHand.end,
      `${name} the selected span is not inside the root open tag`);
    // The decoy survives normalisation byte for byte...
    assert.ok(normaliseAgent(decoyed).includes(DECOY), `${name} the decoy was normalised away`);
    assert.ok(!normaliseAgent(svg).includes(DECOY), `${name} the shipped bytes already carry the decoy`);
    // ...and the untolerated comparison reports it: normalisation no longer makes the two equal, and
    // the first differing region begins inside the injected attribute.
    const regions = diffRegions(normaliseAgent(decoyed), normaliseAgent(svg));
    console.log(`NC-61 ${name} untolerated first differing region `
      + `${JSON.stringify(regions[0] && { start: regions[0].start, left: regions[0].left.slice(0, 24) })} `
      + `injectedAt=${insertAt}`);
    assert.notEqual(normaliseAgent(decoyed), normaliseAgent(svg),
      `${name} the decoy was tolerated by the normalisation`);
    assert.ok(regions.length > 0, `${name} the untolerated comparison reported no differing region`);
    assert.ok(regions[0].start >= insertAt && regions[0].start < decoyAt + DECOY.length,
      `${name} the first differing region is not the decoy: ${JSON.stringify(regions[0])}`);
  }
});

// NC-61 (ii): the case the C-18 selector gets wrong — with a decoy present, changing the *real*
// root agent must still be tolerated, because the real root agent is what gets normalised.
test("NC-61 (ii) an arbitrary root agent still compares equal, decoy present or not", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    for (const [label, base] of [["no decoy", svg], ["decoy present", withDecoy(svg)]]) {
      const changed = replaceRootAgentByHand(base, OTHER_AGENT);
      assert.notEqual(changed, base, `${name} ${label}: the root-agent fixture did not apply`);
      assert.equal(agentOf(changed), OTHER_AGENT, `${name} ${label}: the root agent did not move`);
      console.log(`NC-61 ${name} ${label}: equalAfterNormalise=`
        + `${normaliseAgent(changed) === normaliseAgent(base)}`);
      assert.equal(normaliseAgent(changed), normaliseAgent(base),
        `${name} ${label}: an unrelated root user agent was not tolerated`);
    }
  }
});

// NC-64 (iv)/(v): every malformed shape, each built alone from the shipped bytes, each throwing a
// distinct named error instead of degrading into a looser match. The first five bound the
// containers (the `<svg>` opening tag and the `content` attribute's value); the last four bound the
// agent attribute itself.
const CONTENT_OPEN = 'content="';                                          // NAIVE-CONTROL
const contentValueAt = (text) => text.indexOf(CONTENT_OPEN) + CONTENT_OPEN.length;
const contentValueEnd = (text) => text.indexOf('"', contentValueAt(text));
const MALFORMED_ROOT = [
  {
    label: "(iv) a content value that does not begin with &lt;mxfile",
    mutate: (text) => text.replace("&lt;mxfile ", "&lt;notmxfile "),
    throws: /the content value does not begin with the escaped root &lt;mxfile open tag/,
  },
  {
    label: "(iv) a root open tag with no &gt;",
    mutate: (text) => text.replace("&gt;&lt;diagram", "&lt;diagram"),
    throws: /open tag is not terminated by &gt;/,
  },
  {
    label: "(iv) the content attribute's closing quote deleted",
    mutate: (text) => {
      const end = contentValueEnd(text);
      return text.slice(0, end) + text.slice(end + 1);
    },
    throws: /content attribute: unterminated value/,
  },
  {
    label: "(iv) no content attribute on the outer <svg> opening tag",
    mutate: (text) => text.replace(" content=\"", " xcontent=\""),
    throws: /the outer <svg> opening tag carries no content="…"/,
  },
  {
    label: "(iv) a second content attribute on the same tag",
    mutate: (text) => {
      const at = text.indexOf(CONTENT_OPEN);
      return `${text.slice(0, at - 1)} content="&lt;mxfile&gt;&lt;/mxfile&gt;"${text.slice(at - 1)}`;
    },
    throws: /the outer <svg> opening tag carries 2 content="…" attributes/,
  },
  {
    label: "(v) a root tag with no agent=&quot;",
    mutate: (text) => text.replace(/ agent=&quot;[^&]*&quot;/, ""),
    throws: /carries no agent=&quot;…&quot;/,
  },
  {
    label: "(v) a root tag carrying two agent=&quot;…&quot; attributes",
    mutate: (text) => text.replace(" agent=&quot;", " agent=&quot;Second/1.0&quot; agent=&quot;"),
    throws: /carries 2 agent=&quot;…&quot; attributes/,
  },
  {
    label: "(v) an empty agent value",
    mutate: (text) => text.replace(/ agent=&quot;[^&]*&quot;/, " agent=&quot;&quot;"),
    throws: /the agent value is empty/,
  },
  {
    label: "(v) an agent value carrying an escaped & entity",
    mutate: (text) => text.replace(/ agent=&quot;[^&]*&quot;/, " agent=&quot;Some&amp;Browser/1.0&quot;"),
    throws: /the agent value carries an escaped & entity/,
  },
];

test("NC-64 (iv)/(v) every malformed container and agent shape fails loudly and distinctly", () => {
  const seen = new Set();
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    for (const { label, mutate, throws } of MALFORMED_ROOT) {
      const text = mutate(svg);
      assert.notEqual(text, svg, `${name} ${label}: the malformed fixture did not apply`);
      let message = null;
      try { agentSpan(text); } catch (error) { message = error.message; }
      console.log(`NC-64 ${name} malformed ${label}: threw ${JSON.stringify(message)}`);
      assert.ok(message !== null, `${name} ${label} was tolerated silently`);
      assert.match(message, throws, `${name} ${label} threw the wrong error`);
      // …and the whole normalisation path fails with it, rather than only the selector.
      assert.throws(() => normaliseAgent(text), throws);
      seen.add(message.replace(/\d+/g, "N"));
    }
    assert.equal(readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8"), svg,
      `${name} was rewritten by a malformed-shape control`);
  }
  console.log(`NC-64 distinct named errors=${seen.size} ${JSON.stringify([...seen])}`);
  assert.equal(seen.size, MALFORMED_ROOT.length,
    "two malformed shapes share one error, so the errors do not name the shape");
});

// NC-64 (i): the embed is the attribute **named** `content`, not the first substring that ends in
// one. `data-content="…"` injected before it carries a complete escaped root with its own agent, so
// a substring anchor selects the decoy and normalises it away (measured, `P-C20-2`).
const DATA_CONTENT = ' data-content="&lt;mxfile agent=&quot;DECOY-A&quot;&gt;&lt;/mxfile&gt;"';
const withDataContent = (text) => {
  const at = text.indexOf(CONTENT_OPEN);
  return text.slice(0, at - 1) + DATA_CONTENT + text.slice(at - 1);
};

test("NC-64 (i) the embed is the attribute named content, not a substring that ends in one", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const decoyed = withDataContent(svg);
    assert.notEqual(decoyed, svg, `${name} the data-content fixture did not apply`);
    const hand = rootTagByHand(decoyed);
    const span = agentSpan(decoyed);
    const decoyAt = decoyed.indexOf("DECOY-A");
    console.log(`NC-64 ${name} data-content injectedAt=${decoyed.indexOf(DATA_CONTENT)} `
      + `decoyAt=${decoyAt} independentRoot=${hand.start} selected=[${span.start},${span.end}) `
      + `selectedIsDecoy=${span.text.includes("DECOY-A")}`);
    assert.ok(decoyAt < hand.start, `${name} the decoy is not before the real root`);
    assert.equal(span.start, hand.agentAt, `${name} the data-content decoy was selected`);
    assert.ok(!span.text.includes("DECOY-A"), `${name} the selected span is the decoy`);
    // The decoy survives normalisation byte for byte, and the untolerated comparison reports it.
    assert.ok(normaliseAgent(decoyed).includes("DECOY-A"), `${name} the decoy was normalised away`);
    const regions = diffRegions(normaliseAgent(decoyed), normaliseAgent(svg));
    console.log(`NC-64 ${name} untolerated first differing region `
      + `${JSON.stringify(regions[0] && { start: regions[0].start, left: regions[0].left.slice(0, 24) })}`);
    assert.notEqual(normaliseAgent(decoyed), normaliseAgent(svg),
      `${name} the injected attribute was tolerated by the normalisation`);
    assert.ok(regions.length > 0 && regions[0].start >= decoyed.indexOf(DATA_CONTENT)
      && regions[0].start < decoyAt + "DECOY-A".length,
    `${name} the first differing region is not the injected attribute: ${JSON.stringify(regions[0])}`);
  }
});

// NC-64 (ii)/(iii): the real root is the **first bytes** of the content value, and the only root in
// it. A fake escaped root written before it, and a second real root written after it, are both
// rejected by name; a decoy escaped root in the rendered body — after `content=` has closed — is
// outside the value and is simply ignored.
const withFakeRootBefore = (text) => {
  const at = contentValueAt(text);
  return `${text.slice(0, at)}&lt;mxfile agent=&quot;DECOY-B&quot;&gt;${text.slice(at)}`;
};
const withSecondRootInside = (text) => {
  const at = contentValueEnd(text);
  return `${text.slice(0, at)}&lt;mxfile agent=&quot;DECOY-C&quot;&gt;&lt;/mxfile&gt;${text.slice(at)}`;
};
const withRootInBody = (text) => {
  const after = contentValueEnd(text) + 2;
  return `${text.slice(0, after)}&lt;mxfile agent=&quot;DECOY-D&quot;&gt;&lt;/mxfile&gt;${text.slice(after)}`;
};
const ROOT_POSITION = [
  {
    label: "(ii) a fake escaped root prepended inside the content value",
    mutate: withFakeRootBefore, throws: /the content value carries 2 escaped &lt;mxfile open tags/,
  },
  {
    label: "(iii) a second real root appended inside the content value",
    mutate: withSecondRootInside, throws: /the content value carries 2 escaped &lt;mxfile open tags/,
  },
];

test("NC-64 (ii)/(iii) the real root is the content value's first bytes and its only root", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    for (const { label, mutate, throws } of ROOT_POSITION) {
      const text = mutate(svg);
      assert.notEqual(text, svg, `${name} ${label}: the fixture did not apply`);
      let message = null;
      try { agentSpan(text); } catch (error) { message = error.message; }
      console.log(`NC-64 ${name} ${label}: threw ${JSON.stringify(message)}`);
      assert.ok(message !== null, `${name} ${label} selected a decoy silently`);
      assert.match(message, throws, `${name} ${label} threw the wrong error`);
    }
    // Outside the value: the same decoy in the rendered body changes nothing at all.
    const inBody = withRootInBody(svg);
    assert.notEqual(inBody, svg, `${name} the rendered-body decoy did not apply`);
    const span = agentSpan(inBody);
    console.log(`NC-64 ${name} decoy root in the rendered body: selected=[${span.start},${span.end}) `
      + `equalsShipped=${span.text === agentSpan(svg).text}`);
    assert.equal(span.text, agentSpan(svg).text,
      `${name} a root written after content= closed changed the selection`);
    assert.ok(normaliseAgent(inBody).includes("DECOY-D"),
      `${name} the body decoy vanished, so it was not applied where the control claims`);
    assert.notEqual(normaliseAgent(inBody), normaliseAgent(svg),
      `${name} the body decoy was tolerated by the normalisation`);
  }
});

// NC-64 (v): `agent` is an attribute name, not a suffix. The C-19 boundary was `/\bagent=/`, which
// matches after the `-` in `x-agent=` and rejected a perfectly good export (`P-C20-6`).
const withXAgent = (text) => text.replace(" agent=&quot;", " x-agent=&quot;DECOY&quot; agent=&quot;");

test("NC-64 (v) agent is matched as an attribute name, so x-agent is a different attribute", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const text = withXAgent(svg);
    assert.notEqual(text, svg, `${name} the x-agent fixture did not apply`);
    const hand = rootTagByHand(text);
    const span = agentSpan(text);
    console.log(`NC-64 ${name} x-agent: independentTokens=${hand.tokens.length} `
      + `selected=[${span.start},${span.end}) selectedIsDecoy=${span.text.includes("DECOY")}`);
    assert.equal(hand.tokens.length, 1, `${name} the independent locator counted x-agent as an agent`);
    assert.equal(span.start, hand.agentAt, `${name} the real agent was not selected`);
    assert.ok(!span.text.includes("DECOY"), `${name} x-agent was selected`);
    // The real agent is still the only tolerated span: the decoy stays a byte difference.
    assert.equal(normaliseAgent(replaceAgent(text, OTHER_AGENT).text), normaliseAgent(text),
      `${name} the real root agent stopped being the tolerated span`);
    assert.ok(normaliseAgent(text).includes("x-agent=&quot;DECOY&quot;"),
      `${name} x-agent was normalised away`);
  }
});

// NC-64 (vii): "independent" is measured, not claimed. The fixture's expected offset comes from
// tokenising the `<svg>` opening tag into attribute pairs; a deliberately naive
// `indexOf('content="')` locator is asserted to **disagree** with it on the `data-content` fixture,
// so an assertion built on the naive mechanism could not have caught the production defect.
const naiveContentValueAt = (text) => text.indexOf(CONTENT_OPEN) + CONTENT_OPEN.length;
const naiveRootAt = (text) => text.indexOf("&lt;mxfile", naiveContentValueAt(text));

test("NC-64 (vii) the independent locator disagrees with a naive one on the decoy fixture", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const decoyed = withDataContent(svg);
    const hand = rootTagByHand(decoyed);
    const naive = naiveContentValueAt(decoyed);
    console.log(`NC-64 ${name} independentValueAt=${hand.start} naiveValueAt=${naive} `
      + `naiveRootAt=${naiveRootAt(decoyed)} agree=${hand.start === naive}`);
    assert.notEqual(hand.start, naive,
      `${name} the two locators agree on the decoy fixture, so independence is unassertable`);
    assert.equal(agentSpan(decoyed).start, hand.agentAt,
      `${name} production disagrees with the independent locator`);
    // On the shipped bytes, with no decoy present, they must of course agree.
    assert.equal(rootTagByHand(svg).start, naiveContentValueAt(svg),
      `${name} the two locators already disagree on the shipped bytes`);
  }
});

// --- C-21 / NC-67, NC-68: one shared exact selector, and controls that mutate its real source ----
//
// C-20 made the *normalisation* chain exact but left `svg.match(/\bcontent="([^"]+)"/)` on every
// path that actually extracts the model: `visual/render-native.mjs`'s reopen path,
// `test/helpers/artifact.mjs`'s `readDrawioSvg`, this file's `NC-13a` payload read and
// `visual/drawio-host.mjs`'s export presence check. With a **complete valid** decoy the failure is
// silent rather than loud: the naive regex selects the decoy, `readDrawioSvg`'s own `<mxfile>` +
// `<mxGraphModel>` gate passes on it, and all three `NC-13a` payload assertions are green on it
// (measured as `P-C21-1`…`P-C21-4`). Every path below now goes through `visual/svg-embed.mjs`, and
// the module's kill controls are transformations of that shipped source, not look-alikes.

// The decoy is located and built with the **independent** attribute tokeniser, never with the
// selector under test: `data-content=` written before the real `content=`, carrying its own escaped
// root open tag with `agent="DECOY-A"` and the artifact's own deflated `<diagram>` payload, so it
// is a well-formed embed by every gate any consumer applies to it.
const contentPair = (text) => {
  const pairs = svgAttributePairs(text).filter((pair) => pair.name === "content");
  if (pairs.length !== 1) throw new Error(`independent locator: ${pairs.length} content attributes`);
  return pairs[0];
};
const independentContentValue = (text) => {
  const { valueAt, valueEnd } = contentPair(text);
  return text.slice(valueAt, valueEnd);
};
const DECOY_AGENT = "DECOY-A";
const ROOT_CLOSE_ESCAPED = "&lt;/mxfile&gt;";
const withValidDecoy = (text) => {
  const value = independentContentValue(text);
  const afterRootOpen = value.indexOf("&gt;") + "&gt;".length;
  const decoy = ' data-content="&lt;mxfile host=&quot;decoy&quot; '
    + `agent=&quot;${DECOY_AGENT}&quot;&gt;${value.slice(afterRootOpen)}"`;
  const at = text.lastIndexOf(" content=", contentPair(text).valueAt);
  return text.slice(0, at) + decoy + text.slice(at);
};
// The same decoy, with the real attribute renamed away: an export that carries a valid-looking
// embed but no attribute actually named `content`.
const withDecoyOnly = (text) => withValidDecoy(text).replace(' content="', ' xcontent="');

test("NC-67 (i) a decoyed but otherwise valid artifact still yields the real model", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const decoyed = withValidDecoy(svg);
    assert.notEqual(decoyed, svg, `${name} the decoy did not apply`);
    // The fixture is only a fixture if the naive selector really falls for it and the model it
    // yields really passes the consumer's own validity gate. Both are asserted, not assumed.
    const naiveValue = decoyed.match(/\bcontent="([^"]+)"/)[1];                    // NAIVE-CONTROL
    const naiveModel = inflateDiagrams(decodeEntities(naiveValue));
    assert.ok(naiveValue.includes(DECOY_AGENT), `${name} the naive regex does not select the decoy`);
    assert.match(naiveModel, /<mxfile\b/, `${name} the decoy model fails the consumer's own gate`);
    assert.match(naiveModel, /<mxGraphModel\b/, `${name} the decoy model fails the consumer's own gate`);

    const real = readDrawioSvgSource(svg, name);
    const selected = readDrawioSvgSource(decoyed, `${name} decoyed`);
    console.log(`NC-67 ${name} decoyAt=${decoyed.indexOf(DECOY_AGENT)} `
      + `realContentAt=${contentPair(decoyed).valueAt} naiveModelBytes=${naiveModel.length} `
      + `selectedModelBytes=${selected.model.length} realModelBytes=${real.model.length} `
      + `selectedAgent=${agentOf(decoyed)}`);
    assert.notEqual(naiveModel.length, real.model.length,
      `${name} the decoy model is the real size, so the fixture cannot discriminate`);
    assert.equal(selected.model, real.model, `${name} the decoy answered for the real model`);
    assert.equal(agentOf(decoyed), agentOf(svg), `${name} the decoy agent was selected`);
    // `xcontent=`, and a `content=` nested in the rendered body, are both ignored: neither is an
    // attribute named `content` on the outer `<svg>` opening tag.
    const bodyContent = `${svg}<g><text> content="&lt;mxfile agent=&quot;DECOY-E&quot;&gt;"</text></g>`;
    assert.equal(readDrawioSvgSource(bodyContent, `${name} body`).model, real.model,
      `${name} a content= nested in the rendered body changed the selection`);
  }
});

test("NC-67 (ii) the save/reopen proof and the reopen path read the real payload", () => {
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const shippedPayload = payloadOf(svg);
    for (const [label, text] of [["shipped", svg], ["decoyed", withValidDecoy(svg)]]) {
      const raw = payloadOf(text);
      // NC-13a's three payload assertions, run through the shared selector on both fixtures.
      assert.doesNotMatch(raw, /<mxGraphModel\b/, `${name} ${label}: content= is not the compressed form`);
      assert.match(raw, /<diagram[^>]*>[A-Za-z0-9+/=]+<\/diagram>/, `${name} ${label}: deflated payload`);
      assert.match(inflateDiagrams(raw), /<mxGraphModel[^>]*shadow="0"/, `${name} ${label}: inflates`);
      assert.equal(raw, shippedPayload,
        `${name} ${label}: the selected payload is not the untouched artifact's payload`);
    }
    // The reopen path, driven on a decoyed copy of Draw.io's own live export.
    const exported = report[name].exported;
    const decoyedExport = withValidDecoy(exported);
    assert.notEqual(decoyedExport, exported, `${name} the export decoy did not apply`);
    const reopened = readDrawioSvgText(decoyedExport, `${name} decoyed export`);
    const straight = readDrawioSvgText(exported, `${name} export`);
    console.log(`NC-67 ${name} reopen decoyedBytes=${reopened.model.length} `
      + `realBytes=${straight.model.length} agent=${agentOf(decoyedExport)}`);
    assert.equal(reopened.model, straight.model, `${name} the reopen path returned the decoy model`);
    assert.ok(!reopened.model.includes(DECOY_AGENT), `${name} the reopened model carries the decoy`);
  }
});

// NC-67 (iii): the four consumers, parameterised. Each malformed shape must raise the **same**
// named error from the shared module through every one of them — not a consumer-local message and
// never a silent wrong answer.
const CONSUMERS = [
  { name: "readDrawioSvg", read: (text) => readDrawioSvgSource(text, "fixture") },
  { name: "readDrawioSvgText", read: (text) => readDrawioSvgText(text, "fixture") },
  { name: "the NC-13a payload read", read: (text) => payloadOf(text) },
  { name: "exportXmlSvg's presence check", read: (text) => assertEmbeddedModelPresent(text, "fixture") },
];
const CONTENT_SHAPES = MALFORMED_ROOT.filter((shape) => /content attribute/.test(shape.label));

test("NC-67 (iii) every consumer fails with the same three named errors", () => {
  assert.equal(CONTENT_SHAPES.length, 3,
    `expected the three container shapes, got ${JSON.stringify(CONTENT_SHAPES.map((s) => s.label))}`);
  const svg = readFileSync(resolve(root, "examples/hero.drawio.svg"), "utf8");
  // NC-74 adds a contextual label prefix to some consumers. Strip "label: " to compare the shared
  // selector's core error, which must still be identical across all paths.
  const stripLabel = (msg) => msg.replace(/^fixture: /, "");
  const byShape = new Map();
  for (const { label, mutate, throws } of CONTENT_SHAPES) {
    const text = mutate(svg);
    assert.notEqual(text, svg, `${label}: the fixture did not apply`);
    const messages = CONSUMERS.map(({ name, read }) => {
      let message = null;
      try { read(text); } catch (error) { message = error.message; }
      assert.ok(message !== null, `${name} tolerated ${label} silently`);
      assert.match(message, throws, `${name} threw its own message for ${label}: ${message}`);
      return stripLabel(message);
    });
    console.log(`NC-67 ${label}: ${JSON.stringify(messages)}`);
    assert.equal(new Set(messages).size, 1,
      `${label} produced consumer-local messages: ${JSON.stringify(messages)}`);
    byShape.set(label, messages[0]);
  }
  console.log(`NC-67 distinct shared errors=${new Set(byShape.values()).size}`);
  assert.equal(new Set(byShape.values()).size, 3, "two container shapes share one error");
  // The presence check specifically: a `data-content`-only export is not an export with an embed.
  const decoyOnly = withDecoyOnly(svg);
  assert.match(decoyOnly, /data-content="/, "the data-content-only fixture did not apply");
  assert.doesNotMatch(decoyOnly.slice(0, decoyOnly.indexOf(">")), /(?<=[ \t\r\n])content="/,
    "the data-content-only fixture still carries a real content attribute");
  assert.throws(() => assertEmbeddedModelPresent(decoyOnly, "fixture"),
    /carries no content="…"/, "the presence check accepted a data-content-only export");
});

// NC-67 (iv): no naive selector survives in an active extraction path. The scan is enumerated over
// the four call sites plus the shared module, and it is itself proven by a counter-example it must
// report — an assertion that cannot fail is not an assertion.
const NAIVE_MARKER = "NAIVE-CONTROL";
const NAIVE_FORMS = [
  { kind: "regex-literal", pattern: /\/\\bcontent=/ },
  { kind: "indexOf-literal", pattern: /indexOf\(\s*(['"])content="/ },
  { kind: "content-open-literal", pattern: /(['"])content="\1/ },
];
// Prose that *describes* the removed selector is not a selector, so a `//` comment tail is dropped
// before matching (`://` is kept, so a URL is never mistaken for a comment). A line of real code
// stays scanned, and a line that genuinely needs the shape carries the marker.
const codeOf = (line) => line.replace(/(^|[^:\w])\/\/.*$/, "$1");
const naiveSelectorSites = (source) => source.split("\n").flatMap((line, index) => (
  line.includes(NAIVE_MARKER) ? [] : NAIVE_FORMS
    .filter((form) => form.pattern.test(codeOf(line)))
    .map((form) => ({ line: index + 1, kind: form.kind, text: line.trim() }))
));
const EXTRACTION_PATHS = [
  "visual/render-native.mjs", "visual/drawio-host.mjs", "test/helpers/artifact.mjs",
  "test/native-render.test.mjs", "visual/svg-embed.mjs",
];
const SHARED_MODULE = "visual/svg-embed.mjs";

test("NC-67 (iv) no naive content= selector survives in an active extraction path", () => {
  // The counter-example first: the scan must report the exact shape this correction removed, and
  // must stop reporting it once the line is declared a control.
  const counterExample = 'const match = svg.match(/\\bcontent="([^"]+)"/);';
  const counterSites = naiveSelectorSites(counterExample);
  console.log(`NC-67 counter-example sites=${JSON.stringify(counterSites)}`);
  assert.equal(counterSites.length, 1, "the scan cannot see the selector this correction removed");
  assert.equal(naiveSelectorSites(`${counterExample} // ${NAIVE_MARKER}`).length, 0,
    "the scan ignores its own control marker");
  assert.equal(naiveSelectorSites(`  // the C-19 form was ${counterExample}`).length, 0,
    "the scan reports prose that only describes the removed selector");
  const substringSites = naiveSelectorSites("const at = text.indexOf('content=\"');");
  console.log(`NC-67 substring-anchor sites=${JSON.stringify(substringSites.map((s) => s.kind))}`);
  assert.ok(substringSites.some((site) => site.kind === "indexOf-literal"),
    "the scan cannot see a substring anchor");

  for (const file of EXTRACTION_PATHS) {
    const source = readFileSync(resolve(root, file), "utf8");
    const sites = naiveSelectorSites(source);
    console.log(`NC-67 ${file}: naiveSites=${sites.length} ${JSON.stringify(sites.slice(0, 3))}`);
    assert.deepEqual(sites, [], `${file} still selects the embed by substring or loose regex`);
    if (file === SHARED_MODULE) continue;
    assert.match(source, /from "[^"]*svg-embed\.mjs"/,
      `${file} does not import the shared selector`);
  }
});

// NC-72: proof-only import-graph assertion. Every file that imports/re-exports `visual/svg-embed.mjs`
// must appear in the EXTRACTION_PATHS enumeration set. A synthetic barrel-only re-export is included
// as a wrong-input control to prove the discovery finds re-exports too.
test("NC-72 every importer of svg-embed.mjs is in the enumerated scan set", () => {
  const sourceFiles = (directory = "") => readdirSync(resolve(root, directory), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const file = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : sourceFiles(file);
    }
    return /\.(?:mjs|js)$/.test(entry.name) ? [file] : [];
  });
  const allFiles = sourceFiles();

  // Match side-effect imports and single- or multi-line imports/re-exports.
  const importPattern = /\b(?:import\s*["'][^"']*svg-embed\.mjs["']|(?:import|export)\s+[^;]*?\bfrom\s*["'][^"']*svg-embed\.mjs["'])/;
  const importers = allFiles.filter((file) => {
    const source = readFileSync(resolve(root, file), "utf8");
    return importPattern.test(source);
  }).sort();

  // Synthetic re-export-only barrel control: proves the pattern catches re-exports.
  const barrel = 'export { contentValue } from "./svg-embed.mjs";';
  assert.ok(importPattern.test(barrel),
    "the import-graph discovery cannot see a re-export-only barrel");

  console.log(`NC-72 importers=${JSON.stringify(importers)} scanSet=${JSON.stringify(EXTRACTION_PATHS)}`);
  // Every discovered importer must be in the enumerated scan set.
  for (const file of importers) {
    assert.ok(EXTRACTION_PATHS.includes(file),
      `${file} imports svg-embed.mjs but is not in the enumerated scan set`);
  }
  assert.deepEqual(importers, EXTRACTION_PATHS.filter((file) => file !== SHARED_MODULE).sort(),
    "the discovery missed an enumerated importer or found an unenumerated importer");
});

test("NC-67 (v) the shared selector is one function object, not four copies", async () => {
  const shared = await import(`${SHARED_URL}`);
  const consumers = {
    "visual/render-native.mjs": await import("../visual/render-native.mjs"),
    "visual/drawio-host.mjs": await import("../visual/drawio-host.mjs"),
    "test/helpers/artifact.mjs": await import("./helpers/artifact.mjs"),
  };
  for (const name of ["rootTagSpan", "agentSpan", "agentOf", "splitAtAgent"]) {
    console.log(`NC-67 identity render-native.${name} === svg-embed.${name}: `
      + `${consumers["visual/render-native.mjs"][name] === shared[name]}`);
    assert.equal(consumers["visual/render-native.mjs"][name], shared[name],
      `render-native.mjs re-exported a different ${name}`);
  }
  // The statically imported names this file already asserts NC-64 with are the shared ones too.
  assert.equal(agentSpan, shared.agentSpan, "this file's agentSpan is not the shared one");
  assert.equal(normaliseAgent, shared.normaliseAgent, "this file's normaliseAgent is not the shared one");
  assert.equal(shared.contentValue(readFileSync(resolve(root, "examples/hero.drawio.svg"), "utf8")),
    independentContentValue(readFileSync(resolve(root, "examples/hero.drawio.svg"), "utf8")),
    "the shared value selector disagrees with the independent tokeniser on the shipped bytes");
  assert.deepEqual(Object.keys(consumers).sort(), [
    "test/helpers/artifact.mjs", "visual/drawio-host.mjs", "visual/render-native.mjs",
  ], "the consumer enumeration changed");
});

// --- NC-68: the kill controls are transformations of the shipped selector source ------------------
//
// C-20's five controls were hand-written locators defined inside this file; none read, transformed
// or re-imported production source (`P-C21-8`), so a control could agree with a broken selector by
// construction. Each control below reads `visual/svg-embed.mjs`, applies one named transform,
// asserts the anchor occurred **exactly once** before replacing it, and imports the result through
// a `data:text/javascript` URL (`D-C21-5`, measured on Node v26.7.0 as `P-C21-9`). No file is
// written and no repository module is mutated.
const SHARED_SOURCE_FILE = resolve(root, SHARED_MODULE);
const EMBED_ABLATIONS = {
  // (a) the C-19 anchor: the first substring that ends in `content="`, not the attribute named
  // `content` at an XML-whitespace boundary.
  substringContentName: [[
    "  const found = [];\n"
    + "  for (let at = text.indexOf(CONTENT_NAME, tag.start); at >= 0 && at < tag.end;\n"
    + "    at = text.indexOf(CONTENT_NAME, at + 1)) {\n"
    + "    if (!isSpace(text[at - 1])) continue;\n"
    + "    if (text.startsWith(CONTENT_ASSIGN, at + CONTENT_NAME.length)) found.push(at);\n"
    + "  }",
    "  const found = [text.indexOf(CONTENT_NAME + CONTENT_ASSIGN, tag.start)];",
  ]],
  // (b) the C-19 root anchor: whichever escaped root comes first inside the value, with neither the
  // "first bytes" nor the "only root" requirement.
  firstRootInValue: [
    ["  assertRootIsFirstBytes(value);", "  void value;"],
    ["  assertRootCount(value);", "  void value;"],
  ],
  // (c) the root-count rule alone: a second real root inside the value is tolerated.
  dropRootCountRule: [["  assertRootCount(value);", "  void value;"]],
  // (d) the "the value end must lie inside the <svg> opening tag" bound.
  dropValueEndInsideTag: [[
    "  if (valueEnd < 0 || valueEnd > tag.end) throw new Error(\"content attribute: unterminated value\");",
    "  if (valueEnd < 0) throw new Error(\"content attribute: unterminated value\");",
  ]],
  // (e) the agent attribute-name boundary relaxed to a bare `\bagent=`.
  relaxAgentBoundary: [[
    "    if (isSpace(inside[at - 1])) found.push(at);",
    "    if (true) found.push(at);",
  ]],
};

// Reads the shipped source, applies one named transform, and imports the result. The occurrence
// count is asserted **before** replacing, so a rename can never turn a control into a silent no-op
// — the shape `ablatePlugin` already enforces by throwing (`visual/render-native.mjs`).
async function ablateEmbed(name) {
  const original = readFileSync(SHARED_SOURCE_FILE, "utf8");
  if (name === null) return import(`data:text/javascript,${encodeURIComponent(original)}`);
  const patches = EMBED_ABLATIONS[name];
  if (!patches) throw new Error(`unknown embed ablation "${name}"`);
  let source = original;
  for (const [from, to] of patches) {
    const occurrences = source.split(from).length - 1;
    assert.equal(occurrences, 1,
      `embed ablation "${name}" anchor occurs ${occurrences} times: ${JSON.stringify(from.slice(0, 60))}`);
    source = source.replace(from, to);
  }
  assert.notEqual(source, original, `embed ablation "${name}" changed nothing`);
  // The trailing marker is the cache key: two controls can never share a module instance.
  return import(`data:text/javascript,${encodeURIComponent(`${source}\n//# ablation=${name}\n`)}`);
}

// (d)'s fixture: the content attribute's closing quote deleted **and** a matching
// `&lt;/mxfile&gt;"` tail written into the rendered body, so a selector without the in-tag bound
// rebinds the value into the body and still finds a well-formed root chain — a silent wrong answer
// rather than the named error the bound produces. Built with the independent tokeniser.
const withRebindableTail = (text) => {
  const { valueEnd } = contentPair(text);
  const closeAt = valueEnd - ROOT_CLOSE_ESCAPED.length;
  assert.equal(text.slice(closeAt, valueEnd), ROOT_CLOSE_ESCAPED, "the value does not end with the root close");
  const unquoted = `${text.slice(0, closeAt)}&lt;/mxfake&gt;${text.slice(valueEnd + 1)}`;
  const tagEnd = unquoted.indexOf(">", unquoted.indexOf("<svg"));
  return `${unquoted.slice(0, tagEnd + 1)}${ROOT_CLOSE_ESCAPED}"${unquoted.slice(tagEnd + 1)}`;
};

const EMBED_CONTROLS = [
  {
    name: "substringContentName",
    label: "(a) the exact content name relaxed to a substring match",
    fixture: withValidDecoy,
    broken: (module, text) => module.agentOf(text),
    expect: (value) => assert.equal(value, DECOY_AGENT, "(a) no longer selects the data-content decoy"),
    shipped: (text) => assert.notEqual(agentOf(text), DECOY_AGENT),
  },
  {
    name: "firstRootInValue",
    label: "(b) the root's first-bytes / single-root requirement dropped",
    fixture: withFakeRootBefore,
    broken: (module, text) => module.agentOf(text),
    expect: (value) => assert.equal(value, "DECOY-B", "(b) no longer selects the prepended fake root"),
    shipped: (text) => assert.throws(() => agentSpan(text), /carries 2 escaped &lt;mxfile open tags/),
  },
  {
    name: "dropRootCountRule",
    label: "(c) the root-count rule dropped",
    fixture: withSecondRootInside,
    broken: (module, text) => module.agentOf(text),
    expect: (value, text, svg) => assert.equal(value, agentOf(svg),
      "(c) did not tolerate the second root silently"),
    shipped: (text) => assert.throws(() => agentSpan(text), /carries 2 escaped &lt;mxfile open tags/),
  },
  {
    name: "dropValueEndInsideTag",
    label: "(d) the in-tag value-end bound dropped",
    fixture: withRebindableTail,
    broken: (module, text) => {
      const { valueEnd } = module.contentAttribute(text);
      const tag = module.svgOpenTagSpan(text);
      module.agentOf(text);
      return valueEnd > tag.end ? "rebound-into-body" : "still-inside-the-tag";
    },
    expect: (value) => assert.equal(value, "rebound-into-body",
      "(d) did not rebind the value end past the <svg> opening tag"),
    shipped: (text) => assert.throws(() => agentSpan(text), /content attribute: unterminated value/),
  },
  {
    name: "relaxAgentBoundary",
    label: "(e) the agent name boundary relaxed",
    fixture: withXAgent,
    broken: (module, text) => {
      let message = null;
      try { module.agentSpan(text); } catch (error) { message = error.message; }
      return message;
    },
    expect: (value) => assert.match(String(value), /carries 2 agent=&quot;…&quot; attributes/,
      "(e) no longer counts x-agent as a second agent"),
    shipped: (text) => assert.ok(!agentSpan(text).text.includes("DECOY")),
  },
];

test("NC-68 (a)-(d) each control transforms the shipped selector source and is red on its clause", async () => {
  const svg = readFileSync(resolve(root, "examples/hero.drawio.svg"), "utf8");
  const executed = new Set();
  const modules = new Map();
  for (const control of EMBED_CONTROLS) {
    const module = await ablateEmbed(control.name);
    modules.set(control.name, module);
    const text = control.fixture(svg);
    assert.notEqual(text, svg, `${control.label}: the fixture did not apply`);
    const observed = control.broken(module, text);
    console.log(`NC-68 ${control.label}: ablated -> ${JSON.stringify(String(observed).slice(0, 72))}`);
    control.expect(observed, text, svg);
    // …and the shipped module gets the same fixture right, so the control isolates the mutation.
    control.shipped(text);
    executed.add(control.name);
  }
  // (d) every declared mutation path is executed, and the declared set is exactly the five the
  // criterion names — a declared-but-unrun control, or a missing one, fails here.
  console.log(`NC-68 executed=${JSON.stringify([...executed].sort())}`);
  assert.deepEqual([...executed].sort(), Object.keys(EMBED_ABLATIONS).sort(),
    "a declared control never ran");
  assert.deepEqual(Object.keys(EMBED_ABLATIONS).sort(), [
    "dropRootCountRule", "dropValueEndInsideTag", "firstRootInValue", "relaxAgentBoundary",
    "substringContentName",
  ], "the control set is not the five mutations the criterion enumerates");
  // Two controls are two modules: the data: URL cache key really discriminates.
  assert.notEqual(modules.get("substringContentName"), modules.get("relaxAgentBoundary"),
    "two ablations shared one module instance");
});

test("NC-68 (b) every anchor is asserted to occur exactly once in the shipped source", async () => {
  const source = readFileSync(SHARED_SOURCE_FILE, "utf8");
  for (const [name, patches] of Object.entries(EMBED_ABLATIONS)) {
    for (const [from] of patches) {
      const occurrences = source.split(from).length - 1;
      console.log(`NC-68 anchor ${name} occurrences=${occurrences}`);
      assert.equal(occurrences, 1, `${name}: the anchor does not occur exactly once`);
    }
  }
  // A renamed anchor must fail loudly rather than degrade into a no-op.
  await assert.rejects(() => ablateEmbed("noSuchControl"), /unknown embed ablation/);
});

test("NC-68 (c) the untransformed source imported the same way is byte-identical in behaviour", async () => {
  const fidelity = await ablateEmbed(null);
  for (const name of EXAMPLES) {
    const svg = readFileSync(resolve(root, `examples/${name}.drawio.svg`), "utf8");
    const shipped = {
      content: agentSpan(svg), root: rootTagSpan(svg), value: splitAtAgent(svg),
    };
    const imported = {
      content: fidelity.agentSpan(svg), root: fidelity.rootTagSpan(svg), value: fidelity.splitAtAgent(svg),
    };
    console.log(`NC-68 fidelity ${name} agent=[${imported.content.start},${imported.content.end}) `
      + `root=[${imported.root.start},${imported.root.end}) `
      + `contentValueBytes=${fidelity.contentValue(svg).length}`);
    assert.deepEqual(imported.content, shipped.content, `${name} the imported agent span differs`);
    assert.deepEqual(imported.root, shipped.root, `${name} the imported root span differs`);
    assert.deepEqual(imported.value, shipped.value, `${name} the imported split differs`);
    assert.equal(fidelity.contentValue(svg), independentContentValue(svg),
      `${name} the imported value selector differs`);
  }
});


// NC-61 negative controls (a) and (b), each an explicit alternative selector run alone against the
// same fixtures. (a) is the C-18 first-match-anywhere regex verbatim; (b) is this correction's own
// anchoring with "exactly one" relaxed to "the first one in the root tag".
const firstMatchAnywhere = (text) => {
  const found = /\bagent=&quot;[^&]*&quot;/.exec(text);
  if (!found) throw new Error("no <mxfile agent=…> attribute in the exported bytes");
  return { start: found.index, end: found.index + found[0].length, text: found[0] };
};
const firstAgentInRootTag = (text) => {
  const hand = rootTagByHand(text);
  if (!hand.tokens.length) throw new Error("the root open tag carries no agent");
  return { start: hand.agentAt, end: hand.agentAt + hand.tokens[0].length, text: hand.tokens[0] };
};

test("NC-61 negative controls: the C-18 selector picks the decoy, and 'first in tag' tolerates two", () => {
  const svg = readFileSync(resolve(root, "examples/hero.drawio.svg"), "utf8");
  // (a) the shipped C-18 selector on the decoy fixture that NC-61 (i) passes.
  const decoyed = withDecoy(svg);
  const c18 = firstMatchAnywhere(decoyed);
  console.log(`NC-61 (a) C-18 first-match-anywhere selects ${JSON.stringify(c18.text)}`);
  assert.equal(c18.text, DECOY, "the C-18 selector no longer picks the decoy, so it is not the control");
  assert.notEqual(agentSpan(decoyed).text, c18.text,
    "the anchored selector agrees with the C-18 selector, so (i) proves nothing");
  // (b) "the first agent inside the root tag" on the duplicate fixture that NC-61 (iv) rejects.
  const duplicated = svg.replace(" agent=&quot;", " agent=&quot;Second/1.0&quot; agent=&quot;");
  assert.notEqual(duplicated, svg);
  const relaxed = firstAgentInRootTag(duplicated);
  console.log(`NC-61 (b) 'first agent in the root tag' selects ${JSON.stringify(relaxed.text)} `
    + "where 'exactly one' throws");
  assert.equal(relaxed.text, 'agent=&quot;Second/1.0&quot;',
    "the relaxed selector did not select silently, so it is not the control");
  assert.throws(() => agentSpan(duplicated), /carries 2 agent=&quot;…&quot; attributes/);
});

test("NC-14 the shipped body is Draw.io-generated, not a curated imitation", () => {
  for (const name of EXAMPLES) {
    const { svg } = sources[name];
    // Draw.io's export signature: half-pixel viewBox origin, its light-dark background style and
    // its pointer-events shapes. None of these appear in a hand-authored body.
    assert.match(svg, /viewBox="-0\.5 -0\.5 \d+ \d+"/, `${name} draw.io viewBox`);
    assert.match(svg, /background-color: light-dark\(/, `${name} draw.io background style`);
    assert.match(svg, /pointer-events="/, `${name} draw.io pointer events`);
    assert.doesNotMatch(svg, /class="(entity-card|metric-row|state-pill|impact-pill|legend|lane)"/,
      `${name} curated class`);
    assert.doesNotMatch(svg, /<foreignObject\b|data:image|<image\b/i, `${name} non-native content`);
  }
  const testDir = resolve(root, "test");
  for (const file of ["native-render.test.mjs", "artifacts.test.mjs", "examples.test.mjs",
    "workspace.test.mjs", "simulator.test.mjs", "plugin-adapter.test.mjs"]) {
    const source = readFileSync(resolve(testDir, file), "utf8");
    assert.doesNotMatch(source, /\.(entity-card|metric-row|state-pill|impact-pill)\b/,
      `${file} selects a curated class`);
  }
  assert.equal(existsSync(resolve(root, "test/visual-contract.test.mjs")), false);
  assert.equal(existsSync(resolve(root, "visual/capture.mjs")), false);
});

test("NC-15 the three native renders exist, are current, and stay legible at fit zoom", () => {
  const artifacts = EXAMPLES.map((name) => statSync(resolve(root, `examples/${name}.drawio.svg`)));
  // The pane a user actually opens the file in. VS Code's editor area on a 1440px window with the
  // side bar open is roughly this; it is stated here so the zoom number below is falsifiable.
  const PANE = { w: 1200, h: 800 };
  const optics = {};
  for (const [index, name] of EXAMPLES.entries()) {
    const image = resolve(root, `visual/native-${name}.png`);
    assert.ok(existsSync(image), `${image} missing`);
    assert.ok(statSync(image).size > 40000, `${image} looks empty`);
    assert.ok(statSync(image).mtimeMs >= artifacts[index].mtimeMs - 1000,
      `${image} is older than its artifact — re-run visual/render-native.mjs`);
    const { width, height } = report[name].graph;
    const fitZoom = Math.min(PANE.w / width, PANE.h / height);
    // Painted gap, not model gap: the stroke eats `strokeWidth` of the separation before the zoom
    // factor shrinks what is left.
    const devicePx = (PARALLEL_MIN_SEPARATION - STROKE_WIDTH) * fitZoom;
    optics[name] = {
      canvas: `${width}x${height}`,
      fitZoom: Number(fitZoom.toFixed(3)),
      gapDevicePx: Number(devicePx.toFixed(2)),
      pngBytes: statSync(image).size,
      pngSha256: artifactDigests(name).pngSha256.slice(0, 16),
    };
    assert.ok(fitZoom >= 0.35,
      `${name} fit zoom ${fitZoom.toFixed(3)} — the canvas grew enough to shrink the gap it bought`);
    assert.ok(devicePx > 2,
      `${name} paints the 8px separation as ${devicePx.toFixed(2)} device px at fit zoom`);
  }
  console.log(`NC-15 fit-zoom optics (pane ${PANE.w}x${PANE.h}) ${JSON.stringify(optics)}`);
});

// --- NC-33: the shipped PNGs and the report provably belong to the shipped models ---------------
// The old currency proof was `png.mtime >= artifact.mtime - 1000`, which the 23:18 interactive save
// only tripped by accident. These bind content: the artifact bytes, the PNG bytes and the canonical
// digest of the model the PNG was rendered from.

const nativeReport = JSON.parse(readFileSync(resolve(root, "visual/native-report.json"), "utf8"));

test("NC-33 the report binds each artifact's bytes, its PNG's bytes and its model digest", () => {
  const recomputed = {};
  for (const name of EXAMPLES) {
    const entry = nativeReport.summary[name];
    assert.ok(entry, `${name} missing from visual/native-report.json`);
    const digests = artifactDigests(name);
    recomputed[name] = {
      artifactSha256: digests.artifactSha256.slice(0, 16),
      pngSha256: digests.pngSha256.slice(0, 16),
      modelDigest: digests.modelDigest.slice(0, 16),
    };
    assert.equal(entry.artifactSha256, digests.artifactSha256,
      `${name}: examples/${name}.drawio.svg does not match the report — re-run \`npm run artifacts\``);
    assert.equal(entry.pngSha256, digests.pngSha256,
      `${name}: visual/native-${name}.png does not match the report — re-run \`npm run artifacts\``);
    assert.equal(entry.modelDigest, digests.modelDigest,
      `${name}: the report's model digest is not the model on disk`);
    // And the digest is the digest of the model the generator builds, so all three files and the
    // authored source are bound to one another rather than merely to each other.
    assert.equal(digests.modelDigest, modelDigest(buildExample(name).model),
      `${name}: the shipped model is not the model its source builds`);
  }
  console.log(`NC-33 digests (16 hex) ${JSON.stringify(recomputed)}`);
});

test("NC-33 a mutated artifact, a mutated PNG and a stale report entry are each caught by name", () => {
  const failures = [];
  const check = (name, entry, digests) => {
    const found = [];
    if (entry.artifactSha256 !== digests.artifactSha256) found.push(`${name}: artifact bytes`);
    if (entry.pngSha256 !== digests.pngSha256) found.push(`${name}: png bytes`);
    if (entry.modelDigest !== digests.modelDigest) found.push(`${name}: model digest`);
    return found;
  };
  // (a) one attribute changed in a *copy* of the artifact — nothing on disk is touched.
  const artifactBytes = readFileSync(resolve(root, "examples/hero.drawio.svg"));
  const good = artifactDigests("hero");
  const mutatedArtifact = Buffer.from(
    artifactBytes.toString("utf8").replace('content="&lt;mxfile', 'content="&lt;mxfile '),
  );
  failures.push(...check("hero-artifact", nativeReport.summary.hero, {
    ...good, artifactSha256: sha256(mutatedArtifact),
  }));
  // (b) one byte changed in a copy of the PNG.
  const pngBytes = Buffer.from(readFileSync(resolve(root, "visual/native-hero.png")));
  pngBytes[pngBytes.length - 1] ^= 0x01;
  failures.push(...check("hero-png", nativeReport.summary.hero, { ...good, pngSha256: sha256(pngBytes) }));
  // (c) a stale report entry: the digests of a *different* example.
  failures.push(...check("kitchen-sink-stale", { ...nativeReport.summary.hero }, artifactDigests("kitchen-sink")));
  // (d) the real 2026-07-26 23:18 interactive save: its model digest cannot match the report.
  const drifted = readDrawioSvg(resolve(root, "test/fixtures/interactively-saved-kitchen-sink.drawio.svg"));
  const driftedDigest = modelDigest(drifted.model);
  if (driftedDigest !== nativeReport.summary["kitchen-sink"].modelDigest) {
    failures.push("kitchen-sink-drifted: model digest");
  }
  console.log(`NC-33 negative controls caught ${JSON.stringify(failures)}`);
  assert.deepEqual(failures.sort(), [
    "hero-artifact: artifact bytes",
    "hero-png: png bytes",
    "kitchen-sink-drifted: model digest",
    "kitchen-sink-stale: artifact bytes",
    "kitchen-sink-stale: model digest",
    "kitchen-sink-stale: png bytes",
  ]);
  assert.notEqual(driftedDigest, modelDigest(buildExample("kitchen-sink").model),
    "the drifted save must not share the canonical model digest");
});

test("NC-33 a content change is caught even when the mtimes agree", () => {
  // The point of the criterion: mtime alone would let a same-second rewrite through.
  const artifact = resolve(root, "examples/kitchen-sink.drawio.svg");
  const png = resolve(root, "visual/native-kitchen-sink.png");
  assert.ok(statSync(png).mtimeMs >= statSync(artifact).mtimeMs - 1000, "mtime signal still holds");
  // A model that differs by exactly one attribute keeps every mtime and still fails the digest.
  const shippedModel = readDrawioSvg(artifact).model;
  const oneAttribute = shippedModel.replace('ahmComputedState="Healthy"', 'ahmComputedState="Degraded"');
  assert.notEqual(oneAttribute, shippedModel, "the one-attribute mutation did not apply");
  assert.notEqual(modelDigest(oneAttribute), nativeReport.summary["kitchen-sink"].modelDigest);
});

// --- C-14: the shipped install() path, open stability and Undo/Redo ----------------------------

const CLEAN_OPEN = {
  modified: false, historyLength: 0, indexOfNextAdd: 0, driftedCells: 0, driftLines: 0,
};
const openFacts = (item) => ({
  modified: item.modified, historyLength: item.historyLength,
  indexOfNextAdd: item.indexOfNextAdd, driftedCells: item.driftedCells, driftLines: item.driftLines,
});
const ACTIONS = [
  "ahmSetHealthy", "ahmSetDegraded", "ahmSetUnhealthy", "ahmSetUnknown",
  "ahmImpactStandard", "ahmImpactLimited", "ahmImpactSuppressed", "ahmRecalculate", "ahmValidate",
];

test("NC-38 install() is what registers the shipped actions, and the bare factory is not", () => {
  for (const name of EXAMPLES) {
    const registration = openBefore[name].registration;
    console.log(`NC-38 ${name} registration ${JSON.stringify(registration)}`);
    assert.equal(registration.installed, true);
    assert.deepEqual(registration.actions, ACTIONS, `${name} did not register every action`);
    assert.deepEqual(registration.missing, [], `${name} is missing actions`);
    assert.equal(registration.menu, true, `${name} registered no AHM Health Model menu`);
  }
  // Negative control: the same page, the same factory available on `window`, install() not called.
  const bare = openNoInstall["kitchen-sink"].registration;
  console.log(`NC-38 without install() ${JSON.stringify(bare)}`);
  assert.equal(bare.installed, false);
  assert.deepEqual(bare.actions, [], "actions resolved without install() being called");
  assert.deepEqual(bare.missing, ACTIONS);
  assert.equal(bare.menu, false);
  // And the whole NC-32 transition run — export through Draw.io's own xmlsvg handler and reopen
  // included — is driven through the same entry point: pluginPillTransitions throws when
  // install() registers nothing, so its green result is an install()-path result.
  assert.ok(pillRuntime.exportBytes > 40000, "the install()-driven export produced no real bytes");
});

test("NC-34 opening a shipped example with the plugin installed changes nothing", () => {
  for (const name of EXAMPLES) {
    console.log(`NC-34 ${name} install-before-load ${JSON.stringify(openFacts(openBefore[name]))}`);
    assert.deepEqual(openFacts(openBefore[name]), CLEAN_OPEN, `${name} was dirtied on open`);
    assert.deepEqual(openBefore[name].drift, [], `${name} drifted on open`);
    assert.deepEqual(openBefore[name].errors, [], `${name} reported errors on open`);
  }
  // (b) both install orders. `Draw.loadPlugin` runs during EditorUi init, i.e. before the file is
  // loaded, so install-before-load above is the production order; install-after-load must be clean
  // too, so the result cannot come from an ordering accident.
  for (const name of EXAMPLES) {
    console.log(`NC-34 ${name} install-after-load ${JSON.stringify(openFacts(openAfter[name]))}`);
    assert.deepEqual(openFacts(openAfter[name]), CLEAN_OPEN, `${name} dirtied with a late install`);
    assert.deepEqual(openAfter[name].errors, []);
  }
  // (c) the cross-check with NC-37: this cannot be satisfied by a plugin that stopped working.
  const edited = editSequence.find((step) => step.step === "external edit + wait");
  assert.equal(edited.values.root.computed, "Unhealthy",
    "a clean open was bought by a listener that no longer propagates");
});

test("NC-34 negative control (a): the pre-C-14 plugin dirties every shipped example on open", () => {
  for (const name of EXAMPLES) {
    const item = openPreC14[name];
    console.log(`NC-34 pre-C-14 ${name} ${JSON.stringify(openFacts(item))}`);
    assert.equal(item.modified, true, `${name} was not dirtied by the pre-C-14 plugin`);
    assert.equal(item.historyLength, 1, `${name} recorded ${item.historyLength} undo edits`);
    assert.ok(item.driftLines >= 30,
      `${name} drifted only ${item.driftLines} lines, expected the 30+ class`);
    // The measured signature of the runtime metric: every pill 1px narrower and 1px further right.
    assert.ok(item.drift.some((line) => /-state: w built="83" artifact="82"/.test(line)),
      `${name}: expected the 1px pill narrowing, got ${JSON.stringify(item.drift.slice(0, 3))}`);
  }
});

test("NC-34 negative control (d): each removed root turns the open red on its own", () => {
  // The discriminator: the load/replay filter reverted alone. The plugin now recalculates the whole
  // model on load — and still writes nothing, because the other two roots are fixed.
  const unfiltered = openUnfiltered["kitchen-sink"];
  console.log(`NC-34 listener-filter reverted alone ${JSON.stringify(openFacts(unfiltered))}`);
  assert.deepEqual(openFacts(unfiltered), CLEAN_OPEN,
    "recalculating on load is not itself what dirties the file");

  // Root 1, the runtime font metric.
  const metric = openMetric["kitchen-sink"];
  console.log(`NC-34 runtime metric restored ${JSON.stringify(openFacts(metric))}`);
  assert.equal(metric.modified, true, "the runtime metric no longer dirties the file");
  assert.equal(metric.historyLength, 1);
  assert.ok(metric.drift.some((line) => /-state: w built="83" artifact="82"/.test(line)),
    `expected the 1px narrowing, got ${JSON.stringify(metric.drift.slice(0, 3))}`);

  // Root 3, string style comparison plus key churn. The canonical drift report sorts style keys, so
  // a pure reordering is invisible there by design (NC-31 control (c)) — the undoable edit is the
  // signal, and it is exactly the edit that sets `editor.modified`.
  const style = openStyle["kitchen-sink"];
  console.log(`NC-34 string style comparison restored ${JSON.stringify(openFacts(style))}`);
  assert.equal(style.modified, true, "string style comparison no longer dirties the file");
  assert.equal(style.historyLength, 1, "the style churn recorded no undoable edit");

  // Root 2, the generator shipping the authored state instead of the plugin's rollup.
  const authored = openAuthored["kitchen-sink"];
  console.log(`NC-34 authored-state artifact ${JSON.stringify(openFacts(authored))}`);
  assert.equal(authored.modified, true, "an authored-state artifact no longer dirties the file");
  assert.equal(authored.historyLength, 1);
  assert.ok(authored.drift.some((line) =>
    /^shop: sem .*ahmComputedState=Healthy.*ahmComputedState=Degraded/.test(line)),
  `expected shop to be recomputed, got ${JSON.stringify(authored.drift.slice(0, 3))}`);
});

const step = (steps, label) => {
  const found = steps.find((item) => item.step === label);
  if (!found) throw new Error(`no "${label}" step in ${JSON.stringify(steps.map((s) => s.step))}`);
  return found;
};
const undoSteps = (steps) => steps.filter((item) => /^undo /.test(item.step));
const redoSteps = (steps) => steps.filter((item) => /^redo /.test(item.step));

test("NC-37 one external edit is one entry, settles, and Undo/Redo stays settled", () => {
  for (const item of editSequence) {
    console.log(`NC-37 ${item.step.padEnd(24)} history=${item.historyLength} `
      + `index=${item.indexOfNextAdd} modified=${item.modified} `
      + `${Object.entries(item.values).map(([id, v]) => `${id}=${v.computed}/${v.pillWidth}`).join(" ")}`);
    assert.deepEqual(item.errors, [], `${item.step} reported errors`);
  }
  const loaded = step(editSequence, "install + load + wait");
  assert.deepEqual(
    { modified: loaded.modified, historyLength: loaded.historyLength, indexOfNextAdd: loaded.indexOfNextAdd },
    { modified: false, historyLength: 0, indexOfNextAdd: 0 },
  );

  // Literals, never `settled.historyLength`: one relevant semantic operation is exactly one entry.
  const edited = step(editSequence, "external edit + wait");
  assert.equal(edited.historyLength, 1, `one external edit produced ${edited.historyLength} undoable edits`);
  assert.equal(edited.indexOfNextAdd, 1);

  // (a) it really propagated: the edited entity, both of its parents and the root all moved, in the
  // model the runtime is actually holding — state, pill label, pill geometry and card fill.
  assert.equal(edited.values.db.local, "Unhealthy");
  for (const id of ["db", "shop", "reporting", "root"]) {
    assert.equal(edited.values[id].computed, "Unhealthy", `${id} did not roll up`);
    assert.equal(edited.values[id].label, "Unhealthy", `${id} pill label`);
    assert.equal(edited.values[id].pillWidth, 84, `${id} pill width`);
    assert.equal(edited.values[id].pillX, 128, `${id} pill x`);
    assert.equal(edited.values[id].fill, "#faeceb", `${id} card fill`);
    assert.notEqual(loaded.values[id].computed, "Unhealthy", `${id} was already Unhealthy`);
  }

  // The invariant: nothing moves across a wait longer than any timer the plugin could hold.
  const settled = step(editSequence, "+ wait again");
  assert.equal(settled.historyLength, 1, "history moved across the settle");
  assert.equal(settled.indexOfNextAdd, 1, "index moved across the settle");
  assert.deepEqual(settled.values, edited.values, "the model moved across the settle");

  // One undo restores everything; a second undo has nothing left to do.
  for (const label of ["undo 1 + wait", "undo 2 + wait"]) {
    const item = step(editSequence, label);
    assert.equal(item.historyLength, 1, `${label} rewrote the history`);
    assert.equal(item.indexOfNextAdd, 0, `${label} index`);
    assert.deepEqual(item.values, loaded.values, `${label} did not restore the model`);
  }
  // One redo puts it all back; a second redo has nothing left to do.
  for (const label of ["redo 1 + wait", "redo 2 + wait"]) {
    const item = step(editSequence, label);
    assert.equal(item.historyLength, 1, `${label} rewrote the history`);
    assert.equal(item.indexOfNextAdd, 1, `${label} index`);
    assert.deepEqual(item.values, edited.values, `${label} did not restore the model`);
  }

  // (c) an irrelevant mutation: a pure card move records the move and nothing else.
  const moved = step(editSequence, "move a card + wait");
  assert.equal(moved.historyLength, 2, "the move produced more than one edit");
  assert.equal(moved.indexOfNextAdd, 2);
  assert.deepEqual(moved.values, edited.values, "the move triggered a recalculation write");
});

test("NC-37 negative control (b): the pre-C-14 plugin never settles after an undo", () => {
  const loaded = step(editPreC14, "install + load + wait");
  console.log(`NC-37 pre-C-14 open history=${loaded.historyLength} modified=${loaded.modified}`);
  assert.equal(loaded.modified, true, "the pre-C-14 plugin no longer dirties the open");
  assert.equal(loaded.historyLength, 1);

  const edited = step(editPreC14, "external edit + wait");
  const undos = undoSteps(editPreC14);
  assert.ok(undos.length >= 1);
  for (const item of undos) {
    console.log(`NC-37 pre-C-14 ${item.step} history=${item.historyLength} index=${item.indexOfNextAdd}`);
    // The measured defect: ~600 ms after the undo the listener has re-applied and the index is back
    // at the top, so the undo is gone and the redo entry it should have created is replaced.
    assert.equal(item.indexOfNextAdd, item.historyLength,
      `${item.step} settled — the control no longer reproduces the defect`);
    assert.equal(item.values.db.computed, edited.values.db.computed,
      `${item.step} restored the model — the control no longer reproduces the defect`);
  }
  // And the pill widths in this run are the 1px-narrower runtime measurement.
  assert.equal(loaded.values.root.pillWidth, 82);
  assert.equal(editSequence[0].values.root.pillWidth, 83);
});

test("NC-35 / NC-37 (d) malformed input and scheduled failures reach ui.handleError", () => {
  const expected = {
    "no state-label child": /state pill db-state has no state-label child to write/,
    "state-label with no font style": /state label carries no font style/,
    "state-label at a font size the contract was not derived for":
      /state label font size 14 is not the pill contract's 10/,
    "state cell with no geometry": /state pill is missing its container or label cell/,
    "entity carrying a state the model does not define": /invalid state Sideways in db/,
  };
  for (const [name, pattern] of Object.entries(expected)) {
    const item = failurePaths[name];
    assert.ok(item, `no failure result for "${name}"`);
    console.log(`NC-35 failure "${name}" action=${JSON.stringify(item.viaAction)} `
      + `listener=${JSON.stringify(item.viaListener.slice(0, 1))}`);
    // The registered action path, i.e. what the menu entry drives.
    assert.ok(item.viaAction.some((line) => pattern.test(line)),
      `"${name}" was swallowed by the action path: ${JSON.stringify(item.viaAction)}`);
    // The scheduled path, i.e. the debounced listener — "zero edits" must never come from a
    // recalculation that threw into silence.
    assert.ok(item.viaListener.some((line) => pattern.test(line)),
      `"${name}" was swallowed by the scheduled path: ${JSON.stringify(item.viaListener)}`);
  }
});

// --- C-15: one relevant semantic user operation is exactly one undo entry -----------------------
//
// Every expectation below is written as a literal. Nothing is measured from the run and then
// asserted back at it, and every history/index number is stated, never derived from
// `settled.historyLength`.

const PRE_EDIT = {
  db: { local: "Healthy", computed: "Healthy", label: "Healthy", pillWidth: 73, pillX: 139, fill: "#f2f8f2" },
  shop: { local: "Healthy", computed: "Degraded", label: "Degraded", pillWidth: 83, pillX: 129, fill: "#fbf2e7" },
  reporting: { local: "Degraded", computed: "Degraded", label: "Degraded", pillWidth: 83, pillX: 129, fill: "#fbf2e7" },
  root: { local: "Degraded", computed: "Degraded", label: "Degraded", pillWidth: 83, pillX: 129, fill: "#fbf2e7" },
};
const POST_EDIT = {
  db: { local: "Unhealthy", computed: "Unhealthy", label: "Unhealthy", pillWidth: 84, pillX: 128, fill: "#faeceb" },
  shop: { local: "Healthy", computed: "Unhealthy", label: "Unhealthy", pillWidth: 84, pillX: 128, fill: "#faeceb" },
  reporting: { local: "Degraded", computed: "Unhealthy", label: "Unhealthy", pillWidth: 84, pillX: 128, fill: "#faeceb" },
  root: { local: "Degraded", computed: "Unhealthy", label: "Unhealthy", pillWidth: 84, pillX: 128, fill: "#faeceb" },
};
// What the user can actually see: the painted pill label, the painted pill width and the painted
// card fill. Read from the live DOM, not from the model.
const PAINTED_PRE = {
  db: { label: "Healthy", pillWidth: 73, cardFill: "#f2f8f2" },
  shop: { label: "Degraded", pillWidth: 83, cardFill: "#fbf2e7" },
  reporting: { label: "Degraded", pillWidth: 83, cardFill: "#fbf2e7" },
  root: { label: "Degraded", pillWidth: 83, cardFill: "#fbf2e7" },
};
const PAINTED_POST = {
  db: { label: "Unhealthy", pillWidth: 84, cardFill: "#faeceb" },
  shop: { label: "Unhealthy", pillWidth: 84, cardFill: "#faeceb" },
  reporting: { label: "Unhealthy", pillWidth: 84, cardFill: "#faeceb" },
  root: { label: "Unhealthy", pillWidth: 84, cardFill: "#faeceb" },
};
const painted = (probe) => Object.fromEntries(Object.entries(probe.rendered).map(([id, item]) => [
  id, { label: item.label, pillWidth: item.pill.w, cardFill: item.card.fill },
]));

const RANK = { Healthy: 0, Unknown: 0, Degraded: 1, Unhealthy: 2 };
// A rolled-up state can never be *better* than the entity's own local state. `db` reading
// local=Unhealthy with computed=Healthy is the exact self-contradiction the user rejected.
const modelContradictions = (pairs) => Object.entries(pairs)
  .filter(([, pair]) => RANK[pair.split("/")[1]] < RANK[pair.split("/")[0]])
  .map(([id, pair]) => `${id} ${pair}`);
// The painted pill label must be the state the entity actually holds.
const renderContradictions = (pairs) => Object.entries(pairs)
  .filter(([, pair]) => pair.split("/")[0] !== pair.split("/")[1])
  .map(([id, pair]) => `${id} ${pair}`);

const atomicStep = (run, label) => {
  const found = run.steps.find((item) => item.step === label);
  if (!found) throw new Error(`no "${label}" step in ${JSON.stringify(run.steps.map((s) => s.step))}`);
  return found;
};

test("NC-40 one relevant semantic user operation is exactly one undo entry", () => {
  for (const item of atomic.steps) {
    console.log(`NC-40 ${item.step.padEnd(28)} history=${item.historyLength} index=${item.indexOfNextAdd} `
      + `entries=${JSON.stringify(item.entries.map((entry) => entry.length))} `
      + `stats=${JSON.stringify(item.stats)} `
      + Object.entries(item.values).map(([id, v]) => `${id}=${v.local}/${v.computed}/${v.pillWidth}`).join(" "));
    assert.deepEqual(item.errors, [], `${item.step} reported errors`);
  }

  const loaded = atomicStep(atomic, "install + load + settle");
  assert.deepEqual(
    { modified: loaded.modified, historyLength: loaded.historyLength, indexOfNextAdd: loaded.indexOfNextAdd },
    { modified: false, historyLength: 0, indexOfNextAdd: 0 },
  );
  assert.deepEqual(loaded.values, PRE_EDIT);
  assert.deepEqual(painted(loaded), PAINTED_PRE);

  // (i) the live undo manager, immediately and after a settle longer than any timer.
  for (const label of ["external edit (immediate)", "external edit + settle"]) {
    const item = atomicStep(atomic, label);
    assert.equal(item.historyLength, 1, `${label} historyLength`);
    assert.equal(item.indexOfNextAdd, 1, `${label} indexOfNextAdd`);
    assert.equal(item.entries.length, 1, `${label} entry count`);
    assert.deepEqual(item.values, POST_EDIT, `${label} model`);
    assert.deepEqual(painted(item), PAINTED_POST, `${label} rendered`);
  }

  // The one entry carries the user's own change *and* every transitive consequence.
  const entry = atomicStep(atomic, "external edit + settle").entries[0];
  console.log(`NC-40 single entry (${entry.length} changes) ${JSON.stringify(entry)}`);
  assert.equal(entry[0], "mxValueChange", "the entry does not open with the user's own change");
  assert.equal(entry.length, 29, "the entry does not carry the whole rollup");
  assert.deepEqual([...new Set(entry)].sort(),
    ["mxGeometryChange", "mxStyleChange", "mxValueChange"]);
  assert.equal(entry.filter((change) => change === "mxGeometryChange").length, 8,
    "pill and label geometry are missing from the entry");

  // (ii) every CHANGE dispatch, in order, with the values and the frame it carried.
  console.log(`NC-40 CHANGE dispatches ${JSON.stringify(atomic.log.change.map((item) => ({
    n: item.changes.length, values: item.values, rendered: item.rendered })))}`);
  assert.equal(atomic.log.change.length, 1, "one user operation produced more than one repaint");
  assert.equal(atomic.log.change[0].changes.length, 29);
  for (const dispatch of atomic.log.change) {
    assert.deepEqual(modelContradictions(dispatch.values), [], "a CHANGE dispatch was self-contradictory");
    assert.deepEqual(renderContradictions(dispatch.rendered), [], "a rendered frame was self-contradictory");
  }

  // The measured boundary, recorded rather than claimed away. Since C-16 the rollup joins at the
  // *outer* END_UPDATE, so the two windows now read differently:
  //   updateLevel 1, endingUpdate false — Draw.io's own `setValue` closing: the user's change only
  //   updateLevel 0, endingUpdate true  — the transaction closing: already rolled up, because the
  //                                       plugin joined at this very dispatch
  // Neither window is reachable from the view or from the undo history.
  console.log(`NC-40 END_UPDATE window ${JSON.stringify(atomic.log.endUpdate.map((item) => ({
    updateLevel: item.updateLevel, endingUpdate: item.endingUpdate, history: item.history,
    values: item.values, rendered: item.rendered, serialised: item.serialised })))}`);
  assert.equal(atomic.log.endUpdate.length, 2);
  const [inner, outer] = atomic.log.endUpdate;
  assert.deepEqual([inner.updateLevel, inner.endingUpdate], [1, false]);
  assert.deepEqual([outer.updateLevel, outer.endingUpdate], [0, true]);
  // measured: the inner window is mid-transaction, and a synchronous serialisation shows it
  assert.deepEqual(modelContradictions(inner.values), ["db Unhealthy/Healthy"]);
  assert.equal(inner.serialised, "Unhealthy/Healthy");
  // and the window an observer can actually hook — the outer one — is already consistent
  assert.deepEqual(modelContradictions(outer.values), []);
  assert.equal(outer.serialised, "Unhealthy/Unhealthy");
  // Both are unreachable from what the user sees: nothing is painted until the CHANGE dispatch
  // that follows, so the canvas still carries the whole pre-edit frame at both windows, and no
  // undo entry exists at either.
  const paintedLabels = (item) => Object.fromEntries(Object.entries(item.rendered)
    .map(([id, pair]) => [id, pair.split("/")[0]]));
  const PRE_PAINT = Object.fromEntries(Object.entries(PAINTED_PRE)
    .map(([id, item]) => [id, item.label]));
  for (const window of atomic.log.endUpdate) {
    assert.deepEqual(paintedLabels(window), PRE_PAINT, "an intermediate frame was painted");
    assert.equal(window.history, 0);
  }
});

test("NC-40 negative controls: C-14's design, the join removed, and the rollup suppressed", () => {
  // (a) the C-14 design restored: two entries and the contradictory intermediate, by value.
  const c14 = atomicStep(atomicChangeListener, "external edit + settle");
  console.log(`NC-40 (a) changeListenerRecalc history=${c14.historyLength} index=${c14.indexOfNextAdd} `
    + `entries=${JSON.stringify(c14.entries.map((entry) => entry.length))} `
    + `dispatches=${JSON.stringify(atomicChangeListener.log.change.map((d) => d.changes.length))}`);
  assert.equal(c14.historyLength, 2, "the C-14 control no longer reproduces two entries");
  assert.equal(c14.indexOfNextAdd, 2);
  assert.deepEqual(c14.entries.map((entry) => entry.length), [1, 28]);
  assert.deepEqual(atomicChangeListener.log.change.map((d) => d.changes.length), [1, 28]);
  assert.deepEqual(modelContradictions(atomicChangeListener.log.change[0].values),
    ["db Unhealthy/Healthy"], "the C-14 control showed no contradictory intermediate");
  const halfUndone = atomicStep(atomicChangeListener, "cycle 1 undo + settle");
  console.log(`NC-40 (a) after one undo ${JSON.stringify(halfUndone.values.db)} `
    + `index=${halfUndone.indexOfNextAdd}`);
  assert.deepEqual(halfUndone.values.db,
    { local: "Unhealthy", computed: "Healthy", label: "Healthy", pillWidth: 73, pillX: 139, fill: "#f2f8f2" },
    "the C-14 control no longer half-reverts on the first undo");
  assert.equal(halfUndone.indexOfNextAdd, 1);

  // (b) the join removed: the same recalculation in its own top-level transaction.
  const separate = atomicStep(atomicSeparate, "external edit + settle");
  console.log(`NC-40 (b) separateTransactionRecalc history=${separate.historyLength} `
    + `entries=${JSON.stringify(separate.entries.map((entry) => entry.length))}`);
  assert.equal(separate.historyLength, 2, "recalculating outside the transaction stayed at one entry");
  assert.deepEqual(separate.entries.map((entry) => entry.length), [1, 28]);

  // (c) the derived write suppressed: one entry, but it carries nothing, so "H = 1" alone can
  // never satisfy NC-40.
  const suppressed = atomicStep(atomicNoJoin, "external edit + settle");
  console.log(`NC-40 (c) noJoin history=${suppressed.historyLength} `
    + `entries=${JSON.stringify(suppressed.entries)} shop=${suppressed.values.shop.computed}`);
  assert.equal(suppressed.historyLength, 1);
  assert.deepEqual(suppressed.entries, [["mxValueChange"]],
    "the suppressed control still wrote the rollup");
  assert.equal(suppressed.values.shop.computed, "Degraded", "the rollup propagated with no join");
  assert.equal(suppressed.values.root.computed, "Degraded");
});

test("NC-41 one Undo restores everything, immediately and after any settle; one Redo puts it back", () => {
  const preRendered = atomicStep(atomic, "install + load + settle").rendered;
  const postRendered = atomicStep(atomic, "external edit + settle").rendered;
  for (let cycle = 1; cycle <= 3; cycle++) {
    for (const when of ["(immediate)", "+ settle"]) {
      const undo = atomicStep(atomic, `cycle ${cycle} undo ${when}`);
      console.log(`NC-41 ${undo.step.padEnd(28)} history=${undo.historyLength} index=${undo.indexOfNextAdd} `
        + Object.entries(undo.values).map(([id, v]) => `${id}=${v.computed}/${v.pillWidth}`).join(" "));
      assert.equal(undo.historyLength, 1, `${undo.step} rewrote the history`);
      assert.equal(undo.indexOfNextAdd, 0, `${undo.step} index`);
      assert.deepEqual(undo.values, PRE_EDIT, `${undo.step} model`);
      assert.deepEqual(painted(undo), PAINTED_PRE, `${undo.step} rendered`);
      assert.deepEqual(undo.rendered, preRendered, `${undo.step} rendered boxes`);
      assert.deepEqual(undo.errors, []);

      const redo = atomicStep(atomic, `cycle ${cycle} redo ${when}`);
      console.log(`NC-41 ${redo.step.padEnd(28)} history=${redo.historyLength} index=${redo.indexOfNextAdd} `
        + Object.entries(redo.values).map(([id, v]) => `${id}=${v.computed}/${v.pillWidth}`).join(" "));
      assert.equal(redo.historyLength, 1, `${redo.step} rewrote the history`);
      assert.equal(redo.indexOfNextAdd, 1, `${redo.step} index`);
      assert.deepEqual(redo.values, POST_EDIT, `${redo.step} model`);
      assert.deepEqual(painted(redo), PAINTED_POST, `${redo.step} rendered`);
      assert.deepEqual(redo.rendered, postRendered, `${redo.step} rendered boxes`);
      assert.deepEqual(redo.errors, []);
    }
  }
  // Redo is available immediately after the undo, and the plugin never ran again during a replay.
  const settled = atomicStep(atomic, "external edit + settle");
  assert.equal(settled.stats.recalculations, 1);
  assert.equal(atomicStep(atomic, "cycle 3 redo + settle").stats.recalculations, 1,
    "a replay re-entered the recalculation");
});

test("NC-41 negative control: a plugin that never rolls up fails the redo clause", () => {
  const suppressed = atomicStep(atomicNoJoin, "cycle 1 redo + settle");
  console.log(`NC-41 control noJoin redo ${JSON.stringify(suppressed.values)}`);
  assert.notDeepEqual(suppressed.values, POST_EDIT,
    "the suppressed control restored dependent values it never wrote");
  assert.equal(suppressed.values.shop.computed, "Degraded");
});

const delta = (before, after, field) => after.stats[field] - before.stats[field];

test("NC-42 transaction granularity is the user's, and nothing recurses", () => {
  const shape = (probe) => ({
    modified: probe.modified, historyLength: probe.historyLength, indexOfNextAdd: probe.indexOfNextAdd,
  });
  // 1. three health writes inside ONE beginUpdate/endUpdate.
  console.log(`NC-42 batch ${JSON.stringify(shape(granularity.batch.before))} -> `
    + `${JSON.stringify(shape(granularity.batch.after))} recalc+${delta(granularity.batch.before, granularity.batch.after, "recalculations")} `
    + `dispatches=${granularity.batch.log.change.length} `
    + `entry=${JSON.stringify(granularity.batch.after.entries.at(-1))}`);
  assert.equal(granularity.batch.after.historyLength - granularity.batch.before.historyLength, 1);
  assert.equal(delta(granularity.batch.before, granularity.batch.after, "recalculations"), 1);
  assert.equal(delta(granularity.batch.before, granularity.batch.after, "relevant"), 1);
  assert.equal(granularity.batch.log.change.length, 1, "one transaction produced more than one repaint");
  assert.equal(granularity.batch.after.entries.at(-1).filter((c) => c === "mxValueChange").length >= 4, true);

  // 2. the same three writes as three transactions: three entries, never merged.
  console.log(`NC-42 burst history ${granularity.burst.before.historyLength} -> `
    + `${granularity.burst.after.historyLength} recalc+${delta(granularity.burst.before, granularity.burst.after, "recalculations")} `
    + `entries=${JSON.stringify(granularity.burst.after.entries.map((e) => e.length))}`);
  assert.equal(granularity.burst.after.historyLength - granularity.burst.before.historyLength, 3);
  assert.equal(delta(granularity.burst.before, granularity.burst.after, "recalculations"), 3);
  assert.equal(delta(granularity.burst.before, granularity.burst.after, "relevant"), 3);

  // 3. an irrelevant mutation: a pure card move.
  console.log(`NC-42 move history ${granularity.move.before.historyLength} -> `
    + `${granularity.move.after.historyLength} entry=${JSON.stringify(granularity.move.after.entries.at(-1))} `
    + `recalc+${delta(granularity.move.before, granularity.move.after, "recalculations")}`);
  assert.equal(granularity.move.after.historyLength - granularity.move.before.historyLength, 1);
  assert.deepEqual(granularity.move.after.entries.at(-1), ["mxGeometryChange"]);
  assert.equal(delta(granularity.move.before, granularity.move.after, "recalculations"), 0);
  assert.equal(delta(granularity.move.before, granularity.move.after, "relevant"), 0);
  assert.deepEqual(granularity.move.after.values, granularity.move.before.values,
    "the move triggered a recalculation write");

  // 4. open -> settle -> export -> reopen -> settle.
  console.log(`NC-42 open ${JSON.stringify(shape(granularity.open))} reopened `
    + `${JSON.stringify(shape(granularity.reopened))} drift=${granularity.drift.length}`);
  assert.deepEqual(shape(granularity.open), { modified: false, historyLength: 0, indexOfNextAdd: 0 });
  assert.deepEqual(shape(granularity.reopened), { modified: false, historyLength: 0, indexOfNextAdd: 0 });
  assert.deepEqual(granularity.drift, []);
  assert.equal(granularity.reopened.stats.recalculations, 0, "the load recalculated");

  // 5. a recalculation whose result equals the current model.
  console.log(`NC-42 no-op recalculate history ${granularity.noop.before.historyLength} -> `
    + `${granularity.noop.after.historyLength} recalc+${delta(granularity.noop.before, granularity.noop.after, "recalculations")} `
    + `modified=${granularity.noop.after.modified}`);
  assert.equal(granularity.noop.after.historyLength, granularity.noop.before.historyLength);
  assert.equal(granularity.noop.after.historyLength, 0);
  assert.equal(granularity.noop.after.modified, false);
  assert.equal(delta(granularity.noop.before, granularity.noop.after, "recalculations"), 1,
    "the no-op clause was bought by never recalculating");

  // 6. nothing re-enters *unblocked*. Since C-18 the two shapes are counted apart: `blockedReentries`
  // is a genuine external attempt and stays 0 everywhere here, while the plugin's own closing
  // transaction re-entering its own hook — which is what stops the rollup from recomputing its own
  // output — is counted as `selfSuppressed` and happens exactly once per plugin-driven action.
  const everyStep = [
    granularity.open, granularity.reopened, granularity.noop.after, granularity.batch.after,
    granularity.burst.after, granularity.move.after, granularity.action.after,
    granularity.undo, granularity.redo,
  ];
  console.log(`NC-42 blockedReentries ${JSON.stringify(everyStep.map((item) => item.stats.blockedReentries))}`
    + ` selfSuppressed ${JSON.stringify(everyStep.map((item) => item.stats.selfSuppressed))}`);
  assert.deepEqual(everyStep.map((item) => item.stats.blockedReentries), [0, 0, 0, 0, 0, 0, 0, 0, 0],
    "something blocked a genuine external re-entry where nothing was nested");
  assert.deepEqual(everyStep.map((item) => item.stats.selfSuppressed), [0, 0, 0, 0, 0, 0, 1, 1, 1],
    "a user edit suppressed a re-entry, or the plugin's own action stopped suppressing one");
  assert.equal(delta(granularity.action.before, granularity.action.after, "selfSuppressed"), 1,
    "the plugin's own action no longer re-enters its own hook");
  assert.equal(delta(granularity.action.before, granularity.action.after, "blockedReentries"), 0,
    "the plugin's own action was counted as a genuine external re-entry");
  assert.equal(granularity.redo.stats.recalculations, granularity.action.after.stats.recalculations,
    "undo or redo recalculated");
  assert.equal(granularity.action.after.historyLength - granularity.action.before.historyLength, 1,
    "the plugin's own action is not one entry");
  assert.equal(delta(granularity.action.before, granularity.action.after, "recalculations"), 1);
});

test("NC-42 negative control (a): removing the re-entrancy guard is visible", () => {
  const guarded = granularity.action;
  const unguarded = granularityNoGuard.action;
  console.log(`NC-42 (a) guarded selfSuppressed+${delta(guarded.before, guarded.after, "selfSuppressed")} `
    + `recalc+${delta(guarded.before, guarded.after, "recalculations")} · unguarded `
    + `selfSuppressed+${delta(unguarded.before, unguarded.after, "selfSuppressed")} `
    + `recalc+${delta(unguarded.before, unguarded.after, "recalculations")}`);
  assert.equal(delta(guarded.before, guarded.after, "selfSuppressed"), 1);
  assert.equal(delta(guarded.before, guarded.after, "blockedReentries"), 0);
  assert.equal(delta(guarded.before, guarded.after, "recalculations"), 1);
  assert.equal(unguarded.after.stats.selfSuppressed, 0,
    "the guard is decorative — nothing was suppressed, yet the counter moved");
  assert.equal(unguarded.after.stats.blockedReentries, 0);
  assert.equal(delta(unguarded.before, unguarded.after, "recalculations"), 2,
    "the unguarded plugin did not recalculate twice");
});

test("NC-42 negative control (b): the relevance filter, run in isolation", () => {
  // A settled artifact cannot discriminate: recalculating it writes nothing. The model that can is
  // one whose stored rollup is stale, which is exactly what the filter has to leave alone.
  const shipped = openStale["kitchen-sink"];
  console.log(`NC-42 (b) shipped plugin on a stale-rollup model ${JSON.stringify(openFacts(shipped))}`);
  assert.deepEqual(openFacts(shipped), CLEAN_OPEN, "the shipped plugin rewrote a stale model on load");

  const unfiltered = openStaleUnfiltered["kitchen-sink"];
  console.log(`NC-42 (b) unfilteredListener alone ${JSON.stringify(openFacts(unfiltered))} `
    + `drift=${JSON.stringify(unfiltered.drift.slice(0, 1))}`);
  assert.ok(unfiltered.driftLines >= 8,
    `the filter is decorative: unfiltered drift was ${unfiltered.driftLines} lines`);
  assert.ok(unfiltered.drift.some((line) =>
    /^shop: sem .*ahmComputedState=Healthy.*ahmComputedState=Degraded/.test(line)),
  `expected shop to be recomputed on load, got ${JSON.stringify(unfiltered.drift.slice(0, 3))}`);
  // Measured, and worth stating: under the join the unfiltered write lands *inside the load
  // transaction*, so it moves the file's content while leaving `modified` and the undo history
  // untouched. Drift is the only signal, which is why the drift check is the one that guards it.
  assert.equal(unfiltered.modified, false);
  assert.equal(unfiltered.historyLength, 0);

  // And the mxRootChange early return is *not*, on its own, what stops it: a file load dispatches
  // only mxRootChange, which already fails the positive classification. Measured, not assumed.
  const noRoot = openStaleNoRootFilter["kitchen-sink"];
  console.log(`NC-42 (b) noRootChangeFilter alone ${JSON.stringify(openFacts(noRoot))}`);
  assert.deepEqual(openFacts(noRoot), CLEAN_OPEN);
});

const FAILURE_MESSAGES = {
  "no state-label child": /state pill db-state has no state-label child to write/,
  "state-label with no font style": /state label carries no font style/,
  "state-label at a font size the contract was not derived for":
    /state label font size 14 is not the pill contract's 10/,
  "state cell with no geometry": /state pill is missing its container or label cell/,
  "entity carrying a state the model does not define": /invalid state Sideways in db/,
};
// --- C-16: a failed user edit leaves nothing behind ---------------------------------------------
//
// Every expectation below is a literal. `H` and `index` are written as the numbers they must be,
// never read back off the run, and the model comparison is over user-local values, computed values,
// labels, the *whole* style string of the card, the pill and the dot, and the geometry of the card,
// the pill and the pill label — a run that restores only `ahmLocalState` cannot pass.

const rollbackStep = (item, label) => {
  const found = item.steps.find((step) => step.step === label);
  if (!found) throw new Error(`no "${label}" step in ${JSON.stringify(item.steps.map((s) => s.step))}`);
  return found;
};
// The painted boxes, rounded exactly as the probe reports them, so the rendered DOM is compared as
// data rather than as a screenshot.
const paintedOf = (probe) => Object.fromEntries(Object.entries(probe.rendered).map(([id, item]) => [
  id, { label: item.label, pill: item.pill, card: item.card },
]));

const ROLLBACK_GRID = [
  ["mid-write", rollbackMidWrite],
  ["pre-write", rollbackPreWrite],
];

test("NC-45 a failed user edit restores the whole transaction and leaves the editor untouched", () => {
  for (const [phase, run] of ROLLBACK_GRID) {
    for (const cell of ROLLBACK_CELLS) {
      const shape = cellKey(cell);
      const item = run[shape];
      assert.ok(item, `no ${phase} result for cell "${shape}"`);
      const loaded = rollbackStep(item, "loaded");
      const failed = rollbackStep(item, "failed + settle");
      const immediate = rollbackStep(item, "failed (immediate)");
      const moved = rollbackStep(item, "after an unrelated move");
      const dirty = rollbackStep(item, "failed while dirty + settle");
      console.log(`NC-45 ${phase}/${shape} clean H=${failed.historyLength} i=${failed.indexOfNextAdd} `
        + `modified=${failed.modified} currentEdit=${failed.currentEdit} updateLevel=${failed.updateLevel} `
        + `entries=${JSON.stringify(failed.entries)} errors=${JSON.stringify(failed.errors)} `
        + `xmlsvg ${item.exportClean.slice(0, 12)} -> ${item.exportAfterClean.slice(0, 12)}`);
      console.log(`NC-45 ${phase}/${shape} dirty H=${dirty.historyLength} i=${dirty.indexOfNextAdd} `
        + `modified=${dirty.modified} entries=${JSON.stringify(dirty.entries)} `
        + `xmlsvg ${item.exportDirty.slice(0, 12)} -> ${item.exportAfterDirty.slice(0, 12)}`);

      // (i) the live undo manager, as literals.
      assert.deepEqual(
        [loaded.historyLength, loaded.indexOfNextAdd, loaded.modified, loaded.entries],
        [0, 0, false, []], `${phase}/${shape} did not start from a clean editor`,
      );
      assert.deepEqual(
        [failed.historyLength, failed.indexOfNextAdd, failed.entries],
        [0, 0, []], `${phase}/${shape} left an undo entry behind`,
      );
      // (ii) editor.modified — false when the model was clean, still true when it was dirty.
      assert.equal(failed.modified, false, `${phase}/${shape} dirtied a clean editor`);
      assert.equal(immediate.modified, false, `${phase}/${shape} dirtied the editor mid-transaction`);
      // (iii) the live model: nothing dangling, no open transaction, and every watched cell back.
      assert.equal(failed.currentEdit, 0, `${phase}/${shape} left changes in model.currentEdit`);
      assert.equal(failed.updateLevel, 0, `${phase}/${shape} left model.updateLevel open`);
      assert.deepEqual(failed.cells, loaded.cells, `${phase}/${shape} did not restore the model`);
      assert.deepEqual(immediate.cells, loaded.cells,
        `${phase}/${shape} left a contradictory model before the settle`);
      // (iv) the rendered DOM: painted label, painted pill box and painted card box.
      assert.deepEqual(paintedOf(failed), paintedOf(loaded), `${phase}/${shape} repainted the canvas`);
      assert.deepEqual(paintedOf(immediate), paintedOf(loaded),
        `${phase}/${shape} showed a contradictory frame`);
      // (v) Draw.io's own xmlsvg export, over the whole bytes.
      assert.equal(item.exportAfterClean, item.exportClean, `${phase}/${shape} moved the exported bytes`);
      // Exactly once through ui.handleError.
      assert.equal(failed.errors.length, 1,
        `${phase}/${shape} reported ${failed.errors.length} errors: ${JSON.stringify(failed.errors)}`);

      // The same transaction against an editor that is already dirty and already carries an entry.
      assert.deepEqual(
        [moved.historyLength, moved.indexOfNextAdd, moved.modified, moved.entries],
        [1, 1, true, [["mxGeometryChange"]]], `${phase}/${shape} did not dirty the editor as expected`,
      );
      assert.deepEqual(
        [dirty.historyLength, dirty.indexOfNextAdd, dirty.modified, dirty.entries],
        [1, 1, true, [["mxGeometryChange"]]],
        `${phase}/${shape} disturbed the earlier entry or the dirty flag`,
      );
      assert.equal(dirty.currentEdit, 0);
      assert.equal(dirty.updateLevel, 0);
      assert.deepEqual(dirty.cells, moved.cells, `${phase}/${shape} did not restore the dirty model`);
      assert.deepEqual(paintedOf(dirty), paintedOf(moved));
      assert.equal(item.exportAfterDirty, item.exportDirty);
      assert.equal(dirty.errors.length, 2, `${phase}/${shape} did not report the second failure once`);
    }
  }
});

test("NC-45 every documented validation message still fails loudly and leaves nothing behind", () => {
  for (const [name, pattern] of Object.entries(FAILURE_MESSAGES)) {
    const item = failurePaths[name];
    assert.ok(item, `no failure result for "${name}"`);
    const before = item.probeBefore;
    const afterAction = item.probeAfterAction;
    const afterHook = item.probeAfterListener;
    console.log(`NC-45 "${name}" action=${JSON.stringify(item.viaAction.slice(0, 1))} `
      + `hook=${JSON.stringify(item.viaListener.slice(0, 1))} `
      + `H ${before.historyLength}/${afterAction.historyLength}/${afterHook.historyLength} `
      + `modified ${before.modified}/${afterHook.modified} `
      + `xmlsvg ${item.exportBefore.slice(0, 12)} -> ${item.exportAfterAction.slice(0, 12)} `
      + `-> ${item.exportAfterListener.slice(0, 12)}`);
    // The message itself, on both paths, unchanged from C-14/C-15.
    assert.ok(item.viaAction.some((line) => pattern.test(line)),
      `"${name}" was swallowed by the action path: ${JSON.stringify(item.viaAction)}`);
    assert.ok(item.viaListener.some((line) => pattern.test(line)),
      `"${name}" was swallowed by the derived-write path: ${JSON.stringify(item.viaListener)}`);
    assert.equal(item.viaAction.length, 1, `"${name}" reported the action path more than once`);
    assert.equal(item.viaListener.length, 1, `"${name}" reported the hook path more than once`);
    // Both paths leave the editor exactly as they found it.
    for (const [path, after] of [["action", afterAction], ["hook", afterHook]]) {
      assert.deepEqual(
        [after.historyLength, after.indexOfNextAdd, after.modified, after.entries],
        [0, 0, false, []], `"${name}" left something behind on the ${path} path`,
      );
      assert.equal(after.currentEdit, 0);
      assert.equal(after.updateLevel, 0);
      assert.deepEqual(after.cells, before.cells, `"${name}" did not restore the model (${path})`);
      assert.deepEqual(paintedOf(after), paintedOf(before), `"${name}" repainted the canvas (${path})`);
    }
    assert.equal(item.exportAfterAction, item.exportBefore);
    assert.equal(item.exportAfterListener, item.exportBefore);
  }
});

// The exact levels a rolled-back user transaction closes through. `single` is one inner
// `setValue` plus the user's own `endUpdate`; `multi` is three; `compound` is a `setValue` and a
// `setGeometry`. Nothing else may appear.
// Measured against the shipped plugin at C-17, with `mxEvent.END_EDIT` armed as well. END_EDIT fires
// twice on a rolled-back user transaction — once when the user's own `endUpdate` reaches
// `updateLevel === 0`, and once for the plugin's own nested transaction inside the END_UPDATE
// dispatch — and it cannot be suppressed, because `mxGraphModel.endUpdate` fires it before the
// `endingUpdate` block any listener could run in (`app.min.js` @481771). The `action` cells close
// through a nesting that depends on how far the write got, so only the hook cells pin an exact
// sequence; every cell pins the part that matters, which is that nothing carrying an edit is
// dispatched at all.
const HOOK_TAPE = {
  "hook/single": ["END_UPDATE@1", "END_EDIT@0", "END_EDIT@0", "END_UPDATE@0"],
  "hook/multi": ["END_UPDATE@1", "END_UPDATE@1", "END_UPDATE@1", "END_EDIT@0", "END_EDIT@0", "END_UPDATE@0"],
  "hook/compound": ["END_UPDATE@1", "END_UPDATE@1", "END_EDIT@0", "END_EDIT@0", "END_UPDATE@0"],
};
const CARRIES_AN_EDIT = ["CHANGE", "BEFORE_UNDO", "UNDO"];
const tapeOf = (tape) => tape.map((entry) => `${entry.tag}@${entry.updateLevel}`);

test("NC-46 a rolled-back transaction dispatches nothing, recurses into nothing, and leaves the editor usable", () => {
  for (const [phase, run] of ROLLBACK_GRID) {
    for (const cell of ROLLBACK_CELLS) {
      const shape = cellKey(cell);
      const item = run[shape];
      for (const [which, tape] of [["clean", item.tapeClean], ["dirty", item.tapeDirty]]) {
        console.log(`NC-46 ${phase}/${shape} ${which} tape ${JSON.stringify(tapeOf(tape))}`);
        // The claim that protects observers, over a tape that arms END_EDIT too: nothing that
        // carries an edit is dispatched.
        assert.deepEqual(tape.map((entry) => entry.tag).filter((tag) => CARRIES_AN_EDIT.includes(tag)), [],
          `${phase}/${shape} (${which}) dispatched an event carrying an edit`);
        assert.deepEqual([...new Set(tape.map((entry) => entry.tag))].sort(), ["END_EDIT", "END_UPDATE"],
          `${phase}/${shape} (${which}) dispatched an unexpected event`);
        assert.equal(tape.at(-1).updateLevel, 0, `${phase}/${shape} (${which}) did not close the outer level`);
        assert.deepEqual(tape.map((entry) => entry.history), tape.map(() => tape[0].history),
          `${phase}/${shape} (${which}) recorded an entry mid-transaction`);
        if (HOOK_TAPE[shape]) {
          // The hook cells are pinned as an exact sequence, END_EDIT included.
          assert.deepEqual(tapeOf(tape), HOOK_TAPE[shape],
            `${phase}/${shape} (${which}) closed through an unexpected sequence`);
        }
      }
      for (const step of item.steps) {
        assert.equal(step.stats.blockedReentries, 0,
          `${phase}/${shape} blocked a re-entry at "${step.step}"`);
      }
    }
  }

  // The editor is still usable: the next valid relevant edit is a normal entry, and one undo and
  // one redo move `indexOfNextAdd` by exactly one and carry every dependent with them.
  const item = rollbackRecovery["hook/single"];
  const rolled = rollbackStep(item, "failed + settle");
  const moved = rollbackStep(item, "after an unrelated move");
  const next = rollbackStep(item, "next valid edit + settle");
  const undone = rollbackStep(item, "undo + settle");
  const redone = rollbackStep(item, "redo + settle");
  for (const step of [rolled, moved, next, undone, redone]) {
    console.log(`NC-46 recovery ${step.step.padEnd(26)} H=${step.historyLength} i=${step.indexOfNextAdd} `
      + `entries=${JSON.stringify(step.entries.map((entry) => entry.length))} `
      + `db=${step.cells.db.local}/${step.cells.db.computed} root=${step.cells.root.computed} `
      + `painted=${step.rendered.db.label}/${step.rendered.db.pill.w} `
      + `blockedReentries=${step.stats.blockedReentries}`);
    assert.equal(step.stats.blockedReentries, 0, `the recovery run blocked a re-entry at "${step.step}"`);
  }
  assert.deepEqual([rolled.historyLength, rolled.indexOfNextAdd], [0, 0]);
  assert.deepEqual([moved.historyLength, moved.indexOfNextAdd], [1, 1]);
  // H + 1, and the whole rollup in that one entry.
  assert.deepEqual([next.historyLength, next.indexOfNextAdd], [2, 2]);
  assert.equal(next.entries.length, 2);
  assert.ok(next.entries.at(-1).length > 1,
    `the recovered edit recorded only ${JSON.stringify(next.entries.at(-1))}`);
  // Measured with END_EDIT armed: the user's own `endUpdate`, the plugin's nested rollup transaction
  // inside the END_UPDATE dispatch, and the rollup's own inner write, before the edit is committed.
  assert.deepEqual(item.tapeRecover.map((entry) => entry.tag),
    ["END_UPDATE", "END_EDIT", "END_EDIT", "END_UPDATE", "END_EDIT", "BEFORE_UNDO", "CHANGE", "UNDO"]);
  // One undo, one step, every dependent restored — in the model and in the painted pill.
  assert.deepEqual([undone.historyLength, undone.indexOfNextAdd], [2, 1]);
  assert.deepEqual(undone.cells, moved.cells);
  assert.deepEqual(paintedOf(undone), paintedOf(moved));
  // One redo, one step, all of them back.
  assert.deepEqual([redone.historyLength, redone.indexOfNextAdd], [2, 2]);
  assert.deepEqual(redone.cells, next.cells);
  assert.deepEqual(paintedOf(redone), paintedOf(next));
});

test("NC-46 negative control (a): the same rollback at BEFORE_UNDO records a phantom empty entry", () => {
  const late = rollbackStep(rollbackLate["hook/single"], "failed + settle");
  const loaded = rollbackStep(rollbackLate["hook/single"], "loaded");
  console.log(`NC-46 (a) rollbackAtBeforeUndo H=${late.historyLength} i=${late.indexOfNextAdd} `
    + `modified=${late.modified} entries=${JSON.stringify(late.entries)} `
    + `xmlsvg ${rollbackLate["hook/single"].exportClean.slice(0, 12)} -> `
    + `${rollbackLate["hook/single"].exportAfterClean.slice(0, 12)}`);
  // The model and the bytes *are* restored — which is exactly why the entry and the dirty flag are
  // the discriminators.
  assert.deepEqual(late.cells, loaded.cells);
  assert.equal(rollbackLate["hook/single"].exportAfterClean, rollbackLate["hook/single"].exportClean);
  assert.deepEqual([late.historyLength, late.indexOfNextAdd, late.modified], [1, 1, true],
    "rolling back at BEFORE_UNDO left no phantom entry, so END_UPDATE proves nothing");
  assert.deepEqual(late.entries, [[]], "the phantom entry was not empty");
  assert.deepEqual(rollbackLate["hook/single"].tapeClean.map((entry) => entry.tag),
    ["END_UPDATE", "END_EDIT", "END_UPDATE", "END_EDIT", "END_EDIT", "BEFORE_UNDO", "CHANGE", "UNDO"]);
});

test("NC-46 negative control (b): edit.ignoreEdit clears the dirty flag and not the phantom entry", () => {
  const late = rollbackStep(rollbackLateIgnored["hook/single"], "failed + settle");
  console.log(`NC-46 (b) + ignoreEdit H=${late.historyLength} i=${late.indexOfNextAdd} `
    + `modified=${late.modified} entries=${JSON.stringify(late.entries)}`);
  assert.equal(late.modified, false, "ignoreEdit no longer clears the dirty flag");
  assert.deepEqual([late.historyLength, late.indexOfNextAdd], [1, 1],
    "ignoreEdit removed the entry — it is not supposed to be able to");
  assert.deepEqual(late.entries, [[]]);
});

test("NC-47 the whole-transaction rollback is load-bearing, each control run on its own", () => {
  const shipped = rollbackStep(rollbackMidWrite["hook/single"], "failed + settle");
  const loaded = rollbackStep(rollbackMidWrite["hook/single"], "loaded");
  console.log(`NC-47 shipped on the same fixture H=${shipped.historyLength} `
    + `db=${shipped.cells.db.local}/${shipped.cells.db.computed} `
    + `painted=${shipped.rendered.db.label}/${shipped.rendered.db.pill.w} `
    + `xmlsvg identical=${rollbackMidWrite["hook/single"].exportAfterClean === rollbackMidWrite["hook/single"].exportClean}`);
  assert.deepEqual(shipped.entries, []);
  assert.deepEqual(shipped.cells, loaded.cells);

  // (a) tailOnlyRollback — the C-15 shape: the user's own change survives against a stale rollup.
  const tail = rollbackStep(rollbackTailOnly["hook/single"], "failed + settle");
  console.log(`NC-47 (a) tailOnlyRollback H=${tail.historyLength} i=${tail.indexOfNextAdd} `
    + `modified=${tail.modified} entries=${JSON.stringify(tail.entries)} `
    + `db=${tail.cells.db.local}/${tail.cells.db.computed} `
    + `painted=${tail.rendered.db.label}/${tail.rendered.db.pill.w} `
    + `xmlsvg ${rollbackTailOnly["hook/single"].exportClean.slice(0, 12)} -> `
    + `${rollbackTailOnly["hook/single"].exportAfterClean.slice(0, 12)}`);
  assert.deepEqual([tail.historyLength, tail.indexOfNextAdd, tail.modified], [1, 1, true]);
  assert.deepEqual(tail.entries, [["mxValueChange"]]);
  assert.deepEqual([tail.cells.db.local, tail.cells.db.computed], ["Unhealthy", "Healthy"],
    "the tail-only control no longer reproduces the contradictory model");
  assert.deepEqual([tail.rendered.db.label, tail.rendered.db.pill.w], ["Healthy", 73]);
  assert.notEqual(rollbackTailOnly["hook/single"].exportAfterClean, rollbackTailOnly["hook/single"].exportClean);

  // (b) noRollback — the partial derived tail survives inside the user's own entry.
  const kept = rollbackStep(rollbackRemoved["hook/single"], "failed + settle");
  console.log(`NC-47 (b) noRollback H=${kept.historyLength} entry=${JSON.stringify(kept.entries.at(-1))}`);
  assert.deepEqual([kept.historyLength, kept.indexOfNextAdd, kept.modified], [1, 1, true]);
  assert.ok(kept.entries.at(-1).length > 1,
    "the no-rollback control left no partial entry, so the rollback proves nothing");
  assert.ok(kept.entries.at(-1).includes("mxStyleChange") && kept.entries.at(-1).includes("mxGeometryChange"),
    `the surviving entry carried no derived changes: ${JSON.stringify(kept.entries.at(-1))}`);
  assert.notEqual(rollbackRemoved["hook/single"].exportAfterClean, rollbackRemoved["hook/single"].exportClean);

  // (c) swallowDerivedWrite — every message disappears, on both paths.
  const silent = rollbackStep(rollbackSwallowed["hook/single"], "failed + settle");
  console.log(`NC-47 (c) swallowDerivedWrite errors=${JSON.stringify(silent.errors)}`);
  assert.deepEqual(silent.errors, [], "the blanket catch no longer swallows the hook path");
  for (const name of Object.keys(FAILURE_MESSAGES)) {
    const item = failureSwallowed[name];
    console.log(`NC-47 (c) "${name}" action=${JSON.stringify(item.viaAction)} `
      + `hook=${JSON.stringify(item.viaListener)}`);
    assert.deepEqual(item.viaAction, [], "the blanket catch no longer swallows the action path");
    assert.deepEqual(item.viaListener, [], "the blanket catch no longer swallows the hook path");
  }
});

const ISOLATION_STATS = {
  hooks: 0, relevant: 0, recalculations: 0, blockedReentries: 0, selfSuppressed: 0,
};

test("NC-48 one installation per editor, one API and one counter set per installation", () => {
  assert.equal(isolation.error, null, `the two-editor driver failed: ${isolation.error}`);
  console.log(`NC-48 two real editors distinctEditor=${isolation.distinctEditor} `
    + `distinctGraph=${isolation.distinctGraph} distinctModel=${isolation.distinctModel} `
    + `distinctUndoManager=${isolation.distinctUndoManager} globalMoved=${isolation.globalMoved}`);
  console.log(`NC-48 sameEditorSameApi=${isolation.sameEditorSameApi} `
    + `distinctEditorSameApi=${isolation.distinctEditorSameApi} `
    + `sameStatsObject=${isolation.sameStatsObject} markerA=${isolation.markerA} `
    + `markerB=${isolation.markerB} spreadCopyReturnsFirst=${isolation.spreadCopyReturnsFirst} `
    + `secondFactorySameApi=${isolation.secondFactorySameApi}`);
  // Two editors that are measurably independent before the plugin is anywhere near them.
  assert.deepEqual([isolation.distinctEditor, isolation.distinctGraph, isolation.distinctModel,
    isolation.distinctUndoManager], [true, true, true, true]);
  // Same editor twice: the same API, the same registration, no second hook.
  assert.equal(isolation.sameEditorSameApi, true, "a second install() on the same editor returned a new API");
  // Distinct editors: distinct API, distinct counters, and its own registration on each.
  assert.equal(isolation.distinctEditorSameApi, false, "two editors were handed the same API object");
  assert.equal(isolation.sameStatsObject, false, "two editors were handed the same stats object");
  assert.deepEqual([isolation.markerA, isolation.markerB], [true, true]);
  assert.deepEqual(isolation.actionsA, ACTIONS);
  assert.deepEqual(isolation.actionsB, ACTIONS);
  assert.deepEqual([isolation.menuA, isolation.menuB], [true, true]);
  // One effective model hook per model: +1 endUpdate listener on that model's own first install,
  // +0 on its second, and +0 on the other model's install. One listener is two mxEventSource slots.
  const hook = (census, side) => census[side].byName.endUpdate || 0;
  const slots = (census, side) => census[side].slots;
  const { before, afterFirst, afterFirstTwice, afterSecond } = isolation.census;
  console.log(`NC-48 endUpdate census a=${JSON.stringify([before, afterFirst, afterFirstTwice, afterSecond]
    .map((item) => hook(item, "a")))} b=${JSON.stringify([before, afterFirst, afterFirstTwice, afterSecond]
    .map((item) => hook(item, "b")))} slots a=${JSON.stringify([before, afterFirst, afterFirstTwice, afterSecond]
    .map((item) => slots(item, "a")))} b=${JSON.stringify([before, afterFirst, afterFirstTwice, afterSecond]
    .map((item) => slots(item, "b")))}`);
  assert.deepEqual([before, afterFirst, afterFirstTwice, afterSecond].map((item) => hook(item, "a")),
    [0, 1, 1, 1], "the first editor's model did not get exactly one hook");
  assert.deepEqual([before, afterFirst, afterFirstTwice, afterSecond].map((item) => hook(item, "b")),
    [0, 0, 0, 1], "the second editor's model did not get exactly one hook");
  assert.deepEqual([before, afterFirst, afterFirstTwice, afterSecond].map((item) => slots(item, "a")),
    [36, 38, 38, 38]);
  assert.deepEqual([before, afterFirst, afterFirstTwice, afterSecond].map((item) => slots(item, "b")),
    [36, 36, 36, 38]);

  // An edit in one editor moves only that editor's counters and only that editor's undo history.
  console.log(`NC-48 before ${JSON.stringify(isolation.beforeEdits)}`);
  console.log(`NC-48 after an edit in b ${JSON.stringify(isolation.afterEditInSecond)}`);
  console.log(`NC-48 after an edit in a ${JSON.stringify(isolation.afterEditInFirst)}`);
  assert.deepEqual(isolation.beforeEdits, {
    statsA: ISOLATION_STATS, statsB: ISOLATION_STATS,
    historyA: 0, historyB: 0, modifiedA: false, modifiedB: false,
    valueA: "Healthy/Healthy", valueB: "Healthy/Healthy",
  });
  assert.deepEqual(isolation.afterEditInSecond, {
    statsA: ISOLATION_STATS,
    statsB: { hooks: 1, relevant: 1, recalculations: 1, blockedReentries: 0, selfSuppressed: 0 },
    historyA: 0, historyB: 1, modifiedA: false, modifiedB: true,
    valueA: "Healthy/Healthy", valueB: "Unhealthy/Unhealthy",
  });
  assert.deepEqual(isolation.afterEditInFirst, {
    statsA: { hooks: 1, relevant: 1, recalculations: 1, blockedReentries: 0, selfSuppressed: 0 },
    statsB: { hooks: 1, relevant: 1, recalculations: 1, blockedReentries: 0, selfSuppressed: 0 },
    historyA: 1, historyB: 1, modifiedA: true, modifiedB: true,
    valueA: "Degraded/Degraded", valueB: "Unhealthy/Unhealthy",
  });
  assert.deepEqual(isolation.errors, []);
  // A spread copy of an installed editor carries INSTALL_KEY, so it *is* that installation. Stated
  // as the measurement it is, never as a fresh instance.
  assert.equal(isolation.spreadCopyReturnsFirst, true);
  assert.equal(isolation.secondFactorySameApi, true);
});

test("NC-48 negative control (c): the pre-C-16 factory-level API shares stats across editors", () => {
  assert.equal(isolationShared.error, null, `the control driver failed: ${isolationShared.error}`);
  console.log(`NC-48 (c) sharedFactoryApi distinctEditorSameApi=${isolationShared.distinctEditorSameApi} `
    + `sameStatsObject=${isolationShared.sameStatsObject} `
    + `after an edit in b ${JSON.stringify(isolationShared.afterEditInSecond)}`);
  assert.equal(isolationShared.distinctEditorSameApi, true,
    "the shared-API control no longer shares the API, so the criterion proves nothing");
  assert.equal(isolationShared.sameStatsObject, true);
  // One shared counter set: an edit in the second editor moves the first editor's `stats` too.
  assert.deepEqual(isolationShared.afterEditInSecond.statsA,
    isolationShared.afterEditInSecond.statsB);
  assert.notDeepEqual(isolationShared.afterEditInSecond.statsA, ISOLATION_STATS);
});

test("NC-48 install() is idempotent per editor instance", () => {
  const registration = atomicTwice.registration;
  const slots = registration.listeners.map((item) => item.slots);
  const endUpdate = registration.listeners.map((item) => item.byName.endUpdate || 0);
  console.log(`NC-48 two installs: slots=${JSON.stringify(slots)} `
    + `endUpdate=${JSON.stringify(endUpdate)} sameApi=${registration.sameApi} `
    + `marker=${registration.marker} menu=${registration.menu}`);
  assert.equal(registration.installs, 2);
  assert.deepEqual(registration.actions, ACTIONS, "a second install lost an action");
  assert.deepEqual(registration.missing, []);
  assert.equal(registration.menu, true);
  assert.equal(registration.marker, true, "install() stored no idempotence marker on the editor");
  assert.equal(registration.sameApi, true, "the second install() returned a different API");
  // One effective model hook: +1 END_UPDATE listener on the first install, +0 on the second.
  assert.deepEqual([endUpdate[1] - endUpdate[0], endUpdate[2] - endUpdate[1]], [1, 0]);
  assert.deepEqual([slots[1] - slots[0], slots[2] - slots[1]], [2, 0]);

  const settled = atomicStep(atomicTwice, "external edit + settle");
  console.log(`NC-48 after two installs, one edit: history=${settled.historyLength} `
    + `index=${settled.indexOfNextAdd} entries=${JSON.stringify(settled.entries.map((e) => e.length))} `
    + `stats=${JSON.stringify(settled.stats)}`);
  assert.equal(settled.historyLength, 1);
  assert.equal(settled.indexOfNextAdd, 1);
  assert.equal(settled.stats.recalculations, 1, "a second install caused a duplicate recalculation");
  assert.deepEqual(settled.lastStats, settled.stats);
  assert.deepEqual(settled.errors, []);
  assert.deepEqual(settled.values, POST_EDIT);
  // A clean open is still clean with the C-16 plugin.
  assert.deepEqual(openFacts(openBefore["kitchen-sink"]), CLEAN_OPEN);
});

test("NC-48 negative control (b): without the marker a second install adds a second hook", () => {
  const registration = atomicNoIdempotence.registration;
  const slots = registration.listeners.map((item) => item.slots);
  const endUpdate = registration.listeners.map((item) => item.byName.endUpdate || 0);
  console.log(`NC-48 control noIdempotenceMarker: slots=${JSON.stringify(slots)} `
    + `endUpdate=${JSON.stringify(endUpdate)} sameApi=${registration.sameApi}`);
  assert.deepEqual([endUpdate[1] - endUpdate[0], endUpdate[2] - endUpdate[1]], [1, 1],
    "the marker is decorative — the second install added no listener");
  assert.deepEqual([slots[1] - slots[0], slots[2] - slots[1]], [2, 2]);
  assert.equal(registration.sameApi, false);
  // And the duplicate hook really does recalculate a second time.
  const settled = atomicStep(atomicNoIdempotence, "external edit + settle");
  console.log(`NC-48 control stats first=${JSON.stringify(settled.stats)} `
    + `last=${JSON.stringify(settled.lastStats)}`);
  assert.equal(settled.stats.recalculations + settled.lastStats.recalculations, 2);
});

// --- NC-49 clause 4: nothing is regenerated without a measured cause ----------------------------
//
// The eight generated artifacts, by sha256, against the values they carried at C-15. A byte change
// here is a regeneration, and a regeneration needs a named, measured cause.
const C15_ARTIFACTS = {
  "examples/hero.drawio.svg": "8d0ba4c6",
  "examples/kitchen-sink.drawio.svg": "d3f1fe6f",
  "examples/pills-stress.drawio.svg": "84413072",
  "library/ahm-diagrammo.xml": "3f5bf093",
  "visual/native-hero.png": "165df5ed",
  "visual/native-kitchen-sink.png": "ecb02bfc",
  "visual/native-pills-stress.png": "e5dadaed",
  "visual/native-report.json": "f3fcb054",
};

test("NC-49 the eight generated artifacts are byte-identical to their C-15 values", () => {
  const measured = Object.fromEntries(Object.keys(C15_ARTIFACTS).map((file) => [
    file, sha256(readFileSync(resolve(root, file))).slice(0, 8),
  ]));
  console.log(`NC-49 generated artifacts ${JSON.stringify(measured)}`);
  assert.deepEqual(measured, C15_ARTIFACTS,
    "an artifact was regenerated — name and measure the cause, and return NC-15 to active state");
});

// --- C-17 -----------------------------------------------------------------------------------
//
// Four hardening gaps a fresh inspection found in C-16: a re-entrancy counter that could not move,
// a grid that measured eight of the twelve cells it declared, an unguarded dependency on two
// undocumented internals of the bundled build, and a rollback message that never mentioned the
// other changes it took back.

test("NC-59 the blocked-re-entry counter counts genuine external attempts, and only those", () => {
  // (i)/(ii) the shipped plugin on ordinary edits: every cell of NC-51's grid, clean and dirty, and
  // every step of the edit sequence blocks nothing at all.
  for (const [phase, run] of ROLLBACK_GRID) {
    for (const cell of ROLLBACK_CELLS) {
      const item = run[cellKey(cell)];
      for (const step of item.steps) {
        assert.equal(step.stats.blockedReentries, 0,
          `${phase}/${cellKey(cell)} blocked a re-entry at "${step.step}"`);
      }
    }
  }
  for (const step of editSequence) {
    assert.equal(step.stats.blockedReentries, 0,
      `the edit sequence blocked a re-entry at "${step.step}"`);
  }
  // (i) an ordinary successful action with nothing nested: the public counter stays 0 while the
  // plugin's own expected self-re-entry is counted once, and one recalculation ran.
  const settled = atomicStep(atomic, "external edit + settle");
  console.log(`NC-59 one successful H=1 edit stats=${JSON.stringify(settled.stats)}`);
  console.log(`NC-59 plain action stats=${JSON.stringify(nestingUnforced.after)}`);
  assert.equal(settled.historyLength, 1);
  assert.equal(settled.stats.blockedReentries, 0, "an ordinary user edit blocked a re-entry");
  assert.equal(settled.stats.recalculations, 1);
  assert.equal(nestingUnforced.nestedAttempts, 0);
  assert.equal(nestingUnforced.after.blockedReentries, 0,
    "the plugin's own closing transaction is still counted as an external re-entry");
  assert.equal(nestingUnforced.after.selfSuppressed - nestingUnforced.before.selfSuppressed, 1,
    "the plugin's own action stopped re-entering its own hook");
  assert.equal(nestingUnforced.after.recalculations - nestingUnforced.before.recalculations, 1);

  // (iii) a genuine forced nested entry: a test-owned END_UPDATE listener fires `ahmRecalculate`
  // once while an `ahmSetUnhealthy` action is still in flight.
  console.log(`NC-59 forced ${JSON.stringify(nestingForced)}`);
  console.log(`NC-59 noReentrancyGuard ${JSON.stringify(nestingUnguarded)}`);
  assert.equal(nestingForced.nestedAttempts, 1, "nothing was nested, so the claim is unprovable");
  assert.ok(nestingForced.after.blockedReentries >= 1,
    `the guard blocked nothing under real nesting: ${JSON.stringify(nestingForced.after)}`);
  assert.equal(nestingForced.after.recalculations - nestingForced.before.recalculations, 1,
    "a blocked attempt still counted as a recalculation");
  // (iv) the control for (iii), run alone: the same driver with nothing nested. The whole blocked
  // count must be attributable to the forcing and to nothing else.
  assert.equal(nestingForced.after.blockedReentries - nestingUnforced.after.blockedReentries, 1,
    "the forced nesting was not the cause of the blocked attempt");
  assert.equal(nestingForced.after.selfSuppressed, nestingUnforced.after.selfSuppressed,
    "the forced foreign entry was misread as the plugin's own self-suppression");
  assert.equal(nestingUnforced.after.recalculations, nestingForced.after.recalculations);

  // (v) the `noReentrancyGuard` ablation under the same forced nesting: the opposite signature.
  assert.equal(nestingUnguarded.nestedAttempts, 1);
  assert.equal(nestingUnguarded.after.blockedReentries, 0,
    "the counter moved without the guard, so it is not attributable to the guard");
  assert.equal(nestingUnguarded.after.selfSuppressed, 0);
  assert.equal(nestingUnguarded.after.recalculations - nestingUnguarded.before.recalculations, 3,
    "the unguarded plugin did not actually re-enter");
  assert.ok(nestingUnguarded.after.recalculations > nestingForced.after.recalculations,
    "removing the guard changed nothing, so the guard proves nothing");

  // (vi) the exact key set, read off a live installation rather than off the plugin source.
  console.log(`NC-59 stats keys ${JSON.stringify(Object.keys(hostGuardHealthy.stats).sort())}`);
  assert.deepEqual(Object.keys(hostGuardHealthy.stats).sort(),
    ["blockedReentries", "hooks", "recalculations", "relevant", "selfSuppressed"],
    "the live installation's counter set is not exactly the five counters");
});

test("NC-51 the rollback grid is the full phase x shape x path grid it declares", () => {
  // The axes are a product, so a missing combination is a missing cell rather than a missing entry.
  assert.equal(ROLLBACK_SHAPE_AXIS.length * ROLLBACK_PATH_AXIS.length, 6);
  assert.equal(ROLLBACK_GRID.length * ROLLBACK_CELLS.length, 12, "the declared grid is not twelve cells");
  assert.deepEqual([...new Set(ROLLBACK_CELLS.map(cellKey))].sort(),
    ["action/compound", "action/multi", "action/single",
      "hook/compound", "hook/multi", "hook/single"]);

  for (const [phase, run] of ROLLBACK_GRID) {
    assert.deepEqual(Object.keys(run).sort(), ROLLBACK_CELLS.map(cellKey).sort(),
      `${phase} did not measure every cell`);
    for (const cell of ROLLBACK_CELLS) {
      const key = cellKey(cell);
      const item = run[key];
      const loaded = rollbackStep(item, "loaded");
      const failed = rollbackStep(item, "failed + settle");
      const moved = rollbackStep(item, "after an unrelated move");
      const dirty = rollbackStep(item, "failed while dirty + settle");
      assert.deepEqual([item.shape, item.path], [cell.shape, cell.path],
        `${phase}/${key} was driven as a different cell`);

      // The five NC-45 boundaries, per cell, clean and dirty. (NC-45 asserts them as well; this is
      // the criterion that says all twelve cells were actually driven.)
      assert.deepEqual([failed.historyLength, failed.indexOfNextAdd, failed.modified, failed.entries],
        [0, 0, false, []], `${phase}/${key} left the clean editor changed`);
      assert.deepEqual([failed.currentEdit, failed.updateLevel], [0, 0]);
      assert.deepEqual(failed.cells, loaded.cells, `${phase}/${key} did not restore the model`);
      assert.deepEqual(paintedOf(failed), paintedOf(loaded), `${phase}/${key} repainted the canvas`);
      assert.equal(item.exportAfterClean, item.exportClean, `${phase}/${key} moved the exported bytes`);
      assert.equal(failed.errors.length, 1, `${phase}/${key} did not report exactly once`);
      assert.deepEqual([dirty.historyLength, dirty.indexOfNextAdd, dirty.modified, dirty.entries],
        [1, 1, true, [["mxGeometryChange"]]], `${phase}/${key} disturbed the dirty editor`);
      assert.deepEqual(dirty.cells, moved.cells, `${phase}/${key} did not restore the dirty model`);
      assert.equal(item.exportAfterDirty, item.exportDirty);

      // The four cells C-16 never ran are not silently degenerate: the outer user transaction is
      // proved to have carried its extra changes *before* the action ran, and the action is proved
      // to have actually recalculated. Otherwise "action/compound" is "action/single" with a longer
      // name.
      if (cell.path !== "action") {
        assert.equal(item.driveClean, null, `${phase}/${key} was driven through the action path`);
        continue;
      }
      for (const [which, drive] of [["clean", item.driveClean], ["dirty", item.driveDirty]]) {
        console.log(`NC-51 ${phase}/${key} ${which} pre-action=${JSON.stringify(drive.preActionChanges)} `
          + `recalc ${drive.recalcBefore} -> ${drive.recalcAfter}`);
        assert.equal(drive.recalcAfter - drive.recalcBefore, 1,
          `${phase}/${key} (${which}) did not recalculate on the action call`);
        if (cell.shape === "single") {
          assert.deepEqual(drive.preActionChanges, [],
            `${phase}/${key} (${which}) was not the plugin's own top-level transaction`);
        } else if (cell.shape === "multi") {
          assert.deepEqual(drive.preActionChanges, ["mxValueChange", "mxValueChange"],
            `${phase}/${key} (${which}) carried no second user change before the action ran`);
        } else {
          assert.deepEqual(drive.preActionChanges, ["mxValueChange", "mxGeometryChange"],
            `${phase}/${key} (${which}) carried no geometry change before the action ran`);
        }
      }
    }
  }
});

test("NC-51 negative controls: on the four new cells, a narrower rollback is visible", () => {
  for (const cell of NEW_CELLS) {
    const key = cellKey(cell);
    // (a) tailOnlyRollback — the C-15 shape: the foreign changes the outer transaction carried stay
    // committed, against a stale rollup.
    const tail = rollbackStep(newCellsTailOnly[key], "failed + settle");
    const loaded = rollbackStep(newCellsTailOnly[key], "loaded");
    console.log(`NC-51 (a) ${key} tailOnlyRollback H=${tail.historyLength} i=${tail.indexOfNextAdd} `
      + `modified=${tail.modified} entries=${JSON.stringify(tail.entries)} `
      + `cache=${tail.cells.cache.local} db=${tail.cells.db.local}/${tail.cells.db.computed}`);
    assert.deepEqual([tail.historyLength, tail.indexOfNextAdd, tail.modified], [1, 1, true],
      `the tail-only control left ${key} clean, so the whole-transaction rollback proves nothing`);
    assert.equal(tail.cells.cache.local, "Degraded",
      `the tail-only control took back the foreign change on ${key} too`);
    assert.notDeepEqual(tail.cells, loaded.cells);
    assert.notEqual(newCellsTailOnly[key].exportAfterClean, newCellsTailOnly[key].exportClean);

    // (b) noRollback — the derived tail survives inside the user's own entry.
    const kept = rollbackStep(newCellsNoRollback[key], "failed + settle");
    console.log(`NC-51 (b) ${key} noRollback H=${kept.historyLength} `
      + `entry=${JSON.stringify(kept.entries.at(-1))}`);
    assert.deepEqual([kept.historyLength, kept.indexOfNextAdd, kept.modified], [1, 1, true]);
    assert.ok(kept.entries.at(-1).includes("mxStyleChange"),
      `the no-rollback control left no derived tail on ${key}: ${JSON.stringify(kept.entries.at(-1))}`);
    assert.notEqual(newCellsNoRollback[key].exportAfterClean, newCellsNoRollback[key].exportClean);
  }
});

// --- NC-52: the host compatibility guard --------------------------------------------------------
//
// Asserted on the *editor*, never on the guard's own boolean: the listener census the plugin is
// attributable for, the undo manager, `editor.modified`, the watched cells' values, styles and
// geometry, `window.ahmErrors`, and the rendered pill.
const HOST_REASONS = {
  hostNoEndingUpdate: ["outer-end-update-not-observed", "end-update-edit-is-not-currentEdit",
    "change-not-invertible", "currentEdit-not-emptied", "positive-control-did-not-commit"],
  hostGateBeforeEndUpdate: ["outer-end-update-not-observed", "change-not-invertible",
    "gate-runs-before-end-update"],
  hostNoChangeList: ["probe-threw:this.changes.push is not a function"],
};
const hookSlots = (census) => census.byName.endUpdate || 0;
const DISABLED_STATS = {
  hooks: 0, relevant: 0, recalculations: 0, blockedReentries: 0, selfSuppressed: 0,
};
const documentState = (state) => ({
  history: state.history, index: state.index, modified: state.modified,
  updateLevel: state.updateLevel, currentEdit: state.currentEdit, entries: state.entries,
  cells: state.cells, rendered: state.rendered,
});

test("NC-52 on the bundled build the guard passes, registers the hook, and changes nothing", () => {
  const run = hostGuardHealthy;
  console.log(`NC-52 healthy verdict=${JSON.stringify(run.compatibility.compatible)} `
    + `reasons=${JSON.stringify(run.compatibility.reasons)} elapsedMs=${run.elapsedMs} `
    + `seen=${JSON.stringify(run.compatibility.seen)}`);
  console.log(`NC-52 healthy probeTape=${JSON.stringify(run.probeTape)} `
    + `census=${JSON.stringify([run.census.before, run.census.afterInstall].map(hookSlots))} `
    + `errors=${JSON.stringify(run.errorsAfterInstall)}`);
  // 1. Healthy host: the verdict, the hook, no message.
  assert.equal(run.compatibility.compatible, true, `the bundled build was rejected: ${run.compatibility.reasons}`);
  assert.deepEqual(run.compatibility.reasons, []);
  assert.equal(run.disabled, false);
  assert.deepEqual(run.errorsAfterInstall, []);
  assert.equal(hookSlots(run.census.afterInstall) - hookSlots(run.census.before), 1,
    "install() did not register exactly one model hook on a supported host");

  // 2. The probe is isolated: the *active* model dispatched nothing and moved nothing.
  assert.deepEqual(run.probeTape, [],
    `the probe dispatched on the user's own model: ${JSON.stringify(run.probeTape)}`);
  assert.deepEqual(documentState(run.afterInstall), documentState(run.before),
    "install() changed the user's document");
  assert.deepEqual([run.before.history, run.before.index, run.before.modified, run.before.currentEdit,
    run.before.updateLevel], [0, 0, false, 0, 0]);

  // 3. The positive control is live, asserted on the recorded control tape rather than the verdict.
  assert.deepEqual(run.compatibility.seen.controlTape, ["BEFORE_UNDO", "CHANGE", "UNDO"],
    "the probe's positive control did not commit, so a passing verdict would be vacuous");
  assert.deepEqual(run.compatibility.seen.rolledBackTape, []);
  assert.deepEqual([run.compatibility.seen.emptied, run.compatibility.seen.valueRestored,
    run.compatibility.seen.currentEditAfter], [true, true, 0]);

  // 7. Once per editor: a second install() re-probes nothing and adds no message.
  assert.deepEqual(run.errorsAfterSecondInstall, []);
  assert.equal(hookSlots(run.census.afterSecondInstall), hookSlots(run.census.afterInstall),
    "a second install() added a second hook");
});

test("NC-52 each live host ablation is detected by name and disables every write", () => {
  for (const ablation of HOST_ABLATIONS) {
    const run = hostGuardAblated[ablation];
    console.log(`NC-52 ${ablation} reasons=${JSON.stringify(run.compatibility.reasons)} `
      + `probeTape=${JSON.stringify(run.probeTape)} `
      + `hooks=${hookSlots(run.census.afterInstall) - hookSlots(run.census.before)} `
      + `errors=${run.errorsAfterInstall.length} stats=${JSON.stringify(run.stats)}`);
    // 4. A named reason, the disabled state, and exactly one message.
    assert.equal(run.compatibility.compatible, false, `${ablation} was accepted`);
    assert.deepEqual(run.compatibility.reasons, HOST_REASONS[ablation],
      `${ablation} produced a different set of reasons`);
    assert.equal(run.disabled, true);
    assert.equal(run.errorsAfterInstall.length, 1,
      `${ablation} reported ${run.errorsAfterInstall.length} times`);
    assert.equal(run.errorsAfterInstall[0],
      `${INCOMPATIBLE_PREFIX}${HOST_REASONS[ablation].join(", ")}`,
      `${ablation} did not report the actionable message`);
    // The probe still never touched the user's document.
    assert.deepEqual(run.probeTape, []);
    assert.equal(hookSlots(run.census.afterInstall) - hookSlots(run.census.before), 0,
      `${ablation} still registered a model hook`);

    // 6. Disabled means disabled: nine actions, no throw, no write, no second message.
    for (const [name, outcome] of Object.entries(run.actionErrors)) {
      assert.equal(outcome.threw, null, `${ablation}: ${name} threw`);
      assert.deepEqual(outcome.added, [], `${ablation}: ${name} reported on a disabled host`);
    }
    assert.deepEqual(documentState(run.afterActions), documentState(run.before),
      `${ablation}: an action changed the document on a disabled host`);
    assert.deepEqual(run.stats, DISABLED_STATS,
      `${ablation}: the plugin still ran on a disabled host`);
    // A relevant model edit is the user's own change and nothing else: one entry, one change in it,
    // and no derived rollup anywhere.
    assert.deepEqual([run.afterEdit.history, run.afterEdit.index, run.afterEdit.entries], [1, 1, [1]],
      `${ablation}: the plugin appended to the user's edit on a disabled host`);
    assert.equal(run.afterEdit.cells.db.local, "Degraded");
    assert.equal(run.afterEdit.cells.db.computed, run.before.cells.db.computed,
      `${ablation}: the rollup still ran on a disabled host`);
    assert.equal(run.afterEdit.rendered.db, run.before.rendered.db,
      `${ablation}: the pill was repainted on a disabled host`);
    assert.deepEqual(run.afterSettle.errors, run.errorsAfterInstall,
      `${ablation}: a second message arrived after the settle`);
    assert.deepEqual(run.afterSettle.stats, run.stats);
  }
});

test("NC-52 read-only validate still runs on a disabled host, and only validate does", () => {
  const run = hostGuardValidate;
  const added = Object.fromEntries(Object.entries(run.actionErrors)
    .map(([name, outcome]) => [name, outcome.added]));
  console.log(`NC-52 disabled + malformed model ${JSON.stringify(added)}`);
  assert.equal(run.disabled, true);
  for (const [name, messages] of Object.entries(added)) {
    if (name === "ahmValidate") continue;
    assert.deepEqual(messages, [], `${name} reported on a disabled host`);
  }
  assert.deepEqual(run.actionErrors.ahmValidate.added,
    ["AHM validation: invalid state Sideways in db"],
    "read-only validate stopped reporting its own findings on a disabled host");
  // Reporting is not writing: the document is exactly where it was.
  assert.deepEqual(documentState(run.afterActions), documentState(run.before));
});

// --- NC-56: the four *active-model* identity checks ----------------------------------------------
//
// The guard's other half reads live per-instance state on the editor's own document, so every
// ablation that patches the plugin's throwaway probe model leaves it unproved. Each patch below is
// applied to the live active model, alone, immediately before `install()` reads it.

test("NC-56 every active-model reason is produced at the boundary the guard reads", () => {
  for (const patch of ACTIVE_MODEL_PATCHES) {
    const run = hostGuardPatched[patch];
    console.log(`NC-56 ${patch} applied=${run.patched} reasons=${JSON.stringify(run.compatibility.reasons)} `
      + `disabled=${run.disabled} hooks=${hookSlots(run.census.afterInstall) - hookSlots(run.census.before)} `
      + `errors=${run.errorsAfterInstall.length} stats=${JSON.stringify(run.stats)}`);
    // (i) the patch really landed on the editor's own model, not on a seam nobody reads.
    assert.equal(run.patched, true, `${patch} did not apply to the active model`);
    // (ii) exactly that one reason — deep equality, so a patch that trips two checks is a failure.
    assert.deepEqual(run.compatibility.reasons, [ACTIVE_MODEL_REASONS[patch]],
      `${patch} produced a different set of reasons`);
    assert.equal(run.compatibility.compatible, false);
    // (iii) the editor's own reading of "disabled": no hook, one message, no throw, nothing moved.
    assert.equal(run.disabled, true);
    assert.equal(hookSlots(run.census.afterInstall) - hookSlots(run.census.before), 0,
      `${patch} still registered a model hook`);
    assert.equal(run.errorsAfterInstall.length, 1,
      `${patch} reported ${run.errorsAfterInstall.length} times`);
    assert.equal(run.errorsAfterInstall[0],
      `${INCOMPATIBLE_PREFIX}${ACTIVE_MODEL_REASONS[patch]}`,
      `${patch} did not report the actionable message`);
    assert.deepEqual(run.probeTape, [],
      `${patch}: the probe dispatched on the user's own model`);
    for (const [name, outcome] of Object.entries(run.actionErrors)) {
      assert.equal(outcome.threw, null, `${patch}: ${name} threw`);
      assert.deepEqual(outcome.added, [], `${patch}: ${name} reported on a disabled host`);
    }
    assert.deepEqual(documentState(run.afterActions), documentState(run.before),
      `${patch}: an action changed the document`);
    assert.deepEqual(run.stats, DISABLED_STATS, `${patch}: the plugin still ran`);
    // A relevant model edit is the user's own change and nothing else — the patched host is still a
    // working editor, so "nothing was written" is the plugin's doing and not a broken model.
    assert.deepEqual([run.afterEdit.history, run.afterEdit.index, run.afterEdit.entries], [1, 1, [1]],
      `${patch}: the plugin appended to the user's edit`);
    assert.equal(run.afterEdit.cells.db.local, "Degraded");
    assert.equal(run.afterEdit.cells.db.computed, run.before.cells.db.computed,
      `${patch}: the rollup still ran`);
    assert.equal(run.afterEdit.rendered.db, run.before.rendered.db,
      `${patch}: the pill was repainted`);
    assert.deepEqual(run.afterSettle.errors, run.errorsAfterInstall,
      `${patch}: a second message arrived after the settle`);
  }
  // (iv) the unablated control on the same driver: the four verdicts are attributable to the patch.
  console.log(`NC-56 control reasons=${JSON.stringify(hostGuardHealthy.compatibility.reasons)} `
    + `disabled=${hostGuardHealthy.disabled} `
    + `hooks=${hookSlots(hostGuardHealthy.census.afterInstall) - hookSlots(hostGuardHealthy.census.before)} `
    + `recalculations=${hostGuardHealthy.stats.recalculations}`);
  assert.deepEqual(hostGuardHealthy.compatibility.reasons, []);
  assert.equal(hostGuardHealthy.disabled, false);
  assert.equal(hookSlots(hostGuardHealthy.census.afterInstall)
    - hookSlots(hostGuardHealthy.census.before), 1);
  assert.notDeepEqual(hostGuardHealthy.afterActions.cells, hostGuardHealthy.before.cells,
    "the unablated control wrote nothing, so the four disabled cases prove nothing");
});

test("NC-56 negative control: each identity check, deleted alone, stops detecting its own patch", () => {
  for (const patch of ACTIVE_MODEL_PATCHES) {
    const run = hostGuardCheckRemoved[patch];
    console.log(`NC-56 ${DROPPED_CHECK[patch]} + ${patch} reasons=${JSON.stringify(run.compatibility.reasons)} `
      + `disabled=${run.disabled} errors=${run.errorsAfterInstall.length} `
      + `hooks=${hookSlots(run.census.afterInstall) - hookSlots(run.census.before)}`);
    assert.equal(run.patched, true);
    assert.deepEqual(run.compatibility.reasons, [],
      `${DROPPED_CHECK[patch]} left the reason behind, so the check is not the thing that detects it`);
    assert.equal(run.disabled, false);
    assert.deepEqual(run.errorsAfterInstall, []);
    assert.equal(hookSlots(run.census.afterInstall) - hookSlots(run.census.before), 1,
      `${DROPPED_CHECK[patch]}: the plugin stayed disabled for another reason`);
  }
});

// --- NC-57: two editors, two verdicts, two messages ----------------------------------------------

test("NC-57 two live editors get independent verdicts and independent messages", () => {
  // (i) both compatible: two verdicts, both clean, and both sinks empty.
  assert.equal(isolation.error, null, `the two-editor driver failed: ${isolation.error}`);
  console.log(`NC-57 both compatible disabled=[${isolation.disabledA},${isolation.disabledB}] `
    + `reasons=[${JSON.stringify(isolation.compatibilityA.reasons)},`
    + `${JSON.stringify(isolation.compatibilityB.reasons)}] `
    + `errorsA=${JSON.stringify(isolation.errorsA)} errorsB=${JSON.stringify(isolation.errorsB)}`);
  assert.deepEqual([isolation.disabledA, isolation.disabledB], [false, false]);
  assert.deepEqual(isolation.compatibilityA.reasons, []);
  assert.deepEqual(isolation.compatibilityB.reasons, []);
  assert.deepEqual(isolation.errorsA, []);
  assert.deepEqual(isolation.errorsB, []);
  assert.equal(isolation.sharedSink, false, "the default driver still shares one error sink");

  for (const [order, run] of Object.entries(isolationMixed)) {
    assert.equal(run.error, null, `the mixed driver failed in ${order}: ${run.error}`);
    const patchedKey = run.patched.a ? "a" : "b";
    const stockKey = patchedKey === "a" ? "b" : "a";
    const verdict = { a: run.disabledA, b: run.disabledB };
    const reasons = { a: run.compatibilityA.reasons, b: run.compatibilityB.reasons };
    const sink = { a: run.errorsA, b: run.errorsB };
    const hooks = { a: run.census.afterSecond.a, b: run.census.afterSecond.b };
    const value = { a: run.afterEditInFirst.valueA, b: run.afterEditInFirst.valueB };
    const stats = { a: run.afterEditInFirst.statsA, b: run.afterEditInFirst.statsB };
    console.log(`NC-57 ${order} installOrder=${JSON.stringify(run.installOrder)} `
      + `patched=${JSON.stringify(run.patched)} disabled=${JSON.stringify(verdict)} `
      + `reasons=${JSON.stringify(reasons)} sinks=${JSON.stringify(sink)} `
      + `values=${JSON.stringify(value)} probes=${JSON.stringify(run.probeRuns)}`);
    // (ii) mixed: the stock editor is compatible, hooked and writing; the patched one is not.
    assert.equal(verdict[stockKey], false, `${order}: the stock editor was disabled`);
    assert.deepEqual(reasons[stockKey], []);
    assert.equal(hookSlots(hooks[stockKey]), 1, `${order}: the stock editor lost its hook`);
    assert.equal(verdict[patchedKey], true, `${order}: the patched editor was accepted`);
    assert.deepEqual(reasons[patchedKey], [ACTIVE_MODEL_REASONS[MIXED_PATCH]]);
    assert.equal(hookSlots(hooks[patchedKey]), 0, `${order}: the patched editor was hooked`);
    // The compatible editor's rollup ran on its own edit; the incompatible editor's did not.
    assert.equal(value[stockKey].split("/")[0], value[stockKey].split("/")[1],
      `${order}: the compatible editor did not write its rollup`);
    assert.notEqual(value[patchedKey].split("/")[0], value[patchedKey].split("/")[1],
      `${order}: the incompatible editor wrote a rollup`);
    assert.deepEqual(stats[patchedKey], ISOLATION_STATS, `${order}: the disabled plugin still ran`);
    assert.equal(stats[stockKey].recalculations, 1);
    // (iii) message isolation, asserted as two separate arrays in both install orders.
    assert.equal(run.sharedSink, false, `${order}: the two editors shared one sink`);
    assert.deepEqual(sink[patchedKey],
      [`${INCOMPATIBLE_PREFIX}${ACTIVE_MODEL_REASONS[MIXED_PATCH]}`],
      `${order}: the incompatible editor did not get exactly its own message`);
    assert.deepEqual(sink[stockKey], [], `${order}: the compatible editor was told about it`);
    // (iv) a second install() on the same editor: no second message, and no second probe.
    assert.deepEqual(run.messagesAfterRepeat, run.messagesAfterInstalls,
      `${order}: a repeated install() emitted a second message`);
    assert.equal(run.repeatSameApi, true, `${order}: a repeated install() returned a new API`);
    assert.ok(run.probeRuns.secondInstall >= 1,
      `${order}: the first install() ran no probe, so "no second probe" proves nothing`);
    assert.equal(run.probeRuns.secondInstallRepeat, 0,
      `${order}: a repeated install() re-ran the capability probe`);
    assert.equal(hookSlots(run.census.afterSecondTwice[patchedKey]), 0);
  }
});

test("NC-57 negative control: on one shared sink, message isolation is unassertable", () => {
  const run = isolationSharedSink;
  assert.equal(run.error, null, `the shared-sink control failed: ${run.error}`);
  console.log(`NC-57 sharedSink=${run.sharedSink} errorsA=${JSON.stringify(run.errorsA)} `
    + `errorsB=${JSON.stringify(run.errorsB)} disabled=[${run.disabledA},${run.disabledB}]`);
  assert.equal(run.sharedSink, true, "the control no longer shares a sink");
  assert.deepEqual([run.disabledA, run.disabledB], [false, true],
    "the control is not the same mixed pair");
  // The verdicts are still independent; the *messages* are not, so the clause above cannot be
  // stated on this arrangement at all: the compatible editor's sink also holds the message.
  assert.deepEqual(run.errorsA, run.errorsB);
  assert.equal(run.errorsA.length, 1);
  assert.notDeepEqual(run.errorsA, [],
    "the shared sink still reads empty for the compatible editor, so it is not shared");
});

// --- NC-58: validation never writes --------------------------------------------------------------

const validateFacts = (state) => ({
  history: state.history, index: state.index, modified: state.modified,
  updateLevel: state.updateLevel, currentEdit: state.currentEdit,
  recalculations: state.stats.recalculations,
  styles: state.styles, painted: state.painted, computed: state.computed,
});

test("NC-58 ahmValidate writes nothing on a compatible host", () => {
  const run = validateRun;
  assert.deepEqual(run.compatibility, { compatible: true, reasons: [], disabled: false },
    "the validate driver did not run on a compatible host");
  // (i) the stale case: a derived pill style deliberately made stale by a foreign edit.
  console.log(`NC-58 stale style ${run.staleApplied.before} -> ${run.staleApplied.after}`);
  console.log(`NC-58 stale before ${JSON.stringify(validateFacts(run.stale.before).recalculations)} `
    + `${JSON.stringify([run.stale.before.history, run.stale.before.index, run.stale.before.modified,
      run.stale.before.painted.db])}`);
  console.log(`NC-58 stale after  ${JSON.stringify(validateFacts(run.stale.after).recalculations)} `
    + `${JSON.stringify([run.stale.after.history, run.stale.after.index, run.stale.after.modified,
      run.stale.after.painted.db])} errors=${JSON.stringify(run.stale.outcome)}`);
  assert.match(run.staleApplied.after, /strokeColor=#ff0000/, "the stale-style input did not apply");
  assert.deepEqual(validateFacts(run.stale.after), validateFacts(run.stale.before),
    "ahmValidate changed the document on a compatible host");
  assert.deepEqual([run.stale.before.history, run.stale.before.index, run.stale.before.modified],
    [0, 0, false]);
  assert.equal(run.stale.before.stats.recalculations, 0);
  assert.equal(run.stale.after.stats.recalculations, 0, "ahmValidate counted a recalculation");
  assert.equal(run.stale.exportAfter, run.stale.exportBefore, "ahmValidate moved the exported bytes");
  assert.equal(run.stale.after.painted.db.stroke, "#ff0000", "ahmValidate repainted the pill");
  assert.equal(run.stale.outcome.threw, null);
  assert.deepEqual(run.stale.outcome.errors, [], "a settled model produced a validation message");

  // (iii) the clean case: on a settled model nothing happens at all.
  console.log(`NC-58 clean errors=${JSON.stringify(run.clean.outcome)} `
    + `exportEqual=${run.clean.exportAfter === run.clean.exportBefore}`);
  assert.deepEqual(validateFacts(run.clean.after), validateFacts(run.clean.before));
  assert.deepEqual(run.clean.outcome, { threw: null, errors: [] });
  assert.equal(run.clean.exportAfter, run.clean.exportBefore);

  // (v) the positive control, same host, same session: recalculate does write, dirty and record.
  console.log(`NC-58 recalculate before=${JSON.stringify([run.recalculated.before.history,
    run.recalculated.before.modified, run.recalculated.before.stats.recalculations,
    run.recalculated.before.painted.db.stroke])} after=${JSON.stringify([run.recalculated.after.history,
    run.recalculated.after.modified, run.recalculated.after.stats.recalculations,
    run.recalculated.after.painted.db.stroke])}`);
  assert.deepEqual([run.recalculated.after.history, run.recalculated.after.index,
    run.recalculated.after.modified], [1, 1, true],
  "ahmRecalculate stopped writing, so \"validate writes nothing\" is vacuous");
  assert.equal(run.recalculated.after.stats.recalculations, 1);
  assert.equal(run.recalculated.after.painted.db.stroke, "#a0d8a0",
    "ahmRecalculate did not repair the stale pill");
  assert.notEqual(run.recalculated.exportAfter, run.stale.exportAfter);
});

test("NC-58 ahmValidate still reports the model's own defect, verbatim and unwrapped", () => {
  const run = validateReports;
  // (ii) the reporting case: the original validation text, with no rollback-scope sentence, because
  // nothing was rolled back.
  console.log(`NC-58 reporting clean=${JSON.stringify(run.clean.outcome)} `
    + `stale=${JSON.stringify(run.stale.outcome)}`);
  assert.deepEqual(run.clean.outcome.errors, ["AHM validation: invalid state Sideways in db"]);
  assert.deepEqual(run.stale.outcome.errors, ["AHM validation: invalid state Sideways in db"]);
  assert.deepEqual(validateFacts(run.stale.after), validateFacts(run.stale.before),
    "reporting a defect wrote into the document");
  assert.equal(run.stale.exportAfter, run.stale.exportBefore);
  // The same failure through a *mutating* action does carry the scope sentence, so the plain
  // wording above is validate's own and not a lost suffix.
  console.log(`NC-58 reporting via recalculate=${JSON.stringify(run.recalculated.outcome.errors)}`);
  assert.deepEqual(run.recalculated.outcome.errors,
    [`AHM validation: invalid state Sideways in db. ${ROLLBACK_NOTE}`]);
});

test("NC-58 negative control (a): the pre-C-18 routing repairs, dirties and records", () => {
  const run = validatePreC18;
  console.log(`NC-58 (a) preC18 stale before=${JSON.stringify([run.stale.before.history,
    run.stale.before.modified, run.stale.before.stats.recalculations,
    run.stale.before.painted.db.stroke])} after=${JSON.stringify([run.stale.after.history,
    run.stale.after.modified, run.stale.after.stats.recalculations,
    run.stale.after.painted.db.stroke])} exportEqual=${run.stale.exportAfter === run.stale.exportBefore}`);
  assert.deepEqual([run.stale.after.history, run.stale.after.index, run.stale.after.modified],
    [1, 1, true], "the pre-C-18 routing no longer records, so the fix proves nothing");
  assert.equal(run.stale.after.stats.recalculations - run.stale.before.stats.recalculations, 1);
  assert.equal(run.stale.after.painted.db.stroke, "#a0d8a0",
    "the pre-C-18 routing no longer repaired the stale pill");
  assert.notEqual(run.stale.exportAfter, run.stale.exportBefore);
});

test("NC-58 negative control (b): a swallowed validation error is visible", () => {
  const run = validateSwallowed;
  console.log(`NC-58 (b) swallowed clean=${JSON.stringify(run.clean.outcome)} `
    + `stale=${JSON.stringify(run.stale.outcome)}`);
  assert.deepEqual(run.clean.outcome.errors, [],
    "the swallowing control still reports, so the reporting clause proves nothing");
  assert.deepEqual(run.stale.outcome.errors, []);
  // The defect is genuinely there — the same model still fails through the mutating path.
  assert.deepEqual(run.recalculated.outcome.errors,
    [`AHM validation: invalid state Sideways in db. ${ROLLBACK_NOTE}`]);
});

// --- NC-53: a rollback says what it took back ---------------------------------------------------
//
// Full string literals, never `includes`: the original validation text verbatim, then the scope
// sentence. `drawio/test/plugin-adapter.test.mjs` pins that sentence against `drawio/README.md` and
// against the plugin's own export, so the wording cannot drift between the three.
const ROLLBACK_NOTE = "The entire edit was rolled back, including other changes in the same transaction.";
const rolledBack = (original) => `${original}. ${ROLLBACK_NOTE}`;
const INCOMPATIBLE_PREFIX = "AHM Health Model: this Draw.io runtime does not support the transaction "
  + "semantics the health rollup needs, so automatic recalculation and every AHM Health Model change "
  + "have been disabled to protect your document. Supported runtime: Draw.io Integration 1.9.0 "
  + "(bundled draw.io webapp). Validate still works. Reasons: ";
// The five documented validation failures, keyed by the fixture that produces them, as the exact
// strings the user is shown.
const ORIGINAL_TEXTS = {
  "no state-label child": "AHM validation: state pill db-state has no state-label child to write",
  "state-label with no font style": "AHM validation: state label carries no font style",
  "state-label at a font size the contract was not derived for":
    "AHM validation: state label font size 14 is not the pill contract's 10",
  "state cell with no geometry": "AHM validation: state pill is missing its container or label cell",
  "entity carrying a state the model does not define": "AHM validation: invalid state Sideways in db",
};

test("NC-53 a rolled-back transaction reports one message that names its own scope", () => {
  // (i) + (ii): the exact literal, on both paths, for the mid-write and pre-write originals.
  const MID = "AHM validation: injected failure after the derived write began";
  const PRE = "AHM validation: invalid state Sideways in db";
  for (const [phase, run, original] of [
    ["mid-write", rollbackMidWrite, MID], ["pre-write", rollbackPreWrite, PRE],
  ]) {
    for (const cell of ROLLBACK_CELLS) {
      const key = cellKey(cell);
      const item = run[key];
      const failed = rollbackStep(item, "failed + settle");
      const dirty = rollbackStep(item, "failed while dirty + settle");
      console.log(`NC-53 ${phase}/${key} ${JSON.stringify(failed.errors)}`);
      // (iii) exactly one message per failed transaction — every shape, including the compound one
      // that also carries a third-party geometry change the plugin never authors — clean and dirty,
      // with nothing arriving after the settle.
      assert.deepEqual(failed.errors, [rolledBack(original)],
        `${phase}/${key} did not report the exact rollback message`);
      assert.deepEqual(dirty.errors, [rolledBack(original), rolledBack(original)],
        `${phase}/${key} did not report the second failure exactly once`);
      // (ii) the original text survives verbatim inside it.
      assert.equal(failed.errors[0].slice(0, original.length), original);
    }
  }
  // (ii) for all five documented validation failures, on both paths, as full string literals.
  assert.deepEqual(Object.keys(ORIGINAL_TEXTS), Object.keys(FAILURE_MESSAGES),
    "the documented originals and the measured fixtures are no longer the same five");
  for (const name of Object.keys(FAILURE_MESSAGES)) {
    const item = failurePaths[name];
    const original = ORIGINAL_TEXTS[name];
    assert.match(original, FAILURE_MESSAGES[name],
      `the documented original for "${name}" is not what the fixture produces`);
    console.log(`NC-53 "${name}" action=${JSON.stringify(item.viaAction)} hook=${JSON.stringify(item.viaListener)}`);
    assert.deepEqual(item.viaAction, [rolledBack(original)],
      `"${name}" is not the exact rollback message on the action path`);
    assert.deepEqual(item.viaListener, [rolledBack(original)],
      `"${name}" is not the exact rollback message on the hook path`);
  }
  // (v) a successful edit produces no message at all.
  const settled = atomicStep(atomic, "external edit + settle");
  assert.deepEqual(settled.errors, [], "a successful edit produced a message");
});

test("NC-53 negative controls: the bare message and a doubled message are each visible", () => {
  const bare = rollbackStep(rollbackBareMessage["hook/compound"], "failed + settle");
  const twice = rollbackStep(rollbackReportedTwice["hook/compound"], "failed + settle");
  const original = "AHM validation: injected failure after the derived write began";
  console.log(`NC-53 (a) bareRollbackMessage ${JSON.stringify(bare.errors)}`);
  console.log(`NC-53 (b) reportTwice ${JSON.stringify(twice.errors)}`);
  // (a) the pre-C-17 message: the scope clause is missing, so the criterion turns red on it.
  assert.deepEqual(bare.errors, [original],
    "the bare-message control still names the rollback scope, so the clause proves nothing");
  assert.notEqual(bare.errors[0], rolledBack(original));
  // (b) the same message twice: the count clause turns red.
  assert.deepEqual(twice.errors, [rolledBack(original), rolledBack(original)],
    "the double-report control reported once, so the count clause proves nothing");
});

test("NC-54 the record matches the measurement: the tape, the artifacts and the C-16 guarantees", () => {
  // 2. END_EDIT is recorded rather than claimed absent, and it fires twice on a rolled-back
  // transaction — once for the user's own `endUpdate`, once for the plugin's nested one.
  const tape = rollbackMidWrite["hook/single"].tapeClean;
  console.log(`NC-54 END_EDIT tape ${JSON.stringify(tapeOf(tape))}`);
  assert.deepEqual(tapeOf(tape), ["END_UPDATE@1", "END_EDIT@0", "END_EDIT@0", "END_UPDATE@0"],
    "the measured tape is not the sequence the record claims");
  assert.equal(tape.filter((entry) => entry.tag === "END_EDIT").length, 2,
    "END_EDIT no longer fires twice, so the recorded claim is stale");
  assert.deepEqual(tape.map((entry) => entry.tag).filter((tag) => CARRIES_AN_EDIT.includes(tag)), []);

  // 3. The C-15/C-16 guarantees, re-run on whatever ships rather than assumed: a clean open on all
  // three examples, in both install orders.
  for (const name of EXAMPLES) {
    assert.deepEqual(openFacts(openBefore[name]), CLEAN_OPEN, `${name} did not open clean`);
    assert.deepEqual(openFacts(openAfter[name]), CLEAN_OPEN, `${name} did not open clean (plugin first)`);
  }

  // 4. No artifact is regenerated without a measured cause: the same eight files NC-49 pins, and the
  // sub-manifest the C-16 archive record carries.
  const measured = Object.fromEntries(Object.keys(C15_ARTIFACTS).map((file) => [
    file, sha256(readFileSync(resolve(root, file))).slice(0, 8),
  ]));
  console.log(`NC-54 generated artifacts ${JSON.stringify(measured)}`);
  assert.deepEqual(measured, C15_ARTIFACTS,
    "an artifact was regenerated — name and measure the cause, and return NC-15 to active state");
});

// --- NC-62: a read-only action entered re-entrantly from outside is blocked and counted ----------
//
// `NC-58` above proves the top-level half — validate writes nothing, on every host. This is the half
// C-18 never drove: while a plugin operation is in flight, a foreign `END_UPDATE` listener fires
// `ahmValidate`. With the guard one level down inside `runDrawio` and `readOnly` routed first, that
// entry ran a full extra validation and moved no counter (`P-C19-5` / `P-C19-6`).

const nestingFacts = (run) => ({
  editor: run.editorAfter, exportSha256: run.exportAfter, messages: run.errors,
  recalculations: run.after.recalculations, selfSuppressed: run.after.selfSuppressed,
});

test("NC-62 (ii)/(iii)/(iv) a forced nested read-only entry is blocked once, in both listener orders", () => {
  for (const order of ["after", "before"]) {
    const { forced, control } = nestedValidate[order];
    console.log(`NC-62 listener ${order} forced  attempts=${forced.nestedAttempts} `
      + `reads=${forced.nestedReads} stats=${JSON.stringify(forced.after)} `
      + `messages=${JSON.stringify(forced.errors)}`);
    console.log(`NC-62 listener ${order} control attempts=${control.nestedAttempts} `
      + `reads=${control.nestedReads} stats=${JSON.stringify(control.after)} `
      + `messages=${JSON.stringify(control.errors)}`);
    // (ii) exactly one attempt was made, and it was blocked and counted once.
    assert.equal(forced.nestedAttempts, 1, `${order}: nothing was nested, so the claim is unprovable`);
    assert.equal(forced.after.blockedReentries - forced.before.blockedReentries, 1,
      `${order}: the forced read-only re-entry was not counted exactly once`);
    // (iv) the same driver with nothing nested: the whole count is attributable to the forcing.
    assert.equal(control.nestedAttempts, 0, `${order}: the control nested something`);
    assert.equal(control.after.blockedReentries, 0, `${order}: the unforced control blocked something`);
    assert.equal(forced.after.blockedReentries - control.after.blockedReentries, 1,
      `${order}: the forced nesting was not the cause of the blocked attempt`);
    // The blocked entry did nothing at all: it never read the model, produced no message and no
    // report, and left every observable the control left.
    assert.equal(forced.nestedReads, 0, `${order}: readDrawio ran for the blocked entry`);
    assert.deepEqual(forced.errors, control.errors,
      `${order}: the blocked entry produced a message the control does not have`);
    assert.equal(forced.errors.length, 1,
      `${order}: the fixture stopped producing exactly the outer operation's one message`);
    assert.equal(forced.after.recalculations, control.after.recalculations,
      `${order}: a blocked attempt counted as a recalculation`);
    assert.equal(forced.after.selfSuppressed, control.after.selfSuppressed,
      `${order}: the forced foreign entry was misread as the plugin's own self-suppression`);
    assert.equal(forced.after.recalculations - forced.before.recalculations, 1,
      `${order}: the outer operation is not the only recalculation`);
    assert.deepEqual(forced.editorAfter, control.editorAfter,
      `${order}: the blocked entry moved history, values, styles, geometry or the painted pill`);
    assert.equal(forced.exportAfter, control.exportAfter,
      `${order}: the blocked entry moved Draw.io's own exported bytes`);
    // This fixture rolls its outer operation back, so nothing at all should have been written.
    assert.equal(forced.exportAfter, forced.exportBefore, `${order}: the rolled-back run wrote bytes`);
    assert.deepEqual(
      [forced.editorAfter.history, forced.editorAfter.index, forced.editorAfter.modified,
        forced.editorAfter.updateLevel, forced.editorAfter.currentEdit],
      [0, 0, false, 0, 0],
      `${order}: the rolled-back run left an undo entry, a dirty flag or an open transaction`,
    );
  }
  // (iii) both orders produce the same reading, so "blocked" does not depend on which listener
  // Draw.io reaches first.
  assert.deepEqual(nestingFacts(nestedValidate.after.forced), nestingFacts(nestedValidate.before.forced),
    "the two listener registration orders do not agree");
  assert.deepEqual(nestedValidate.after.forced.after, nestedValidate.before.forced.after);
});

test("NC-62 (ii) a blocked entry leaves a *successful* outer operation completely undisturbed", () => {
  const { forced, control } = nestedValidateClean;
  console.log(`NC-62 clean forced  attempts=${forced.nestedAttempts} reads=${forced.nestedReads} `
    + `stats=${JSON.stringify(forced.after)} hist=${forced.editorAfter.history} `
    + `modified=${forced.editorAfter.modified}`);
  console.log(`NC-62 clean control attempts=${control.nestedAttempts} reads=${control.nestedReads} `
    + `stats=${JSON.stringify(control.after)} hist=${control.editorAfter.history} `
    + `modified=${control.editorAfter.modified}`);
  assert.equal(forced.nestedAttempts, 1);
  assert.equal(control.nestedAttempts, 0);
  assert.equal(forced.after.blockedReentries - control.after.blockedReentries, 1);
  assert.equal(forced.nestedReads, 0, "readDrawio ran for the blocked entry");
  assert.deepEqual(forced.errors, control.errors);
  assert.deepEqual(forced.errors, []);
  assert.equal(forced.after.recalculations, control.after.recalculations);
  assert.equal(forced.after.selfSuppressed, control.after.selfSuppressed);
  assert.equal(forced.after.recalculations - forced.before.recalculations, 1,
    "the outer operation is not the only recalculation");
  assert.deepEqual(forced.editorAfter, control.editorAfter,
    "the blocked entry disturbed the write the outer operation made");
  assert.equal(forced.exportAfter, control.exportAfter);
  assert.equal(forced.exportBefore, control.exportBefore);
  // The outer operation really did write, so "undisturbed" is asserted against a moving target.
  assert.notEqual(forced.exportAfter, forced.exportBefore, "the outer operation wrote nothing");
  assert.deepEqual(
    [forced.editorAfter.history, forced.editorAfter.index, forced.editorAfter.modified,
      forced.editorAfter.updateLevel, forced.editorAfter.currentEdit],
    [1, 1, true, 0, 0],
    "the successful outer operation stopped recording one undo entry",
  );
});

test("NC-62 (v) negative controls: without the guard, and on the C-18 ordering, the nested validate runs", () => {
  for (const [label, run] of [
    ["(v) noReentrancyGuard", nestedValidateUnguarded],
    ["(a) guardAfterReadOnlyRoute", nestedValidatePreC19],
  ]) {
    const control = nestedValidate.after.control;
    console.log(`NC-62 ${label} attempts=${run.nestedAttempts} reads=${run.nestedReads} `
      + `stats=${JSON.stringify(run.after)} messages=${JSON.stringify(run.errors)}`);
    assert.equal(run.nestedAttempts, 1, `${label}: nothing was nested`);
    // The nested validate genuinely executed: it read the model and it spoke.
    assert.ok(run.nestedReads > 0, `${label}: the nested validate never reached the model`);
    assert.equal(run.after.blockedReentries, 0, `${label}: the ablated plugin still counted a block`);
    assert.equal(run.errors.length, 2, `${label}: the extra validation message did not appear`);
    assert.deepEqual(run.errors.slice(0, 1), control.errors,
      `${label}: the first message is not the outer operation's`);
    assert.equal(run.errors[1], "AHM validation: invalid state Sideways in db",
      `${label}: the second message is not the nested validate's`);
    // ...and it still wrote nothing, which is why the counter is the only honest discriminator.
    assert.equal(run.exportAfter, run.exportBefore, `${label}: the nested validate wrote bytes`);
    assert.equal(run.after.recalculations, control.after.recalculations,
      `${label}: the nested read-only entry counted a recalculation`);
  }
});

test("NC-62 (vii) a nested ahmValidate outside any plugin operation behaves as a top-level one", () => {
  const run = nestedValidateOutside;
  console.log(`NC-62 outside-operation attempts=${run.nestedAttempts} reads=${run.nestedReads} `
    + `stats=${JSON.stringify(run.after)} messages=${JSON.stringify(run.errors)}`);
  assert.equal(run.nestedAttempts, 1, "nothing was nested, so the claim is unprovable");
  // The enclosing transaction carries no health attribute, so no plugin operation is in flight.
  assert.equal(run.after.recalculations, 0, "the foreign edit was treated as a relevant edit");
  assert.equal(run.after.blockedReentries, 0, "a validate outside any plugin operation was blocked");
  assert.equal(run.after.selfSuppressed, 0);
  // It ran, it reported the model's own defect, and it wrote nothing.
  assert.ok(run.nestedReads > 0, "the allowed validate never reached the model");
  assert.deepEqual(run.errors, ["AHM validation: invalid state Sideways in db"],
    "the allowed validate did not report the model's defect verbatim and unwrapped");
  assert.equal(run.editorAfter.updateLevel, 0);
  assert.equal(run.editorAfter.currentEdit, 0);
});

test("NC-62 (vi) negative control (b): folding self-suppression into the public counter is visible", () => {
  console.log(`NC-62 (b) folded stats=${JSON.stringify(nestingFolded.after)} `
    + `plain stats=${JSON.stringify(nestingUnforced.after)}`);
  assert.equal(nestingFolded.nestedAttempts, 0, "the control nested something");
  // The shipped split: one plain successful action, nothing external, the counter stays 0.
  assert.equal(nestingUnforced.after.blockedReentries, 0);
  assert.equal(nestingUnforced.after.selfSuppressed - nestingUnforced.before.selfSuppressed, 1);
  // The ablation moves the same event into the public counter, so (vi) reads red on it.
  assert.equal(nestingFolded.after.selfSuppressed, 0,
    "the folded control still counted a self-suppression, so it is not the control");
  assert.equal(nestingFolded.after.blockedReentries - nestingFolded.before.blockedReentries, 1,
    "folding self-suppression into blockedReentries changed nothing, so the split proves nothing");
  assert.equal(nestingFolded.after.recalculations, nestingUnforced.after.recalculations);
});

// --- NC-65: while ANY installed operation is in flight, an external nested action is blocked ------
//
// `NC-62` above drove the mutating half: a foreign listener firing an AHM action while the plugin's
// own transaction was open. This is the half it never drove. `ahmValidate` is top-level and
// read-only, and its findings leave through `ui.handleError` — *inside* the operation — so an error
// sink that re-enters the plugin arrives while a read-only operation is in flight. With the flag
// armed only inside `runDrawio` that state did not exist, and the nested validate ran a second full
// validation (`P-C20-9`).

const sinkFacts = (run) => ({
  editor: run.editorAfter, exportSha256: run.exportAfter, messages: run.errors,
  recalculations: run.after.recalculations, selfSuppressed: run.after.selfSuppressed,
});

test("NC-65 (i) a nested validate fired from the operation's own error sink is blocked once", () => {
  const { forced, control } = sinkValidate;
  console.log(`NC-65 (i) forced  attempts=${forced.nestedAttempts} reads=${forced.nestedReads} `
    + `stats=${JSON.stringify(forced.after)} messages=${JSON.stringify(forced.errors)}`);
  console.log(`NC-65 (i) control attempts=${control.nestedAttempts} reads=${control.nestedReads} `
    + `stats=${JSON.stringify(control.after)} messages=${JSON.stringify(control.errors)}`);
  assert.equal(forced.nestedAttempts, 1, "nothing was nested, so the claim is unprovable");
  assert.equal(control.nestedAttempts, 0, "the unforced control nested something");
  assert.equal(forced.after.blockedReentries - control.after.blockedReentries, 1,
    "the nested entry from the error sink was not counted exactly once");
  assert.equal(forced.after.blockedReentries - forced.before.blockedReentries, 1);
  assert.equal(control.after.blockedReentries, 0, "the unforced control blocked something");
  // The blocked entry did nothing: it never reached the model and it never spoke.
  assert.equal(forced.nestedReads, 0, "readDrawio ran for the blocked entry");
  assert.equal(forced.errors.length, 1, "the outer validate did not report exactly once");
  assert.deepEqual(forced.errors, control.errors,
    "the blocked entry produced a message the control does not have");
  assert.deepEqual(forced.errors, ["AHM validation: invalid state Sideways in db"]);
  assert.equal(forced.after.recalculations, control.after.recalculations,
    "a blocked attempt counted as a recalculation");
  assert.equal(forced.after.selfSuppressed, control.after.selfSuppressed,
    "the forced external entry was misread as the plugin's own self-suppression");
  assert.equal(forced.after.recalculations, 0, "a read-only validate ran a recalculation");
  // ...and nothing at all moved: history, index, modified, updateLevel, every watched value, style
  // and geometry, the painted pill, and Draw.io's own exported bytes.
  assert.deepEqual(forced.editorAfter, control.editorAfter,
    "the blocked entry moved history, values, styles, geometry or the painted pill");
  assert.deepEqual(forced.editorAfter, forced.editorBefore, "a top-level validate wrote");
  assert.equal(forced.exportAfter, control.exportAfter);
  assert.equal(forced.exportAfter, forced.exportBefore, "a top-level validate moved the bytes");
  assert.deepEqual(
    [forced.editorAfter.history, forced.editorAfter.index, forced.editorAfter.modified,
      forced.editorAfter.updateLevel, forced.editorAfter.currentEdit],
    [0, 0, false, 0, 0],
    "a top-level validate left an undo entry, a dirty flag or an open transaction",
  );
});

test("NC-65 (ii) a nested *mutating* action from the same sink is blocked and writes nothing", () => {
  const { forced, unguarded } = sinkMutating;
  console.log(`NC-65 (ii) forced    attempts=${forced.nestedAttempts} reads=${forced.nestedReads} `
    + `stats=${JSON.stringify(forced.after)} exportMoved=${forced.exportAfter !== forced.exportBefore}`);
  console.log(`NC-65 (ii) unguarded attempts=${unguarded.nestedAttempts} `
    + `reads=${unguarded.nestedReads} stats=${JSON.stringify(unguarded.after)} `
    + `exportMoved=${unguarded.exportAfter !== unguarded.exportBefore} `
    + `messages=${JSON.stringify(unguarded.errors)}`);
  assert.equal(forced.nestedAttempts, 1, "nothing was nested");
  assert.equal(forced.after.blockedReentries - forced.before.blockedReentries, 1,
    "the nested mutating entry was not counted exactly once");
  assert.equal(forced.nestedReads, 0, "readDrawio ran for the blocked mutating entry");
  assert.equal(forced.after.recalculations, 0, "the blocked mutating entry counted a recalculation");
  assert.deepEqual(forced.editorAfter, forced.editorBefore,
    "the blocked mutating entry wrote to the model");
  assert.equal(forced.exportAfter, forced.exportBefore, "the blocked mutating entry moved bytes");
  assert.deepEqual(
    [forced.editorAfter.history, forced.editorAfter.index, forced.editorAfter.modified],
    [0, 0, false],
    "the blocked mutating entry recorded an undo entry or dirtied the editor",
  );
  // The same fixture with the arming removed really does run the whole mutating path — it reads the
  // model, opens a transaction (the model's END_UPDATE dispatch is what moves `hooks`), writes,
  // fails the same validation and reports its own rollback. None of that happens when it is
  // blocked, so "no write" above is measured against a nested action that demonstrably gets there.
  assert.equal(unguarded.nestedAttempts, 1, "the ablated control nested nothing");
  assert.equal(unguarded.after.blockedReentries, 0, "the ablated control still blocked");
  assert.ok(unguarded.nestedReads > 0, "the ablated nested mutating action never reached the model");
  assert.equal(unguarded.after.recalculations - unguarded.before.recalculations, 1,
    "the ablated nested mutating action never ran, so (ii) is unfalsifiable");
  assert.equal(unguarded.after.hooks - unguarded.before.hooks, 1,
    "the ablated nested mutating action opened no transaction, so (ii) is unfalsifiable");
  assert.equal(unguarded.errors.length, 2, "the ablated nested mutating action reported nothing");
  assert.equal(unguarded.errors[1],
    "AHM validation: invalid state Sideways in db. The entire edit was rolled back, "
    + "including other changes in the same transaction.",
    "the second message is not the nested mutating action's own rollback report");
  assert.equal(forced.errors.length, 1, "the blocked mutating entry produced a message");
  assert.equal(forced.after.hooks, 0, "the blocked mutating entry opened a transaction");
});

test("NC-65 (iii) the guard clears: a later top-level validate reports normally", () => {
  for (const [label, run] of [["(i) validate", sinkValidate.forced], ["(ii) mutating", sinkMutating.forced]]) {
    console.log(`NC-65 (iii) after ${label}: secondErrors=${JSON.stringify(run.second.errors)} `
      + `secondStats=${JSON.stringify(run.second.after)} attemptsTotal=${run.second.nestedAttempts}`);
    assert.deepEqual(run.second.errors, ["AHM validation: invalid state Sideways in db"],
      `${label}: the second top-level validate did not report exactly once`);
    assert.equal(run.second.after.blockedReentries, run.after.blockedReentries,
      `${label}: the second top-level validate was blocked, so the flag is stuck`);
    assert.equal(run.second.nestedAttempts, 1,
      `${label}: the sink fired again, so the second run is not an unforced control`);
    assert.equal(run.second.threw, null, `${label}: the second top-level validate threw`);
    assert.equal(run.exportSecond, run.exportBefore, `${label}: the second validate wrote bytes`);
  }
});

test("NC-65 (iv) the release survives a throw out of the report path", () => {
  const run = sinkThrows;
  console.log(`NC-65 (iv) first threw=${JSON.stringify(run.threw)} stats=${JSON.stringify(run.after)}`);
  console.log(`NC-65 (iv) second threw=${JSON.stringify(run.second.threw)} `
    + `stats=${JSON.stringify(run.second.after)}`);
  // With no `ui.handleError`, `report` re-throws: the first top-level validate leaves through the
  // action, i.e. through `run`'s `finally`.
  assert.equal(run.threw, "AHM validation: invalid state Sideways in db",
    "the report path did not throw, so the cleanup is not under test");
  assert.deepEqual(run.errors, [], "an error sink recorded something on a host that has none");
  // The next top-level validate on the same editor still runs, still reaches the model and still
  // reports. A flag left set would make it return `undefined` and count a block instead.
  assert.equal(run.second.threw, "AHM validation: invalid state Sideways in db",
    "the second top-level validate did not run, so the flag is stuck after a throw");
  assert.equal(run.second.after.blockedReentries, 0,
    "the second top-level validate was counted as a blocked re-entry");
  assert.equal(run.second.after.recalculations, 0);
  assert.deepEqual(run.editorSecond, run.editorBefore, "a throwing validate moved the editor");
  assert.equal(run.exportSecond, run.exportBefore, "a throwing validate moved the bytes");
});

test("NC-65 (v) the mutating nesting NC-62 measured stays blocked on every model dispatch", () => {
  for (const event of ["EXECUTED", "BEFORE_UNDO"]) {
    const { forced, control } = nestedValidateEvents[event];
    console.log(`NC-65 (v) ${event} forced  attempts=${forced.nestedAttempts} `
      + `reads=${forced.nestedReads} stats=${JSON.stringify(forced.after)}`);
    console.log(`NC-65 (v) ${event} control attempts=${control.nestedAttempts} `
      + `reads=${control.nestedReads} stats=${JSON.stringify(control.after)}`);
    assert.equal(forced.nestedAttempts, 1, `${event}: nothing was nested`);
    assert.equal(control.nestedAttempts, 0, `${event}: the control nested something`);
    assert.equal(forced.after.blockedReentries - control.after.blockedReentries, 1,
      `${event}: the forced nested validate was not blocked and counted once`);
    assert.equal(control.after.blockedReentries, 0, `${event}: the unforced control blocked something`);
    assert.equal(forced.nestedReads, 0, `${event}: readDrawio ran for the blocked entry`);
    assert.equal(forced.after.recalculations, control.after.recalculations,
      `${event}: a blocked attempt counted as a recalculation`);
    assert.equal(forced.after.selfSuppressed, control.after.selfSuppressed,
      `${event}: the forced foreign entry was misread as self-suppression`);
    assert.deepEqual(forced.editorAfter, control.editorAfter,
      `${event}: the blocked entry disturbed the outer operation`);
    assert.equal(forced.exportAfter, control.exportAfter);
    // The outer operation really did write, so "undisturbed" is asserted against a moving target.
    assert.notEqual(forced.exportAfter, forced.exportBefore, `${event}: the outer operation wrote nothing`);
  }
});

test("NC-65 (viii) a disabled host blocks the same re-entry, and still writes nothing", () => {
  const { forced, control } = sinkDisabled;
  console.log(`NC-65 (viii) disabled forced  compat=${JSON.stringify(forced.compatibility)} `
    + `attempts=${forced.nestedAttempts} reads=${forced.nestedReads} `
    + `stats=${JSON.stringify(forced.after)} messages=${JSON.stringify(forced.errors)}`);
  console.log(`NC-65 (viii) disabled control attempts=${control.nestedAttempts} `
    + `stats=${JSON.stringify(control.after)} messages=${JSON.stringify(control.errors)}`);
  assert.equal(forced.compatibility.disabled, true, "the host-disabling patch did not apply");
  assert.deepEqual(forced.compatibility.reasons, ["endUpdate-patched"]);
  assert.equal(forced.nestedAttempts, 1, "nothing was nested on the disabled host");
  assert.equal(control.nestedAttempts, 0, "the unforced disabled control nested something");
  assert.equal(forced.after.blockedReentries - control.after.blockedReentries, 1,
    "the nested entry on a disabled host was not counted exactly once");
  assert.equal(control.after.blockedReentries, 0, "the unforced disabled control blocked something");
  assert.equal(forced.nestedReads, 0, "readDrawio ran for the blocked entry on a disabled host");
  // NC-58's clause, re-run: validate still reports on a disabled host, and still writes nothing.
  assert.deepEqual(forced.errors, ["AHM validation: invalid state Sideways in db"]);
  assert.deepEqual(forced.errors, control.errors);
  assert.deepEqual(forced.editorAfter, forced.editorBefore, "a disabled host wrote during validate");
  assert.equal(forced.exportAfter, forced.exportBefore, "a disabled host moved the bytes");
  assert.deepEqual(forced.second.errors, ["AHM validation: invalid state Sideways in db"],
    "the disabled host's guard is stuck after the blocked re-entry");
});

test("NC-65 (viii) the counter split and the five-key stats set are unchanged", () => {
  console.log(`NC-65 (viii) plain action stats=${JSON.stringify(nestingUnforced.after)}`);
  console.log(`NC-65 (viii) keys=${JSON.stringify(Object.keys(sinkValidate.forced.settled))}`);
  // A plain successful action: the plugin's own re-entry is self-suppression, never a block.
  assert.equal(nestingUnforced.after.blockedReentries, 0);
  assert.equal(nestingUnforced.after.selfSuppressed - nestingUnforced.before.selfSuppressed, 1);
  assert.equal(nestingUnforced.after.recalculations - nestingUnforced.before.recalculations, 1);
  assert.deepEqual(Object.keys(sinkValidate.forced.settled).sort(),
    ["blockedReentries", "hooks", "recalculations", "relevant", "selfSuppressed"]);
  // Control (b): folding the hook's own suppression into the public counter is visible.
  assert.equal(nestingFolded.after.selfSuppressed, 0,
    "the folded control still counted a self-suppression, so it is not the control");
  assert.equal(nestingFolded.after.blockedReentries - nestingFolded.before.blockedReentries, 1,
    "folding self-suppression into blockedReentries changed nothing, so the split proves nothing");
});

test("NC-65 (vii) negative controls (a) and (c): the nested validate actually runs on both", () => {
  const control = sinkValidate.control;
  for (const [label, run] of [
    ["(a) noOperationGuard", sinkUnguarded],
    ["(c) guardInsideRunDrawio (the C-19 shape)", sinkGuardInDrawio],
  ]) {
    console.log(`NC-65 ${label} attempts=${run.nestedAttempts} reads=${run.nestedReads} `
      + `stats=${JSON.stringify(run.after)} messages=${JSON.stringify(run.errors)}`);
    assert.equal(run.nestedAttempts, 1, `${label}: nothing was nested`);
    // The nested validate genuinely executed: it read the model and it spoke a second time.
    assert.ok(run.nestedReads > 0, `${label}: the nested validate never reached the model`);
    assert.equal(run.after.blockedReentries, 0, `${label}: the ablated plugin still counted a block`);
    assert.equal(run.errors.length, 2, `${label}: the extra validation message did not appear`);
    assert.deepEqual(run.errors.slice(0, 1), control.errors,
      `${label}: the first message is not the outer operation's`);
    assert.equal(run.errors[1], "AHM validation: invalid state Sideways in db",
      `${label}: the second message is not the nested validate's`);
    assert.equal(run.exportAfter, run.exportBefore, `${label}: the nested validate wrote bytes`);
    assert.equal(run.after.recalculations, 0, `${label}: a read-only entry counted a recalculation`);
  }
  // (c) is the discrimination this correction adds: the C-19 shape still blocks the *mutating*
  // nesting NC-62 measured, and only the top-level read-only path goes red on it.
  const mutating = nestedValidateGuardInDrawio;
  console.log(`NC-65 (c) C-19 shape on the mutating path: ${JSON.stringify(mutating.after)} `
    + `attempts=${mutating.nestedAttempts} reads=${mutating.nestedReads} `
    + `messages=${JSON.stringify(mutating.errors)}`);
  assert.equal(mutating.nestedAttempts, 1, "(c): nothing was nested on the mutating path");
  assert.equal(mutating.after.blockedReentries - mutating.before.blockedReentries, 1,
    "(c) went red on the mutating path too, so it does not isolate the top-level read-only route");
  assert.equal(mutating.nestedReads, 0, "(c): the nested validate ran on the mutating path");
  assert.equal(mutating.errors.length, 1, "(c): a second message appeared on the mutating path");
});

// --- C-22 / NC-73: ablatePlugin requires exactly one anchor occurrence per patch -----------------

test("NC-73 ablatePlugin rejects a missing anchor", () => {
  const source = "function noMatch() { return 42; }";
  assert.throws(
    () => ablatePlugin(["adapterBeforeGuard"], source),
    (error) => error.name === "AblationAnchorError" && /not found/.test(error.message),
    "a missing anchor did not throw a named AblationAnchorError",
  );
});

test("NC-73 ablatePlugin rejects a duplicated anchor", () => {
  const anchor = "        if (operationInFlight) { stats.blockedReentries++; return undefined; }\n"
    + "        operationInFlight = true;";
  const source = `first\n${anchor}\nmore code\n${anchor}\nlast`;
  assert.throws(
    () => ablatePlugin(["adapterBeforeGuard"], source),
    (error) => error.name === "AblationAnchorError" && /occurs 2 times/.test(error.message),
    "a duplicated anchor did not throw a named AblationAnchorError",
  );
});

test("NC-73 all real ablations still apply exactly once on the shipped source", () => {
  for (const name of PLUGIN_ABLATION_NAMES) {
    assert.doesNotThrow(() => ablatePlugin([name]),
      `ablation "${name}" failed the exactly-once check on the shipped source`);
  }
  assert.equal(PLUGIN_ABLATION_NAMES.length, 34, "the plugin ablation inventory changed");
});

// --- C-22 / NC-74: shared parser wrappers include the caller's label in error messages -----------

test("NC-74 shared parser wrappers preserve the literal label and selector error", () => {
  const wrappers = [
    { name: "readDrawioSvgText", read: readDrawioSvgText },
    { name: "readDrawioSvgSource", read: readDrawioSvgSource },
  ];
  const cases = [
    { svg: "<svg></svg>", label: "my-artifact.svg" },
    { svg: "<svg>no content here</svg>", label: "file[0].drawio.svg" },
    { svg: "<svg></svg>", label: "label+with(regex)metachar$" },
  ];
  for (const { name, read } of wrappers) {
    for (const { svg, label } of cases) {
      assert.throws(
        () => read(svg, label),
        (error) => error.message.startsWith(`${label}: `)
          && error.cause instanceof Error
          && error.message.endsWith(error.cause.message),
        `${name} did not preserve the label and shared selector error for "${label}"`,
      );
    }
  }
});
