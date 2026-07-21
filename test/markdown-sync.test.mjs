// Tests for the pure markdown-sync transform: turns a plain ```mermaid fence into a machine-owned
// managed block (visible <img> plus a fully hidden HTML comment holding the still-editable fence,
// its `-->` terminators escaped to `--&gt;` so the comment never closes early), and keeps reruns
// idempotent/edit-aware. No filesystem, no subprocess — see cli.test.mjs for the real CLI
// end-to-end proof of mutation/atomic-rename/path-resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { marked } from "marked";
import {
  syncMarkdown, svgHref, escapeAltText, escapeLearnAttr, preferredIdentities,
  escapeCommentTerminator, unescapeCommentTerminator, decodeManagedSpans, assertBlocksEncodable,
} from "../src/markdown-sync.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";

// ---------- codec: escapeCommentTerminator / unescapeCommentTerminator ----------

test("escapeCommentTerminator/unescapeCommentTerminator: round-trips every arrow variant and blank-line-separated bodies byte-for-byte", () => {
  const cases = {
    "plain arrow": "a --> b",
    "dotted arrow": "a -.-> b",
    "thick arrow": "a ==> b",
    "cross arrow": "a --x b",
    "circle arrow": "a --o b",
    "async arrow (contains a real --> prefix plus a trailing >)": "a -->> b",
    "multiple arrows on one line": "a --> b --> c",
    "blank lines between statements": "a --> b\n\nc --> d\n\ne --> f",
    "no arrows at all": "flowchart BT\nclassDef green fill:#0f0;",
  };
  for (const [name, raw] of Object.entries(cases)) {
    const encoded = escapeCommentTerminator(raw);
    assert.equal(unescapeCommentTerminator(encoded), raw, name);
    // encoding must never insert/remove a line — line count is stable (see decode-view line-number
    // stability requirement: extractBlocks()'s line-based indexing must stay valid either way).
    assert.equal(encoded.split("\n").length, raw.split("\n").length, `${name}: line count changed`);
  }
});

test("escapeCommentTerminator: every literal '-->' becomes '--&gt;', never a bare '>' left dangling", () => {
  assert.equal(escapeCommentTerminator("a --> b"), "a --&gt; b");
  assert.equal(escapeCommentTerminator("a -->> b"), "a --&gt;> b");
  assert.doesNotMatch(escapeCommentTerminator("a --> b --> c"), /-->/);
});

test("escapeCommentTerminator: rejects (throws) raw text that already contains the reserved encoded token, naming the reason", () => {
  assert.throws(
    () => escapeCommentTerminator('a["already --&gt; encoded"] --> b'),
    /already contains.*--&gt;|reserved/i,
  );
});

test("unescapeCommentTerminator: is the exact inverse of escapeCommentTerminator for any input that survived encoding", () => {
  const raw = "a --> b\nc -.-> d\ne ==> f";
  assert.equal(unescapeCommentTerminator(escapeCommentTerminator(raw)), raw);
});

// ---------- decodeManagedSpans: recover real Mermaid text from a hidden-source comment ----------

test("decodeManagedSpans: unescapes only the lines inside a hidden-source comment, leaving everything else byte-identical", () => {
  const md = [
    "# Title",
    "<!-- diagrammo:sync checkout -->",
    "![Checkout](checkout.svg)",
    "",
    "<!-- diagrammo:source",
    "```mermaid",
    "flowchart BT",
    "a --&gt; b",
    "```",
    "-->",
    "<!-- /diagrammo:sync checkout -->",
    "",
    "Prose mentioning --&gt; literally should never be touched, since it sits outside any comment.",
  ].join("\n");
  const decoded = decodeManagedSpans(md);
  const lines = decoded.split("\n");
  assert.equal(lines[7], "a --> b", "fence body inside the comment must be unescaped");
  assert.equal(lines[12], "Prose mentioning --&gt; literally should never be touched, since it sits outside any comment.", "text outside a hidden-source comment is never decoded (no broad HTML-entity decode)");
  assert.equal(lines.length, md.split("\n").length, "decode never changes line count");
});

test("decodeManagedSpans: a bare fence or an old <details>-shape fence (no hidden-source comment) passes through completely unchanged", () => {
  const bare = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  assert.equal(decodeManagedSpans(bare), bare);
  const oldShape = [
    "<!-- diagrammo:sync checkout -->", "![Checkout](checkout.svg)", "",
    "<details>", "<summary>Mermaid source</summary>", "",
    "```mermaid", "flowchart BT", "a --> b", "```", "",
    "</details>", "<!-- /diagrammo:sync checkout -->",
  ].join("\n") + "\n";
  assert.equal(decodeManagedSpans(oldShape), oldShape);
});

