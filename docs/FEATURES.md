# Feature reference

Every feature below is exercised by the automated test suite (`npm test`); the **Verified by**
notes name the test that pins the behavior. If a statement here stops being true, a test fails.

Quick links: [CLI](#command-line) · [Renderer selection](#renderer-selection) ·
[Per-block options](#per-block-options) · [Themes](#themes) ·
[Health-model swimlanes](#health-model-swimlanes) · [Signal rows](#signal-rows) ·
[Layout guarantees](#layout-guarantees) · [Plain mermaid](#plain-mermaid-blocks) ·
[Diagnostics](#diagnostics-reference) · [Exit codes](#exit-codes) ·
[Programmatic API](#programmatic-api) · [Legacy commands](#legacy-entry-points)

---

## Command line

```
npx ahm-diagrammo <file.md> [more.md ...] [options]

  -o, --out <dir>        output directory                    (default: ./diagrams)
  -t, --theme <name>     portal | midnight | candy | slate   (default: portal)
  -r, --renderer <name>  auto | swimlane | mermaid           (default: auto)
  -l, --list             list detected blocks and options, render nothing
  -v, --verbose          log every parsed node/edge/fold decision
      --strict           any warning fails the run (exit 1)
      --no-gallery       don't write gallery.html
  -h, --help             this help
  -V, --version          print version
```

Each run writes one `<slug>.svg` per mermaid block, a `manifest.json` (slug, file, source,
fence line, renderer, theme, title, node/lane counts, dimensions), and a `gallery.html` that
shows every diagram with its title, renderer, and theme. Multiple input files aggregate into one
output directory and one manifest, and slugs stay unique **across files** (a duplicate becomes
`-2`, `-3`, … instead of overwriting). Options that take a value fail fast with
`option -o requires a value` when it's missing. Progress goes to **stdout**; warnings and errors
go to **stderr**, prefixed with `file:line`.

`--list` is a dry run — it prints what each block would become and writes nothing:

```
examples/showcase.md: 6 mermaid blocks
  examples/showcase.md:11  health-model-zero-config  →  swimlane · portal
  examples/showcase.md:35  fence-info-options-…      →  swimlane · midnight  (theme="midnight")
  examples/showcase.md:56  order-pipeline-health     →  swimlane · candy  (title="Order pipeline health" …)
  examples/showcase.md:114 any-other-mermaid-…       →  mermaid · portal
```

*Verified by:* `cli.test.mjs` — "renders a healthy file", "--list explains detection without
writing files", "--no-gallery skips gallery.html", "multiple files aggregate into one manifest",
"duplicate slugs across input files get distinct output names", "bad CLI arguments fail fast".

## Renderer selection

Per block, in this order:

1. Block option `renderer:` (any of the three channels below), else
2. CLI `-r/--renderer`, else
3. **auto**: a block is a *health model* — and gets the swimlane renderer — when it is a
   `flowchart BT` (or `graph BT`) **and** binds at least one `class … blue|green|amber|red|purple`.
   Everything else (sequence, state, ER, class, non-BT or unclassed flowcharts) goes through
   mermaid-cli with the same theme.

*Verified by:* `swimlane.test.mjs` — "looksLikeHealthModel detects health flowcharts only";
`docs.test.mjs` — "showcase.md demonstrates every option channel".

## Per-block options

Three channels, all invisible to GitHub's and VS Code's mermaid preview. Later channels win:
**fence info < frontmatter < `%%|` directives**.

**1. Fence info string** — extra tokens after the language. GitHub only reads the first word:

````markdown
```mermaid midnight
```mermaid swimlane theme=candy title="Checkout"
````

Bare tokens match a renderer or theme name; `key=value` sets any option, and quoted values may
contain spaces (`title="Checkout flow"`, single or double quotes; an unterminated quote warns).
Unknown bare tokens are warned about and ignored.

**2. YAML frontmatter** — mermaid understands the block natively (`title:` even shows in
previews); diagrammo reads the `diagrammo:` key and strips *only that key* before handing the
block to mermaid-cli, so native keys like `config:` pass through:

````markdown
```mermaid
---
title: Order pipeline health
diagrammo:
  theme: candy
  lanes: [Storefront, Order flows, Services]
  subtitle: Live measurements from the collectors.
---
flowchart BT
  ...
```
````

**3. `%%|` directive comments** — mermaid treats `%%` lines as comments; one `key: value` each:

````markdown
```mermaid
%%| theme: slate
%%| legend: false
```
````

| Key | Type | Effect |
|-----|------|--------|
| `renderer` | `auto` \| `swimlane` \| `mermaid` | force the renderer for this block |
| `theme` | theme name | theme for this block |
| `title` | string | figure title (default: nearest Markdown heading) |
| `subtitle` | string | line under the title (swimlane only; set `""` to hide) |
| `lanes` | list | custom swimlane labels, top to bottom |
| `legend` | boolean | `false` hides the legend (swimlane only) |
| `name` | string | output file name (default: slug of title/heading; duplicates get `-2`, `-3`, …) |
| `background` | color | canvas background (mermaid renderer only) |

Unknown keys warn (listing the valid ones); unknown `renderer`/`theme` values are **errors** that
fail the block with its fence line; a non-list `lanes` warns and is ignored. Values parse as
YAML-ish scalars: quotes, numbers, `true/false/on/off/yes/no`, `[inline, lists]`.

Fences follow CommonMark closing rules: the closing fence must use the opener's character and
be at least as long, so a ` ``` ` line inside a `~~~mermaid` block stays part of the block.

*Verified by:* `extract.test.mjs` — option merge/precedence, line numbers, unknown-key/value
issues, quoted fence values, unterminated-quote warning, fence-closing rules,
`stripDiagrammoKey`, yamlite scalars/nesting/lists, `~~~` fences, duplicate slugs, unclosed
fences; `docs.test.mjs` — all three channels live in `examples/showcase.md`.

## Themes

Four built-in themes, shared by both renderers so a whole document matches:
**`portal`** (Azure portal light, default), **`midnight`** (dark), **`candy`** (warm pastel),
**`slate`** (cool gray-blue). A theme defines background/band/ink/muted colors, the five state
palettes (healthy, degraded, unhealthy, unknown-dashed, standby), pill colors, metric-bar colors,
and the mermaid `themeVariables` used for non-health blocks.

*Verified by:* `swimlane.test.mjs` — "pill flood stays clean in every theme" renders the hardest
fixture in all four; `mermaid.test.mjs` — themed sequence diagram.

## Health-model swimlanes

The mermaid dialect the swimlane renderer understands:

| Construct | Syntax |
|-----------|--------|
| node | `id["Line 1<br/>Line 2"]` (`<div>` wrappers stripped, `<br/>` splits lines) |
| solid edge | `a --> b` |
| labeled edge | `a -->\|label\| b` or `a -- "label" --> b` |
| dashed (propagation) edge | `a -. label .-> b` (label optional) |
| state classes | `classDef` + `class n1,n2 green` — `blue`=signal, `green`=Healthy, `amber`=Degraded, `red`=Unhealthy, `purple`=Standby; unclassed nodes render Unknown (dashed border) |

Node labels: the first line is the entity **name**; a line in parentheses (or matching
worst-of/active-active/region wording) becomes the small **qualifier** under the name; bare state
words (`healthy`, `degraded`, …) are display hints and are removed; anything else joins the
qualifier. Entity icons are picked from name keywords (web, api, database, queue, cache, shield,
…, falling back to a cube).

Lanes come from the longest path to the root: 1–3 lanes get the standard labels (Workload root /
Business & user flows / Application components), deeper models add Dependencies, Subsystems,
`Layer n` — or set your own with `lanes:`. Edge visuals: unlabeled solid edges between adjacent
lanes bundle tightly under their parent; labeled and dashed edges route individually with the
label in a pill; connectors take the **child's** state color so a tolerated failure stays
traceable under a green parent.

Graph oddities never crash a render, they warn and degrade gracefully: cycles (layering breaks
them arbitrarily), self-loops (not drawn), same-lane edges (routed over the lane), downward
edges (drawn bottom-up), signal nodes with no entity target (drawn as their own card).

*Verified by:* `swimlane.test.mjs` — parse/fold tests, "torture-weird" (single node, two-node,
cycles, self-loop, orphan signals), geometry over every fixture; `docs.test.mjs`.

## Signal rows

A `blue` (signal) node folds **into** the entity it points to as a status table — one row per
`<br/>`-separated label line. Each row can carry an explicit measurement and its own state:

```text
apiSig["P95 latency = 230 ms (degraded)<br/>Error rate = 0.4%<br/>Requests = 1.2k/s"] --> api[...]
```

- `name = value` → the value shows right-aligned as the row's Result.
- `(healthy|degraded|unhealthy|unknown)` suffix → that row's status dot and result color.
- Rows without an explicit value get a deterministic placeholder derived from the row name.
- If no row is marked and the entity is degraded/unhealthy, the first row inherits that state.
- A signal pointing at several entities folds into each of them.

*Verified by:* `swimlane.test.mjs` — "foldSignals: explicit results and states survive";
`docs.test.mjs` — "showcase measurement syntax lands in the output".

## Layout guarantees

Enforced by the geometric verifier (`test/helpers/geo.mjs`) over the renderer's emitted geometry
model, on every stress fixture:

1. Cards never overlap each other, never leave their lane band or the canvas.
2. Connectors never pass through a card's interior — lane-skipping edges ride corridors between
   cards of intermediate lanes.
3. No two horizontal or vertical connector segments of different edges are ever collinear.
4. Label pills never overlap other pills, cards, or any other edge's connector; long labels wrap
   to two lines.
5. Text never leaves the canvas or its container (card, pill). Long names wrap, then the card
   widens (to 480px); only past that is text ellipsized — and then it keeps the full text as an
   SVG `<title>` tooltip *and* emits a warning.
6. The SVG contains no `NaN`/`Infinity`, is well-formed, and rendering is deterministic
   (same input → byte-identical output).

Density costs height, not legibility: channels between lanes grow rows to fit their edges.

*Verified by:* `swimlane.test.mjs` — every `geometry:` test, "torture-text: long content wraps
instead of vanishing", "rendering is deterministic"; `layout.test.mjs` — projection separations,
track disjointness, corridor picking.

## Plain mermaid blocks

Non-health blocks render through mermaid-cli (`mmdc`) with the block's theme mapped onto
mermaid's `themeVariables`, and `classDef blue/green/amber/red/purple` remapped to the theme's
state palette. Output is Learn-safe: `htmlLabels:false`, native `<text>` only, no
`foreignObject`. Cards get rounded corners and a soft shadow. `mmdc` is resolved from the
package, the project, the PATH, or fetched once via `npx` (pinned to 11.16.0 for reproducibility); Chrome is found via
`PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, or common install locations. Failures retry 3× and
then surface the underlying mmdc error.

*Verified by:* `mermaid.test.mjs` — themed sequence diagram without `foreignObject`, failure
surfaces "mmdc failed after 3 attempts" (suite auto-skips without Chrome).

## Diagnostics reference

Format: `level  file:line  message` (+ an indented `↳ hint` where useful). `info` lines appear
only with `--verbose`.

| Level | Message (trigger) |
|-------|-------------------|
| error | `unknown theme "x" (themes: …)` / `unknown renderer "x" (…)` — block fails, others continue |
| FAIL | `no nodes parsed — N unrecognized line(s), first at line L` — block produced nothing usable |
| warn | `unrecognized line: "…"` + hint (edge-syntax hint when the line contains an arrow) |
| warn | `flowchart direction "LR" — the swimlane renderer draws bottom-up (BT)…` |
| warn | `ignored "subgraph" statement (not supported by the swimlane renderer)` — also style, linkStyle, click, direction, accTitle/accDescr |
| warn | `class "x" is not a health class — nodes keep state "unknown" (known: …)` |
| warn | `unknown option "x" (known: renderer, theme, …)` / `"lanes" should be a list …` |
| warn | `fence token "x" is neither a renderer nor a theme — ignored` |
| warn | `malformed directive "%%\| …" — expected "%%\| key: value"` |
| warn | `unterminated " quote in fence options` |
| warn | `mermaid fence is never closed (\`\`\` missing)…` |
| warn | `cycle detected — the roll-up hierarchy is ambiguous…` / `self-loop on "x" is not drawn` |
| warn | `edge a → b connects nodes in the same lane…` / `…points downward (child sits above its parent)…` |
| warn | `signal node "x" has no outgoing edge to an entity — drawn as its own card` |
| warn | `entity name / qualifier / signal row / edge label "…" clipped (full text kept as tooltip)` |
| warn | `label pill "…" could not fully avoid crossing connectors` (last-resort; the fixtures never trigger it) |
| info | `edge a → b \|label\|`, `node x "Label"`, `folded signal "s" (3 rows) into e`, `graph: N nodes, M edges, L lanes` |

*Verified by:* `swimlane.test.mjs` parse-diagnostic tests; `extract.test.mjs` issue tests;
`cli.test.mjs` — "broken blocks fail with file:line and per-line parse warnings".

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | every block rendered (warnings allowed unless `--strict`) |
| 1 | any block failed, any input file unreadable, bad CLI arguments, no input file — or any warning under `--strict` |

*Verified by:* `cli.test.mjs` — "--strict turns warnings into a failing run", "bad CLI arguments
fail fast".

## Programmatic API

```js
import {
  extractBlocks, renderSwimlane, renderMermaid, looksLikeHealthModel,
  getTheme, THEMES, THEME_NAMES, galleryHtml, Diagnostics,
  parseGraph, foldSignals, layout, textWidth, wrapText,
} from "ahm-diagrammo";

const blocks = extractBlocks(markdown, THEME_NAMES); // [{slug, heading, code, options, line, issues}]
const diag = new Diagnostics({ file: "doc.md" });
const { svg, W, H, nodes, lanes, debug } = renderSwimlane(blocks[0].code, {
  theme: "candy", title: "My model", lanes: ["Root", "Services"], diag, baseLine: blocks[0].codeLine - 1,
});
// debug = { cards, pills, segs, texts, lanes } — the geometry model the test verifier consumes
```

*Verified by:* the entire suite imports through these entry points.

## Legacy entry points

The original commands are deprecated shims: they print a deprecation note on stderr and forward
to the CLI, so old workflows keep producing the same files in the same places:

```bash
node swimlane-auto.mjs <article.md> <outDir>   # → diagrammo <md> -o <outDir> -r swimlane --no-gallery
node convert.mjs <article.md> <outDir>         # → diagrammo <md> -o <outDir> -r mermaid --no-gallery
```

*Verified by:* `cli.test.mjs` — "legacy wrappers forward to the CLI with a deprecation note".

## Golden files

Rendering is deterministic, so `test/golden/` holds the exact SVG output for every swimlane
block of the example documents and stress fixtures. `npm test` byte-compares against them; after
an intended visual change, `npm run goldens` regenerates them and the git diff shows exactly
what moved.

*Verified by:* `golden.test.mjs` — one test per pinned diagram; `swimlane.test.mjs` —
"rendering is deterministic".
