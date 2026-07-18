// build-pages.mjs — builds the minimal, deterministic GitHub Pages artifact for the browser
// editor. Deletes and recreates outRoot, copies only the runtime files the editor actually
// loads (never node_modules/, package*.json, test/, scripts/, .github/, or non-browser src/
// modules), vendors the three locked ESM libraries from node_modules into outRoot/web/vendor/,
// and emits web/vendor/THIRD_PARTY_LICENSES.txt reproducing those libraries' exact upstream
// license texts (required for redistribution). Accepts injected repoRoot/nodeModulesRoot/outRoot
// so tests can build against a temp fixture instead of the real repository. Fails loudly (throws)
// if any required source file is missing, matching scripts/test.mjs's fail-loud style.
import { writeFileSync, readFileSync, mkdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Runtime files the editor actually loads (traced from the live import graph): index.html, the
// web/*.mjs modules + stylesheet, the browser-safe src/*.mjs closure, and the curated example
// Markdown files the dropdown fetches at runtime.
const ROOT_FILES = ["index.html"];

const WEB_FILES = [
  "web/style.css",
  "web/app.mjs",
  "web/convert.mjs",
  "web/examples.mjs",
  "web/markdown-preview.mjs",
  "web/export-zip.mjs",
];

// Exactly the 7-module browser-safe closure: swimlane -> extract/themes/text/diag/layout;
// text -> font-metrics. src/index.mjs, src/mermaid.mjs (node: builtins), and src/gallery.mjs are
// deliberately excluded.
const SRC_FILES = [
  "src/extract.mjs",
  "src/swimlane.mjs",
  "src/themes.mjs",
  "src/diag.mjs",
  "src/text.mjs",
  "src/layout.mjs",
  "src/font-metrics.mjs",
];

const EXAMPLE_FILES = [
  "kitchen-sink.md",
  "pills-stress.md",
  "examples/showcase.md",
  "docs/how-it-works.md",
];

// The three npm-locked, Node-18-safe browser ESM entry points, vendored so the site ships with
// no runtime CDN dependency. Copied from the *injected* nodeModulesRoot, never a committed copy.
const VENDOR_FILES = [
  { from: "marked/lib/marked.esm.js", to: "web/vendor/marked.esm.js" },
  { from: "dompurify/dist/purify.es.mjs", to: "web/vendor/purify.es.mjs" },
  { from: "fflate/esm/browser.js", to: "web/vendor/fflate.esm.js" },
];

// Redistribution notice source for each vendored library. The vendored ESM files' own headers are
// insufficient for redistribution on their own (fflate's browser.js carries no notice at all;
// marked/dompurify carry only a copyright line plus a license *reference*, not the full text that
// MIT's permission notice and Apache-2.0 §4(a) require), so the build reproduces each package's
// exact upstream LICENSE text — read verbatim from the locked node_modules, never hand-copied —
// into web/vendor/THIRD_PARTY_LICENSES.txt. `pkg` supplies the version + SPDX id; `note` records a
// required attribution or the resolved choice for a dual-licensed component.
const LICENSE_FILE = "web/vendor/THIRD_PARTY_LICENSES.txt";
const VENDOR_LICENSES = [
  { name: "marked", pkg: "marked/package.json", license: "marked/LICENSE.md" },
  {
    name: "dompurify",
    pkg: "dompurify/package.json",
    license: "dompurify/LICENSE",
    note: "Redistributed under the Apache License 2.0 (one of the two options offered by this component's `MPL-2.0 OR Apache-2.0` dual license). Copyright (c) Cure53 and other contributors.",
  },
  { name: "fflate", pkg: "fflate/package.json", license: "fflate/LICENSE" },
];

export function buildSite({ repoRoot = REPO_ROOT, nodeModulesRoot = join(REPO_ROOT, "node_modules"), outRoot = join(REPO_ROOT, "_site") } = {}) {
  rmSync(outRoot, { recursive: true, force: true });
  mkdirSync(outRoot, { recursive: true });

  for (const rel of [...ROOT_FILES, ...WEB_FILES, ...SRC_FILES, ...EXAMPLE_FILES]) {
    copyRequired(join(repoRoot, rel), join(outRoot, rel), rel);
  }

  for (const { from, to } of VENDOR_FILES) {
    copyRequired(join(nodeModulesRoot, from), join(outRoot, to), from);
  }

  writeFileSync(join(outRoot, LICENSE_FILE), renderThirdPartyLicenses(nodeModulesRoot));

  writeFileSync(join(outRoot, ".nojekyll"), "");

  return { outRoot };
}

// Deterministic, fixed-order aggregation of the vendored libraries' exact upstream license texts.
// Reads each package's version/SPDX id from its package.json and its LICENSE verbatim from the
// injected node_modules; throws (fail-loud) if either is missing, matching copyRequired.
function renderThirdPartyLicenses(nodeModulesRoot) {
  const bar = "=".repeat(80);
  const preamble = [
    "Third-party browser libraries",
    "",
    "The files under web/vendor/ are unmodified copies of third-party ESM libraries, vendored",
    "so this site ships no runtime CDN dependency. Their license notices are reproduced in full",
    "below, as required for redistribution. Each library's original source header is also kept",
    "intact in its vendored file.",
    "",
  ].join("\n");

  const sections = VENDOR_LICENSES.map(({ name, pkg, license, note }) => {
    const pkgPath = join(nodeModulesRoot, pkg);
    const licensePath = join(nodeModulesRoot, license);
    if (!existsSync(pkgPath)) {
      throw new Error(`build:pages — required source is missing: ${pkg} (expected at ${pkgPath})`);
    }
    if (!existsSync(licensePath)) {
      throw new Error(`build:pages — required source is missing: ${license} (expected at ${licensePath})`);
    }
    const { version, license: spdx } = JSON.parse(readFileSync(pkgPath, "utf8"));
    const text = readFileSync(licensePath, "utf8").replace(/\s+$/, "");
    const header = [
      bar,
      `${name} ${version}`,
      `SPDX-License-Identifier: ${spdx}`,
      ...(note ? [note] : []),
      bar,
    ].join("\n");
    return `${header}\n\n${text}\n`;
  });

  return `${preamble}\n${sections.join("\n")}`;
}

function copyRequired(src, dest, label) {
  if (!existsSync(src)) {
    throw new Error(`build:pages — required source is missing: ${label} (expected at ${src})`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest);
}

// Thin CLI wrapper: `node scripts/build-pages.mjs` builds the real repo into <repo>/_site.
// Fails loudly by letting the throw propagate (matches scripts/test.mjs's style).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { outRoot } = buildSite();
  console.log(`build:pages — wrote ${outRoot}`);
}
