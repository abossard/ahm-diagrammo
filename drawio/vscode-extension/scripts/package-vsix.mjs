#!/usr/bin/env node
// Package VSIX: sync assets then run vsce package.
"use strict";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const extRoot = join(__dirname, "..");

console.log("package-vsix: syncing assets...");
execSync("node scripts/sync-assets.mjs", { cwd: extRoot, stdio: "inherit" });

console.log("package-vsix: packaging VSIX...");
execSync("npx @vscode/vsce@3.9.2 package --skip-license --allow-missing-repository", {
  cwd: extRoot,
  stdio: "inherit"
});

console.log("package-vsix: done");
