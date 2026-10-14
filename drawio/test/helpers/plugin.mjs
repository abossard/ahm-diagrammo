// The `node:vm` boundary itself lives in `scripts/load-plugin.mjs`, because the generator reaches
// the plugin's semantics through the same boundary; re-exported here so the tests keep one import.
export { PLUGIN_FILE, loadPlugin } from "../../scripts/load-plugin.mjs";

export function entity(id, state = "Healthy", impact = "standard") {
  return {
    id,
    role: "entity",
    ahmId: id,
    localState: state,
    computedState: state,
    impact,
    aggregation: "worstOf",
    style: "",
  };
}

export function dependency(id, source, target, impact = "standard") {
  return { id, role: "dependency", source, target, edgeImpact: impact, style: "" };
}

export function signal(id, owner, state) {
  return { id, role: "signal", owner, state, style: "" };
}

export function model(cells) {
  return { cells: structuredClone(cells) };
}
