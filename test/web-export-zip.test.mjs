// web-export-zip.test.mjs — DOM-free Node tests for buildDiagramZip's entry-map/archive logic,
// using an injected stub rasterizer (never real Canvas/Blob) so the ZIP-building logic itself is
// verified with real bytes via fflate's own unzipSync. svgToPngBytes (the real Canvas rasterizer)
// is browser-only and covered by real-browser checks per the blueprint's Test strategy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strToU8 } from "fflate";
import { buildDiagramZip } from "../web/export-zip.mjs";
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

// A stub rasterizer that never touches Canvas/Blob: deterministic bytes derived from the
// requested dimensions, so tests can assert exactly what was requested/returned.
const stubRasterize = async (svg, w, h) => strToU8(`stub-png:${w}x${h}`);

test("buildDiagramZip: one .svg and one .png per health result, unsupported/error omitted, real ZIP bytes", async () => {
  const doc = [HEALTH_BLOCK, SEQUENCE_BLOCK, ZERO_NODE_HEALTH_SHAPED_BLOCK].join("\n");
  const results = convertMarkdown(doc);
  const { bytes, count, skipped } = await buildDiagramZip(results, { rasterize: stubRasterize });

  assert.equal(count, 1); // exactly one health-kind result in this fixture
  assert.equal(skipped, 2); // the unsupported + error results are omitted, not zero-byte entries

  const entries = unzipSync(bytes);
  const names = Object.keys(entries).sort();
  assert.deepEqual(names, ["checkout.png", "checkout.svg"]);
  assert.equal(Buffer.from(entries["checkout.svg"]).toString("utf8"), results[0].svg);
  assert.equal(Buffer.from(entries["checkout.png"]).toString("utf8"), `stub-png:${results[0].meta.w}x${results[0].meta.h}`);
});

test("buildDiagramZip: zero health-kind results signals nothing to export instead of an empty archive", async () => {
  const doc = [SEQUENCE_BLOCK, ZERO_NODE_HEALTH_SHAPED_BLOCK].join("\n");
  const results = convertMarkdown(doc);
  const outcome = await buildDiagramZip(results, { rasterize: stubRasterize });

  assert.equal(outcome.bytes, null);
  assert.equal(outcome.count, 0);
  assert.equal(outcome.skipped, 2);
});

test("buildDiagramZip: two health blocks sharing a heading get disambiguated, unique ZIP entry names (reusing extract.mjs's own slug scheme)", async () => {
  const oneHealthBlock = (label) => `## Checkout
\`\`\`mermaid
flowchart BT
    ${label}a["A"] --> ${label}b["B"]
    classDef green fill:#f2f8f2,stroke:#a0d8a0;
    class ${label}a,${label}b green;
\`\`\`
`;
  const doc = [oneHealthBlock("x"), oneHealthBlock("y")].join("\n");
  const results = convertMarkdown(doc);
  assert.deepEqual(results.map((r) => r.slug), ["checkout", "checkout-2"]); // extract.mjs's existing disambiguation

  const { bytes, count } = await buildDiagramZip(results, { rasterize: stubRasterize });
  assert.equal(count, 2);
  const names = Object.keys(unzipSync(bytes)).sort();
  assert.deepEqual(names, ["checkout-2.png", "checkout-2.svg", "checkout.png", "checkout.svg"]);
});

test("buildDiagramZip: rasterize is invoked with each health result's own SVG explicit width/height (never a default fallback size)", async () => {
  const results = convertMarkdown(HEALTH_BLOCK);
  const seen = [];
  const recordingRasterize = async (svg, w, h) => {
    seen.push({ w, h });
    return strToU8("x");
  };
  await buildDiagramZip(results, { rasterize: recordingRasterize });
  assert.deepEqual(seen, [{ w: results[0].meta.w, h: results[0].meta.h }]);
  assert.ok(Number.isInteger(seen[0].w) && seen[0].w > 0);
  assert.ok(Number.isInteger(seen[0].h) && seen[0].h > 0);
});
