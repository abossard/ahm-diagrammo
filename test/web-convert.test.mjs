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
