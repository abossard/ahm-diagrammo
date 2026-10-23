// hero.test.mjs — proves hero.md is a genuine, non-trivial specimen of the original 10-entity
// "Workload root" hero model (recovered from the deleted swimlane.mjs reference implementation
// and cross-checked against the pre-SVG hero screenshot, since removed), that the committed
// svg/hero.svg is a real, native, unmodified CLI render of it (never hand-crafted/copied from
// another diagram), and that it is byte-distinct from svg/compare-diagrammo.svg — the diagram it
// used to accidentally duplicate. Own helper set (tmp()/run()), matching test/cli.test.mjs and
// test/examples.test.mjs's per-file convention rather than a shared helper module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES } from "../src/themes.mjs";
import { parseGraph, foldSignals, looksLikeHealthModel, renderSwimlane } from "../src/swimlane.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "diagrammo.mjs");
const read = (...p) => readFileSync(join(ROOT, ...p), "utf8");
const README = () => read("README.md");

// the exact 10 entities the original hero screenshot (since removed) depicted (root + 3 flows +
// 6 components) — recovered verbatim from the deleted swimlane.mjs (git history, commit 914d07a)
const EXPECTED_ENTITIES = [
  "Workload root", "Shop and commerce", "Reporting", "Logistics",
  "Web frontend", "App hosting", "Database", "Analytics store", "Order queue", "Shipping service",
];
// unique labels from the 5-node why-not-just-vanilla-mermaid model svg/hero.svg used to
// accidentally duplicate — must never appear in the recreated hero
const OTHER_MODEL_LABELS = ["Storefront", "Order intake", "Order API", "Payment service"];
const ROOT_ARTIFACTS = [
  {
    name: "kitchen-sink",
    source: "kitchen-sink.md",
    output: "kitchen-sink-health-model.svg",
    committed: join("svg", "kitchen-sink.svg"),
    expectedTitle: "Kitchen sink health model",
    expectedContent: [/API service/, /Secondary region/],
  },
  {
    name: "pills-stress",
    source: "pills-stress.md",
    output: "pills-stress-test.svg",
    committed: join("svg", "pills-stress.svg"),
    expectedTitle: "Pills stress test",
    expectedContent: [/Middle flow/, /Shared dependency/],
  },
];

