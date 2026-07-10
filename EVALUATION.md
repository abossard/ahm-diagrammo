# Health model diagrams: options to produce true SVGs

How to turn the placeholder Mermaid diagrams in `azure-monitor-health-models.md` (22 `flowchart BT` blocks today) into publication-ready SVGs that look like the Azure portal health graph. This evaluates every option, recommends a pipeline, and links the working examples.

## Why this is needed

- Microsoft Learn (Markdig) does not render Mermaid fenced blocks. Learn needs PNG or SVG.
- The article already carries a reviewer note that the Mermaid blocks are placeholders to be replaced with real images.
- Established repo practice: keep each Mermaid block for GitHub review, tag it with `<!-- TODO: [VISUAL] Export this Mermaid diagram to PNG/SVG for Microsoft Learn publication -->`, and swap in the image before publication.

## Two target looks

1. **Portal health-graph cards** (recommended default). Matches the real product: rounded cards, an icon header, a status footer, and a state-colored border. This is what the health models Graph blade draws.
2. **WAF layered architecture style** (the attached reference image). Swimlanes for App name, Business and user flows, Application components, and Platform resources, with Azure service icons and colored flow lines. Useful when the diagram is more about architecture than live health.

The article's diagrams are health roll-ups (signals to components to flows to a root), so the portal card look is the natural fit. The same pipeline can output the layered look by swapping the theme.

## The options

### A. Portal-themed Mermaid to SVG (recommended, scalable)
Reuse the existing Mermaid, remap the placeholder `classDef` colors to the exact portal palette, and render each block to SVG with `mermaid-cli` (`mmdc`).

- Strengths: the 22 `flowchart BT` diagrams already exist, so one theme converts all of them. Output is true SVG with native `<text>`, which renders inside `<img>` on Learn. One command reruns the whole set.
- Limits: Mermaid nodes are rounded rectangles. You get the palette, the rounded corners, and a soft shadow, but not the icon header or status footer without post-processing.
- Example output: `out/*.svg` (all 22), preview `shots/img-chrome.png`.

### B. Draw.io theme and shape library
Author a draw.io library whose shape styles carry the portal palette and Azure icons, then export SVG.

- Strengths: pixel control, real Azure icons, and human-editable `.drawio` XML for later edits.
- Limits: manual authoring per diagram. Converting 22 diagrams by hand is slow, and there is no draw.io CLI on this machine, so export is a manual desktop step.
- Best for: one or two hero diagrams that need hand tuning.

### C. Programmatic SVG from the portal CSS (highest fidelity)
Render portal-structured node markup with the exact node CSS from the portal source, then capture it. This reproduces the card down to the icon header, the status footer with a state dot, the `color-mix` fill, and the box-shadow.

- Strengths: near-identical to the portal card. Data-driven, so it scales if wired to a layout step.
- Limits: needs a layout pass for edges and node positions to fully replace Mermaid. As shown it produces a raster screenshot. For true SVG, hand-author the same structure as native SVG shapes.
- Example output: `theme/hero.html`, screenshot `shots/hero-portal-card.png`.

### C2. Swimlane technical figure (native SVG, documentation-grade)
`swimlane-auto.mjs` parses each Mermaid block and generates a native SVG laid out in horizontal swimlanes: workload root, business and user flows, application components, and signals. Nodes are layered automatically by their distance to the root, with signal nodes pinned to the bottom lane and columns ordered by barycenter to reduce edge crossings. Each entity has an icon and a status footer, signals show their metrics, edges are colored by the child health state, dashed propagation edges carry their labels, and a legend explains the states.

- Strengths: true SVG with native text (renders inside `<img>` on Learn), the layered layout matches how health rolls up, it reads like professional technical documentation, and it runs across every diagram in one command.
- Limits: middle-lane names use the canonical health-model vocabulary (flows, components), which is a close but not perfect fit for every model.
- Example output: `out-swimlane/*.svg` (staged in the repo under `_images/azure-monitor-health-models/swimlane/`), contact sheet `shots/gallery-swim.png`.

### D. Real portal screenshots via `az monitor health-models` plus health reports
Deploy a real health model, push manual health reports to force Degraded and Unhealthy, then screenshot the live Graph blade.

- Strengths: authentic, authoritative, and exactly what the reviewer note anticipates. The forced states let you capture any scenario on demand.
- Limits: output is PNG raster, not SVG. Needs an Azure subscription, RBAC to create `Microsoft.CloudHealth/healthmodels`, and a CloudHealth region such as `swedencentral`. Forced states expire, so screenshot inside the window.
- Example: `ingest-demo/deploy.sh` and `ingest-demo/ingest.sh` (both runnable in `DRY_RUN=1`).

