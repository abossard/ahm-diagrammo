import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { extractBlocks } from "../../src/extract.mjs";
import { foldSignals, layout, parseGraph } from "../../src/swimlane.mjs";
import { objectAttributes, readDrawioSvg } from "./helpers/artifact.mjs";

const repo = resolve(import.meta.dirname, "../..");
const drawio = resolve(repo, "drawio");
const names = ["hero", "kitchen-sink", "pills-stress"];

function sorted(values) {
  return values.map((value) => JSON.stringify(value)).sort();
}

test("EARS-14 editable example semantics exactly match live source examples", () => {
  for (const name of names) {
    const markdown = readFileSync(resolve(repo, `${name}.md`), "utf8");
    const block = extractBlocks(markdown)[0];
    const graph = foldSignals(parseGraph(block.code));
    const sourceLayout = layout(graph);
    const { model } = readDrawioSvg(resolve(drawio, `examples/${name}.drawio.svg`));
    const entities = objectAttributes(model, "entity");
    const signals = objectAttributes(model, "signal");
    const dependencies = objectAttributes(model, "dependency");

    const sourceEntities = [...graph.nodes.values()].map((node) => ({
      id: node.id,
      label: node.lines[0],
      state: node.state === "alt" ? "standby" : node.state,
      qualifier: node.lines.slice(1, -1).join(" ").replace(/[()]/g, ""),
      lane: Math.min(sourceLayout.lane.get(node.id), 2),
    }));
    const artifactEntities = entities.map((entity) => ({
      id: entity.ahmId,
      label: entity.label,
      state: entity.ahmAuthoredState,
      qualifier: entity.ahmQualifier || "",
      lane: Number(entity.ahmLane),
    }));
    assert.deepEqual(sorted(artifactEntities), sorted(sourceEntities), `${name} entities`);

    const sourceSignals = [...graph.nodes.values()].flatMap((node) =>
      (node.signals || []).map((row) => ({
        owner: node.id,
        label: row.name,
        state: row.state,
      })));
    const artifactSignals = signals.map((signal) => ({
      owner: signal.ahmOwner,
      label: signal.label,
      state: signal.ahmState.toLowerCase(),
    }));
    assert.deepEqual(sorted(artifactSignals), sorted(sourceSignals), `${name} signals`);

    const sourceEdges = graph.edges.map((edge) => ({
      source: edge.from,
      target: edge.to,
      label: edge.label || "",
      impact: /limited/i.test(edge.label || "") ? "limited"
        : /suppressed/i.test(edge.label || "") ? "suppressed" : "standard",
    }));
    const artifactEdges = dependencies.map((edge) => ({
      source: edge.cell.source,
      target: edge.cell.target,
      label: edge.label || "",
      impact: edge.ahmImpact,
    }));
    assert.deepEqual(sorted(artifactEdges), sorted(sourceEdges), `${name} dependencies`);
  }
});
