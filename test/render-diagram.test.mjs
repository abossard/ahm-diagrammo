// The single entry point: resolveRenderer() picks the look, renderDiagram() dispatches to it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forgetTextWidths } from "pele";
import { renderDiagram, resolveRenderer } from "../src/render.mjs";
import { Diagnostics } from "../src/diag.mjs";

const HEALTH = [
  "flowchart BT",
  '    sig["Latency = 42 ms (degraded)<br/>Errors = 0.1% (healthy)"] --> api["API<br/>degraded"]',
  '    api --> root["Root<br/>degraded"]',
  "    classDef blue fill:#eff6fc,stroke:#0078D4;",
  "    classDef amber fill:#fbf2e7,stroke:#db7500;",
  "    class sig blue;",
  "    class api,root amber;",
].join("\n");
const SEQUENCE = "sequenceDiagram\n  A->>B: hello";

const RESOLUTION = [
  { requested: undefined, code: HEALTH, expected: "swimlane" },
  { requested: "auto", code: HEALTH, expected: "swimlane" },
  { requested: "AUTO", code: SEQUENCE, expected: "mermaid" },
  { requested: "swimlane", code: HEALTH, expected: "swimlane" },
  { requested: "swimlane", code: SEQUENCE, expected: "swimlane" },
  { requested: "pele", code: HEALTH, expected: "pele" },
  { requested: "pele", code: SEQUENCE, expected: "mermaid" },
  { requested: "mermaid", code: HEALTH, expected: "mermaid" },
  { requested: "mermaid", code: SEQUENCE, expected: "mermaid" },
];
for (const { requested, code, expected } of RESOLUTION) {
  test(`resolveRenderer(${requested}, ${code === HEALTH ? "health model" : "sequence"}) → ${expected}`, () => {
    assert.equal(resolveRenderer(requested, code), expected);
  });
}

const RENDERS = [
  { renderer: "auto", code: HEALTH, expected: "swimlane", marker: /<svg\b[^>]*font-family="Segoe UI/ },
  { renderer: "pele", code: HEALTH, expected: "pele", marker: /class="pele pele-flowchart ahm-root"/ },
  { renderer: "mermaid", code: HEALTH, expected: "mermaid", marker: /class="pele pele-flowchart"/ },
  { renderer: "auto", code: SEQUENCE, expected: "mermaid", marker: /class="pele pele-sequence"/ },
];
for (const { renderer, code, expected, marker } of RENDERS) {
  test(`renderDiagram renderer=${renderer} renders ${expected} static SVG`, () => {
    const r = renderDiagram(code, { renderer, theme: "slate" });
    assert.equal(r.renderer, expected);
    assert.match(r.svg, marker);
    assert.ok(r.width > 0 && r.height > 0, `${r.width}x${r.height}`);
    assert.doesNotMatch(r.svg, /foreignObject|var\(--/);
    assert.match(r.svg, /Latency|hello/);
  });
}

test("renderDiagram pele accepts CLI block source and keeps preview-only colors out of its diagnostics", () => {
  const block = `---\ntitle: Checkout\ndiagrammo:\n  renderer: pele\n---\n%%| legend: false\n${HEALTH}`;
  const diag = new Diagnostics();
  const r = renderDiagram(block, { renderer: "pele", theme: "portal", legend: false, diag });
  assert.equal(r.renderer, "pele");
  assert.doesNotMatch(r.svg, /ahm-legend/);
  assert.deepEqual(diag.warnings, []);
  assert.deepEqual(diag.errors, []);
});

test("renderDiagram rejects an unknown renderer with the valid choices", () => {
  assert.throws(() => renderDiagram(HEALTH, { renderer: "pixels" }), /unknown renderer "pixels" \(use auto, swimlane, pele, mermaid\)/);
});

// Pele measures text on a canvas (the host's installed fonts) whenever a canvas global exists.
// Every renderer must measure with its own metrics instead, so poisoned canvas globals stay untouched.
for (const { renderer, code } of [
  { renderer: "swimlane", code: HEALTH },
  { renderer: "pele", code: HEALTH },
  { renderer: "mermaid", code: HEALTH },
  { renderer: "mermaid", code: SEQUENCE },
]) {
  test(`renderDiagram renderer=${renderer} never measures text with host fonts (${code === HEALTH ? "health model" : "sequence"})`, () => {
    const touched = [];
    const saved = { OffscreenCanvas: globalThis.OffscreenCanvas, document: globalThis.document };
    globalThis.OffscreenCanvas = class { constructor() { touched.push("OffscreenCanvas"); } };
    globalThis.document = {
      createElement: () => { touched.push("document.createElement"); },
      fonts: { size: 0, check: () => { touched.push("document.fonts"); return true; } },
    };
    forgetTextWidths();
    try {
      renderDiagram(code, { renderer, theme: "portal" });
    } finally {
      globalThis.OffscreenCanvas = saved.OffscreenCanvas;
      globalThis.document = saved.document;
      forgetTextWidths();
    }
    assert.deepEqual(touched, []);
  });
}
