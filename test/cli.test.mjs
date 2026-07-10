// End-to-end CLI tests: real process spawns, real files, real exit codes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "diagrammo.mjs");
const FIX = join(ROOT, "test", "fixtures");

function tmp() {
  const d = mkdtempSync(join(tmpdir(), "diagrammo-test-"));
  process.on("exit", () => { try { rmSync(d, { recursive: true, force: true }); } catch {} });
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
