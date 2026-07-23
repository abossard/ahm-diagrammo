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

// A lane wide enough (10 leaves sharing one root) to exceed the 1024 default without any
// maxWidth token — the same real-world shape as the browser editor's own health-model examples.
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
const WIDE_BLOCK_OVERRIDE = wideBlockLines(" maxWidth=1400").join("\n");

test("convertMarkdown: a recognized health-model block renders an SVG via renderSwimlane", () => {
  const [result] = convertMarkdown(HEALTH_BLOCK);
  assert.equal(result.kind, "health");
  assert.match(result.svg, /^<svg[\s>]/);
  assert.equal(result.meta.nodes, 2); // webSig folds into web as a signal row, not a standalone node
});

test("convertMarkdown: a non-health-model block is reported as unsupported, not rendered or thrown", () => {
  const [result] = convertMarkdown(SEQUENCE_BLOCK);
  assert.equal(result.kind, "unsupported");
  assert.equal(result.svg, undefined);
  assert.match(result.message, /not a recognized health model/);
});

test("convertMarkdown: a zero-node health-shaped block surfaces renderSwimlane's own thrown message", () => {
  const [result] = convertMarkdown(ZERO_NODE_HEALTH_SHAPED_BLOCK);
  assert.equal(result.kind, "error");
  // same message shape asserted by test/swimlane.test.mjs's "zero-node block throws a useful error"
  assert.match(result.message, /no nodes parsed.*unrecognized line/s);
});

test("convertMarkdown: a document mixing all three kinds classifies each block independently, in source order", () => {
  const doc = [HEALTH_BLOCK, SEQUENCE_BLOCK, ZERO_NODE_HEALTH_SHAPED_BLOCK].join("\n");
  const results = convertMarkdown(doc);
  assert.deepEqual(results.map((r) => r.kind), ["health", "unsupported", "error"]);
});

// ---- maxWidth: default-bounded rendering, per-block override, no new browser UI control -------

test("convertMarkdown: a wide block with no maxWidth token renders bounded to the 1024 default; a fence-info override threads through and changes the outcome", () => {
  const [byDefault] = convertMarkdown(WIDE_BLOCK);
  assert.equal(byDefault.kind, "health");
  assert.ok(byDefault.meta.w <= 1024, `expected the default bound, got ${byDefault.meta.w}`);

  const [overridden] = convertMarkdown(WIDE_BLOCK_OVERRIDE);
  assert.equal(overridden.kind, "health");
  assert.ok(overridden.meta.w <= 1400, `expected the 1400 override bound, got ${overridden.meta.w}`);
  assert.notEqual(overridden.meta.w, byDefault.meta.w, "an accepted override must change the outcome, not be silently ignored");
});

// ---- laneLabels: default-on shown text, fence-info override removes it (C22) -------------------

const WIDE_BLOCK_NO_LABELS = wideBlockLines(" laneLabels=false").join("\n");

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
