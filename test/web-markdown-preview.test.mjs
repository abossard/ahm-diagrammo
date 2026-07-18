// web-markdown-preview.test.mjs — pure-logic tests for the two Node-safe helpers in
// web/markdown-preview.mjs: the nonce-tagged marked pass (renderMarkdownSlots) and the ordered
// slot -> outcome mapping (mapSlotsToOutcomes). Both run identically in Node and browser and never
// call DOMPurify.sanitize — the browser-only sanitize-then-DOM-node-replace orchestrator
// (renderMarkdownPreview) is exercised only by real-browser checks (see blueprint Test strategy).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { renderMarkdownSlots, mapSlotsToOutcomes, secureNonce } from "../web/markdown-preview.mjs";
import { convertMarkdown } from "../web/convert.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHOWCASE = readFileSync(join(ROOT, "examples", "showcase.md"), "utf8");

// Node 18 ESM exposes no Web Crypto global, so web/markdown-preview.mjs's default secureNonce()
// (globalThis.crypto.randomUUID) cannot run here. Inject a fresh, genuinely unpredictable nonce per
// call — backed by Node's own crypto.randomUUID — mirroring the browser's secure default without
// making the browser module import node:crypto. Freshness per call is what keeps the anti-forgery
// test below meaningful (each render mints a distinct, unguessable nonce).
const freshNonce = () => randomUUID();

// Reused verbatim from test/web-convert.test.mjs rather than inventing new fixtures.
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

// A non-mermaid fenced code block, to prove the renderer override only claims mermaid fences.
const JS_BLOCK = `## Snippet
\`\`\`js
const x = 1;
\`\`\`
`;

test("secureNonce: delegates to the injected Web Crypto's randomUUID, and fails loud (never a weak fallback) when secure Web Crypto is unavailable", () => {
  // Happy path: the browser default reads globalThis.crypto; here we inject the crypto source so the
  // assertion is deterministic and version-independent (Node 18 ESM has no Web Crypto global at all).
  assert.equal(secureNonce({ randomUUID: () => "11111111-1111-4111-8111-111111111111" }), "11111111-1111-4111-8111-111111111111");
  // Production-default failure: a missing or incomplete Web Crypto must throw explicitly rather than
  // silently mint a predictable nonce. Proven by injecting the source (no global state mutated).
  // `null`/`{}` are used instead of `undefined` because passing `undefined` would re-trigger the
  // `globalThis.crypto` default parameter (present on Node 20+, browsers), masking the guard.
  assert.throws(() => secureNonce(null), /secure Web Crypto/);
  assert.throws(() => secureNonce({}), /secure Web Crypto/);
  assert.throws(() => secureNonce({ randomUUID: "not-a-function" }), /secure Web Crypto/);
});

test("renderMarkdownSlots: plain Markdown (heading, list, emphasis, inline code, link, table) survives the pure marked pass", () => {
  const doc = [
    "# Title",
    "",
    "- one",
    "- two",
    "",
    "**bold** and \`inline code\` and a [link](https://example.com).",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
  ].join("\n");
  const { html } = renderMarkdownSlots(doc, freshNonce);
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<li>two<\/li>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>inline code<\/code>/);
  assert.match(html, /<a href="https:\/\/example\.com">link<\/a>/);
  assert.match(html, /<table>/);
});

test("renderMarkdownSlots: a non-mermaid fenced code block falls back to marked's default renderer, untouched", () => {
  const { html, slotCount } = renderMarkdownSlots(JS_BLOCK, freshNonce);
  assert.equal(slotCount, 0);
  assert.match(html, /<pre><code class="language-js">/);
  assert.doesNotMatch(html, /data-ahm-slot/);
});

