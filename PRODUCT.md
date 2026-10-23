# Product

## Register

product

## Users

Engineers and technical writers maintaining Azure health-model documentation. They work directly with Markdown and Mermaid and need static SVG for publishing targets such as Microsoft Learn, which do not render Mermaid.

## Product Purpose

ahm-diagrammo turns Mermaid blocks in Markdown into consistent, readable, static SVG through one entry point (`bin/diagrammo.mjs`, or `renderDiagram()` for library callers):

- health models render in the swimlane look (default) or the Pele AHM look (`renderer: pele`) from the same source
- every other Mermaid diagram renders through Pele in the same theme
- `--sync-markdown` keeps each SVG and its hidden Mermaid source together, with Learn image directives on request
- the Pele AHM look is also a package API (`renderAhm()`): caller supplies source and semantic states, signal rows render as in-card Signal/Value/State tables, row state colors stay independent from entity state

## Design Principles

- One entry point; the renderer is a per-block or per-run choice, not a separate tool
- Explicit diagnostics instead of silent drops
- Deterministic outputs for identical inputs and options
- Static, Learn-safe SVG: native text, concrete colors, no browser at render time

## Out of Scope

Browser editor, Python/Azure ingestion tutorials, draw.io and VS Code extension surfaces, npm publishing automation.
