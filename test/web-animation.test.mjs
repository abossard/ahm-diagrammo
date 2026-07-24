import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReplayScenarios, nextReplayState } from "../web/animation.mjs";

const MODEL = Object.freeze({
  entities: [
    { id: "api", name: "API", state: "degraded", qualifier: null },
    { id: "flow", name: "Order flow", state: "degraded", qualifier: "worstOf" },
    { id: "branch", name: "Queue branch", state: "healthy", qualifier: null },
    { id: "root", name: "Root", state: "degraded", qualifier: null },
  ],
  signals: [
    { id: "s-latency", sourceId: "sig", ownerId: "api", name: "P95", result: "230 ms", state: "degraded" },
    { id: "s-depth", sourceId: "qSig", ownerId: "branch", name: "Queue depth", result: "18", state: "healthy" },
  ],
  relationships: [
    { id: "r-limited", from: "api", to: "flow", label: "limited propagation" },
    { id: "r-branch", from: "api", to: "branch", label: null },
    { id: "r-flow-root", from: "flow", to: "root", label: null },
    { id: "r-branch-root", from: "branch", to: "root", label: null },
    { id: "r-cycle", from: "root", to: "api", label: null },
  ],
});

test("buildReplayScenarios: creates one scenario per signal and no inert choice for a signal-free model", () => {
  const scenarios = buildReplayScenarios(MODEL);
  assert.deepEqual(scenarios.map(({ id, label }) => ({ id, label })), [
    { id: "s-latency", label: "P95 — API" },
    { id: "s-depth", label: "Queue depth — Queue branch" },
  ]);
  assert.deepEqual(buildReplayScenarios({ entities: MODEL.entities, signals: [], relationships: MODEL.relationships }), []);
});

for (const { signalId, entityIds, steps } of [
  {
    signalId: "s-latency",
    entityIds: ["api", "flow", "branch", "root"],
    steps: [
      ["r-limited", "flow"],
      ["r-branch", "branch"],
      ["r-flow-root", "root"],
      ["r-branch-root", null],
      ["r-cycle", null],
    ],
  },
  {
    signalId: "s-depth",
    entityIds: ["branch", "root", "api", "flow"],
    steps: [
      ["r-branch-root", "root"],
      ["r-cycle", "api"],
      ["r-limited", "flow"],
      ["r-branch", null],
      ["r-flow-root", null],
    ],
  },
]) {
  test(`buildReplayScenarios: ${signalId} emits each reachable edge and target once in breadth-first order`, () => {
    const [scenario] = buildReplayScenarios({
      ...MODEL,
      signals: MODEL.signals.filter(({ id }) => id === signalId),
    });
    assert.deepEqual(scenario.entityIds, entityIds);
    assert.deepEqual(
      scenario.steps.map(({ edgeId, targetId }) => [edgeId, targetId]),
      steps,
    );
    assert.equal(new Set(scenario.edgeIds).size, scenario.edgeIds.length);
    assert.equal(new Set(scenario.entityIds).size, scenario.entityIds.length);
  });
}

test("buildReplayScenarios: preserves exact authored logic and states missing rules explicitly", () => {
  const [scenario] = buildReplayScenarios(MODEL);
  assert.deepEqual(scenario.steps[0].logic, ["limited propagation", "worstOf"]);
  assert.match(scenario.steps[0].narration, /limited propagation/);
  assert.match(scenario.steps[0].narration, /worstOf/);
  assert.deepEqual(scenario.steps[1].logic, []);
  assert.match(scenario.steps[1].narration, /Rollup rule not specified/);
  assert.throws(
    () => buildReplayScenarios({ ...MODEL, signals: [{ ...MODEL.signals[0], ownerId: "missing" }] }),
    /unknown owner "missing"/,
  );
});

for (const [state, event, expected] of [
  ["idle", "play", "running"],
  ["running", "pause", "paused"],
  ["paused", "play", "running"],
  ["running", "restart", "idle"],
  ["paused", "restart", "idle"],
  ["complete", "restart", "idle"],
  ["idle", "pause", "idle"],
  ["complete", "play", "complete"],
]) {
  test(`nextReplayState: ${state} + ${event} -> ${expected}`, () => {
    assert.equal(nextReplayState(state, event), expected);
  });
}

test("nextReplayState: rejects an unknown state and ignores an unknown event", () => {
  assert.throws(() => nextReplayState("broken", "play"), /unknown replay state/);
  assert.equal(nextReplayState("idle", "not-an-event"), "idle");
});
