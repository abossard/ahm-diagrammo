// Plain mermaid path (Pele) — every non-health diagram, rendered in Node with static colors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMermaid } from "../src/mermaid.mjs";
import { THEMES, THEME_NAMES } from "../src/themes.mjs";

const DIAGRAMS = {
  sequence: "sequenceDiagram\n  A->>B: hello\n  B-->>A: world",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Busy: start",
  er: "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
  class: "classDiagram\n  class Order {\n    +submit()\n  }\n  Order <|-- RushOrder",
  pie: 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85',
  gantt: "gantt\n  title Plan\n  dateFormat YYYY-MM-DD\n  section Build\n  Code :a1, 2024-01-01, 10d",
  flowchart: "flowchart LR\n  subgraph G[Group]\n    a[hello] --> b{world}\n  end",
};

for (const [type, code] of Object.entries(DIAGRAMS)) {
  for (const themeName of THEME_NAMES) {
    test(`renderMermaid: ${type} in ${themeName} is static, variable-free and Learn-safe`, () => {
      const { svg, width, height } = renderMermaid(code, { theme: themeName });
      assert.match(svg, /^<svg\b/);
      assert.ok(width > 0 && height > 0, `${width}x${height}`);
      assert.match(svg, /<text/);
      assert.doesNotMatch(svg, /var\(--|--_|--pele-/, "every CSS variable must be resolved");
      assert.doesNotMatch(svg, /<(foreignObject|style|script|image)\b/i);
      assert.ok(svg.includes(THEMES[themeName].ink), "theme ink must be applied");
    });
  }
}

test("renderMermaid remaps the health classDefs onto the theme's state palette", () => {
  const code = "flowchart LR\n  a --> b\n  classDef green fill:#000000,stroke:#000000;\n  class a green;";
  for (const themeName of THEME_NAMES) {
    const { svg } = renderMermaid(code, { theme: themeName });
    const healthy = THEMES[themeName].state.healthy;
    assert.match(svg, new RegExp(`fill:${healthy.fill};stroke:${healthy.border}`), themeName);
    assert.doesNotMatch(svg, /#000000/, themeName);
  }
});

test("renderMermaid drops diagrammo directives and the diagrammo frontmatter key, keeps mermaid's title", () => {
  const code = "---\ntitle: Kept title\ndiagrammo:\n  theme: slate\n---\nflowchart LR\n%%| legend: false\n  a --> b";
  const { svg } = renderMermaid(code, { theme: "portal" });
  assert.match(svg, />Kept title</);
  assert.doesNotMatch(svg, /legend: false|diagrammo/);
});

const BACKGROUNDS = [
  { name: "midnight paints its own background", opts: { theme: "midnight" }, fill: THEMES.midnight.bg },
  { name: "light themes stay transparent", opts: { theme: "portal" }, fill: null },
  { name: "background option wins", opts: { theme: "portal", background: "#fafafa" }, fill: "#fafafa" },
  { name: "background option is attribute-escaped", opts: { theme: "portal", background: 'red"/><script>' }, fill: "red&#34;/&#62;&#60;script&#62;" },
];
for (const { name, opts, fill } of BACKGROUNDS) {
  test(`renderMermaid background: ${name}`, () => {
    const { svg } = renderMermaid(DIAGRAMS.sequence, opts);
    const rect = svg.match(/^<svg\b[^>]*><rect width="100%" height="100%" fill="([^"]*)"\/>/);
    assert.equal(rect?.[1] ?? null, fill);
  });
}

test("renderMermaid surfaces Pele failures with the underlying reason", () => {
  assert.throws(
    () => renderMermaid("thisIsNotAMermaidDiagramType\n  at all", { theme: "portal" }),
    /^Error: pele failed: No diagram type detected/
  );
});
