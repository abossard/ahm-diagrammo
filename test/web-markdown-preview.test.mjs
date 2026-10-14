import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { renderMarkdownSlots, mapSlotsToOutcomes, secureNonce } from "../web/markdown-preview.mjs";
import { convertMarkdown } from "../web/convert.mjs";
import { syncMarkdown, escapeCommentTerminator } from "../src/markdown-sync.mjs";

const health = '## Health\n```mermaid midnight\nflowchart BT\nchild["Child"] --> root["Root"]\nclass child,root green;\n```\n';
const unsupported = "## Sequence\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n";
const broken = "## Broken\n```mermaid\nflowchart BT\nunrecognized text\nclass foo green;\n```\n";
const managed = syncMarkdown(health, [{ slug: "stable", openLine: 2, closeLine: 6, title: "Health", href: "old.svg" }]);
const freshNonce = () => randomUUID();

test("secureNonce: requires secure Web Crypto, never a predictable fallback", () => {
  assert.equal(secureNonce({ randomUUID: () => "secure" }), "secure");
  for (const input of [null, {}, { randomUUID: "not-a-function" }]) assert.throws(() => secureNonce(input), /secure Web Crypto/);
});

test("renderMarkdownSlots: keeps full prose and non-Mermaid code", () => {
  const source = "# Title\n\n- one\n- two\n\n**bold** and `inline` and [link](https://example.com).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```\n";
  const { html, slotCount } = renderMarkdownSlots(source, freshNonce, []);
  for (const pattern of [/<h1>Title<\/h1>/, /<li>one<\/li>/, /<strong>bold<\/strong>/, /<code>inline<\/code>/, /<table>/, /language-js/]) assert.match(html, pattern);
  assert.equal(slotCount, 0);
});

for (const fence of ["````", "~~~~"]) {
  test(`preview: Mermaid examples inside literal ${fence} Markdown remain code`, () => {
    const source = `${fence}markdown\n${health}${fence}\n\n${health}`;
    const results = convertMarkdown(source);
    const prepared = renderMarkdownSlots(source, freshNonce, results);
    assert.equal(results.length, 1);
    assert.equal(prepared.slots.length, 1);
    assert.match(prepared.html, /<pre><code class="language-markdown">/);
    assert.match(prepared.html, /```mermaid midnight/);
  });
}

for (const [label, source] of [
  ["tagged fences", `${health}\nBetween\n\n${unsupported}\n${broken}`],
  ["managed hidden source", `Before\n\n${managed}\nAfter\n`],
  ["managed legacy source", `Before\n\n<!-- diagrammo:sync stable -->\n<details>\n${health}\n</details>\n<!-- /diagrammo:sync stable -->\n\nAfter`],
  ["CRLF", health.replaceAll("\n", "\r\n")],
]) {
  test(`preview: ${label} binds prepared identities, not outcome array positions`, () => {
    const results = convertMarkdown(source);
    const prepared = renderMarkdownSlots(source, freshNonce, results);
    const slots = mapSlotsToOutcomes(prepared, [...results].reverse());
    assert.equal(slots.length, results.length);
    assert.deepEqual(slots.map((s) => s.outcome.kind), results.map((r) => r.kind));
    assert.deepEqual(slots.map((s) => s.outcome.identity), results.map((r) => r.identity));
    assert.equal(prepared.slotCount, results.length);
    assert.doesNotMatch(prepared.html, /old\.svg|diagrammo:source|<details>/);
    if (source.includes("Before")) {
      assert.ok(prepared.html.indexOf("Before") < prepared.html.indexOf("data-ahm-slot"));
      assert.ok(prepared.html.indexOf("After") > prepared.html.indexOf("data-ahm-slot"));
    }
  });
}

test("preview: an unknown identity is explicit without invalidating other mappings", () => {
  const source = health + unsupported;
  const results = convertMarkdown(source);
  const prepared = renderMarkdownSlots(source, freshNonce, results);
  const slots = mapSlotsToOutcomes(prepared, [results[0]]);
  assert.equal(slots[0].outcome.kind, "health");
  assert.equal(slots[1].outcome.kind, "unavailable");
});

test("preview: hostile previous-nonce HTML cannot own a new prepared diagram", () => {
  const first = renderMarkdownSlots(health, freshNonce, convertMarkdown(health));
  const forged = `<div data-ahm-slot="${first.nonce}-0"></div>`;
  const source = `${forged}\n\n${health}`;
  const results = convertMarkdown(source);
  const next = renderMarkdownSlots(source, freshNonce, results);
  assert.notEqual(next.nonce, first.nonce);
  assert.equal(next.slots.length, 1);
  assert.equal(next.slots[0].identity, results[0].identity);
  assert.match(next.html, new RegExp(first.nonce));
});

for (const hidden of [false, true]) {
  test(`preview: shared ${hidden ? "hidden" : "ordinary"} source keeps ordered identities and trailing prose`, () => {
    const body = health + unsupported + health.replace("Child", "Sibling");
    const source = "Before\n\n" + (hidden ? "<!-- diagrammo:source\n" + escapeCommentTerminator(body) + "-->\n" : body) + "\nAfter\n\n" + broken;
    const results = convertMarkdown(source);
    assert.deepEqual(results.map((r) => r.kind), ["health", "unsupported", "health", "error"]);
    const prepared = renderMarkdownSlots(source, freshNonce, [...results].reverse());
    assert.equal(prepared.slotCount, 4);
    assert.deepEqual(prepared.slots.map((s) => s.identity), results.map((r) => r.identity));
    assert.deepEqual(mapSlotsToOutcomes(prepared, [...results].reverse()).map((s) => s.outcome.kind), results.map((r) => r.kind));
    assert.equal((prepared.html.match(/data-ahm-slot=/g) || []).length, 4);
    assert.match(prepared.html, /Before[\s\S]*data-ahm-slot[\s\S]*After[\s\S]*data-ahm-slot/);
    assert.doesNotMatch(prepared.html, /Diagram unavailable|diagrammo:source/);
  });
}

for (const [label, start, indent, end, listTag] of [
  ["unordered", "- First", "    ", "- Second", "ul"],
  ["ordered", "1. First", "   ", "2. Second", "ol"],
  ["nested", "- Outer\n  - First", "      ", "  - Second", "ul"],
]) {
  test(`preview: ${label} list retains raw container ownership`, () => {
    const fence = health.slice(health.indexOf("```")).trimEnd();
    const source = start + "\n\n" + fence.split("\n").map((line) => indent + line).join("\n") + "\n\n" + end + "\n\nAfter";
    const results = convertMarkdown(source);
    assert.equal(results.length, 1);
    const { html, slots } = renderMarkdownSlots(source, freshNonce, results);
    assert.equal(slots.length, 1);
    assert.match(html, new RegExp(`<${listTag}>[\\s\\S]*<li>[\\s\\S]*First[\\s\\S]*data-ahm-slot`));
    assert.ok(html.indexOf("data-ahm-slot") < html.indexOf("</li>"), "diagram stays in the first item");
    assert.match(html, /Second[\s\S]*After/);
    assert.equal((html.match(new RegExp(`<${listTag}>`, "g")) || []).length, label === "nested" ? 2 : 1);
  });
}
