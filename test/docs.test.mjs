// Documentation stays true: docs/gallery/source.md is the living feature demo, so every claim in
// it must keep working — renderer detection, all three option channels, themes, custom lanes,
// measurements, and clean geometry. If a feature changes, this test (and the docs) must too.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBlocks, KNOWN_OPTIONS } from "../src/extract.mjs";
import { renderSwimlane, looksLikeHealthModel } from "../src/swimlane.mjs";
import { renderDiagram, resolveRenderer } from "../src/render.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const blocks = extractBlocks(read("docs", "gallery", "source.md"), THEME_NAMES);
const bySlug = Object.fromEntries(blocks.map((b) => [b.slug, b]));
const README = read("README.md");
const FEATURES = read("docs", "FEATURES.md");

test("CLI guidance uses the local checkout, and preparation and rendering each have one documented owner", () => {
  for (const [name, text] of [["README", README], ["FEATURES", FEATURES]]) {
    assert.match(text, /node bin\/diagrammo\.mjs/, `${name}: local-checkout CLI`);
    assert.doesNotMatch(text, /npx (?:--yes )?ahm-diagrammo\b/, `${name}: unpublished npm package`);
  }
  assert.match(README, /src\/document\.mjs/);
  assert.match(README, /src\/render\.mjs/);
  assert.match(read("docs", "how-it-works.md"), /prepareDocuments[\s\S]*renderDiagram/);
});

test("the gallery source carries no option mistakes", () => {
  for (const b of blocks) assert.deepEqual(b.issues, [], `${b.slug}: ${JSON.stringify(b.issues)}`);
});

const CHANNELS = [
  { name: "zero config: the classes alone mark a health model", slug: "health-model-zero-config",
    check: (b) => { assert.equal(looksLikeHealthModel(b.code), true); assert.deepEqual(b.options, {}); } },
  { name: "the fence line sets the theme", slug: "theme-midnight",
    check: (b) => assert.equal(b.options.theme, "midnight") },
  { name: "frontmatter sets title and subtitle", slug: "order-pipeline-health",
    check: (b) => { assert.equal(b.options.title, "Order pipeline health"); assert.equal(b.options.subtitle, "Measurements from the order collectors."); } },
  { name: "frontmatter sets lane names", slug: "lane-names",
    check: (b) => assert.deepEqual(b.options.lanes, ["Storefront", "Order flows", "Services"]) },
  { name: "a directive switches the legend off", slug: "legend-off",
    check: (b) => assert.equal(b.options.legend, false) },
  { name: "a directive hides lane labels", slug: "lane-labels-off",
    check: (b) => assert.equal(b.options.laneLabels, false) },
  { name: "a directive forces the plain Mermaid look on a health model", slug: "plain-mermaid-look",
    check: (b) => { assert.equal(looksLikeHealthModel(b.code), true); assert.equal(resolveRenderer(b.options.renderer, b.code), "mermaid"); } },
  { name: "other diagrams route to the mermaid renderer", slug: "sequence-diagram",
    check: (b) => assert.equal(resolveRenderer(undefined, b.code), "mermaid") },
];
for (const { name, slug, check } of CHANNELS) {
  test(`gallery: ${name} (${slug})`, () => {
    assert.ok(bySlug[slug], `docs/gallery/source.md has no block "${slug}"`);
    check(bySlug[slug]);
  });
}

for (const b of blocks.filter((x) => looksLikeHealthModel(x.code))) {
  test(`gallery health model ${b.slug} renders geometrically clean in its declared theme`, () => {
    const r = renderSwimlane(b.code, {
      theme: b.options.theme || "portal",
      title: b.options.title ?? b.heading,
      subtitle: b.options.subtitle,
      lanes: b.options.lanes,
      legend: b.options.legend,
      laneLabels: b.options.laneLabels,
    });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `${b.slug}:\n  ${geo.join("\n  ")}`);
    assert.deepEqual(verifySvgString(r.svg), []);
  });
}