## Decision matrix

| Option | True SVG | Portal fidelity | Effort for all diagrams | Rerun cost | Learn-safe | Best role |
|--------|:-------:|:---------------:|:-----------------:|:----------:|:----------:|-----------|
| A Mermaid theme | Yes | Good | Low (one command) | Very low | Yes | Default for all diagrams |
| B Draw.io | Yes | High | High (manual) | High | Yes | Hand-tuned hero |
| C Portal CSS | With extra work | Very high | Medium | Low | Yes as PNG, yes as SVG if hand-authored | Hero and covers |
| D Portal screenshots | No (PNG) | Exact | Medium (per scenario) | Medium | Yes as PNG | Authentic reference shots |
| E WAF layered style | Yes | N/A (different look) | Low (theme swap in A) | Very low | Yes | Architecture-first diagrams |

## Recommendation

- **Convert every diagram with option A.** It is the only path that turns all 22 `flowchart BT` blocks into true SVG from a single source with one command, and the output renders correctly on Learn.
- **Use option C for a hero image** at the top of the article, where the full portal card with icon and status footer adds the most value.
- **Use option D to capture authentic reference screenshots** when you want the real product, for example a Degraded roll-up. The health-report step is the "send reports to make it degraded" flow.
- **Keep option B in reserve** for a diagram that needs hand editing.

## The portal theme (source of truth)

Colors from `AHM-CloudHealth-Portal/src/Extension/Client/ReactViews/Styles/variables.module.scss`:

| State | Border | Highlight | SVG fill (tint on white) |
|-------|--------|-----------|--------------------------|
| Healthy | `#a0d8a0` | `#baf61a` | `#f4faf4` |
| Degraded | `#db7500` | `#ffb307` | `#fbf1e6` |
| Unhealthy | `#ba0d16` | `#ff3e1a` | `#faecec` |
| Unknown | `#C8C6C4` | `#a0a0a0` | `#f6f6f5` (dashed border) |
| Signal input | `#0078D4` (Azure blue) | | `#eff6fc` |

Geometry from `Styles/_graph-view-blade.scss`: card width 200px, border radius 12px, 2px state border, fill `color-mix(state 8 to 12%, control background)`, header with a 28px icon and a label, a footer with a top border and the status, and a soft drop shadow. Edges take the source node state color at 2px, dashed for Unknown.

## How to run option A

```bash
cd health-model-diagrams
npm install                     # pulls mermaid-cli
node convert.mjs \
  ../../well-architected/service-guides/azure-monitor-health-models.md \
  out                           # writes out/<slug>.svg for every diagram
```

`mermaid-config.json` carries the portal `themeVariables` and sets `htmlLabels:false` so labels are native SVG text. `convert.mjs` remaps the `classDef` colors, drops the `<div>` label wrappers, and post-processes each SVG to add rounded corners and a drop shadow. `puppeteer-config.json` points `mmdc` at the installed Chrome.

## Embedding in the article

Put the SVGs under the WAF convention and reference them with the `:::image:::` extension:

```markdown
:::image type="content" source="./_images/azure-monitor-health-models/diagram.svg" alt-text="Health model roll-up from signals to components to the workload root, with the logistics branch degraded." lightbox="./_images/azure-monitor-health-models/diagram.svg":::
```

Keep the Mermaid block above the image with its `<!-- TODO: [VISUAL] -->` marker so GitHub reviewers still see the diagram and the source stays editable. Learn shows the SVG, GitHub shows the Mermaid.

## Gotchas learned

- **Do not use `htmlLabels:true`.** It puts labels in `<foreignObject>` HTML, which does not render when the SVG is embedded as `<img>` on Learn, and librsvg cannot rasterize it either. Native SVG text is portable.
- **Do not preview with `rsvg-convert`.** librsvg strips leading whitespace inside adjacent `<tspan>` runs, so multi-word labels look joined. The same SVG renders correctly in Chrome and on Learn. Use headless Chrome for PNG fallbacks.
- **CloudHealth is region-limited.** Deploy option D models in a supported region such as `swedencentral`.
- **The root entity must be named the same as the model.** The resource provider manages a built-in root by that name.

## Files in this toolkit

- `convert.mjs`, `mermaid-config.json`, `puppeteer-config.json`: option A pipeline.
- `out/`: the 22 generated SVGs (also copied into the repo `_images/azure-monitor-health-models/`).
- `theme/hero.html`: option C portal-fidelity card mock.
- `ingest-demo/deploy.sh`, `ingest-demo/ingest.sh`: option D deploy and health-report recipe.
- `shots/`: rendered previews and the hero screenshot.
