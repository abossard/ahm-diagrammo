import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { renderAhm } from "ahm-diagrammo";

const sourcePath = process.argv[2];
const metadataPath = process.argv[3];
const outputDir = process.argv[4];

if (!sourcePath || !metadataPath || !outputDir) {
  console.error("Usage: node examples/render-nested-views.mjs <source.mmd> <metadata.json> <output-dir>");
  process.exit(1);
}

const source = readFileSync(resolve(sourcePath), "utf8");
const metadata = JSON.parse(readFileSync(resolve(metadataPath), "utf8"));

if (!metadata?.models || !metadata?.views) {
  console.error("Metadata must define { models, views }");
  process.exit(1);
}

const baseOptions = {
  direction: "BT",
  lanes: true,
  legend: false,
};

mkdirSync(resolve(outputDir), { recursive: true });

for (const [name, view] of Object.entries(metadata.views)) {
  const nested = { models: metadata.models, view };
  const result = renderAhm(source, { ...baseOptions, nested, idPrefix: `nested-${name}` });
  const output = resolve(outputDir, `${name}.svg`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, result.svg, "utf8");
  console.log(`Wrote ${output} (${result.width}x${result.height})`);
}
