// End-to-end CLI tests: real process spawns, real files, real exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "diagrammo.mjs");
const FIX = join(ROOT, "test", "fixtures");

// Cleanup registry: a single process "exit" listener (registered once, at module load) removes
// every temp dir any tmp() call has created — instead of one new listener per call, which trips
// Node's MaxListenersExceededWarning once a test file calls tmp() more than 10 times.
const cleanupDirs = [];
process.on("exit", () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "diagrammo-test-"));
  cleanupDirs.push(d);
  return d;
}
// run CLI, never throw on nonzero exit
async function run(...argv) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [CLI, ...argv]);
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}
// same as run(), but in a chosen working directory (for relative -o/input path resolution tests)
async function runIn(cwd, ...argv) {
  try {
    const { stdout, stderr } = await pexec(process.execPath, [CLI, ...argv], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

test("renders a healthy file: exit 0, svg + manifest + gallery, technical log", async () => {
  const out = tmp();
  const r = await run(join(ROOT, "kitchen-sink.md"), "-o", out);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /kitchen-sink\.md: 1 mermaid block/);
  assert.match(r.stdout, /ok\s+.*kitchen-sink\.md:\d+\s+kitchen-sink-health-model\.svg\s+\[swimlane · portal\]\s+\(\d+ nodes, \d+ lanes, \d+×\d+\)/);
  assert.ok(existsSync(join(out, "kitchen-sink-health-model.svg")));
  assert.ok(existsSync(join(out, "gallery.html")));
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.length, 1);
  assert.equal(manifest[0].renderer, "swimlane");
  assert.ok(manifest[0].line >= 1);
});

test("--list explains detection without writing files", async () => {
  const out = tmp();
  const r = await run(join(FIX, "torture-deep.md"), "--list", "-o", out);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /torture-deep\.md:\d+\s+deep-model-with-lane-skipping-edges\s+→\s+swimlane · portal/);
  assert.ok(!existsSync(join(out, "manifest.json")), "--list must not write");
});

test("broken blocks fail with file:line and per-line parse warnings; exit 1", async () => {
  const out = tmp();
  const r = await run(join(FIX, "errors.md"), "-o", out, "-r", "swimlane");
  assert.equal(r.code, 1);
  // garbage block: FAIL with position and reason (errors go to stderr, like a compiler)
  assert.match(r.stderr, /FAIL .*errors\.md:5\s+garbage-that-parses-to-nothing: no nodes parsed — \d+ unrecognized line\(s\), first at line \d+/);
  // its unrecognized lines are itemized with absolute line numbers
  assert.match(r.stderr, /errors\.md:7\s+unrecognized line: "this is not === valid mermaid at all"/);
  assert.match(r.stderr, /errors\.md:9\s+unrecognized line/);
  // empty block fails too
  assert.match(r.stderr, /FAIL .*errors\.md:14\s+empty-block: no nodes parsed/);
  // unknown theme is an error bound to its fence line
  assert.match(r.stderr, /FAIL .*errors\.md:19\s+unknown-theme: unknown theme "neon"/);
  // unknown option key + bad lanes are warnings, block still renders
  assert.match(r.stderr, /unknown option "colour"/);
  assert.match(r.stderr, /"lanes" should be a list/);
  assert.match(r.stdout, /ok .*unknown-option-key-and-bad-lanes\.svg/);
  // summary counts what happened
  assert.match(r.stdout, /Rendered 1\/4 diagrams/);
});

test("--strict turns warnings into a failing run", async () => {
  const out = tmp();
  // torture-weird renders fine but emits cycle/self-loop warnings
  const relaxed = await run(join(FIX, "torture-weird.md"), "-o", out);
  assert.equal(relaxed.code, 0, relaxed.stderr);
  const strict = await run(join(FIX, "torture-weird.md"), "-o", tmp(), "--strict");
  assert.equal(strict.code, 1);
});

test("--verbose logs parsed edges and folds", async () => {
  const r = await run(join(ROOT, "kitchen-sink.md"), "-o", tmp(), "--verbose");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /info\s+.*edge web → shop/);
  assert.match(r.stderr, /info\s+.*folded signal "webSig"/);
  assert.match(r.stderr, /info\s+.*graph: \d+ nodes, \d+ edges, \d+ lanes/);
});

