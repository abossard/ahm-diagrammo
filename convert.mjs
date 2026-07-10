#!/usr/bin/env node
// Deprecated — use `npx ahm-diagrammo <article.md> -o <outDir> -r mermaid`. This shim forwards there.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const [, , md, out] = process.argv;
if (!md || !out) { console.error("Usage: node convert.mjs <article.md> <outDir>"); process.exit(1); }
console.error(`convert.mjs is deprecated — forwarding to: diagrammo ${md} -o ${out} -r mermaid --no-gallery`);
const cli = fileURLToPath(new URL("./bin/diagrammo.mjs", import.meta.url));
process.exit(spawnSync(process.execPath, [cli, md, "-o", out, "-r", "mermaid", "--no-gallery"], { stdio: "inherit" }).status ?? 1);
