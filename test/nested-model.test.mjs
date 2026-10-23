import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as peleParse } from "pele";
import { parseAhmSource } from "../src/health-model.mjs";
import { projectNestedModel } from "../src/ahm-nested-model.mjs";

const BASE_SOURCE = [
  "flowchart TB",
  'subgraph platform["Platform"]',
  'subgraph payments["Payments"]',
  'api["API"]',
  'worker["Worker"]',
  'subgraph ledger["Ledger"]',
  'db["Primary DB"]',
  "end",
  "end",
  'infra["Infra"]',
  "end",
  'shared["Latency = 120 (degraded)"]:::blue',
  "shared --> api",
  "shared --> infra",
  "api --> worker",
  "worker --> db",
  "infra --> api",
  "infra --> worker",
  "class api healthy;",
  "class worker degraded;",
  "class db unhealthy;",
  "class infra standby;",
].join("\n");

function parseBase() {
  const canonical = parseAhmSource(BASE_SOURCE);
  const parsed = peleParse(BASE_SOURCE);
  return { canonical, parsed };
}

function baseNested(mode = "expanded") {
  return {
    models: {
      payments: { state: "degraded", detailRef: "diagram://payments" },
      ledger: { state: "unhealthy" },
    },
    view: { mode },
  };
}

test("expanded projection keeps model hierarchy and shared signal owner edges", () => {
  const { canonical, parsed } = parseBase();
  const projected = projectNestedModel({ canonical, parsed, nested: baseNested("expanded") });

  assert.equal(projected.projection.mode, "expanded");
  assert.deepEqual(projected.projection.displayed.models, ["payments", "ledger"]);
  assert.deepEqual(projected.projection.displayed.entities, ["api", "worker", "db", "infra"]);

  const payments = projected.trace.models.find((model) => model.id === "payments");
  const ledger = projected.trace.models.find((model) => model.id === "ledger");
  assert.deepEqual(payments.directEntityIds, ["api", "worker"]);
  assert.equal(ledger.parentId, "payments");
  assert.deepEqual(ledger.directEntityIds, ["db"]);

  assert.deepEqual(projected.trace.signalOwners, [
    { signalId: "shared", ownerEntityId: "api" },
    { signalId: "shared", ownerEntityId: "infra" },
  ]);
  assert.deepEqual(projected.projection.topLevelRoles, [{ id: "platform", label: "Platform", role: "lane" }]);
});

test("collapsed projection maps hidden descendants to visible model cards without merging edges", () => {
  const { canonical, parsed } = parseBase();
  const withAuthoredModelSelf = {
    ...canonical,
    dependencies: [
      ...canonical.dependencies,
      { from: "infra", to: "worker", dashed: true, label: "fallback" },
      { from: "payments", to: "payments", dashed: false, label: "summary-loop" },
    ],
  };
  const projected = projectNestedModel({
    canonical: withAuthoredModelSelf,
    parsed,
    nested: baseNested("collapsed"),
  });

  assert.deepEqual(projected.projection.displayed.models, ["payments"]);
  assert.deepEqual(projected.projection.displayed.entities, ["infra"]);

  const rendered = projected.projection.relationships;
  const renderedPairs = rendered.map((dep) => `${dep.from}->${dep.to}:${dep.label ?? ""}:${dep.dependencyIndex}`);
  assert.deepEqual(renderedPairs, [
    "infra->payments::2",
    "infra->payments::3",
    "infra->payments:fallback:4",
    "payments->payments:summary-loop:5",
  ]);
  assert.equal(rendered.filter((dep) => dep.from === "infra" && dep.to === "payments").length, 3);

  const detailOnlyIndexes = projected.trace.relationships
    .filter((dep) => dep.kind === "detail-only")
    .map((dep) => dep.dependencyIndex);
  assert.deepEqual(detailOnlyIndexes, [0, 1]);
});

test("detail projection focuses subtree and marks external relationships outside-focus", () => {
  const { canonical, parsed } = parseBase();
  const projected = projectNestedModel({
    canonical,
    parsed,
    nested: { ...baseNested("detail"), view: { mode: "detail", detailFocus: "payments" } },
  });

  assert.deepEqual(projected.projection.displayed.models, ["payments", "ledger"]);
  assert.deepEqual(projected.projection.displayed.entities, ["api", "worker", "db"]);

  const outside = projected.trace.relationships.filter((dep) => dep.kind === "outside-focus");
  assert.deepEqual(outside.map((dep) => dep.dependencyIndex), [2, 3]);
  assert.ok(outside.every((dep) => dep.displayed === null));
});

