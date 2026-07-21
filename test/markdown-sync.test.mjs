// Tests for the pure markdown-sync transform: turns a plain ```mermaid fence into a machine-owned
// managed block (visible <img> + collapsed <details> holding the still-editable fence), and keeps
// reruns idempotent/edit-aware. No filesystem, no subprocess — see cli.test.mjs for the real CLI
// end-to-end proof of mutation/atomic-rename/path-resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import { syncMarkdown, svgHref, escapeAltText, preferredIdentities } from "../src/markdown-sync.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";

test("syncMarkdown: wraps a plain fence into the exact literal managed block", () => {
  const md = [
    "# Doc",
    "",
    "## Checkout",
    "",
    "```mermaid",
    "flowchart BT",
    "a --> b",
    "```",
    "",
    "More prose.",
  ].join("\n");
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }]);
  const expected = [
    "# Doc",
    "",
    "## Checkout",
    "",
    "<!-- diagrammo:sync checkout -->",
    "![Checkout](checkout.svg)",
    "",
    "<details>",
    "<summary>Mermaid source</summary>",
    "",
    "```mermaid",
    "flowchart BT",
    "a --> b",
    "```",
    "",
    "</details>",
    "<!-- /diagrammo:sync checkout -->",
    "",
    "More prose.",
  ].join("\n");
  assert.equal(out, expected);
});

test("syncMarkdown: GitHub-flavored rendering shows the img and keeps <details> collapsed with the fence intact", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }]);
  const html = marked.parse(out);
  // <img> sits outside/above <details>
  const imgIdx = html.indexOf('<img src="checkout.svg"');
  const detailsIdx = html.indexOf("<details>");
  assert.ok(imgIdx >= 0 && detailsIdx > imgIdx, html);
  // <details> carries no open attribute (collapsed by default)
  assert.doesNotMatch(html, /<details open/);
  // the fenced mermaid source is present inside, as real markdown-rendered code, not escaped text
  assert.match(html, /<pre><code class="language-mermaid">flowchart BT\na --&gt; b\n<\/code><\/pre>/);
});

test("syncMarkdown: the fence recovered from the synced Markdown is byte-identical to the original", () => {
  const original = "## Metrics\n\n```mermaid swimlane theme=candy title=\"X\"\nflowchart BT\na[\"A\"] --> b[\"B\"]\n```\n";
  const [b] = extractBlocks(original, THEME_NAMES);
  const out = syncMarkdown(original, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "metrics.svg" }]);
  const [recovered] = extractBlocks(out, THEME_NAMES);
  assert.equal(recovered.code, b.code);
  assert.equal(recovered.info, b.info);
});

test("syncMarkdown: multiple blocks including colliding headings map to the correct managed block each", () => {
  const md = [
    "## Same",
    "```mermaid",
    "flowchart BT",
    "a --> b",
    "```",
    "",
    "## Same",
    "```mermaid",
    "flowchart BT",
    "c --> d",
    "```",
    "",
    "## Other",
    "```mermaid",
    "flowchart BT",
    "e --> f",
    "```",
  ].join("\n");
  const blocks = extractBlocks(md, THEME_NAMES);
  assert.deepEqual(blocks.map((b) => b.slug), ["same", "same-2", "other"]);
  const specs = blocks.map((b) => ({ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: `${b.slug}.svg` }));
  const out = syncMarkdown(md, specs);
  const reBlocks = extractBlocks(out, THEME_NAMES);
  assert.deepEqual(reBlocks.map((b) => b.slug), ["same", "same-2", "other"]);
  assert.equal(reBlocks[0].code, blocks[0].code);
  assert.equal(reBlocks[1].code, blocks[1].code);
  assert.equal(reBlocks[2].code, blocks[2].code);
  assert.match(out, /<!-- diagrammo:sync same -->[\s\S]*?a --> b[\s\S]*?<!-- \/diagrammo:sync same -->/);
  assert.match(out, /<!-- diagrammo:sync same-2 -->[\s\S]*?c --> d[\s\S]*?<!-- \/diagrammo:sync same-2 -->/);
  assert.match(out, /<!-- diagrammo:sync other -->[\s\S]*?e --> f[\s\S]*?<!-- \/diagrammo:sync other -->/);
});