test("decodeManagedSpans: a hidden-source comment that never finds a closing '-->' fails loudly", () => {
  // deliberately no end identity marker either, so there is truly no "-->" anywhere in the
  // remainder of the document (an end marker line would itself contain one and be mistaken for it)
  const malformed = [
    "<!-- diagrammo:sync checkout -->", "![Checkout](checkout.svg)", "",
    "<!-- diagrammo:source", "```mermaid", "flowchart BT", "a --&gt; b", "```",
    // no closing "-->" at all
  ].join("\n") + "\n";
  assert.throws(() => decodeManagedSpans(malformed), /hidden-source comment opened at line 4 is missing its closing/);
});

test("decodeManagedSpans: a line that clearly attempts a hidden-source marker but has the wrong shape fails loudly rather than being silently treated as prose", () => {
  const cases = {
    "trailing self-close (would never stay open across the fence)": "<!-- diagrammo:source -->",
    "extra token after the keyword": "<!-- diagrammo:source extra",
    "no space, still self-closed": "<!--diagrammo:source-->",
  };
  for (const [name, sourceLine] of Object.entries(cases)) {
    const md = ["<!-- diagrammo:sync checkout -->", "![x](x.svg)", "", sourceLine, "```mermaid", "flowchart BT", "a --&gt; b", "```", "-->", "<!-- /diagrammo:sync checkout -->"].join("\n") + "\n";
    assert.throws(() => decodeManagedSpans(md), /looks like a hidden-source marker but is not a valid one/, name);
  }
});

test("syncMarkdown: wraps a plain fence into the exact literal managed block (visible <img> plus one hidden-source comment holding the escaped fence)", () => {
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
    "<!-- diagrammo:source",
    "```mermaid",
    "flowchart BT",
    "a --&gt; b",
    "```",
    "-->",
    "<!-- /diagrammo:sync checkout -->",
    "",
    "More prose.",
  ].join("\n");
  assert.equal(out, expected);
});

test("syncMarkdown: GitHub-flavored/CommonMark rendering shows only the <img> — no visible disclosure text, no leaked fence content, and the hidden comment passes through verbatim as an inert node", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "checkout.svg" }]);
  const html = marked.parse(out); // marked defaults to gfm:true, the repo's existing GFM proxy
  // the <img> is the only visible/renderable element this block produces
  assert.match(html, /<img src="checkout\.svg" alt="Checkout">/);
  // no collapsed-but-present disclosure widget (that was the old, merely-collapsed mechanism)
  assert.doesNotMatch(html, /<details/);
  assert.doesNotMatch(html, /<summary/);
  assert.doesNotMatch(html, /Mermaid source/);
  // no leaked fence content rendered as visible markdown (a <pre><code> block would be visible)
  assert.doesNotMatch(html, /<pre>/);
  assert.doesNotMatch(html, /<code/);
  // the hidden-source comment is present verbatim (proving pass-through, not corruption/loss) —
  // marked classifies it as one opaque HTML-comment block, never re-wrapped in a visible <p>
  assert.match(html, /<!-- diagrammo:source\n```mermaid\nflowchart BT\na --&gt; b\n```\n-->/);
  assert.doesNotMatch(html, /<p>[^<]*<!-- diagrammo:source/);
});

test("syncMarkdown: the fence recovered (via decodeManagedSpans) from the synced Markdown is byte-identical to the original", () => {
  const original = "## Metrics\n\n```mermaid swimlane theme=candy title=\"X\"\nflowchart BT\na[\"A\"] --> b[\"B\"]\n```\n";
  const [b] = extractBlocks(original, THEME_NAMES);
  const out = syncMarkdown(original, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "metrics.svg" }]);
  // extractBlocks() must never see escaped text directly — every real caller decodes first
  const [recovered] = extractBlocks(decodeManagedSpans(out), THEME_NAMES);
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
  const reBlocks = extractBlocks(decodeManagedSpans(out), THEME_NAMES);
  assert.deepEqual(reBlocks.map((b) => b.slug), ["same", "same-2", "other"]);
  assert.equal(reBlocks[0].code, blocks[0].code);
  assert.equal(reBlocks[1].code, blocks[1].code);
  assert.equal(reBlocks[2].code, blocks[2].code);
  assert.match(out, /<!-- diagrammo:sync same -->[\s\S]*?a --&gt; b[\s\S]*?<!-- \/diagrammo:sync same -->/);
  assert.match(out, /<!-- diagrammo:sync same-2 -->[\s\S]*?c --&gt; d[\s\S]*?<!-- \/diagrammo:sync same-2 -->/);
  assert.match(out, /<!-- diagrammo:sync other -->[\s\S]*?e --&gt; f[\s\S]*?<!-- \/diagrammo:sync other -->/);
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