test("renderMarkdownSlots: every mermaid fence in examples/showcase.md gets one ordered nonce-tagged slot, matching convertMarkdown's own count", () => {
  const results = convertMarkdown(SHOWCASE);
  const { html, nonce, slotCount } = renderMarkdownSlots(SHOWCASE, freshNonce);
  assert.equal(slotCount, results.length);
  // slots appear in the html in ascending ordinal order (document order)
  const ids = [...html.matchAll(/data-ahm-slot="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, results.map((_, i) => `${nonce}-${i}`));
});

test("mapSlotsToOutcomes: maps showcase.md's slots to convertMarkdown's own per-block outcome, in order", () => {
  const results = convertMarkdown(SHOWCASE);
  const { nonce, slotCount } = renderMarkdownSlots(SHOWCASE, freshNonce);
  const slots = mapSlotsToOutcomes({ nonce, slotCount }, results);
  assert.deepEqual(slots.map((s) => s.outcome.kind), results.map((r) => r.kind));
  assert.deepEqual(slots.map((s) => s.slotId), results.map((_, i) => `${nonce}-${i}`));
  // every health outcome carries the trusted SVG string from convertMarkdown, verbatim
  slots.forEach((s, i) => {
    if (s.outcome.kind === "health") assert.equal(s.outcome.svg, results[i].svg);
  });
});

test("mapSlotsToOutcomes: a document mixing health/unsupported/error fences classifies each slot independently, in source order", () => {
  const doc = [HEALTH_BLOCK, SEQUENCE_BLOCK, ZERO_NODE_HEALTH_SHAPED_BLOCK].join("\n");
  const results = convertMarkdown(doc);
  const { nonce, slotCount } = renderMarkdownSlots(doc, freshNonce);
  const slots = mapSlotsToOutcomes({ nonce, slotCount }, results);
  assert.deepEqual(slots.map((s) => s.outcome.kind), ["health", "unsupported", "error"]);
  assert.match(slots[0].outcome.svg, /^<svg[\s>]/);
  assert.match(slots[1].outcome.message, /not a recognized health model/);
  assert.match(slots[2].outcome.message, /no nodes parsed.*unrecognized line/s);
});

test("renderMarkdownSlots: a raw-HTML fragment forging a previous call's exact nonce-tagged placeholder cannot desync the next call's own slot count", () => {
  const { html: html1, nonce: nonce1 } = renderMarkdownSlots(HEALTH_BLOCK, freshNonce);
  const forgedPlaceholder = html1.match(/<div data-ahm-slot="[^"]+"><\/div>/)[0];
  assert.match(forgedPlaceholder, new RegExp(`^<div data-ahm-slot="${nonce1}-0"></div>$`));

  // A new render call, whose source is literally the prior call's placeholder markup (raw HTML)
  // followed by one real health fence.
  const doc2 = `${forgedPlaceholder}\n\n${HEALTH_BLOCK}`;
  const { html: html2, nonce: nonce2, slotCount: slotCount2 } = renderMarkdownSlots(doc2, freshNonce);

  assert.notEqual(nonce2, nonce1, "each render call must mint a fresh nonce");
  assert.equal(slotCount2, 1, "only the one real fence is counted; the forged placeholder is not a fence");
  // The forged text survives as inert raw HTML (proving the attack surface is real)...
  assert.match(html2, new RegExp(`data-ahm-slot="${nonce1}-0"`));
  // ...but a nonce-prefix match for the *new* call's own nonce excludes it and equals slotCount.
  const currentNonceIds = [...html2.matchAll(new RegExp(`data-ahm-slot="${nonce2}-\\d+"`, "g"))];
  assert.equal(currentNonceIds.length, slotCount2);
});

test("mapSlotsToOutcomes: a slotCount/results-length mismatch degrades gracefully to an 'unavailable' descriptor per slot, never throws", () => {
  const results = convertMarkdown(HEALTH_BLOCK); // 1 result
  const mismatched = mapSlotsToOutcomes({ nonce: "test-nonce", slotCount: 3 }, results);
  assert.equal(mismatched.length, 3);
  for (const s of mismatched) assert.equal(s.outcome.kind, "unavailable");
  assert.deepEqual(mismatched.map((s) => s.slotId), ["test-nonce-0", "test-nonce-1", "test-nonce-2"]);
});

test("renderMarkdownSlots: fence-info variants ('mermaid midnight', 'mermaid slate') are still recognized as mermaid slots", () => {
  const doc = "```mermaid midnight\nflowchart BT\n  a --> b\n```\n";
  const { slotCount, html } = renderMarkdownSlots(doc, freshNonce);
  assert.equal(slotCount, 1);
  assert.match(html, /data-ahm-slot/);
});