test("bad CLI arguments fail fast with clear messages", async () => {
  const noFile = await run();
  assert.equal(noFile.code, 1);
  assert.match(noFile.stdout, /Usage:/);
  const badTheme = await run("x.md", "-t", "sparkles");
  assert.equal(badTheme.code, 1);
  assert.match(badTheme.stderr, /unknown theme "sparkles"/);
  const badRenderer = await run("x.md", "-r", "pixels");
  assert.equal(badRenderer.code, 1);
  assert.match(badRenderer.stderr, /unknown renderer "pixels"/);
  const missing = await run("does-not-exist.md");
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /cannot read does-not-exist\.md/);
  for (const option of ["-o", "--theme", "-r"]) {
    const missingValue = await run("x.md", option);
    assert.equal(missingValue.code, 1);
    assert.match(missingValue.stderr, new RegExp(`option ${option.replace("-", "\\-")} requires a value`));
    assert.doesNotMatch(missingValue.stderr, /\n\s+at /);
  }
});

test("--no-gallery skips gallery.html but keeps svg + manifest", async () => {
  const out = tmp();
  const r = await run(join(ROOT, "kitchen-sink.md"), "-o", out, "--no-gallery");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(out, "kitchen-sink-health-model.svg")));
  assert.ok(existsSync(join(out, "manifest.json")));
  assert.ok(!existsSync(join(out, "gallery.html")));
});

test("multiple files aggregate into one manifest with per-file sources", async () => {
  const out = tmp();
  const r = await run(join(ROOT, "kitchen-sink.md"), join(ROOT, "pills-stress.md"), "-o", out);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.equal(manifest.length, 2);
  assert.ok(manifest.some((m) => m.source.includes("kitchen-sink.md")));
  assert.ok(manifest.some((m) => m.source.includes("pills-stress.md")));
});

test("duplicate slugs across input files get distinct output names", async () => {
  const out = tmp();
  const source = join(ROOT, "kitchen-sink.md");
  const r = await run(source, source, "-o", out);
  assert.equal(r.code, 0, r.stderr);
  const manifest = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.map((m) => m.svg), ["kitchen-sink-health-model.svg", "kitchen-sink-health-model-2.svg"]);
  assert.ok(existsSync(join(out, manifest[0].svg)));
  assert.ok(existsSync(join(out, manifest[1].svg)));
});

test("legacy wrappers forward to the CLI with a deprecation note", async () => {
  const out = tmp();
  const sw = await pexec(process.execPath, [join(ROOT, "swimlane-auto.mjs"), join(ROOT, "kitchen-sink.md"), out]);
  assert.match(sw.stderr, /deprecated — forwarding to: diagrammo/);
  assert.match(sw.stdout, /Rendered 1\/1 diagrams/);
  assert.ok(existsSync(join(out, "kitchen-sink-health-model.svg")));
  assert.ok(existsSync(join(out, "manifest.json")));
  // missing args still fail with usage
  const bad = await run(); // reuse: no-arg CLI covered elsewhere; check the shim directly
  assert.equal(bad.code, 1);
  const shimBad = await pexec(process.execPath, [join(ROOT, "convert.mjs")]).catch((e) => e);
  assert.equal(shimBad.code, 1);
  assert.match(String(shimBad.stderr), /Usage: node convert\.mjs/);
});

// ---- --sync-markdown: real CLI end-to-end mutation/idempotency/path-resolution proof ----------

const HEALTH_MERMAID = [
  "flowchart BT",
  '    a["A<br/>healthy"] --> b["B<br/>healthy"]',
  "    classDef green fill:#f2f8f2,stroke:#a0d8a0;",
  "    class a,b green;",
].join("\n");

function healthDoc(heading = "Checkout") {
  return [`## ${heading}`, "", "```mermaid", HEALTH_MERMAID, "```", "", "More prose stays put."].join("\n") + "\n";
}

test("--sync-markdown appears in --help output", async () => {
  const r = await run("--help");
  assert.match(r.stdout, /--sync-markdown/);
});

