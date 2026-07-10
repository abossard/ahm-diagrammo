// Tests for markdown extraction, option channels, and the YAML subset parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractBlocks, parseYamlite, splitFrontmatter, stripDiagrammoKey } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";

const md = (s) => s.replace(/^ {4}/gm, "");

test("parseYamlite: scalars, nesting, lists", () => {
  const y = parseYamlite(md(`
    title: Order pipeline
    count: 3
    ratio: 0.5
    on: true
    off: false
    lanes: [Root, "Order flows", Services]
    diagrammo:
      theme: candy
      legend: false
      steps:
        - one
        - two
  `));
  assert.equal(y.title, "Order pipeline");
  assert.equal(y.count, 3);
  assert.equal(y.ratio, 0.5);
  assert.equal(y.on, true);
  assert.equal(y.off, false);
  assert.deepEqual(y.lanes, ["Root", "Order flows", "Services"]);
  assert.equal(y.diagrammo.theme, "candy");
  assert.equal(y.diagrammo.legend, false);
  assert.deepEqual(y.diagrammo.steps, ["one", "two"]);
});

test("extractBlocks: line numbers, fence info, directives, frontmatter merge", () => {
  const doc = [
    "# Title",              // 1
    "",                     // 2
    "```mermaid candy",     // 3  <- fence
    "%%| legend: false",    // 4
    "flowchart BT",         // 5
    "a --> b",              // 6
    "```",                  // 7
    "",                     // 8
    "## Second",            // 9
    "```mermaid",           // 10
    "---",                  // 11
    "title: From FM",       // 12
    "diagrammo:",           // 13
    "  theme: slate",       // 14
    "---",                  // 15
    "flowchart BT",         // 16
    "c --> d",              // 17
    "```",                  // 18
  ].join("\n");
  const blocks = extractBlocks(doc, THEME_NAMES);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].line, 3);
  assert.equal(blocks[0].codeLine, 4);
  assert.equal(blocks[0].options.theme, "candy");
  assert.equal(blocks[0].options.legend, false);
  assert.equal(blocks[1].options.theme, "slate");
  assert.equal(blocks[1].options.title, "From FM");
  assert.equal(blocks[1].slug, "from-fm");
});

test("extractBlocks: directives override frontmatter which overrides fence", () => {
  const doc = "```mermaid midnight\n---\ndiagrammo:\n  theme: slate\n---\n%%| theme: candy\nflowchart BT\na --> b\n```";
  const [b] = extractBlocks(doc, THEME_NAMES);
  assert.equal(b.options.theme, "candy");
});

test("extractBlocks: quoted fence values may contain spaces", () => {
  const [b] = extractBlocks('```mermaid title="Checkout flow" subtitle=\'Live status\'\nflowchart BT\na --> b\n```', THEME_NAMES);
  assert.equal(b.options.title, "Checkout flow");
  assert.equal(b.options.subtitle, "Live status");
  assert.equal(b.slug, "checkout-flow");
});

test("extractBlocks: unknown option key and bad values produce issues", () => {
  const doc = "```mermaid\n%%| renderer: sparkles\n%%| colour: red\n%%| lanes: oops\nflowchart BT\na --> b\n```";
  const [b] = extractBlocks(doc, THEME_NAMES);
  const msgs = b.issues.map((i) => i.message).join("\n");
  assert.match(msgs, /unknown renderer "sparkles"/);
  assert.match(msgs, /unknown option "colour"/);
  assert.match(msgs, /"lanes" should be a list/);
  assert.equal(b.issues.find((i) => i.message.includes("sparkles")).level, "error");
});

test("extractBlocks: unknown theme is a block-level error with fence line", () => {
  const doc = "line1\n\n```mermaid theme=neon\nflowchart BT\na --> b\n```";
  const [b] = extractBlocks(doc, THEME_NAMES);
  const err = b.issues.find((i) => i.level === "error");
  assert.match(err.message, /unknown theme "neon"/);
  assert.equal(err.line, 3);
});

test("extractBlocks: unclosed fence is flagged but still returned", () => {
  const doc = "```mermaid\nflowchart BT\na --> b";
  const [b] = extractBlocks(doc, THEME_NAMES);
  assert.ok(b);
  assert.match(b.issues[0].message, /never closed/);
});

test("stripDiagrammoKey keeps mermaid-native frontmatter, drops only the diagrammo key", () => {
  const code = "---\ntitle: Kept\nconfig:\n  theme: forest\ndiagrammo:\n  theme: candy\n  legend: false\n---\nflowchart BT\na --> b\n";
  const { raw } = splitFrontmatter(code);
  const stripped = stripDiagrammoKey(raw);
  assert.match(stripped, /title: Kept/);
  assert.match(stripped, /theme: forest/);
  assert.doesNotMatch(stripped, /diagrammo/);
  assert.doesNotMatch(stripped, /candy/);
  // frontmatter with ONLY a diagrammo key vanishes entirely
  const only = splitFrontmatter("---\ndiagrammo:\n  theme: slate\n---\nflowchart BT\n").raw;
  assert.equal(stripDiagrammoKey(only), "");
});

test("extractBlocks: ~~~ fences and duplicate slugs", () => {
  const doc = "## Same\n~~~mermaid\nflowchart BT\na --> b\n~~~\n\n## Same\n~~~mermaid\nflowchart BT\nc --> d\n~~~";
  const blocks = extractBlocks(doc, THEME_NAMES);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].slug, "same");
  assert.equal(blocks[1].slug, "same-2");
});

test("extractBlocks: closing fence matches opener character and minimum length", () => {
  const doc = "````mermaid\nflowchart BT\na --> b\n```\n~~~\n````\n\n~~~mermaid\nflowchart BT\nc --> d\n```\n~~~~";
  const blocks = extractBlocks(doc, THEME_NAMES);
  assert.equal(blocks.length, 2);
  assert.match(blocks[0].code, /```\n~~~/);
  assert.match(blocks[1].code, /```/);
  assert.ok(!blocks.some((b) => b.issues.some((i) => i.message.includes("never closed"))));
});
