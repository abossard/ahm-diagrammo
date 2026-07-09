// render.mjs — CLI: render a scene module to an SVG.
// Usage: node render.mjs scene-appservice.mjs ../out-arch/appservice-baseline.svg
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { renderScene } from "./azure-arch.mjs";

const [, , sceneFile, outArg] = process.argv;
const out = outArg || "../out-arch/appservice-baseline.svg";
const mod = await import("./" + sceneFile.replace(/^\.\//, ""));
const svg = renderScene(mod.scene);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, svg, "utf8");
console.log(`wrote ${out} (${mod.scene.width}x${mod.scene.height}), foreignObject=${(svg.match(/foreignObject/g) || []).length}`);