test("--sync-markdown: default (no flag) leaves Markdown byte-unchanged", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const original = healthDoc();
  writeFileSync(mdPath, original, "utf8");
  const r = await run(mdPath, "-o", join(dir, "out"));
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(mdPath, "utf8"), original);
});

test("--sync-markdown: first run rewrites the fence into a managed block and writes the SVG", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc(), "utf8");
  const outDir = join(dir, "out");
  const r = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(join(outDir, "checkout.svg")));
  const synced = readFileSync(mdPath, "utf8");
  assert.match(synced, /<!-- diagrammo:sync checkout -->\n!\[Checkout\]\(out\/checkout\.svg\)\n\n<details>\n<summary>Mermaid source<\/summary>\n\n```mermaid\nflowchart BT/);
  assert.doesNotMatch(synced, /<details open/);
  assert.match(synced, /<\/details>\n<!-- \/diagrammo:sync checkout -->/);
  assert.match(synced, /More prose stays put\./);
});

test("--sync-markdown: rerunning unmodified is byte-identical (idempotent)", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc(), "utf8");
  const outDir = join(dir, "out");
  const r1 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const afterFirst = readFileSync(mdPath, "utf8");
  const r2 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const afterSecond = readFileSync(mdPath, "utf8");
  assert.equal(afterSecond, afterFirst);
  assert.equal((afterSecond.match(/diagrammo:sync checkout/g) || []).length, 2);
});

test("--sync-markdown: editing the inner fence then rerunning updates the SVG and keeps a single wrapper", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc(), "utf8");
  const outDir = join(dir, "out");
  const r1 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const svgPath = join(outDir, "checkout.svg");
  const svgBefore = readFileSync(svgPath, "utf8");
  const synced = readFileSync(mdPath, "utf8");
  const edited = synced.replace("A<br/>healthy", "A2<br/>healthy");
  assert.notEqual(edited, synced, "expected the fixture edit to actually change the fence");
  writeFileSync(mdPath, edited, "utf8");
  const r2 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const svgAfter = readFileSync(svgPath, "utf8");
  assert.notEqual(svgAfter, svgBefore);
  const finalMd = readFileSync(mdPath, "utf8");
  assert.equal((finalMd.match(/diagrammo:sync checkout/g) || []).length, 2);
  assert.match(finalMd, /A2<br\/>healthy/);
});

test("--sync-markdown: a file with multiple mermaid blocks maps each managed block to the right SVG", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const doc = [
    "## First", "", "```mermaid", HEALTH_MERMAID, "```", "",
    "## Second", "", "```mermaid", HEALTH_MERMAID.replace("A<br/>healthy", "X<br/>healthy"), "```", "",
  ].join("\n");
  writeFileSync(mdPath, doc, "utf8");
  const outDir = join(dir, "out");
  const r = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r.code, 0, r.stderr);
  const synced = readFileSync(mdPath, "utf8");
  assert.match(synced, /<!-- diagrammo:sync first -->[\s\S]*?!\[First\]\(out\/first\.svg\)[\s\S]*?<!-- \/diagrammo:sync first -->/);
  assert.match(synced, /<!-- diagrammo:sync second -->[\s\S]*?!\[Second\]\(out\/second\.svg\)[\s\S]*?<!-- \/diagrammo:sync second -->/);
  assert.ok(existsSync(join(outDir, "first.svg")));
  assert.ok(existsSync(join(outDir, "second.svg")));
});

test("--sync-markdown: a nested Markdown file with a differently-nested -o resolves a correct relative href", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "sub", "dir"), { recursive: true });
  const mdPath = join(dir, "sub", "dir", "page.md");
  writeFileSync(mdPath, healthDoc(), "utf8");
  const r = await runIn(dir, join("sub", "dir", "page.md"), "-o", join("out", "assets"), "--sync-markdown");
  assert.equal(r.code, 0, r.stderr);
  const synced = readFileSync(mdPath, "utf8");
  const m = synced.match(/!\[Checkout\]\((\S+)\)/);
  assert.ok(m, synced);
  assert.equal(m[1], "../../out/assets/checkout.svg");
  assert.ok(existsSync(resolve(dirname(mdPath), m[1])));
});

test("--sync-markdown: a real render failure leaves the Markdown unchanged and reports the existing diagnostic", async () => {
  const dir = tmp();
  const mdPath = join(dir, "errors.md");
  const original = readFileSync(join(FIX, "errors.md"), "utf8");
  writeFileSync(mdPath, original, "utf8");
  const r = await run(mdPath, "-o", join(dir, "out"), "-r", "swimlane", "--sync-markdown");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /FAIL .*errors\.md:5\s+garbage-that-parses-to-nothing: no nodes parsed/);
  assert.equal(readFileSync(mdPath, "utf8"), original);
});

test("--sync-markdown: a malformed managed marker leaves the Markdown unchanged with a nonzero exit", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const corrupted = [
    "<!-- diagrammo:sync checkout -->",
    "![Checkout](checkout.svg)",
    "",
    "<details>",
    "<summary>Mermaid source</summary>",
    "",
    "```mermaid",
    HEALTH_MERMAID,
    "```",
    "",
    "</details>",
    // begin marker on purpose has no matching end marker
  ].join("\n") + "\n";
  writeFileSync(mdPath, corrupted, "utf8");
  const r = await run(mdPath, "-o", join(dir, "out"), "--sync-markdown");
  assert.equal(r.code, 1);
  assert.match(r.stderr, /error: cannot sync .*doc\.md.*missing its end marker/);
  assert.equal(readFileSync(mdPath, "utf8"), corrupted);
});