test("syncMarkdown: hand-editing the fence inside the hidden comment (decode -> edit -> resync, the documented flow) updates the same wrapper", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const synced = syncMarkdown(md, spec(b));
  // the fence lives escaped inside the hidden comment on disk; editing it directly means decoding
  // first (the documented flow), editing the real Mermaid text, then letting resync re-encode it.
  assert.doesNotMatch(synced, /a --> b/, "sanity: the fence body should be escaped on disk");
  assert.match(synced, /a --&gt; b/, "sanity: the escaped fence body should be present");
  const decodedForEdit = decodeManagedSpans(synced);
  const edited = decodedForEdit.replace("a --> b", "a --> b\nb --> c");
  const [b2] = extractBlocks(edited, THEME_NAMES);
  assert.equal(b2.slug, "checkout");
  const resynced = syncMarkdown(edited, spec(b2));
  assert.equal((resynced.match(/diagrammo:sync checkout/g) || []).length, 2);
  const [recovered] = extractBlocks(decodeManagedSpans(resynced), THEME_NAMES);
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

// ---------- migrating an old <details>-shape managed block to the new hidden-comment shape ------

test("syncMarkdown: an existing OLD <details>-shape managed block is recognized as valid (not malformed) and migrated to the new hidden-comment shape on resync, keeping its slug/filename identity", () => {
  const oldShape = [
    "# Doc", "",
    "<!-- diagrammo:sync notification-health -->",
    "![Notification health](assets/notification-health.svg)", "",
    "<details>", "<summary>Mermaid source</summary>", "",
    "```mermaid", "flowchart BT", 'sig["Signal"] --> node["Node"]', "```", "",
    "</details>",
    "<!-- /diagrammo:sync notification-health -->", "",
    "Trailing prose.",
  ].join("\n") + "\n";

  // old shape must be recognized as a *valid* span (never malformed) so it migrates, not rejects
  const identities = preferredIdentities(oldShape);
  assert.deepEqual(identities.slugs, ["notification-health"]);

  const [b] = extractBlocks(oldShape, THEME_NAMES, new Map(), identities.byOpenLine);
  assert.equal(b.slug, "notification-health"); // stable identity preserved, not re-derived
  const migrated = syncMarkdown(oldShape, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "assets/notification-health.svg" }]);

  // new shape: no more <details>/<summary>, exactly one hidden-source comment, same slug/href
  assert.doesNotMatch(migrated, /<details>|<summary>/);
  assert.match(migrated, /<!-- diagrammo:sync notification-health -->\n!\[[^\]]*\]\(assets\/notification-health\.svg\)\n\n<!-- diagrammo:source\n```mermaid/);
  assert.match(migrated, /sig\["Signal"\] --&gt; node\["Node"\]/, "fence content preserved, only the terminator escaped");
  assert.match(migrated, /Trailing prose\./);

  // fence recovered from the migrated block equals the original OLD-shape fence, byte-for-byte
  const [recovered] = extractBlocks(decodeManagedSpans(migrated), THEME_NAMES);
  assert.equal(recovered.code, b.code);

  // migrating twice (idempotent from here on) never double-wraps or duplicates markers
  const [b2] = extractBlocks(decodeManagedSpans(migrated), THEME_NAMES);
  const resynced = syncMarkdown(migrated, [{ slug: b2.slug, openLine: b2.line, closeLine: b2.closeLine, title: b2.heading, href: "assets/notification-health.svg" }]);
  assert.equal(resynced, migrated);
  assert.equal((resynced.match(/diagrammo:sync notification-health/g) || []).length, 2);
});

// ---------- assertBlocksEncodable: preflight ambiguity guard across a file's whole block set ----

test("assertBlocksEncodable: throws, naming the offending line, when a block's raw fence text already contains the reserved token", () => {
  const md = [
    "## Checkout", "",
    "```mermaid",
    'a["already --&gt; encoded"] --> b',
    "```",
  ].join("\n");
  const blocks = extractBlocks(md, THEME_NAMES);
  assert.throws(() => assertBlocksEncodable(md, blocks), /reserved token.*\(fence at line 3\)/s);
});

