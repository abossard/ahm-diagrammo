# AHM Diagrammo for Draw.io

1. Open `drawio/ahm-diagrammo.code-workspace` in VS Code and install the recommended
   **Draw.io Integration** extension.
2. Open a file in `examples/` with **Open With… → Draw.io**. Use the full **Draw.io** editor,
   not the experimental inline editor.
3. On first load, review and allow the fingerprinted plugin prompt. VS Code stores approval
   for that exact local file. Editing the plugin changes its fingerprint, so VS Code will prompt
   again.
4. Insert native shapes from the **AHM Diagrammo** library. Select an entity and use the
   **AHM Health Model** menu to set local health, set dependency impact, validate, or recalculate.

All plugin and library settings are relative to this workspace. Shape data remains editable through
Draw.io's **Edit Data** command. Entities, dependencies, groups, swimlanes, and the legend are native
cells. An **AHM Health Model** action — setting local health or impact, or **Recalculate** — writes
the label, the style and the pill geometry of the whole trickle-up inside one model transaction, so
it is one native undo/redo step. Editing `ahmLocalState` directly through **Edit Data** is the same:
the rollup joins your own edit before it reaches the undo history, so one health change is one undo
step and one Undo puts every dependent card, pill and colour back.

The `.drawio.svg` files remain viewable and editable without the plugin. Rollup actions require the
approved plugin in the full VS Code editor. The simulator intentionally supports explicit local
inputs and `worstOf` rollup only; it does not query Azure or evaluate thresholds.

## When a health change is rejected, the whole edit goes back

A health change is validated before it is written. If it fails — an entity carrying a state the
model does not define, a state pill missing its label, a label whose font no longer matches the pill
contract — nothing is written and **the transaction that caused it is taken back in full**. That is
deliberate and it is wider than the plugin's own writes: if you moved a card and changed its state
in one operation, the move goes back too, because the two were one undo step and one of them was
invalid. The editor is left exactly as it was — no undo entry, no dirty flag, no repaint — and you
get exactly one message, which is the original validation text followed by this sentence:

> The entire edit was rolled back, including other changes in the same transaction.

## The plugin checks the Draw.io runtime before it writes anything

The rollup joins your own transaction and, on failure, empties it before Draw.io's history gate sees
it. That rests on transaction semantics the mxGraph API does not document, so `install()` first runs
a read-only capability probe on a throwaway model — never on your document — and confirms the live
model is the stock implementation. If the host does not behave the way the rollup needs, the plugin
disables **every** automatic recalculation and every AHM Health Model change instead of writing into
a document it cannot safely take back, and reports that once, naming the supported runtime:
`Draw.io Integration 1.9.0 (bundled draw.io webapp)`. **Validate** keeps working, because it writes
nothing. That is true on every host, not only a rejected one: validate reads the model, reports what
is wrong with it and never opens a transaction, so it never repairs a stale pill, never dirties the
file and never adds an undo entry. **Recalculate** is the action that repairs. The check is
behavioural: no version string is compared, and no bundled source is parsed.

## The examples are generated demos, not documents you edit

`examples/*.drawio.svg` and `library/ahm-diagrammo.xml` are **generated canonical demos**. The
authored markdown (`hero.md`, `kitchen-sink.md`, `pills-stress.md`) plus `scripts/generate-artifacts.mjs`
is the source of truth; a shipped artifact is a build output that you may *open*. Editing one in
place is an unsupported workflow — **copy it, or create a new diagram from the shape library**
(a blank-model command is planned) before you edit. A save from VS Code writes the editor's current
model over the whole file, including any state the plugin recalculated while you looked at it, and
the next `npm run artifacts` throws that away.

`npm run drift` rebuilds every artifact in memory and compares it against the bytes on disk, naming
the exact file and the exact cells that differ:

```
npm run drift        # read-only; also runs as part of npm test
```

The comparison folds only the serialisation differences Draw.io was measured to introduce on an
innocent save — style key order, the omitted `connectable="1"` default, omitted zero-valued geometry
attributes, and the `<mxfile>`/`<mxGraphModel>` editor-state attributes. Everything else — every
`ahm*` attribute, every style value, parent, geometry number and waypoint — is compared.

## Regenerating the artifacts

```
node scripts/generate-artifacts.mjs      # native mxGraphModel + library, no browser needed
node visual/render-native.mjs --write    # Draw.io's own xmlsvg export + visual/native-*.png
```

The second step boots the same bundled Draw.io build the VS Code extension loads and calls Draw.io's
`{action:"export", format:"xmlsvg"}` handler, so the shipped SVG body is generated by Draw.io itself.
It writes the artifact first, then the PNG rendered from those exact bytes, then
`visual/native-report.json` last. The report records, per example, `artifactSha256`, `pngSha256` and
`modelDigest` (the canonical digest of the model that was rendered), and `npm test` recomputes all
three from disk — so a stale PNG or a hand-edited artifact fails on content, not on a timestamp.
`pngSha256` pins the PNG bytes that are *shipped*; it is not a claim that re-rendering reproduces
them. Chrome's PNG encoder is not byte-deterministic, so a regenerated PNG can differ in its bytes
while showing identical pixels — regenerating updates the report, and the report keeps the pair
consistent.