test("syncMarkdown: every non-managed line survives untouched, verbatim", () => {
  const md = [
    "# Title",
    "",
    "Some | table | row",
    "|---|---|",
    "| a | b |",
    "",
    "```js",
    "const x = 1;",
    "```",
    "",
    "![existing](other.png)",
    "",
    "## Checkout",
    "```mermaid",
    "flowchart BT",
    "a --> b",
    "```",
    "",
    "Trailing prose stays put.",
  ].join("\n");
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }]);
  const before = md.split("\n").slice(0, b.line - 1);
  const after = md.split("\n").slice(b.closeLine);
  const outLines = out.split("\n");
  assert.deepEqual(outLines.slice(0, before.length), before);
  assert.deepEqual(outLines.slice(outLines.length - after.length), after);
});

test("syncMarkdown: rerunning on unchanged input is byte-identical (no nested wrappers, no duplicated markers)", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const once = syncMarkdown(md, spec(b));
  const [b2] = extractBlocks(once, THEME_NAMES);
  const twice = syncMarkdown(once, spec(b2));
  assert.equal(twice, once);
  assert.equal((twice.match(/diagrammo:sync checkout/g) || []).length, 2); // exactly one begin + one end
});

test("syncMarkdown: editing the fence inside an existing managed block then re-syncing replaces the same wrapper", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const synced = syncMarkdown(md, spec(b));
  const edited = synced.replace("a --> b", "a --> b\nb --> c");
  const [b2] = extractBlocks(edited, THEME_NAMES);
  assert.equal(b2.slug, "checkout");
  const resynced = syncMarkdown(edited, spec(b2));
  assert.equal((resynced.match(/diagrammo:sync checkout/g) || []).length, 2);
  const [recovered] = extractBlocks(resynced, THEME_NAMES);
  assert.match(recovered.code, /b --> c/);
});

test("syncMarkdown: preserves CRLF line endings and no-final-newline presence", () => {
  const crlf = "## Checkout\r\n\r\n```mermaid\r\nflowchart BT\r\na --> b\r\n```\r\nTrailer, no newline at EOF";
  const [b] = extractBlocks(crlf.replace(/\r\n/g, "\n"), THEME_NAMES);
  const out = syncMarkdown(crlf, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }]);
  assert.ok(out.includes("\r\n"), "expected CRLF to be preserved");
  assert.ok(!/[^\r]\n/.test(out), "expected every newline to be part of a CRLF pair");
  assert.ok(!out.endsWith("\n") && !out.endsWith("\r"), "expected no trailing newline to be introduced");
  assert.ok(out.endsWith("Trailer, no newline at EOF"));
});

test("svgHref: relative to the Markdown file's own directory, POSIX separators, angle form for spaces", () => {
  assert.equal(svgHref("/repo/docs/page.md", "/repo/docs/assets/diagram.svg"), "assets/diagram.svg");
  assert.equal(svgHref("/repo/sub/dir/page.md", "/repo/out/assets/diagram.svg"), "../../out/assets/diagram.svg");
  assert.equal(svgHref("/repo/docs/page.md", "/repo/docs/assets/my diagram.svg"), "<assets/my diagram.svg>");
});

test("escapeAltText: escapes Markdown-significant brackets and strips newlines", () => {
  assert.equal(escapeAltText("Checkout [flow]"), "Checkout \\[flow\\]");
  assert.equal(escapeAltText("Line one\nLine two"), "Line one Line two");
});

test("syncMarkdown: a valid managed span is never rejected merely because the fence's current heading/title derives a different slug", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const synced = syncMarkdown(md, spec(b));
  // heading renamed after the fact — a fresh extractBlocks() call (no preferred slug given) now
  // derives "payment", but the managed span's own marker slug ("checkout") must still win.
  const renamed = synced.replace("## Checkout", "## Payment");
  const [b2] = extractBlocks(renamed, THEME_NAMES);
  assert.equal(b2.slug, "payment"); // sanity: the naive re-derivation really would change
  assert.doesNotThrow(() => syncMarkdown(renamed, spec(b2)));
  const out = syncMarkdown(renamed, spec(b2));
  assert.match(out, /<!-- diagrammo:sync checkout -->/);
  assert.doesNotMatch(out, /diagrammo:sync payment/);
  assert.match(out, /!\[Payment\]\(checkout\.svg\)/); // alt text reflects the new heading
  assert.equal((out.match(/diagrammo:sync checkout/g) || []).length, 2);
});

test("preferredIdentities: exposes each managed span's stable slug keyed by its fence's exact open line", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }];
  const synced = syncMarkdown(md, spec);
  const identities = preferredIdentities(synced);
  assert.deepEqual(identities.slugs, ["checkout"]);
  const [innerBlock] = extractBlocks(synced, THEME_NAMES);
  assert.equal(identities.byOpenLine.get(innerBlock.line), "checkout");
});

