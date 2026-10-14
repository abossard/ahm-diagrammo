import { test } from "node:test";
import assert from "node:assert/strict";
import { syncMarkdown } from "../src/markdown-sync.mjs";

const code = 'flowchart BT\nchild["Child"] --> root["Root"]\nclass child,root green;';
const ordinary = `# Checkout\n\n\`\`\`mermaid theme=midnight\n%%| theme: candy\n${code}\n\`\`\`\n`;
const managed = syncMarkdown(ordinary, [{ slug: "permanent", openLine: 3, closeLine: 8, title: "Checkout", href: "permanent.svg" }]);

for (const [label, source, slug, line] of [
  ["ordinary", ordinary, "checkout", 3],
  ["hidden managed", managed.replace("# Checkout", "# Renamed"), "permanent", 7],
  ["legacy managed", `<!-- diagrammo:sync permanent -->\n<details>\n${ordinary}\n</details>\n<!-- /diagrammo:sync permanent -->`, "permanent", 5],
]) {
  test(`prepareDocuments: ${label} preserves input, locations, options and identity`, async () => {
    const { prepareDocuments } = await import("../src/document.mjs");
    const inputs = [{ name: "input.md", source }];
    const before = structuredClone(inputs);
    const first = prepareDocuments(inputs, { theme: "slate", renderer: "auto" });
    assert.deepEqual(first, prepareDocuments(inputs, { theme: "slate", renderer: "auto" }));
    assert.deepEqual(inputs, before);
    const [b] = first[0].blocks;
    assert.equal(b.slug, slug);
    assert.equal(b.line, line);
    assert.equal(b.codeLine, line + 1);
    assert.equal(b.renderer, "swimlane");
    assert.equal(b.effectiveOptions.theme, "candy");
    assert.equal(source.split("\n")[b.line - 1], "```mermaid theme=midnight");
    assert.equal(b.code.includes("--&gt;"), false);
    assert.ok(b.identity);
  });
}

test("prepareDocuments: reserves managed identities across the complete batch before allocation", async () => {
  const { prepareDocuments } = await import("../src/document.mjs");
  const documents = prepareDocuments([
    { name: "plain.md", source: ordinary.replace("Checkout", "Permanent") },
    { name: "managed.md", source: managed },
    { name: "last.md", source: ordinary.replace("Checkout", "Permanent") },
  ]);
  assert.deepEqual(documents.map((d) => d.blocks[0].slug), ["permanent-2", "permanent", "permanent-3"]);
  const duplicate = prepareDocuments([{ name: "a", source: managed }, { name: "b", source: managed }], {}, { sync: true });
  assert.ok(duplicate.some((d) => d.diagnostics.some((i) => i.level === "error" && /duplicate managed identity/.test(i.message))));
});

for (const [option, level] of [["renderer=wat", "error"], ["theme=wat", "error"], ['laneLabels="wat"', "warn"]]) {
  test(`prepareDocuments: keeps ${option} severity ${level}`, async () => {
    const { prepareDocuments } = await import("../src/document.mjs");
    const [doc] = prepareDocuments([{ name: "input", source: ordinary.replace("theme=midnight", option).replace("%%| theme: candy\n", "") }]);
    assert.ok(doc.blocks[0].issues.some((i) => i.level === level));
  });
}

test("prepareDocuments: null block defaults keep the host theme and renderer", async () => {
  const { prepareDocuments } = await import("../src/document.mjs");
  const source = ordinary.replace("%%| theme: candy", "%%| theme: null\n%%| renderer: null");
  const [doc] = prepareDocuments([{ name: "input", source }], { theme: "midnight", renderer: "mermaid" });
  assert.equal(doc.blocks[0].effectiveOptions.theme, "midnight");
  assert.equal(doc.blocks[0].renderer, "mermaid");
});

for (const [label, prefix] of [
  ["incomplete identity", "```text\n<!-- diagrammo:sync x -->\n```\n\n"],
  ["invalid identity", "~~~~text\n<!-- diagrammo:sync bad_slug -->\n~~~\n~~~~~\n\n"],
  ["invalid hidden source", "```text\n<!-- diagrammo:source wrong -->\n```\n\n"],
  ["incomplete hidden source", "~~~text\n<!-- diagrammo:source\n~~~\n\n"],
  ["complete duplicate example", "````markdown\n" + managed + "`````\n\n"],
]) {
  test(`prepareDocuments: literal ${label} has no ownership or document diagnostic`, async () => {
    const { prepareDocuments } = await import("../src/document.mjs");
    const inputs = Object.freeze([Object.freeze({ name: "input.md", source: prefix + managed })]);
    for (const sync of [false, true]) {
      const [doc] = prepareDocuments(inputs, {}, { sync });
      assert.deepEqual(doc.diagnostics, []);
      assert.equal(doc.blocks.length, 1);
      const [block] = doc.blocks;
      assert.equal(block.slug, "permanent");
      assert.equal(block.line, prefix.split("\n").length + 6);
      assert.equal(doc.markdown.slice(0, prefix.length), prefix);
      assert.equal(doc.source, prefix + managed);
      assert.deepEqual([doc], prepareDocuments(inputs, {}, { sync }));
    }
  });
}

for (const marker of ["<!-- diagrammo:sync x -->", "<!-- diagrammo:sync bad_slug -->", "<!-- diagrammo:source wrong -->"]) {
  test(`prepareDocuments: real ${marker} stays document-fatal at its raw line`, async () => {
    const { prepareDocuments } = await import("../src/document.mjs");
    const source = "Before\n\n" + marker + "\n" + ordinary;
    for (const sync of [false, true]) {
      const [doc] = prepareDocuments([{ name: "input", source }], {}, { sync });
      assert.deepEqual(doc.blocks, []);
      assert.equal(doc.diagnostics.length, 1);
      assert.equal(doc.diagnostics[0].line, 3);
      assert.equal(doc.diagnostics[0].level, "error");
      assert.equal(doc.source, source);
    }
  });
}
