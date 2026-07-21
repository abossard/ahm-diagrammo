// build-pages.test.mjs — proves scripts/build-pages.mjs builds a minimal, deterministic Pages
// artifact using dependency-injected repoRoot/nodeModulesRoot/outRoot against temp fixtures
// (mkdtempSync(tmpdir()) + exit cleanup, matching test/cli.test.mjs's tmp() convention). Never
// renames or touches the real repository's node_modules/src/web to prove the "missing input"
// case — the fixture simply omits a file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { buildSite } from "../scripts/build-pages.mjs";

// Cleanup registry: a single process "exit" listener (registered once, at module load) removes
// every temp dir any tmp() call has created — instead of one new listener per call, which trips
// Node's MaxListenersExceededWarning once a test file calls tmp() more than 10 times (matches
// test/cli.test.mjs's identical fix for the same pattern).
const cleanupDirs = [];
process.on("exit", () => {
  for (const d of cleanupDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});
function tmp() {
  const d = mkdtempSync(join(tmpdir(), "diagrammo-pages-test-"));
  cleanupDirs.push(d);
  return d;
}

function writeFile(root, relPath, content = "") {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

// A minimal fixture that satisfies buildSite's manifest, plus a handful of paths that *must
// never* be copied (present on purpose, so their absence in _site proves an active exclusion,
// not merely that the source lacked them).
function makeFixtureRepo(root) {
  writeFile(root, "index.html", "<html>fixture</html>");
  for (const f of [
    "web/style.css", "web/app.mjs", "web/convert.mjs", "web/examples.mjs",
    "web/markdown-preview.mjs", "web/export-zip.mjs",
  ]) writeFile(root, f, `/* ${f} */`);
  for (const f of [
    "src/extract.mjs", "src/swimlane.mjs", "src/themes.mjs", "src/diag.mjs",
    "src/text.mjs", "src/layout.mjs", "src/font-metrics.mjs",
  ]) writeFile(root, f, `/* ${f} */`);
  for (const f of ["kitchen-sink.md", "pills-stress.md", "examples/showcase.md", "docs/how-it-works.md"]) {
    writeFile(root, f, `# ${f}`);
  }
  // Present but forbidden: buildSite must exclude these even though they exist in the fixture.
  writeFile(root, "package.json", "{}");
  writeFile(root, "package-lock.json", "{}");
  writeFile(root, "src/index.mjs", "export {}");
  writeFile(root, "src/mermaid.mjs", "export {}");
  writeFile(root, "src/gallery.mjs", "export {}");
  writeFile(root, "node_modules/should-not-copy/index.js", "//");
  writeFile(root, "test/should-not-copy.test.mjs", "//");
  writeFile(root, "scripts/should-not-copy.mjs", "//");
  writeFile(root, ".github/workflows/should-not-copy.yml", "//");
}

function makeFixtureNodeModules(root) {
  // Each vendored package supplies its ESM entry, a package.json (version + SPDX id read at build
  // time, never hardcoded), and its LICENSE file (copied verbatim into THIRD_PARTY_LICENSES.txt).
  // Synthetic marker bodies prove the build reads the injected node_modules rather than baking in
  // upstream text; the dompurify SPDX id is the real dual-license string so the OR case is covered.
  writeFile(root, "marked/lib/marked.esm.js", "export const marked = 1;");
  writeFile(root, "marked/package.json", JSON.stringify({ name: "marked", version: "1.2.3-fixture", license: "MIT" }));
  writeFile(root, "marked/LICENSE.md", "MARKED-FIXTURE-LICENSE permission notice body.\n");
  writeFile(root, "dompurify/dist/purify.es.mjs", "export default { sanitize(x) { return x; } };");
  writeFile(root, "dompurify/package.json", JSON.stringify({ name: "dompurify", version: "4.5.6-fixture", license: "(MPL-2.0 OR Apache-2.0)" }));
  writeFile(root, "dompurify/LICENSE", "DOMPURIFY-FIXTURE-APACHE-LICENSE body.\n");
  writeFile(root, "fflate/esm/browser.js", "export function zipSync() {}");
  writeFile(root, "fflate/package.json", JSON.stringify({ name: "fflate", version: "7.8.9-fixture", license: "MIT" }));
  writeFile(root, "fflate/LICENSE", "FFLATE-FIXTURE-MIT-LICENSE body.\n");
}

const REQUIRED_PATHS = [
  "index.html",
  "web/style.css", "web/app.mjs", "web/convert.mjs", "web/examples.mjs",
  "web/markdown-preview.mjs", "web/export-zip.mjs",
  "src/extract.mjs", "src/swimlane.mjs", "src/themes.mjs", "src/diag.mjs",
  "src/text.mjs", "src/layout.mjs", "src/font-metrics.mjs",
  "kitchen-sink.md", "pills-stress.md", "examples/showcase.md", "docs/how-it-works.md",
  ".nojekyll",
  "web/vendor/marked.esm.js", "web/vendor/purify.es.mjs", "web/vendor/fflate.esm.js",
  "web/vendor/THIRD_PARTY_LICENSES.txt",
];

const FORBIDDEN_PATHS = [
  "node_modules", "package.json", "package-lock.json",
  "src/index.mjs", "src/mermaid.mjs", "src/gallery.mjs",
  "test", "scripts", ".github",
];

test("buildSite: copies every required runtime path, including the three vendored libraries", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);

  buildSite({ repoRoot, nodeModulesRoot, outRoot });

  for (const p of REQUIRED_PATHS) {
    assert.ok(existsSync(join(outRoot, p)), `expected ${p} to exist in the built site`);
  }
});