for (const mode of ["expanded", "collapsed"]) {
  test(`detailFocus is rejected outside detail mode (${mode})`, () => {
    const { canonical, parsed } = parseBase();
    assert.throws(
      () =>
        projectNestedModel({
          canonical,
          parsed,
          nested: { ...baseNested(mode), view: { mode, detailFocus: "payments" } },
        }),
      /detailFocus is only allowed in detail mode/
    );
  });
}

test("detail mode requires a registered focus model", () => {
  const { canonical, parsed } = parseBase();
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: { ...baseNested("detail"), view: { mode: "detail", detailFocus: "missing" } },
      }),
    /detailFocus "missing" must reference a registered model/
  );
});

test("rejects colliding model IDs with entities and signals", () => {
  const { canonical, parsed } = parseBase();
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: { api: { state: "healthy" } },
          view: { mode: "expanded" },
        },
      }),
    /collides with an entity ID/
  );
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: { shared: { state: "healthy" } },
          view: { mode: "expanded" },
        },
      }),
    /collides with a signal ID/
  );
});

test("rejects unknown keys and invalid model state", () => {
  const { canonical, parsed } = parseBase();
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: { payments: { state: "healthy", extra: true } },
          view: { mode: "expanded" },
        },
      }),
    /unsupported nested\.models\.payments key "extra"/
  );
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: { payments: { state: "not-a-state" } },
          view: { mode: "expanded" },
        },
      }),
    /nested\.models\.payments\.state unsupported entity state "not-a-state"/
  );
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: { payments: {} },
          view: { mode: "expanded" },
        },
      }),
    /nested\.models\.payments\.state must be provided/
  );
});

test("rejects conflicting entity membership across disjoint models", () => {
  const source = [
    "flowchart TB",
    'svc["Service"]',
    "class svc healthy;",
  ].join("\n");
  const canonical = parseAhmSource(source);
  const parsed = {
    ...peleParse(source),
    subgraphs: [
      { id: "alpha", title: "Alpha", nodes: ["svc"] },
      { id: "beta", title: "Beta", nodes: ["svc"] },
    ],
  };
  assert.throws(
    () =>
      projectNestedModel({
        canonical,
        parsed,
        nested: {
          models: {
            alpha: { state: "healthy" },
            beta: { state: "degraded" },
          },
          view: { mode: "expanded" },
        },
      }),
    /conflicting entity membership for "svc"/
  );
});

test("rejects dependency endpoints that target unregistered groups", () => {
  const { canonical, parsed } = parseBase();
  const withGroupEdge = {
    ...canonical,
    dependencies: [...canonical.dependencies, { from: "platform", to: "api", dashed: false, label: null }],
  };
  assert.throws(
    () =>
      projectNestedModel({
        canonical: withGroupEdge,
        parsed,
        nested: baseNested("expanded"),
      }),
    /unsupported dependency endpoint "platform"/
  );
});

test("supports standby model state with a complete model registry", () => {
  const { canonical, parsed } = parseBase();
  const projected = projectNestedModel({
    canonical,
    parsed,
    nested: {
      models: {
        payments: { state: "standby" },
        ledger: { state: "healthy" },
      },
      view: { mode: "expanded" },
    },
  });
  const payments = projected.trace.models.find((item) => item.id === "payments");
  assert.equal(payments?.state, "standby");
});

test("keeps group-endpoint registration diagnostics when registry is incomplete", () => {
  const { canonical, parsed } = parseBase();
  const withGroupDependency = {
    ...canonical,
    dependencies: [...canonical.dependencies, { from: "ledger", to: "payments", dashed: false, label: null }],
  };
  assert.throws(
    () =>
      projectNestedModel({
        canonical: withGroupDependency,
        parsed,
        nested: {
          models: { payments: { state: "standby" } },
          view: { mode: "expanded" },
        },
      }),
    /unsupported dependency endpoint "ledger" from unregistered group/
  );
});
