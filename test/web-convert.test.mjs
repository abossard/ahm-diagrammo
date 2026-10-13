// web-convert.test.mjs — pure-logic tests for the browser editor's block classification glue.
// Runs identically in Node (no DOM dependency) since web/convert.mjs only calls the existing
// src/*.mjs exports; it never reimplements parsing/rendering/theming.
import { test } from "node:test";
import assert from "node:assert/strict";
import { convertMarkdown } from "../web/convert.mjs";

const HEALTH_BLOCK = `## Checkout
\`\`\`mermaid
flowchart BT
    webSig["Availability"] --> web["Web frontend<br/>healthy"]
    web --> root["Workload root<br/>healthy"]
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    classDef blue fill:#eff6fc,stroke:#0078D4;
    class webSig blue;
    class web,root green;
\`\`\`
`;

const SEQUENCE_BLOCK = `## Order flow
\`\`\`mermaid
sequenceDiagram
    participant U as User
    U->>W: Place order
\`\`\`
`;

const ZERO_NODE_HEALTH_SHAPED_BLOCK = `## Broken
\`\`\`mermaid
flowchart BT
total --- garbage === here
class foo green;
\`\`\`
`;

// A lane wide enough (10 leaves sharing one root) to stress a real browser-editor health-model
// layout.
const WIDE_LEAF_LIST = Array.from({ length: 10 }, (_, i) => `leaf${i + 1}`);
const wideBlockLines = (fenceInfo = "") => [
  "## Wide",
  `\`\`\`mermaid${fenceInfo}`,
  "flowchart BT",
  ...WIDE_LEAF_LIST.map((id, i) => `${id}["Leaf service number ${i + 1}<br/>healthy"] --> root["Workload root<br/>healthy"]`),
  "classDef green fill:#f2f8f2,stroke:#a0d8a0;",
  `class ${WIDE_LEAF_LIST.join(",")},root green;`,
  "```",
  "",
];
const WIDE_BLOCK = wideBlockLines().join("\n");

test("convertMarkdown: a recognized health-model block renders an SVG via renderSwimlane", () => {
  const [result] = convertMarkdown(HEALTH_BLOCK);
  assert.equal(result.kind, "health");
  assert.match(result.svg, /^<svg[\s>]/);
  assert.equal(result.meta.nodes, 2); // webSig folds into web as a signal row, not a standalone node
  assert.equal(Object.hasOwn(result, "animation"), false);
  assert.doesNotMatch(result.svg, /data-ahm-(?:entity|signal|edge|edge-label|qualifier|logic|part|route-segment|route-members|port)=/);
});

test("convertMarkdown: a non-health-model block is reported as unsupported, not rendered or thrown", () => {
  const [result] = convertMarkdown(SEQUENCE_BLOCK);
  assert.equal(result.kind, "unsupported");
  assert.equal(result.svg, undefined);
  assert.equal(result.animation, undefined);
  assert.match(result.message, /not a recognized health model/);
});

test("convertMarkdown: a zero-node health-shaped block surfaces renderSwimlane's own thrown message", () => {
  const [result] = convertMarkdown(ZERO_NODE_HEALTH_SHAPED_BLOCK);
  assert.equal(result.kind, "error");
  assert.equal(result.animation, undefined);
  // same message shape asserted by test/swimlane.test.mjs's "zero-node block throws a useful error"
  assert.match(result.message, /no nodes parsed.*unrecognized line/s);
});

test("convertMarkdown: a document mixing all three kinds classifies each block independently, in source order", () => {
  const doc = [HEALTH_BLOCK, SEQUENCE_BLOCK, ZERO_NODE_HEALTH_SHAPED_BLOCK].join("\n");
  const results = convertMarkdown(doc);
  assert.deepEqual(results.map((r) => r.kind), ["health", "unsupported", "error"]);
});

test("convertMarkdown: a wide health-model block still renders as a health result with stable metadata", () => {
  const [byDefault] = convertMarkdown(WIDE_BLOCK);
  assert.equal(byDefault.kind, "health");
  assert.ok(byDefault.meta.nodes > 1, "expected multiple nodes");
  assert.ok(byDefault.meta.w > 0 && byDefault.meta.h > 0, "expected non-empty output size");
  const [again] = convertMarkdown(WIDE_BLOCK);
  assert.deepEqual(again.meta, byDefault.meta, "metadata must be deterministic");
  assert.equal(again.svg, byDefault.svg, "rendering must be deterministic");
});