test("--sync-markdown: a marker with an unsafe slug (bad_slug) fails loudly before any write, with input bytes unchanged and no nested wrapper/temp", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const corrupted = [
    "<!-- diagrammo:sync bad_slug -->",
    "![Checkout](checkout.svg)",
    "",
    "<details>",
    "<summary>Mermaid source</summary>",
    "",
    "```mermaid",
    HEALTH_MERMAID,
    "```",
    "",
    "</details>",
    "<!-- /diagrammo:sync bad_slug -->",
  ].join("\n") + "\n";
  writeFileSync(mdPath, corrupted, "utf8");
  const outDir = join(dir, "out");
  const r = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /error: cannot sync .*doc\.md.*looks like a managed marker but is not a valid one/);
  assert.equal(readFileSync(mdPath, "utf8"), corrupted, "input bytes must stay unchanged");
  assert.ok(!existsSync(outDir), "must fail before any render/manifest/gallery write");
  const leftoverTmp = readdirSync(dir).filter((f) => f.includes(".diagrammo-sync.tmp"));
  assert.deepEqual(leftoverTmp, [], "no atomic temp file should ever be created");
  assert.equal((corrupted.match(/diagrammo:sync/g) || []).length, 2, "sanity: no nested/double wrapper was ever produced");
});

test("--sync-markdown: a file with zero mermaid blocks is left unchanged and exits 0", async () => {
  const dir = tmp();
  const mdPath = join(dir, "prose.md");
  const original = "# Just prose\n\nNo diagrams here.\n";
  writeFileSync(mdPath, original, "utf8");
  const r = await run(mdPath, "-o", join(dir, "out"), "--sync-markdown");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /prose\.md: 0 mermaid blocks/);
  assert.equal(readFileSync(mdPath, "utf8"), original);
});

test("--sync-markdown: combined with --list writes nothing (--list always wins)", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const original = healthDoc();
  writeFileSync(mdPath, original, "utf8");
  const outDir = join(dir, "out");
  const r = await run(mdPath, "--list", "--sync-markdown", "-o", outDir);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(mdPath, "utf8"), original);
  assert.ok(!existsSync(join(outDir, "manifest.json")));
  assert.ok(!existsSync(join(outDir, "checkout.svg")));
});

// ---- Stable managed identity: heading/title rename must never rename or orphan a managed SVG ---