test("buildSite: never copies node_modules, package manifests, dev tooling, or non-browser-safe src modules", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);

  buildSite({ repoRoot, nodeModulesRoot, outRoot });

  for (const p of FORBIDDEN_PATHS) {
    assert.ok(!existsSync(join(outRoot, p)), `expected ${p} to be absent from the built site`);
  }
});

test("buildSite: two builds from the same fixture produce byte-identical trees (deterministic)", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);
  const outA = join(root, "_site-a");
  const outB = join(root, "_site-b");

  buildSite({ repoRoot, nodeModulesRoot, outRoot: outA });
  buildSite({ repoRoot, nodeModulesRoot, outRoot: outB });

  // diff -r exits non-zero (and execFileSync throws) on any difference, including file lists.
  assert.doesNotThrow(() => execFileSync("diff", ["-r", outA, outB]));
});

test("buildSite: throws when a required source file is missing from the fixture (never by renaming real node_modules)", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);
  rmSync(join(repoRoot, "web/markdown-preview.mjs"));

  assert.throws(() => buildSite({ repoRoot, nodeModulesRoot, outRoot }));
});

test("buildSite: throws when a vendored library file is missing from the injected node_modules fixture", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);
  rmSync(join(nodeModulesRoot, "fflate/esm/browser.js"));

  assert.throws(() => buildSite({ repoRoot, nodeModulesRoot, outRoot }));
});

test("buildSite: emits THIRD_PARTY_LICENSES.txt with each vendored library's version, SPDX id, and exact upstream license text", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);

  buildSite({ repoRoot, nodeModulesRoot, outRoot });

  const notices = readFileSync(join(outRoot, "web/vendor/THIRD_PARTY_LICENSES.txt"), "utf8");
  // Name + version read from each package.json (not hardcoded), one section per vendored library.
  assert.match(notices, /marked 1\.2\.3-fixture/);
  assert.match(notices, /dompurify 4\.5\.6-fixture/);
  assert.match(notices, /fflate 7\.8\.9-fixture/);
  // SPDX ids preserved verbatim, including the dompurify dual-license "OR" string.
  assert.match(notices, /SPDX-License-Identifier: MIT/);
  assert.match(notices, /SPDX-License-Identifier: \(MPL-2\.0 OR Apache-2\.0\)/);
  // Exact upstream LICENSE bodies copied verbatim from the injected node_modules.
  assert.ok(notices.includes("MARKED-FIXTURE-LICENSE permission notice body."));
  assert.ok(notices.includes("DOMPURIFY-FIXTURE-APACHE-LICENSE body."));
  assert.ok(notices.includes("FFLATE-FIXTURE-MIT-LICENSE body."));
  // The resolved choice for the OR-licensed component is recorded alongside its section.
  assert.match(notices, /Apache License 2\.0.*dual license/);
});

test("buildSite: throws when a vendored library's LICENSE file is missing from the injected node_modules fixture", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);
  rmSync(join(nodeModulesRoot, "dompurify/LICENSE"));

  assert.throws(() => buildSite({ repoRoot, nodeModulesRoot, outRoot }));
});

test("buildSite: deletes and recreates outRoot, leaving no stale file from a prior build", () => {
  const root = tmp();
  const repoRoot = join(root, "repo");
  const nodeModulesRoot = join(root, "node_modules");
  const outRoot = join(root, "_site");
  makeFixtureRepo(repoRoot);
  makeFixtureNodeModules(nodeModulesRoot);

  mkdirSync(outRoot, { recursive: true });
  writeFileSync(join(outRoot, "stale-leftover-file.txt"), "should be removed");

  buildSite({ repoRoot, nodeModulesRoot, outRoot });

  assert.ok(!existsSync(join(outRoot, "stale-leftover-file.txt")));
  assert.ok(existsSync(join(outRoot, "index.html")));
});
