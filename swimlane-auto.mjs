#!/usr/bin/env node
// Deprecated — use `npx ahm-diagrammo <article.md> -o <outDir>`. This shim forwards there.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const [, , md, out = "out-swimlane"] = process.argv;
if (!md) { console.error("Usage: node swimlane-auto.mjs <article.md> <outDir>"); process.exit(1); }
console.error(`swimlane-auto.mjs is deprecated — forwarding to: diagrammo ${md} -o ${out} -r swimlane --no-gallery`);
const cli = fileURLToPath(new URL("./bin/diagrammo.mjs", import.meta.url));
process.exit(spawnSync(process.execPath, [cli, md, "-o", out, "-r", "swimlane", "--no-gallery"], { stdio: "inherit" }).status ?? 1);