## Signals are a table inside the card

Each entity's signals render as a compact native table: a small state icon carrying a glyph
(`✓` healthy, `!` degraded, `×` unhealthy, `?` unknown) as well as the state colour, the
signal name, and the authored value right-aligned in its own column. Rows have no background and no
border of their own — a 1px hairline separates them, and the entity's state-tinted card is the only
card surface. Every part is a normal Draw.io cell, so a row, its icon, its label and its value all
stay selectable and editable, and the shape data (`ahmRole="signal"`, `ahmState`, `ahmResult`) is
unchanged.

Those four are the only signal states there are: `src/swimlane.mjs` accepts
`(healthy|degraded|unhealthy|unknown)` on a metric line, and `Standby` is an entity class rather
than a signal state. The generator rejects anything else at its public boundary instead of quietly
drawing it as Healthy, so a state can never reach the canvas with the wrong glyph.

Signal names are measured and wrapped into the label column, and the row grows to hold the extra
lines; a name too long for three lines is ellipsized. Either way the label can never reach the value
column or leave the card, and the exact authored string stays on the cell as `ahmLabel` (with
`ahmLabelClipped="1"` when the render had to shorten it), so nothing is lost to the containment.

## Connectors are routed by Draw.io, not by this repo

Dependencies are plain native connectors: `edgeStyle=orthogonalEdgeStyle` with standard fixed
connection points (`exitX`/`entryX`) and **no stored waypoints at all**. Labels are native
`edgeLabel` children with relative geometry. Drag an entity anywhere on the board and Draw.io
re-routes the connector and carries its label along — that behaviour is the point, and it is why the
generator deliberately owns no router.

The shipped examples start clean. That is bought entirely with placement and connection points, not
with a path: one row per lane, a per-column vertical stagger, card and lane heights quantised to a
16px grid so the built-in router's midpoints land 8px apart instead of coinciding, and a distinct
`exitX`/`entryX` per dependency. Every one of those survives a move, because none of them is a
route. `drawio/test/native-render.test.mjs` re-runs the generator with those levers ablated
(`laneStagger [0,0,0]`, `portMinGap 0`, `quantum 1`) and proves the same measurement fails, so the
8px floor is a property of the layout rather than of the example data.

The tradeoff is explicit: Draw.io's built-in orthogonal router has no obstacle avoidance, so **after
you rearrange things** it may send a connector across a card or let two connectors overlap. That is
accepted — drag a connector and Draw.io will store your waypoints for you if you want a specific
path. Nothing here claims the layout stays clean through arbitrary edits.

## Known limitations

- **Draw.io owns the `.drawio.svg` body.** The visible SVG in `examples/` is Draw.io's own `xmlsvg`
  export rather than a hand-authored drawing, because the extension replaces the whole file with that export on
  every save. Reopening and saving therefore reproduces the same canvas rather than a different one,
  but any body committed here is provisional: the next save rewrites it. The embedded model and all
  shape data (`ahmRole`, `ahmLocalState`, `ahmComputedState`, `ahmAuthoredState`, impact,
  aggregation) survive that rewrite untouched, and lane labels, the legend dot/bar row and the
  state-colored connectors are native cells, so they survive with it.
- **The embedded model is stored compressed.** Draw.io's embed export always deflates the
  `content="<mxfile…>"` payload, so the shipped `content=` is deflate+base64 exactly like a file
  saved from VS Code — it is not human-readable in a diff. The reopen boundary in
  `test/helpers/artifact.mjs` inflates it transparently and also accepts the plain form, and
  `node visual/render-native.mjs` prints the model measurements if you need to inspect it.
- **Connector paths are Draw.io's, and can change.** Because no waypoints are persisted, reopening
  or rearranging a diagram can produce a different path than the one in `visual/native-*.png`. Those
  PNGs record the shipped layout, not a guaranteed rendering.
- **Recalculation is live, and authored state is only preserved as authored.** Local states in the
  examples are hand-authored; the `ahmComputedState` each card ships is the plugin's own rollup of
  them, so opening a shipped example with the plugin installed recomputes nothing and changes
  nothing. **Recalculate**, or any local-state edit, recomputes the whole rollup from there. An
  entity authored `unknown` or `standby` keeps its Unknown/Standby presentation instead of turning
  green, but worse evidence still wins, and once you change a local state the authored look is gone.
- **Visual verification tooling is optional.** Opening the workspace, editing shapes, and running
  `AHM Health Model` actions only need VS Code and Node.js. Chrome and Puppeteer are additional,
  optional tools used solely by `drawio/visual/render-native.mjs` and `drawio/test/native-render.test.mjs`
  to render and measure the native canvas; they are not required for the normal VS Code editing
  workflow. Those scripts resolve a local macOS Chrome path and the locally installed Draw.io
  extension, and are not guaranteed to run unmodified on other setups. Running `npm test` inside
  `drawio/` also executes the native-render test alongside the plain unit tests, so `npm test` itself
  inherits that Chrome/Puppeteer prerequisite; ordinary VS Code editing does not.
