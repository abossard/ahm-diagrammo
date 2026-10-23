# Examples

Runnable examples. Paths are relative to the repository root; from an installed package, prefix
them with `node_modules/ahm-diagrammo/`.

| Example | What it shows |
|---------|---------------|
| [sync-markdown/](sync-markdown/) | A Markdown file already run through `--sync-markdown`: a visible SVG plus the hidden, still-editable Mermaid source |
| [source-to-svg.mjs](source-to-svg.mjs) with [hero-source.mmd](hero-source.mmd) | The library call `renderAhm` on a plain `.mmd` file |
| [render-nested-views.mjs](render-nested-views.mjs) with [nested-source.mmd](nested-source.mmd) and [nested-metadata.json](nested-metadata.json) | Pele nested model views: expanded, collapsed and detail |
| [nested-source-stress.mmd](nested-source-stress.mmd), [nested-source-ancestor-stress.mmd](nested-source-ancestor-stress.mmd) | Nested sources that `expanded` and `detail` reject with named diagnostics |

Render a Markdown file in both looks (the CLI):

```bash
node bin/diagrammo.mjs hero.md -o out/swimlane
```

```bash
node bin/diagrammo.mjs hero.md -o out/pele -r pele
```

Render a plain Mermaid file with the library:

```bash
node examples/source-to-svg.mjs examples/hero-source.mmd out/hero.svg
```

Render the three nested model views:

```bash
node examples/render-nested-views.mjs examples/nested-source.mmd examples/nested-metadata.json out/nested
```

Resync the Markdown example after editing its hidden source (from `examples/sync-markdown/`):

```bash
node ../../bin/diagrammo.mjs README.md -o assets --sync-markdown
```

For every feature rendered in both looks, see the [gallery](../docs/gallery/README.md).