test("assertBlocksEncodable: does not throw for ordinary blocks with real arrows only", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const blocks = extractBlocks(md, THEME_NAMES);
  assert.doesNotThrow(() => assertBlocksEncodable(md, blocks));
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

// ---------- Microsoft Learn image-directive output (opt-in --image-format learn) --------------

test("svgHref: learn format returns the raw POSIX path (no CommonMark angle-bracket form), even with spaces", () => {
  // default/commonmark keeps its angle-bracket-for-spaces behavior (asserted above); learn does not
  assert.equal(svgHref("/repo/docs/page.md", "/repo/docs/assets/diagram.svg", "learn"), "assets/diagram.svg");
  assert.equal(svgHref("/repo/docs/page.md", "/repo/docs/assets/my diagram.svg", "learn"), "assets/my diagram.svg");
  assert.equal(svgHref("/repo/sub/dir/page.md", "/repo/out/assets/diagram.svg", "learn"), "../../out/assets/diagram.svg");
});

test("escapeLearnAttr: escapes attribute-significant characters and flattens newlines (idempotent-safe, deterministic)", () => {
  assert.equal(escapeLearnAttr('A "quoted" & <tagged> value'), "A &quot;quoted&quot; &amp; &lt;tagged&gt; value");
  assert.equal(escapeLearnAttr("Line one\nLine two"), "Line one Line two");
  // & escaped first so an existing bare & never breaks a later-inserted entity
  assert.equal(escapeLearnAttr('Tom & "Jerry"'), "Tom &amp; &quot;Jerry&quot;");
});

test("syncMarkdown: --image-format learn vs commonmark differ only in the visible token line; markers + hidden source are identical", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "diagrams/checkout.svg" }];
  const cases = {
    commonmark: { format: "commonmark", visible: "![Checkout](diagrams/checkout.svg)" },
    learn: {
      format: "learn",
      visible: ':::image type="content" source="diagrams/checkout.svg" alt-text="Checkout" lightbox="diagrams/checkout.svg" border="false":::',
    },
  };
  for (const [name, { format, visible }] of Object.entries(cases)) {
    const out = syncMarkdown(md, spec, { imageFormat: format });
    const expected = [
      "## Checkout",
      "",
      "<!-- diagrammo:sync checkout -->",
      visible,
      "",
      "<!-- diagrammo:source",
      "```mermaid",
      "flowchart BT",
      "a --&gt; b",
      "```",
      "-->",
      "<!-- /diagrammo:sync checkout -->",
      "",
    ].join("\n");
    assert.equal(out, expected, name);
  }
});

test("syncMarkdown: learn-mode source/lightbox href is attribute-escaped when the (directory) path carries \" & < >", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  // svgHref only ever emits [a-z0-9-]+.svg filenames, but the directory portion (from -o or the
  // file's own parents) can carry attribute-significant characters — those must not close source="
  const href = 'a&b/<x>/"q"/checkout.svg';
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href }], { imageFormat: "learn" });
  assert.match(out, /source="a&amp;b\/&lt;x&gt;\/&quot;q&quot;\/checkout\.svg"/);
  assert.match(out, /lightbox="a&amp;b\/&lt;x&gt;\/&quot;q&quot;\/checkout\.svg"/);
  const directive = out.split("\n").find((l) => l.startsWith(":::image"));
  assert.equal((directive.match(/"/g) || []).length % 2, 0, "every quote in the directive is balanced");
});

test("syncMarkdown: learn-mode alt text with attribute-significant characters is escaped inside alt-text=\"...\"", () => {
  const md = '## A "risky" & <odd> title\n\n```mermaid\nflowchart BT\na --> b\n```\n';
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: b.heading, href: "d.svg" }], { imageFormat: "learn" });
  assert.match(out, /alt-text="A &quot;risky&quot; &amp; &lt;odd&gt; title"/);
  // the raw double-quote must never survive unescaped inside the attribute (it would close it early)
  const visibleLine = out.split("\n").find((l) => l.startsWith(":::image"));
  assert.equal((visibleLine.match(/"/g) || []).length % 2, 0, "every quote in the directive line is balanced");
});

test("syncMarkdown: rerunning learn-mode on an already-learn-synced file is byte-identical (idempotent)", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const once = syncMarkdown(md, spec(b), { imageFormat: "learn" });
  const [b2] = extractBlocks(decodeManagedSpans(once), THEME_NAMES);
  const twice = syncMarkdown(once, spec(b2), { imageFormat: "learn" });
  assert.equal(twice, once, "a learn-mode resync of unchanged input must not drift");
  assert.equal((twice.match(/:::image/g) || []).length, 1, "no duplicated/nested directive");
});