// ---- laneLabels: default-on shown text, fence-info override removes it (C22) -------------------

const WIDE_BLOCK_NO_LABELS = wideBlockLines(" laneLabels=false").join("\n");
const ANIMATION_HOOK = /data-ahm-(?:entity|signal|edge|edge-label|qualifier|logic|part|route-segment|route-members|port)=/;

test("convertMarkdown: laneLabels=false threads through the browser converter and removes the lane-label text from the emitted SVG", () => {
  // "Application components" (this fixture's second default lane label, for its leaf lane) is
  // used rather than "Workload root" because the latter is ALSO this fixture's root card's own
  // literal name — laneLabels=false must leave a card's own name untouched, so asserting on it
  // here would be ambiguous. No leaf entity is named "Application components".
  const [byDefault] = convertMarkdown(WIDE_BLOCK);
  assert.equal(byDefault.kind, "health");
  assert.match(byDefault.svg, />Application/, "default (labels shown) must include the lane-label text");

  const [labelsOff] = convertMarkdown(WIDE_BLOCK_NO_LABELS);
  assert.equal(labelsOff.kind, "health");
  assert.doesNotMatch(labelsOff.svg, />Application/, "laneLabels=false must remove the lane-label text from the browser converter's emitted SVG");
  assert.equal(labelsOff.meta.nodes, byDefault.meta.nodes, "node count must stay unchanged");
});

const THEME_FIELD_CASES = [
  ["default theme", HEALTH_BLOCK, {}, "portal"],
  ["convert option theme override", HEALTH_BLOCK, { theme: "midnight" }, "midnight"],
  ["fence info theme", HEALTH_BLOCK.replace("```mermaid", "```mermaid theme=candy"), { theme: "portal" }, "candy"],
  ["frontmatter theme", HEALTH_BLOCK.replace("flowchart BT", "---\ndiagrammo:\n  theme: slate\n---\nflowchart BT"), { theme: "portal" }, "slate"],
  ["directive theme", HEALTH_BLOCK.replace("flowchart BT", "%%| theme: candy\nflowchart BT"), { theme: "portal" }, "candy"],
];

for (const [name, markdown, options, expectedTheme] of THEME_FIELD_CASES) {
  test(`convertMarkdown: health outcome keeps theme field for ${name}`, () => {
    const [result] = convertMarkdown(markdown, options);
    assert.equal(result.kind, "health");
    assert.equal(result.theme, expectedTheme);
  });
}

const LEGACY_INTERACTIVE_INPUTS = new Map([
  ["absent", HEALTH_BLOCK],
  ["fence false", HEALTH_BLOCK.replace("```mermaid", "```mermaid interactive=false")],
  ["fence true", HEALTH_BLOCK.replace("```mermaid", "```mermaid interactive=true")],
  ["fence wrong-type", HEALTH_BLOCK.replace("```mermaid", "```mermaid interactive=\"true\"")],
  ["frontmatter false", HEALTH_BLOCK.replace("flowchart BT", "---\ndiagrammo:\n  interactive: false\n---\nflowchart BT")],
  ["frontmatter true", HEALTH_BLOCK.replace("flowchart BT", "---\ndiagrammo:\n  interactive: true\n---\nflowchart BT")],
  ["frontmatter wrong-type", HEALTH_BLOCK.replace("flowchart BT", "---\ndiagrammo:\n  interactive: \"true\"\n---\nflowchart BT")],
  ["directive false", HEALTH_BLOCK.replace("flowchart BT", "%%| interactive: false\nflowchart BT")],
  ["directive true", HEALTH_BLOCK.replace("flowchart BT", "%%| interactive: true\nflowchart BT")],
  ["directive wrong-type", HEALTH_BLOCK.replace("flowchart BT", "%%| interactive: \"true\"\nflowchart BT")],
]);

for (const [name, markdown] of LEGACY_INTERACTIVE_INPUTS) {
  test(`convertMarkdown: former interactive input ${name} stays static and deterministic`, () => {
    const [baseline] = convertMarkdown(HEALTH_BLOCK);
    const [result] = convertMarkdown(markdown);
    assert.equal(result.kind, "health");
    assert.equal(result.svg, baseline.svg);
    assert.deepEqual(result.meta, baseline.meta);
    assert.equal(Object.hasOwn(result, "animation"), false);
    assert.doesNotMatch(result.svg, ANIMATION_HOOK);
  });
}