test("--sync-markdown: renaming the heading after a first sync keeps the marker/href/filename stable", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc("Checkout"), "utf8");
  const outDir = join(dir, "out");
  const r1 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const svgPath = join(outDir, "checkout.svg");
  assert.ok(existsSync(svgPath));
  const svgBefore = readFileSync(svgPath, "utf8");

  // rename the heading AND edit the inner diagram so the SVG bytes genuinely should change
  let synced = readFileSync(mdPath, "utf8");
  synced = synced.replace("## Checkout", "## Payment").replace("A<br/>healthy", "A2<br/>healthy");
  writeFileSync(mdPath, synced, "utf8");

  const r2 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const finalMd = readFileSync(mdPath, "utf8");
  assert.match(finalMd, /<!-- diagrammo:sync checkout -->/);
  assert.doesNotMatch(finalMd, /diagrammo:sync payment/);
  assert.match(finalMd, /!\[Payment\]\(out\/checkout\.svg\)/); // alt text follows the new heading, filename stays
  assert.ok(existsSync(svgPath));
  assert.ok(!existsSync(join(outDir, "payment.svg")), "must not create an orphan payment.svg");
  const svgAfter = readFileSync(svgPath, "utf8");
  assert.notEqual(svgAfter, svgBefore, "checkout.svg content should reflect the edited diagram");
  const manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  assert.ok(manifest.some((m) => m.slug === "checkout" && m.svg === "checkout.svg"));
});

test("--sync-markdown: adding/changing in-fence title=/name= options after a first sync keeps the stable filename and marker", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc("Checkout"), "utf8");
  const outDir = join(dir, "out");
  const r1 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const svgPath = join(outDir, "checkout.svg");
  const svgBefore = readFileSync(svgPath, "utf8");

  let synced = readFileSync(mdPath, "utf8");
  synced = synced
    .replace("```mermaid\nflowchart BT", '```mermaid title="Payment" name="payment"\nflowchart BT')
    .replace("A<br/>healthy", "A3<br/>healthy");
  writeFileSync(mdPath, synced, "utf8");

  const r2 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const finalMd = readFileSync(mdPath, "utf8");
  assert.match(finalMd, /<!-- diagrammo:sync checkout -->/);
  assert.doesNotMatch(finalMd, /diagrammo:sync payment/);
  assert.match(finalMd, /\(out\/checkout\.svg\)/);
  assert.ok(existsSync(svgPath));
  assert.ok(!existsSync(join(outDir, "payment.svg")));
  const svgAfter = readFileSync(svgPath, "utf8");
  assert.notEqual(svgAfter, svgBefore);
});

test("--sync-markdown: syncing a subset of a previously multi-file sync keeps that file's reserved slug and leaves sibling files' assets untouched", async () => {
  const dir = tmp();
  const aPath = join(dir, "a.md");
  const bPath = join(dir, "b.md");
  writeFileSync(aPath, healthDoc("Checkout"), "utf8");
  writeFileSync(bPath, healthDoc("Checkout"), "utf8"); // same heading as a.md -> collides, b gets checkout-2
  const outDir = join(dir, "out");
  const r1 = await run(aPath, bPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const aSvg = join(outDir, "checkout.svg");
  const bSvg = join(outDir, "checkout-2.svg");
  assert.ok(existsSync(aSvg));
  assert.ok(existsSync(bSvg));
  const aHashBefore = readFileSync(aSvg, "utf8");
  const bHashBefore = readFileSync(bSvg, "utf8");
  assert.match(readFileSync(bPath, "utf8"), /<!-- diagrammo:sync checkout-2 -->/);

  // resync only b.md, having edited its inner diagram content, without a.md present at all
  let bMd = readFileSync(bPath, "utf8").replace("A<br/>healthy", "A-b-edited<br/>healthy");
  writeFileSync(bPath, bMd, "utf8");
  const r2 = await run(bPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const bFinal = readFileSync(bPath, "utf8");
  assert.match(bFinal, /<!-- diagrammo:sync checkout-2 -->/);
  assert.match(bFinal, /!\[Checkout\]\(out\/checkout-2\.svg\)/);
  assert.doesNotMatch(bFinal, /diagrammo:sync checkout -->/); // never claims a.md's slug
  assert.notEqual(readFileSync(bSvg, "utf8"), bHashBefore, "b's own SVG should update");
  assert.equal(readFileSync(aSvg, "utf8"), aHashBefore, "a's checkout.svg must stay untouched");
});

test("--sync-markdown: an existing managed slug plus a new plain colliding block in the same run — managed keeps its slug, the new block gets the next unique slug", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  writeFileSync(mdPath, healthDoc("Checkout"), "utf8");
  const outDir = join(dir, "out");
  const r1 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r1.code, 0, r1.stderr);
  const checkoutSvg = join(outDir, "checkout.svg");
  const checkoutSvgBefore = readFileSync(checkoutSvg, "utf8");

  // append a brand-new plain block that deliberately collides on the same heading text
  let synced = readFileSync(mdPath, "utf8");
  synced += "\n" + ["## Checkout", "", "```mermaid", HEALTH_MERMAID.replace("A<br/>healthy", "Z<br/>healthy"), "```", ""].join("\n");
  writeFileSync(mdPath, synced, "utf8");

  const r2 = await run(mdPath, "-o", outDir, "--sync-markdown");
  assert.equal(r2.code, 0, r2.stderr);
  const finalMd = readFileSync(mdPath, "utf8");
  assert.match(finalMd, /<!-- diagrammo:sync checkout -->/);
  assert.match(finalMd, /<!-- diagrammo:sync checkout-2 -->/);
  assert.ok(existsSync(join(outDir, "checkout.svg")));
  assert.ok(existsSync(join(outDir, "checkout-2.svg")));
  assert.equal(readFileSync(checkoutSvg, "utf8"), checkoutSvgBefore, "the pre-existing managed asset must never be overwritten by an unrelated new block");
});

