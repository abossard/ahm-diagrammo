# ahm-diagrammo

Turn the mermaid blocks in a Markdown file into good-looking SVGs — with one command:

```bash
npx ahm-diagrammo your-doc.md
```

**[Open the browser editor](https://abossard.github.io/ahm-diagrammo/)** to edit Markdown,
preview every diagram, and download the rendered SVGs and PNGs without installing anything.

Its specialty is **Azure Monitor health models**: Mermaid `flowchart BT` health models become
SVGs that look like the Azure portal health graph, render as `<img>` on Microsoft Learn (native
`<text>`, no `foreignObject`), and scale without blurring. Every other mermaid block in the
file — sequence, state, ER, plain flowcharts — is rendered too, through mermaid-cli with the
same theme, so a whole document stays visually consistent.

## Why not just vanilla mermaid?

The exact same mermaid block, rendered by vanilla mermaid and by diagrammo:

| Vanilla mermaid | `npx ahm-diagrammo` |
|---|---|
| ![Vanilla mermaid rendering](screenshots/compare-vanilla.png) | ![diagrammo rendering](screenshots/compare-diagrammo.png) |

Same source, but diagrammo understands what the diagram *means*:

- **Signals fold into their entity** as a status table with per-row status dots, metric icons,
  and right-aligned results — instead of floating as separate boxes with `=` signs in prose.
- **States become the visual language**: Azure-portal state colors, status pills on every card,
  a legend, and connectors colored by the child's state so a failing dependency stays traceable.
- **Swimlanes** (Workload root / flows / components) replace an unlabeled scatter, and each
  entity gets an icon matched from its name.
- **Labels sit in collision-free pills** on their own routing tracks; the layout engine
  guarantees nothing overlaps or gets truncated, no matter how dense the model gets.
- **Title, subtitle, and theme** come from the block's own tags — nothing configured anywhere else.

<details>
<summary>The shared mermaid source of both renderings</summary>

```mermaid
flowchart BT
    apiSig["P95 latency = 230 ms (degraded)<br/>Error rate = 0.4%<br/>Requests = 1.2k/s"] --> api["Order API<br/>degraded"]
    qSig["Queue depth = 18<br/>Oldest message = 4 s"] --> queue["Order queue<br/>healthy"]
    paySig["Auth failures = 7% (unhealthy)<br/>Settlement lag = 12 min (degraded)"] --> pay["Payment service<br/>unhealthy"]

    api --> orders["Order intake<br/>degraded"]
    queue --> orders
    pay -. "limited<br/>propagation" .-> orders
    orders --> root["Storefront<br/>(worstOf)<br/>degraded"]

    classDef blue fill:#eff6fc,stroke:#0078D4;
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef amber fill:#fbf2e7,stroke:#db7500;
    classDef red fill:#faeceb,stroke:#ba0d16;
    class apiSig,qSig,paySig blue;
    class queue green;
    class api,orders,root amber;
    class pay red;
```

</details>

## Examples

Signals live **inside** each entity as a status table (status dot, name, metric icon, result). Health
rolls up through business flows to the workload root. Relationship labels render as pills.

![Hero](screenshots/hero.png)

### Kitchen sink: one figure, every feature

Healthy, Degraded, Unhealthy, Unknown, and Standby states. Multi-row signal tables. Dashed propagation
edges. Qualifiers like worstOf and active-active. Long names, straight and elbow connectors.

![Kitchen sink](screenshots/kitchen-sink.png)

### Pills stress test: labels that never collide

Many labeled edges converge on one parent, and one child feeds several parents. Each pill anchors on its
child's vertical drop, and the router levels edges by horizontal span. No pill overlaps another, no line
crosses another, and every pill belongs to one relationship.

![Pills stress test](svg/pills-stress.svg)

### More examples

| | |
|---|---|
| Circuit breaker (limited propagation, unhealthy) | Multi-region (worst-of, tolerated failure) |
| ![Circuit breaker](screenshots/circuit-breaker.png) | ![Multi-region](screenshots/multi-region.png) |
| Portfolio (nested models, discovered) | Architecture diagram (declarative) |
| ![Portfolio](screenshots/portfolio.png) | ![Architecture](screenshots/architecture.png) |

All 22 service-guide diagrams: [screenshots/gallery.png](screenshots/gallery.png).

## Usage

```bash
npx ahm-diagrammo doc.md                       # everything into ./diagrams + gallery.html
npx ahm-diagrammo doc.md -o out -t midnight    # pick an output dir and a default theme
npx ahm-diagrammo doc.md --list                # show what each block would render as
npx ahm-diagrammo doc.md --verbose             # log every parsed node/edge/fold decision
npx ahm-diagrammo doc.md --strict              # any warning fails the run (CI-friendly)
```

The command walks the file, and for each ` ```mermaid ` block:

- a **health model** (`flowchart BT` whose classes bind to `blue/green/amber/red/purple`) becomes a
  portal-style **swimlane** figure — pure code, no browser needed;
- **anything else** is rendered through mermaid-cli in the same theme (this path needs Chrome/Chromium;
  it finds one via `PUPPETEER_EXECUTABLE_PATH`, `CHROME_PATH`, or the usual install locations).

Each run writes the SVGs, a `manifest.json`, and a `gallery.html` you can open to browse everything at
once. Try the [browser editor](https://abossard.github.io/ahm-diagrammo/) or run
`npx ahm-diagrammo examples/showcase.md -o out-showcase`.

## Agent plugin

The repository exposes one shared `diagrammo` skill to GitHub Copilot CLI and Claude Code. Copilot can
install it directly:

```bash
copilot plugin install abossard/ahm-diagrammo
```

Or add this repository as a marketplace and install the same plugin:

```bash
copilot plugin marketplace add abossard/ahm-diagrammo
copilot plugin install ahm-diagrammo@ahm-diagrammo
```

In Claude Code, run `/plugin marketplace add abossard/ahm-diagrammo`, then
`/plugin install ahm-diagrammo@ahm-diagrammo`. Invoke `/ahm-diagrammo:diagrammo` for a rendering task.
In Copilot CLI, `/skills list` confirms discovery; ask Copilot to use the `diagrammo` skill. Both hosts
load [`skills/diagrammo/SKILL.md`](skills/diagrammo/SKILL.md).

## How it works

ahm-diagrammo reads the Markdown file, extracts every mermaid block, merges each block's options,
picks a renderer, and writes the SVGs. The figure below is that pipeline, drawn by ahm-diagrammo from
its own health model in [docs/how-it-works.md](docs/how-it-works.md):

![How ahm-diagrammo renders one Markdown file](docs/assets/how-it-works-pipeline.svg)

Regenerate it from the source:

```bash
npx ahm-diagrammo docs/how-it-works.md -o docs/assets
```

Read it bottom-up: a Markdown file enters at the bottom and the output bundle rolls up at the top.
Signal tables show where options, runtime requirements, render stages, and output artifacts enter
the pipeline. The
[lane-by-lane reference](docs/how-it-works.md) maps each stage to its code and test.

## Tags & YAML: per-block options

Every block can override the CLI defaults, three ways — all invisible to GitHub's and VS Code's
mermaid preview:

**1. The fence line.** GitHub only reads the first word of the info string, so extra tokens are free:

````markdown
```mermaid midnight
flowchart BT
  ...
```
````

**2. `%%|` directive comments.** Mermaid treats `%%` lines as comments:

````markdown
```mermaid
%%| theme: candy
%%| title: Order pipeline
%%| legend: false
flowchart BT
  ...
```
````

**3. YAML frontmatter.** Mermaid understands the frontmatter block natively (`title:` even shows up
in previews); diagrammo reads the `diagrammo:` key:

````markdown
```mermaid
---
title: Order pipeline health
diagrammo:
  theme: slate
  lanes: [Storefront, Order flows, Services]
  subtitle: Live measurements from the collectors.
---
flowchart BT
  ...
```
````

| Key | What it does |
|-----|--------------|
| `renderer` | `auto` (default), `swimlane`, or `mermaid` |
| `theme` | `portal` (default), `midnight`, `candy`, `slate` |
| `title` / `subtitle` | figure header text (title defaults to the nearest Markdown heading) |
| `lanes` | custom swimlane labels, top to bottom: `[Root, Flows, Services]` |
| `legend` | `false` hides the legend |
| `name` | output file name (defaults to a slug of the title/heading) |
| `background` | canvas background color (mermaid renderer only) |

Signal rows can carry a real measurement and their own state, straight in the mermaid label:

```text
apiSig["P95 latency = 230 ms (degraded)<br/>Error rate = 0.4%"] --> api[...]
```

Rows without an explicit value get a deterministic placeholder derived from the row name.

The complete feature reference — every CLI flag, option key, theme, diagnostic message, and
layout guarantee, each mapped to the test that verifies it — is in
[docs/FEATURES.md](docs/FEATURES.md).

## Diagnostics: compiler-grade parse logging

Every line of every block is classified. Anything the parser can't place produces a warning with
the **absolute file line** and a hint; blocks that can't render at all fail with a reason:

```text
  FAIL doc.md:5  checkout-model: no nodes parsed — 3 unrecognized line(s), first at line 7
       warn  doc.md:7   unrecognized line: "this is not === valid mermaid at all"
             ↳ expected a node (id[Label]), an edge, class/classDef, or a comment
       warn  doc.md:9   unrecognized line: "---> dangling arrow"
             ↳ looks like an edge — supported forms: A --> B, A -->|label| B, A -- "label" --> B, ...
```

Warnings cover: unknown themes/renderers/option keys (each with the valid values), malformed
`%%|` directives, non-BT flowchart directions, unknown `class` names, ignored `subgraph`/`style`
statements, cycles and self-loops, same-lane or downward edges, orphan signal nodes, unclosed
fences, and any text that had to be clipped (which always keeps the full text as an SVG tooltip).
`--verbose` additionally logs every parsed edge, node, signal fold, and the graph summary.
`--strict` turns warnings into a failing exit code. Progress goes to stdout, diagnostics to stderr.

## Layout guarantees

The swimlane engine is a Sugiyama-style layered renderer with hard no-overlap rules, each
enforced by geometric tests:

- **Everything is measured.** Text widths come from per-glyph advance tables measured once in
  headless Chrome against the real font stack (`scripts/measure-font.mjs` regenerates them), so
  cards, pills, lane gutters, and the legend size to their content. Long names wrap (cards grow
  to a cap) before anything is ever ellipsized; the rare clip keeps a tooltip and warns.
- **Cards can't overlap.** Per-lane coordinates come from constrained 1-D projection
  (cluster-merge): nodes sit at the mean of their neighbors subject to minimum separations.
- **Connectors can't cross cards.** Lane-skipping edges ride corridors — the verified gaps
  between cards of the lanes they pass through.
- **Horizontal runs can't collide.** Each channel between lanes reserves interval-colored
  tracks for labeled/dashed/skipping edges and for the per-parent buses; the channel grows to
  fit its rows, so density costs height, never legibility.
- **Pills stay readable.** Label pills wrap to two lines when long, sit on rows nearest their
  child (where crossing connectors are sparse), get repaired onto a different row when the
  assignment pins them under a connector, and finally slide along their own line to a
  verified-clear spot.

`npm test` runs the suite: unit tests for the layout algorithms, parse-diagnostic tests, CLI
end-to-end tests (real process spawns, exit codes, log format), a mermaid-cli smoke test (skipped
without Chrome), a geometric verifier that renders stress fixtures (lane-skipping meshes, a
16-pill flood, 14-row tables, unicode extremes, cycles) and asserts that no card, pill,
connector, or text box overlaps, escapes its container, or leaves the canvas — and golden-file
tests: rendering is deterministic, so the committed SVGs under `test/golden/` pin the exact
output, and any visual change shows up as a reviewable diff (`npm run goldens` after intended
changes).

### Publishing

CI runs `npm ci` and the complete suite on Node 18, 22, and 24, then packs the package and executes
both CLI aliases from the tarball. Publishing is triggered only by a GitHub Release tagged exactly
`v<package.json version>`; the release workflow repeats those checks before publishing publicly to
npm with provenance.

For the first publication, create a temporary granular npm token that can publish the new public
package and save it as the `NPM_TOKEN` Actions secret. After that succeeds, open the package's
**Trusted Publisher** settings on npm, select GitHub Actions, and set the owner to `abossard`, the
repository to `ahm-diagrammo`, and the workflow filename to `release.yml`. No GitHub environment is
used. Then remove the Actions secret and revoke the bootstrap token; subsequent releases
authenticate through GitHub OIDC.

## What's inside

| Tool | What it does |
|------|--------------|
| `bin/diagrammo.mjs` | The `npx ahm-diagrammo` CLI: extracts blocks, picks a renderer per block, applies themes and per-block options, writes SVGs + manifest + gallery. |
| `src/swimlane.mjs` | The swimlane engine. Parses `flowchart BT` into a graph, folds signals into their entity as a status table, layers the graph into swimlanes, and renders portal-styled SVG with roll-up connectors and pill labels. |
| `src/mermaid.mjs` | Themed Mermaid via mermaid-cli for everything else. Keeps the original node shapes, applies the theme palette, polishes corners and shadows. |
| `src/themes.mjs` | The four themes, shared by both renderers. |
| `src/layout.mjs` | The pure layout algorithms: constrained 1-D projection, interval-colored track assignment, corridor picking. |
| `src/text.mjs` | Browser-free text measurement and wrapping, backed by the generated `src/font-metrics.mjs` (regenerate with `scripts/measure-font.mjs`). |
| `src/diag.mjs` | Structured diagnostics with file:line attribution. |
| `src/extract.mjs` | Markdown fence extraction plus the three option channels (fence info, `%%\|` directives, frontmatter), with option validation. |
| `test/` | The suite: layout unit tests, parse-diagnostic tests, CLI e2e tests, and the geometric overlap verifier run against the stress fixtures in `test/fixtures/`. |
| `swimlane-auto.mjs`, `convert.mjs` | Deprecated shims — they print a note and forward to the CLI so old workflows keep working. |
| `arch/` | Declarative Azure architecture-diagram engine: containers, orthogonal routing, pluggable icons. |
| `ingest-demo/` | An `az monitor health-models` deploy plus `ingest-health-report` recipe. Force live states, then screenshot the real portal. |
| `examples/showcase.md` | One file exercising every feature — render it and open the gallery. |
| `EVALUATION.md` | The options analysis: Mermaid theme, draw.io, portal CSS, screenshots, layered. |

The reference set of generated SVGs lives under [`svg/`](svg/).

## Design notes

- **Learn-safe SVG.** Set `htmlLabels:false` everywhere, so labels become native `<text>`/`<tspan>` and
  render inside `<img>`. Never `<foreignObject>`.
- **Portal palette** from the health-models portal source: Healthy `#a0d8a0`, Degraded `#db7500`,
  Unhealthy `#ba0d16`, Unknown `#c8c6c4`, signal and azure `#0078d4`.
- **Signals sit in the entity**, not beside it. The generator folds each signal into an attached
  4-column table.
- **Roll-up connectors take the child's state color.** A tolerated failure (active-active, worst-of)
  keeps the parent green while the failing child's own line stays red.
- **Pills anchor at the child's vertical drop** and level by horizontal span, so they never overlap and
  always sit on one line.
- **Zero install weight for the common path.** The package has no runtime dependencies; the swimlane
  renderer is pure Node. Only non-health blocks need mermaid-cli, which is resolved from your project,
  your PATH, or fetched once via npx.
- Render preview PNGs with headless Chrome, not librsvg. librsvg drops leading `<tspan>` spaces.

## Icons and licensing

The health-model generators draw only original, in-code glyphs. No external icon assets.

The architecture engine (`arch/`) takes pluggable icons and can use the official Microsoft Azure
architecture icons once you drop them into `arch/icons/`. This repo does not carry those icons; the
checked-in architecture SVG uses the original fallback glyphs instead. See `arch/icons/README.md`.

## License

MIT (see `LICENSE`). Diagrams generated by these tools carry no third-party icon assets.