test("syncMarkdown: a commonmark-synced block re-synced with --image-format learn switches the visible token in place, keeping the same slug and hidden source", () => {
  const md = "## Checkout\n\n```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const spec = (blk) => [{ slug: blk.slug, openLine: blk.line, closeLine: blk.closeLine, title: blk.heading, href: "checkout.svg" }];
  const cm = syncMarkdown(md, spec(b), { imageFormat: "commonmark" });
  assert.match(cm, /!\[Checkout\]\(checkout\.svg\)/);
  const [b2] = extractBlocks(decodeManagedSpans(cm), THEME_NAMES);
  const learn = syncMarkdown(cm, spec(b2), { imageFormat: "learn" });
  assert.doesNotMatch(learn, /!\[Checkout\]\(checkout\.svg\)/, "old commonmark token is gone");
  assert.match(learn, /:::image type="content" source="checkout\.svg" alt-text="Checkout" lightbox="checkout\.svg" border="false":::/);
  assert.equal((learn.match(/diagrammo:sync checkout/g) || []).length, 2, "same slug, single wrapper");
  // hidden source is untouched and still recovers the original fence byte-for-byte
  assert.equal(extractBlocks(decodeManagedSpans(learn), THEME_NAMES)[0].code, b.code);
});

// ---------- `%%| alt:` per-diagram alt-text override (shared alt pipeline) ----------
//
// The alt precedence for a synced visible embed is: explicit `%%| alt:` override → existing
// `title` (which the CLI resolves to `options.title ?? heading`) → generic fallback. These tests
// mirror the CLI's spec shape (`title: options.title ?? heading, alt: options.alt`) so they prove
// the same pipeline the real command feeds into syncMarkdown().

// Build a syncMarkdown spec from an extracted block exactly as bin/diagrammo.mjs does.
const specFromBlock = (b, href = "checkout.svg") => [{
  slug: b.slug, openLine: b.line, closeLine: b.closeLine,
  title: b.options.title ?? b.heading, alt: b.options.alt, href,
}];

test("syncMarkdown: `%%| alt:` override beats both title and heading, in both image formats, safely escaped", () => {
  const md = [
    "## Fallback Heading",
    "",
    '```mermaid title="Rendered Title"',
    '%%| alt: Regions "A" & <B> to [root]',
    "flowchart BT",
    "a --> b",
    "```",
    "",
  ].join("\n");
  const [b] = extractBlocks(md, THEME_NAMES);
  assert.equal(b.options.alt, 'Regions "A" & <B> to [root]');
  const cases = {
    commonmark: {
      format: "commonmark",
      // escapeAltText escapes \ [ ] only — brackets become \[ \]; quotes/&/<> are inert in ![...]
      match: /!\[Regions "A" & <B> to \\\[root\\\]\]\(checkout\.svg\)/,
    },
    learn: {
      format: "learn",
      // escapeLearnAttr escapes & < > " — brackets are inert inside an attribute value
      match: /alt-text="Regions &quot;A&quot; &amp; &lt;B&gt; to \[root\]"/,
    },
  };
  for (const [name, { format, match }] of Object.entries(cases)) {
    const out = syncMarkdown(md, specFromBlock(b), { imageFormat: format });
    assert.match(out, match, name);
    // the visible embed line must not fall back to title/heading (the hidden source legitimately
    // still carries the fence's `title="Rendered Title"`, so scope this to the visible token only)
    const visible = out.split("\n").find((l) => l.startsWith(format === "learn" ? ":::image" : "!["));
    assert.doesNotMatch(visible, /Rendered Title|Fallback Heading/, `${name}: visible alt is the override, not title/heading`);
  }
});

