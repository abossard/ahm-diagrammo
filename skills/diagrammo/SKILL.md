---
name: diagrammo
description: Inspect and render Mermaid blocks in Markdown as themed SVG output with the packaged ahm-diagrammo CLI.
---

# Diagrammo

Use the packaged CLI. Do not reimplement parsing, renderer selection, layout, theming, or SVG generation.

1. Confirm the requested Markdown input and output directory. If the input is missing or invalid, stop and report the problem instead of guessing.
2. Inspect before render when appropriate, especially for unfamiliar input or when the user asks what will be generated:
   `npx --yes ahm-diagrammo "$INPUT" --list`
3. Render into an explicit output directory:
   `npx --yes ahm-diagrammo "$INPUT" --out "$OUTPUT" --strict`
4. Verify the command exited successfully. Parse `$OUTPUT/manifest.json`, confirm every listed `.svg` exists and is non-empty, and report the emitted files. Also confirm `gallery.html` when gallery generation is enabled.

Preserve the user's Markdown. Surface CLI diagnostics and non-zero exits rather than masking
them. `--sync-markdown` is the sole, explicit opt-in exception: only invoke it when the user asks
to check in an editable-source-plus-rendered-SVG Markdown file, never as a default action. Its
first generated SVG filename is stable for that managed block's lifetime — do not hand-edit its
`<!-- diagrammo:sync ... -->` markers; renaming a heading or a fence's `title=`/`name=` later is
safe and never renames the file. The Mermaid source itself lives fully hidden (not merely
collapsed) inside a `<!-- diagrammo:source ... -->` comment, with every literal `-->` escaped to
`--&gt;`. Editing it directly is safe — write real, unescaped Mermaid (a raw `-->` is fine); the
next `--sync-markdown` run decodes, re-renders, and re-escapes it. Never hand-type the literal
`--&gt;` token into a fence — the CLI rejects a fence that already contains it, since decoding
would then be ambiguous.

## Per-diagram directives

Author-controlled options live inside the fence as `%%| key: value` lines (also settable via
fence-info `key=value` or a `diagrammo:` frontmatter block). Common keys: `theme`, `title`,
`subtitle`, `lanes`, `legend`, `alt`, and `laneLabels`.

To make a wide swimlane narrower, set `%%| laneLabels: false`. It hides the right-hand lane-label
text and reclaims that gutter — nothing else moves: node placement, edge routing, edge state
colors, lane bands, and SVG height are all unchanged. There is no width-wrapping/`maxWidth` knob;
narrowing is achieved only by reclaiming the label gutter, never by wrapping lanes onto extra rows.
`laneLabels` defaults to `true` (labels shown); a non-boolean value warns and falls back to `true`.