test("gallery signal-row syntax lands in both looks (value and state per row)", () => {
  const { code } = bySlug["signal-rows"];
  const swimlane = renderDiagram(code, { renderer: "swimlane" }).svg;
  const pele = renderDiagram(code, { renderer: "pele" }).svg;
  for (const svg of [swimlane, pele]) {
    assert.match(svg, /230 ms/);
    assert.match(svg, /2\.4%/);
    assert.match(svg, /1\.2k\/s/);
  }
  assert.match(pele, /∅/, "Pele marks a missing value");
  assert.match(pele, /row-state-unknown/, "Pele treats a row without a state as unknown");
});

// ---- Precision guards: docs stay in lock-step with the code they describe --------------------

test("README and FEATURES list every theme and option key the code exports", () => {
  for (const name of THEME_NAMES) {
    assert.ok(README.includes(name), `README omits theme "${name}"`);
    assert.ok(FEATURES.includes(name), `FEATURES omits theme "${name}"`);
  }
  for (const key of KNOWN_OPTIONS) {
    assert.ok(README.includes("`" + key + "`"), `README omits option key "${key}"`);
    assert.ok(FEATURES.includes("`" + key + "`"), `FEATURES omits option key "${key}"`);
  }
});

test("FEATURES keeps the source-state/static contracts; no doc claims stale neutral trunks", () => {
  assert.match(FEATURES, /connectors take the \*\*source\*\* state color[\s\S]*grey connector strokes are used only for\s+unknown-state sources/i);
  assert.match(FEATURES, /One logical lane always renders as one physical lane band/);
  assert.match(FEATURES, /Rendering is static-only/);

  for (const text of [README, FEATURES]) {
    assert.doesNotMatch(text, /shared trunk[^.\n]*neutral color/i);
    assert.doesNotMatch(text, /trunk-color neutrality/i);
  }
  assert.doesNotMatch(README, /connectors colored by the child's state/i);
});

test("FEATURES documents every CLI flag the binary defines", () => {
  const bin = read("bin", "diagrammo.mjs");
  const binFlags = [...new Set(bin.match(/--[a-z][a-z-]+/g) || [])];
  assert.ok(binFlags.length >= 8, `expected the CLI to define flags, found ${binFlags.length}`);
  for (const flag of binFlags) {
    assert.ok(FEATURES.includes(flag), `FEATURES omits CLI flag "${flag}"`);
  }
});

// ---- Dogfooding: the tool renders its own pipeline, and that figure ships in the docs --------

test("docs/how-it-works.md holds a self-rendered health-model figure that regenerates clean", () => {
  const HOWTO = read("docs", "how-it-works.md");
  const howtoBlocks = extractBlocks(HOWTO, THEME_NAMES);
  const health = howtoBlocks.filter((b) => looksLikeHealthModel(b.code));
  assert.ok(health.length >= 1, "expected >=1 health-model block in how-it-works.md");
  for (const b of health) {
    assert.deepEqual(b.issues, [], `${b.slug}: ${JSON.stringify(b.issues)}`);
    const r = renderSwimlane(b.code, {
      theme: b.options.theme || "portal",
      title: b.options.title ?? b.heading,
      subtitle: b.options.subtitle,
      lanes: b.options.lanes,
      legend: b.options.legend,
    });
    assert.deepEqual(verifyGeometry(r), [], `${b.slug} geometry:\n  ${verifyGeometry(r).join("\n  ")}`);
    assert.deepEqual(verifySvgString(r.svg), []);
  }
  // the exact regeneration command lives next to the source
  assert.match(HOWTO, /node bin\/diagrammo\.mjs docs\/how-it-works\.md -o docs\/assets/);
});

test("the committed pipeline SVG ships under docs/, uses native text, and is embedded", () => {
  const rel = join("docs", "assets", "how-it-works-pipeline.svg");
  const svg = read(rel);
  assert.equal((svg.match(/foreignObject/g) || []).length, 0, "pipeline SVG must not use foreignObject");
  assert.match(svg, /<text/, "pipeline SVG must carry native <text>");
  assert.deepEqual(verifySvgString(svg), []);
  const embed = "assets/how-it-works-pipeline.svg";
  assert.ok(README.includes("docs/" + embed) || FEATURES.includes(embed),
    "pipeline SVG is not embedded from README or FEATURES");
});