test("syncMarkdown: without an alt override, alt text is unchanged (title, then heading, then generic fallback)", () => {
  const cases = {
    "title wins over heading when both present": {
      md: '## Heading\n\n```mermaid title="Real Title"\nflowchart BT\na --> b\n```\n',
      expect: /!\[Real Title\]\(checkout\.svg\)/,
    },
    "heading is used when no title/alt": {
      md: "## Just A Heading\n\n```mermaid\nflowchart BT\na --> b\n```\n",
      expect: /!\[Just A Heading\]\(checkout\.svg\)/,
    },
    "generic fallback when neither heading nor title nor alt": {
      md: "```mermaid\nflowchart BT\na --> b\n```\n",
      // no heading → extractBlocks defaults heading to "diagram"; but the CLI passes
      // title = options.title ?? heading = "diagram", so alt is "diagram" here. Force the
      // true no-title/no-heading fallback by passing an empty title spec below instead.
      expect: /!\[diagram\]/,
    },
  };
  for (const [name, { md, expect }] of Object.entries(cases)) {
    const [b] = extractBlocks(md, THEME_NAMES);
    assert.equal(b.options.alt, undefined, `${name}: no alt override present`);
    const out = syncMarkdown(md, specFromBlock(b), { imageFormat: "commonmark" });
    assert.match(out, expect, name);
  }
  // the true generic fallback ("Mermaid diagram") only appears when title is also empty/absent
  const md = "```mermaid\nflowchart BT\na --> b\n```\n";
  const [b] = extractBlocks(md, THEME_NAMES);
  const out = syncMarkdown(md, [{ slug: b.slug, openLine: b.line, closeLine: b.closeLine, title: "", alt: undefined, href: "x.svg" }]);
  assert.match(out, /!\[Mermaid diagram\]\(x\.svg\)/);
});

test("syncMarkdown: an empty/whitespace `%%| alt:` override never emits empty accessibility text — it falls back to title/heading", () => {
  const cases = {
    "empty alt falls back to title": {
      md: '## H\n\n```mermaid title="The Title"\n%%| alt:\nflowchart BT\na --> b\n```\n',
      commonmark: /!\[The Title\]\(checkout\.svg\)/,
      learn: /alt-text="The Title"/,
    },
    "whitespace-only alt falls back to heading (no title)": {
      md: "## Heading Only\n\n```mermaid\n%%| alt:    \nflowchart BT\na --> b\n```\n",
      commonmark: /!\[Heading Only\]\(checkout\.svg\)/,
      learn: /alt-text="Heading Only"/,
    },
  };
  for (const [name, { md, commonmark, learn }] of Object.entries(cases)) {
    const [b] = extractBlocks(md, THEME_NAMES);
    const cm = syncMarkdown(md, specFromBlock(b), { imageFormat: "commonmark" });
    assert.match(cm, commonmark, `${name} (commonmark)`);
    assert.doesNotMatch(cm, /!\[\]\(/, `${name}: never an empty commonmark alt`);
    const lrn = syncMarkdown(md, specFromBlock(b), { imageFormat: "learn" });
    assert.match(lrn, learn, `${name} (learn)`);
    assert.doesNotMatch(lrn, /alt-text=""/, `${name}: never an empty learn alt-text`);
  }
});

test("syncMarkdown: the `%%| alt:` override lives inside the hidden source and round-trips across a resync (fresh fence + existing managed block)", () => {
  const md = [
    "## Checkout",
    "",
    "```mermaid",
    "%%| alt: Durable screen-reader description of the roll-up",
    "flowchart BT",
    "a --> b",
    "```",
    "",
  ].join("\n");
  for (const format of ["commonmark", "learn"]) {
    const [b] = extractBlocks(md, THEME_NAMES);
    // first sync (fresh fence)
    const once = syncMarkdown(md, specFromBlock(b), { imageFormat: format });
    // the override text survives inside the hidden diagrammo:source comment
    const [b2] = extractBlocks(decodeManagedSpans(once), THEME_NAMES);
    assert.equal(b2.options.alt, "Durable screen-reader description of the roll-up", `${format}: alt recovered from managed block`);
    // second sync (existing managed block) is byte-identical and preserves the visible alt
    const twice = syncMarkdown(once, specFromBlock(b2), { imageFormat: format });
    assert.equal(twice, once, `${format}: resync with an unchanged alt override must be byte-idempotent`);
    const expectAlt = format === "learn"
      ? /alt-text="Durable screen-reader description of the roll-up"/
      : /!\[Durable screen-reader description of the roll-up\]/;
    assert.match(twice, expectAlt, `${format}: visible embed keeps the override alt`);
    // slug/filename identity and the hidden fence body are untouched by the alt override
    assert.equal((twice.match(/diagrammo:sync checkout/g) || []).length, 2, `${format}: single wrapper, stable slug`);
    assert.equal(extractBlocks(decodeManagedSpans(twice), THEME_NAMES)[0].code, b.code, `${format}: hidden fence body preserved`);
  }
});