test("--sync-markdown: a managed slug duplicated across two input files targeting the same output directory fails before any write, with a clear diagnostic", async () => {
  const dir = tmp();
  const aPath = join(dir, "a.md");
  const bPath = join(dir, "b.md");
  const managed = (edge) => [
    "<!-- diagrammo:sync checkout -->",
    "![Checkout](checkout.svg)", "",
    "<details>", "<summary>Mermaid source</summary>", "",
    "```mermaid", "flowchart BT", edge, "```", "",
    "</details>", "<!-- /diagrammo:sync checkout -->", "",
  ].join("\n") + "\n";
  writeFileSync(aPath, managed("a --> b"), "utf8");
  writeFileSync(bPath, managed("c --> d"), "utf8");
  const outDir = join(dir, "out");
  const r = await run(aPath, bPath, "-o", outDir, "--sync-markdown");
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /managed slug "checkout" is already used by/);
  assert.ok(!existsSync(outDir), "must fail before any render/manifest/gallery write");
  assert.equal(readFileSync(aPath, "utf8"), managed("a --> b"));
  assert.equal(readFileSync(bPath, "utf8"), managed("c --> d"));
});

// ---- Tightly coupled defects: exit-listener growth and concurrent-sync temp-file race ---------

test("tmp(): repeated calls do not register a new process 'exit' listener each time", () => {
  const before = process.listenerCount("exit");
  for (let i = 0; i < 15; i++) tmp();
  const after = process.listenerCount("exit");
  assert.ok(after <= before + 1, `expected exit listener count to stay bounded (before=${before}, after=${after})`);
});

test("--sync-markdown: two concurrent real syncs of the same file never race the atomic temp file", async () => {
  const dir = tmp();
  const mdPath = join(dir, "doc.md");
  const outDir = join(dir, "out");

  function runOnce() {
    return new Promise((resolveRun) => {
      const child = spawn(process.execPath, [CLI, mdPath, "-o", outDir, "--sync-markdown"]);
      let stderr = "";
      child.stderr.on("data", (d) => { stderr += d; });
      child.on("close", (code) => resolveRun({ code, stderr }));
    });
  }

  const ITER = 12;
  for (let i = 0; i < ITER; i++) {
    writeFileSync(mdPath, healthDoc(), "utf8"); // reset so each pair races on the same starting bytes
    const [r1, r2] = await Promise.all([runOnce(), runOnce()]);
    for (const r of [r1, r2]) assert.equal(r.code, 0, `iter ${i}: ${r.stderr}`);
    const finalMd = readFileSync(mdPath, "utf8");
    assert.match(finalMd, /<!-- diagrammo:sync checkout -->[\s\S]*<!-- \/diagrammo:sync checkout -->/);
    assert.equal((finalMd.match(/diagrammo:sync checkout/g) || []).length, 2);
  }
  const leftoverTmp = readdirSync(dir).filter((f) => f.includes(".diagrammo-sync.tmp"));
  assert.deepEqual(leftoverTmp, [], "no atomic temp file should ever survive a concurrent pair");
});
