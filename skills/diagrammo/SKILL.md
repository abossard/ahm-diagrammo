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

Preserve the user's Markdown. Surface CLI diagnostics and non-zero exits rather than masking them.
