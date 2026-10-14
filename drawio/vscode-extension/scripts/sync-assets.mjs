#!/usr/bin/env node
// Deterministic asset sync: concat ahm-health.js + ahm-authoring.js, copy library, write manifest.
"use strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// `--root <dir>` relocates the whole source/output tree for tests only. It expects the same
// layout as the repository (`<root>/plugin`, `<root>/library`, `<root>/vscode-extension`).
// Omitted in product use, where the tree is derived from this script's own location.
const rootFlagIndex = process.argv.indexOf("--root");
const drawioRoot = rootFlagIndex >= 0 && process.argv[rootFlagIndex + 1]
  ? resolve(process.argv[rootFlagIndex + 1])
  : join(__dirname, "..", "..");
const extRoot = rootFlagIndex >= 0 ? join(drawioRoot, "vscode-extension") : join(__dirname, "..");

const healthSrc = join(drawioRoot, "plugin", "ahm-health.js");
const authoringSrc = join(extRoot, "plugin-src", "ahm-authoring.js");
const librarySrc = join(drawioRoot, "library", "ahm-diagrammo.xml");
const licenseSrc = join(drawioRoot, "..", "LICENSE");

const pluginDest = join(extRoot, "assets", "plugin", "ahm-diagrammo.plugin.js");
const libraryDest = join(extRoot, "assets", "library", "ahm-diagrammo.xml");
const manifestDest = join(extRoot, "assets", "manifest.json");
const licenseDest = join(extRoot, "LICENSE");

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// Validate sources exist
for (const [name, path] of [["ahm-health.js", healthSrc], ["ahm-authoring.js", authoringSrc], ["ahm-diagrammo.xml", librarySrc]]) {
  if (!existsSync(path)) {
    console.error("sync-assets: missing source file: " + name + " at " + path);
    process.exit(1);
  }
}

// Concat plugin
const healthContent = readFileSync(healthSrc);
const authoringContent = readFileSync(authoringSrc);
const pluginContent = Buffer.concat([healthContent, Buffer.from("\n"), authoringContent]);

ensureDir(pluginDest);
writeFileSync(pluginDest, pluginContent);

// Copy library
ensureDir(libraryDest);
const libraryContent = readFileSync(librarySrc);
writeFileSync(libraryDest, libraryContent);

// Copy LICENSE if available
if (existsSync(licenseSrc)) {
  copyFileSync(licenseSrc, licenseDest);
}

// Write manifest. Content-derived only: no timestamp, so repeated runs are byte-identical.
const manifest = {
  sources: {
    "ahm-health.js": sha256(healthContent),
    "ahm-authoring.js": sha256(authoringContent),
    "ahm-diagrammo.xml": sha256(libraryContent)
  },
  pluginSha256: sha256(pluginContent),
  librarySha256: sha256(libraryContent)
};

writeFileSync(manifestDest, JSON.stringify(manifest, null, 2) + "\n");

console.log("sync-assets: done");
console.log("  plugin sha256: " + manifest.pluginSha256);
console.log("  library sha256: " + manifest.librarySha256);