const cleanupDirs = [];
process.on("exit", () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "diagrammo-hero-test-"));
  cleanupDirs.push(d);
  return d;
}
async function run(...argv) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [CLI, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("hero.md holds exactly one mermaid health-model block modeling all 10 original entities", () => {
  const blocks = extractBlocks(read("hero.md"), THEME_NAMES);
  assert.equal(blocks.length, 1, `expected exactly one mermaid fence, found ${blocks.length}`);
  const [block] = blocks;
  assert.deepEqual(block.issues, [], `hero.md block has parser issues: ${JSON.stringify(block.issues)}`);
  assert.equal(looksLikeHealthModel(block.code), true);

  const g = foldSignals(parseGraph(block.code));
  assert.equal(g.nodes.size, 10, `expected exactly 10 state-bearing entities, found ${g.nodes.size}`);
  const states = new Set([...g.nodes.values()].map((n) => n.state));
  assert.ok(states.has("healthy") && states.has("degraded"), "expected both healthy and degraded entities, matching the original screenshot");

  const problems = [];
  for (const label of EXPECTED_ENTITIES) {
    if (![...g.nodes.values()].some((n) => n.lines.join(" ").includes(label)))
      problems.push(`missing original entity label "${label}"`);
  }
  assert.deepEqual(problems, [], problems.join("\n"));

  // no heading precedes the block on purpose, so the renderer's own default title/subtitle
  // ("diagram" / "Signals live inside each entity...") reproduce the original screenshot exactly
  assert.equal(block.heading, "diagram");
  assert.equal(block.options.title, undefined);
  assert.equal(block.options.subtitle, undefined);
});

test("hero.md renders geometrically clean and distinct from the compare-diagrammo model", () => {
  const blocks = extractBlocks(read("hero.md"), THEME_NAMES);
  const [block] = blocks;
  const r = renderSwimlane(block.code, { theme: "portal", title: block.options.title ?? block.heading });
  assert.deepEqual(verifyGeometry(r), []);
  assert.deepEqual(verifySvgString(r.svg), []);
  for (const label of OTHER_MODEL_LABELS) {
    assert.doesNotMatch(r.svg, new RegExp(label), `hero render must not contain the other model's "${label}"`);
  }
});

test("the committed svg/hero.svg is native, foreignObject-free, and byte-distinct from svg/compare-diagrammo.svg", () => {
  const hero = read("svg", "hero.svg");
  const compareDiagrammo = read("svg", "compare-diagrammo.svg");

  assert.equal((hero.match(/foreignObject/g) || []).length, 0, "hero.svg must not use foreignObject");
  assert.equal((hero.match(/<image[\s>]/gi) || []).length, 0, "hero.svg must not embed a raster <image>");
  assert.equal((hero.match(/data:image/gi) || []).length, 0, "hero.svg must not embed a data-URI image");
  assert.match(hero, /<text/, "hero.svg must carry native <text>");
  assert.deepEqual(verifySvgString(hero), []);

  assert.notEqual(hero, compareDiagrammo, "svg/hero.svg must no longer duplicate svg/compare-diagrammo.svg");
  for (const label of EXPECTED_ENTITIES) assert.match(hero, new RegExp(label), `hero.svg is missing "${label}"`);
  for (const label of OTHER_MODEL_LABELS) assert.doesNotMatch(hero, new RegExp(label), `hero.svg still contains compare-diagrammo's "${label}"`);
});

test("running the documented CLI command against hero.md reproduces svg/hero.svg byte-identically, twice (idempotent)", async () => {
  const committedSvg = read("svg", "hero.svg");

  const out1 = tmp();
  const r1 = await run(join(ROOT, "hero.md"), "-o", out1);
  assert.equal(r1.code, 0, r1.stderr || r1.stdout);
  assert.match(r1.stdout, /swimlane/, "expected the swimlane renderer, not the plain mermaid renderer");
  const svgPath1 = join(out1, "diagram.svg");
  assert.ok(existsSync(svgPath1), "expected hero.md's single block to render to diagram.svg (no heading -> default slug)");
  const fresh1 = readFileSync(svgPath1, "utf8");
  assert.equal(fresh1, committedSvg, "fresh CLI regeneration of hero.md drifted from the committed svg/hero.svg");

  // rerun into a second tmp dir: byte-identical again (idempotent, no hidden nondeterminism)
  const out2 = tmp();
  const r2 = await run(join(ROOT, "hero.md"), "-o", out2);
  assert.equal(r2.code, 0, r2.stderr || r2.stdout);
  const fresh2 = readFileSync(join(out2, "diagram.svg"), "utf8");
  assert.equal(fresh2, fresh1, "two independent regenerations of hero.md must be byte-identical");
});

for (const artifact of ROOT_ARTIFACTS) {
  test(`${artifact.name}: committed svg is native, distinct from hero, and carries expected title/content`, () => {
    const hero = read("svg", "hero.svg");
    const svg = read(artifact.committed);
    assert.notEqual(svg, hero, `${artifact.committed} must not duplicate svg/hero.svg`);
    assert.match(svg, new RegExp(`>${artifact.expectedTitle}<`), `${artifact.committed} title mismatch`);
    for (const marker of artifact.expectedContent) {
      assert.match(svg, marker, `${artifact.committed} is missing expected content marker ${marker}`);
    }
    assert.deepEqual(verifySvgString(svg), []);
  });

  test(`${artifact.name}: CLI regeneration is byte-identical and idempotent`, async () => {
    const committedSvg = read(artifact.committed);
    const source = join(ROOT, artifact.source);

    const out1 = tmp();
    const r1 = await run(source, "-o", out1);
    assert.equal(r1.code, 0, r1.stderr || r1.stdout);
    const rendered1 = join(out1, artifact.output);
    assert.ok(existsSync(rendered1), `expected ${artifact.output} from ${artifact.source}`);
    const fresh1 = readFileSync(rendered1, "utf8");
    assert.equal(fresh1, committedSvg, `fresh CLI regeneration of ${artifact.source} drifted from ${artifact.committed}`);

    const out2 = tmp();
    const r2 = await run(source, "-o", out2);
    assert.equal(r2.code, 0, r2.stderr || r2.stdout);
    const fresh2 = readFileSync(join(out2, artifact.output), "utf8");
    assert.equal(fresh2, fresh1, `${artifact.source} regeneration must stay byte-identical across runs`);
  });
}

const PELE_ARTIFACTS = [
  { source: "hero.md", output: "diagram.svg", committed: join("svg", "pele", "hero.svg") },
  { source: "kitchen-sink.md", output: "kitchen-sink-health-model.svg", committed: join("svg", "pele", "kitchen-sink.svg") },
  { source: "pills-stress.md", output: "pills-stress-test.svg", committed: join("svg", "pele", "pills-stress.svg") },
];
for (const artifact of PELE_ARTIFACTS) {
  test(`${artifact.source}: -r pele regenerates ${artifact.committed} byte-identically`, async () => {
    const out = tmp();
    const r = await run(join(ROOT, artifact.source), "-o", out, "-r", "pele", "--strict");
    assert.equal(r.code, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /\[pele · portal\]/);
    const fresh = readFileSync(join(out, artifact.output), "utf8");
    assert.equal(fresh, read(artifact.committed), `fresh -r pele render of ${artifact.source} drifted from ${artifact.committed}`);
    assert.notEqual(fresh, read(artifact.committed.replace(join("pele", ""), "")), "the Pele look must differ from the swimlane look");
  });
}

test("README's Hero example still points at svg/hero.svg", () => {
  assert.match(README(), /!\[Hero\]\(svg\/hero\.svg\)/, "README's Hero image must resolve to svg/hero.svg");
});
