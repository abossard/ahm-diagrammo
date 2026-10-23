import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderAhm } from "ahm-diagrammo";

const input = process.argv[2];
const output = process.argv[3];

if (!input || !output) {
  console.error("Usage: node examples/source-to-svg.mjs <input.mmd> <output.svg>");
  process.exit(1);
}

const source = readFileSync(resolve(input), "utf8");
const result = renderAhm(source, { direction: "BT", lanes: true, theme: "portal" });

mkdirSync(dirname(resolve(output)), { recursive: true });
writeFileSync(resolve(output), result.svg, "utf8");
console.log(`Wrote ${output} (${result.width}x${result.height})`);