test("syncMarkdown: malformed managed markers reject with a clear error and produce no output", () => {
  const cases = {
    "missing end marker": "<!-- diagrammo:sync checkout -->\n![x](x.svg)\n\n<details>\n<summary>Mermaid source</summary>\n\n```mermaid\nflowchart BT\na --> b\n```\n\n</details>\n",
    "mismatched slug on end marker": "<!-- diagrammo:sync checkout -->\n![x](x.svg)\n\n<details>\n<summary>Mermaid source</summary>\n\n```mermaid\nflowchart BT\na --> b\n```\n\n</details>\n<!-- /diagrammo:sync other -->\n",
    "duplicate begin for the same slug": [
      "<!-- diagrammo:sync checkout -->",
      "![x](x.svg)", "", "<details>", "<summary>Mermaid source</summary>", "",
      "```mermaid", "flowchart BT", "a --> b", "```", "",
      "</details>", "<!-- /diagrammo:sync checkout -->",
      "<!-- diagrammo:sync checkout -->",
      "![x](x.svg)", "", "<details>", "<summary>Mermaid source</summary>", "",
      "```mermaid", "flowchart BT", "c --> d", "```", "",
      "</details>", "<!-- /diagrammo:sync checkout -->",
    ].join("\n"),
    "span with no mermaid fence inside": "<!-- diagrammo:sync checkout -->\nplain prose, no fence at all\n<!-- /diagrammo:sync checkout -->\n",
    "end marker with no begin at all": "<!-- /diagrammo:sync checkout -->\n",
  };
  for (const [name, source] of Object.entries(cases)) {
    assert.throws(() => syncMarkdown(source, []), { name: "Error" }, name);
  }
});

test("syncMarkdown: a begin-marker line that clearly attempts a managed marker but has an invalid slug/shape fails loudly rather than being treated as prose", () => {
  const wrap = (beginLine) => [
    beginLine,
    "![x](x.svg)", "", "<details>", "<summary>Mermaid source</summary>", "",
    "```mermaid", "flowchart BT", "a --> b", "```", "",
    "</details>", "<!-- /diagrammo:sync checkout -->",
  ].join("\n") + "\n";
  const cases = {
    "underscore in slug": "<!-- diagrammo:sync bad_slug -->",
    "uppercase in slug": "<!-- diagrammo:sync BadSlug -->",
    "empty slug": "<!-- diagrammo:sync -->",
    "extra token after slug": "<!-- diagrammo:sync checkout extra -->",
    "extra attribute-looking token": "<!-- diagrammo:sync checkout foo=bar -->",
    "missing comment close": "<!-- diagrammo:sync checkout",
  };
  for (const [name, beginLine] of Object.entries(cases)) {
    assert.throws(
      () => syncMarkdown(wrap(beginLine), []),
      /looks like a managed marker but is not a valid one/,
      name,
    );
  }
});

test("syncMarkdown: an end-marker line that clearly attempts a managed marker but has an invalid slug/shape fails loudly rather than being treated as prose", () => {
  const body = [
    "![x](x.svg)", "", "<details>", "<summary>Mermaid source</summary>", "",
    "```mermaid", "flowchart BT", "a --> b", "```", "", "</details>",
  ].join("\n");
  const wrap = (endLine) => ["<!-- diagrammo:sync checkout -->", body, endLine].join("\n") + "\n";
  const cases = {
    "underscore in slug": "<!-- /diagrammo:sync bad_slug -->",
    "uppercase in slug": "<!-- /diagrammo:sync Checkout -->",
    "empty slug": "<!-- /diagrammo:sync -->",
    "extra token after slug": "<!-- /diagrammo:sync checkout extra -->",
    "missing comment close": "<!-- /diagrammo:sync checkout",
  };
  for (const [name, endLine] of Object.entries(cases)) {
    assert.throws(
      () => syncMarkdown(wrap(endLine), []),
      /looks like a managed marker but is not a valid one/,
      name,
    );
  }
});

test("syncMarkdown: an ordinary HTML comment that merely mentions diagrammo:sync later in the line stays prose and syncs normally", () => {
  const md = [
    "<!-- see diagrammo:sync docs for details -->",
    "## Checkout", "", "```mermaid", "flowchart BT", "a --> b", "```", "",
  ].join("\n") + "\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }];
  assert.doesNotThrow(() => syncMarkdown(md, spec));
  const out = syncMarkdown(md, spec);
  assert.match(out, /^<!-- see diagrammo:sync docs for details -->/);
  assert.match(out, /<!-- diagrammo:sync checkout -->/);
});
