import { test } from "node:test";
import assert from "node:assert/strict";
import { parse as peleParse } from "pele";
import { buildPeleAhmSource, parseAhmSource } from "../src/health-model.mjs";

const BASE = [
  "flowchart LR",
  'api["API gateway (degraded)"]',
  'worker["Worker queue"]',
  'db["Primary DB"]',
  'shared["Shared signal = 42 (healthy)"]:::blue',
  'missing["No reading"]:::blue',
  'empty["Probe =  (unknown)"]:::blue',
  'zero["Requests = 0 (healthy)"]:::blue',
  "shared --> api",
  "shared --> worker",
  "missing --> db",
  "empty --> worker",
  "zero --> db",
  "api -->|depends| db",
  "worker -.->|fallback| db",
  "class api amber;",
  "class worker green;",
  "class db red;",
].join("\n");

test("parseAhmSource preserves ownership and missing/zero/empty distinctions", () => {
  const model = parseAhmSource(BASE);
  const entity = new Map(model.entities.map((x) => [x.id, x]));
  assert.equal(entity.get("api").state, "degraded");
  assert.equal(entity.get("worker").state, "healthy");
  assert.equal(entity.get("db").state, "unhealthy");

  const workerRows = entity.get("worker").signals;
  const dbRows = entity.get("db").signals;
  const apiRows = entity.get("api").signals;

  assert.equal(apiRows.filter((r) => r.name === "Shared signal").length, 1);
  assert.equal(workerRows.filter((r) => r.name === "Shared signal").length, 1);

  assert.equal(dbRows.find((r) => r.name === "No reading").valueKind, "missing");
  assert.equal(workerRows.find((r) => r.name === "Probe").valueKind, "empty");
  assert.equal(dbRows.find((r) => r.name === "Requests").value, "0");
  assert.equal(model.dependencies.length, 2);
});

test("parseAhmSource rejects unsupported terminal signal state", () => {
  const source = [
    "flowchart BT",
    'a["Service"]',
    's["Latency = 12 (standby)"]:::blue',
    "s --> a",
    "class a green;",
  ].join("\n");
  assert.throws(
    () => parseAhmSource(source),
    /unsupported signal state "standby"/
  );
});

test("parseAhmSource rejects dangling relationships", () => {
  const source = [
    "flowchart TB",
    'a["Service"]',
    "a --> missingNode",
    "class a healthy;",
  ].join("\n");
  assert.throws(
    () => parseAhmSource(source),
    /dangling edge "a -> missingNode"/
  );
});

test("parseAhmSource accepts registered group dependency endpoints only when opted in", () => {
  const source = [
    "flowchart TB",
    'subgraph payments["Payments"]',
    'api["API"]',
    "end",
    'infra["Infra"]',
    "payments --> infra",
    "infra --> payments",
    "class api green;",
    "class infra amber;",
  ].join("\n");

  assert.throws(
    () => parseAhmSource(source),
    /dangling edge "payments -> infra"/
  );

  const model = parseAhmSource(source, { allowGroupEndpoints: true });
  assert.deepEqual(
    model.dependencies.map((dep) => [dep.from, dep.to]),
    [
      ["payments", "infra"],
      ["infra", "payments"],
    ]
  );
});

test("parseAhmSource rejects unsupported directives and config injection lines", () => {
  const withClick = [
    "flowchart LR",
    'api["API"]',
    'sig["S = 1 (healthy)"]:::blue',
    "sig --> api",
    'click api "https://example.com"',
    "class api green;",
  ].join("\n");
  assert.throws(() => parseAhmSource(withClick), /unsupported statement/i);

  const withInit = [
    "%%{init: {\"theme\":\"dark\"}}%%",
    "flowchart LR",
    'api["API"]',
    'sig["S = 1 (healthy)"]:::blue',
    "sig --> api",
    "class api green;",
  ].join("\n");
  assert.throws(() => parseAhmSource(withInit), /unsupported statement/i);
});

test("parseAhmSource preserves escaped delimiters in signal rows", () => {
  const source = [
    "flowchart LR",
    'api["API"]',
    'sig["Latency \\= p95 = 2300 ms \\(raw\\) (degraded)"]:::blue',
    "sig --> api",
    "class api amber;",
  ].join("\n");
  const model = parseAhmSource(source);
  assert.equal(model.entities[0].signals[0].name, "Latency = p95");
  assert.equal(model.entities[0].signals[0].value, "2300 ms (raw)");
  assert.equal(model.entities[0].signals[0].state, "degraded");
});

const SIGNAL_STATES = ["healthy", "degraded", "unhealthy", "unknown"];
for (const signalState of SIGNAL_STATES) {
  test(`parseAhmSource parses terminal state without equals (${signalState})`, () => {
    const source = [
      "flowchart LR",
      'svc["Shipping service"]',
      `sig["Queue depth (${signalState})"]:::blue`,
      "sig --> svc",
      "class svc green;",
    ].join("\n");
    const model = parseAhmSource(source);
    const row = model.entities.find((entity) => entity.id === "svc")?.signals[0];
    assert.ok(row);
    assert.equal(row.name, "Queue depth");
    assert.equal(row.valueKind, "missing");
    assert.equal(row.value, null);
    assert.equal(row.state, signalState);
  });
}

for (const signalState of SIGNAL_STATES) {
  test(`parseAhmSource rejects state-only signal row after normalization (${signalState})`, () => {
    const source = [
      "flowchart LR",
      'svc["Shipping service"]',
      `sig["(${signalState})"]:::blue`,
      "sig --> svc",
      "class svc green;",
    ].join("\n");
    assert.throws(
      () => parseAhmSource(source),
      /missing a signal name/
    );
  });
}

for (const signalState of SIGNAL_STATES) {
  test(`parseAhmSource preserves escaped literal terminal-looking row (${signalState})`, () => {
    const source = [
      "flowchart LR",
      'svc["Shipping service"]',
      `sig["\\(${signalState}\\)"]:::blue`,
      "sig --> svc",
      "class svc green;",
    ].join("\n");
    const model = parseAhmSource(source);
    const row = model.entities.find((entity) => entity.id === "svc")?.signals[0];
    assert.ok(row);
    assert.equal(row.name, `(${signalState})`);
    assert.equal(row.valueKind, "missing");
    assert.equal(row.value, null);
    assert.equal(row.state, "unknown");
  });
}

test("parseAhmSource keeps ordinary missing row without terminal state", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service"]',
    'sig["Queue depth"]:::blue',
    "sig --> svc",
    "class svc green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const row = model.entities.find((entity) => entity.id === "svc")?.signals[0];
  assert.ok(row);
  assert.equal(row.name, "Queue depth");
  assert.equal(row.valueKind, "missing");
  assert.equal(row.value, null);
  assert.equal(row.state, "unknown");
});

test("parseAhmSource preserves escaped literal terminal parentheses in signal names", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service"]',
    'sig["Queue depth \\(degraded\\)"]:::blue',
    "sig --> svc",
    "class svc green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const row = model.entities.find((entity) => entity.id === "svc")?.signals[0];
  assert.ok(row);
  assert.equal(row.name, "Queue depth (degraded)");
  assert.equal(row.valueKind, "missing");
  assert.equal(row.state, "unknown");
});

test("parseAhmSource preserves explicit empty and zero values with supplied state", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service"]',
    'empty["Queue depth =  (degraded)"]:::blue',
    'zero["Queue depth = 0 (healthy)"]:::blue',
    "empty --> svc",
    "zero --> svc",
    "class svc green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const rows = model.entities.find((entity) => entity.id === "svc")?.signals ?? [];
  const empty = rows.find((row) => row.name === "Queue depth" && row.state === "degraded");
  const zero = rows.find((row) => row.name === "Queue depth" && row.state === "healthy");
  assert.ok(empty);
  assert.ok(zero);
  assert.equal(empty.valueKind, "empty");
  assert.equal(empty.value, "");
  assert.equal(zero.valueKind, "present");
  assert.equal(zero.value, "0");
});

test("parseAhmSource rejects unsupported terminal state without equals", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service"]',
    'sig["Queue depth (standby)"]:::blue',
    "sig --> svc",
    "class svc green;",
  ].join("\n");
  assert.throws(
    () => parseAhmSource(source),
    /unsupported signal state "standby"/
  );
});

test("parseAhmSource consumes standalone subsequent state lines as metadata", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service<br/>healthy"]',
    'sig["Availability = 99.95% (healthy)"]:::blue',
    "sig --> svc",
    "class svc green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const svc = model.entities.find((entity) => entity.id === "svc");
  assert.ok(svc);
  assert.equal(svc.state, "healthy");
  assert.equal(svc.presentation.title, "Shipping service");
  assert.equal(svc.presentation.qualifier, "");
});

test("parseAhmSource preserves qualifiers that contain health words", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service<br/>healthy partners"]',
    "class svc green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const svc = model.entities.find((entity) => entity.id === "svc");
  assert.ok(svc);
  assert.equal(svc.presentation.title, "Shipping service");
  assert.equal(svc.presentation.qualifier, "healthy partners");
});

test("parseAhmSource rejects conflicting class and standalone subsequent state hint", () => {
  const source = [
    "flowchart LR",
    'svc["Shipping service<br/>unhealthy"]',
    "class svc green;",
  ].join("\n");
  assert.throws(
    () => parseAhmSource(source),
    /conflicting class "healthy" and hint "unhealthy"/
  );
});

test("parseAhmSource accepts bare subgraph member references and preserves escaped entity text", () => {
  const source = [
    "flowchart BT",
    'subgraph laneA["Core lane"]',
    "a",
    "end",
    'a["Replica \\(Degraded\\) of b<br/>still \\(healthy\\) partners"]',
    "class a green;",
  ].join("\n");
  const model = parseAhmSource(source);
  const entity = model.entities.find((node) => node.id === "a");
  assert.ok(entity);
  assert.equal(entity.presentation.title, "Replica (Degraded) of b");
  assert.equal(entity.presentation.qualifier, "still (healthy) partners");
  assert.equal(entity.state, "healthy");
  assert.deepEqual(model.explicitLanes, [
    { id: "laneA", label: "Core lane", entities: ["a"] },
  ]);
});

test("buildPeleAhmSource supports explicit and inferred lanes", () => {
  const explicit = [
    "flowchart LR",
    'subgraph laneIngress["Ingress"]',
    'api["API"]',
    "end",
    'subgraph laneData["Data"]',
    'db["DB"]',
    "end",
    'sig["S = 1 (healthy)"]:::blue',
    "sig --> api",
    "api --> db",
    "class api green;",
    "class db red;",
  ].join("\n");
  const explicitModel = parseAhmSource(explicit);
  const explicitSource = buildPeleAhmSource(explicitModel, { lanes: true });
  assert.match(explicitSource.source, /^flowchart LR/m);
  assert.doesNotMatch(explicitSource.source, /swimlane-beta/);
  assert.match(explicitSource.source, /subgraph lane_0\["Ingress"\]/);
  assert.match(explicitSource.source, /subgraph lane_1\["Data"\]/);

  const inferred = [
    "flowchart BT",
    'a["A"]',
    'b["B"]',
    'c["C"]',
    "a --> b",
    "b --> c",
    "class a green;",
    "class b amber;",
    "class c red;",
  ].join("\n");
  const inferredModel = parseAhmSource(inferred);
  const inferredSource = buildPeleAhmSource(inferredModel, { lanes: true });
  assert.match(inferredSource.source, /subgraph lane_0\["Level 2"\]/);
  assert.match(inferredSource.source, /subgraph lane_1\["Level 1"\]/);
  assert.match(inferredSource.source, /subgraph lane_2\["Level 0"\]/);
});

test("buildPeleAhmSource emits parseable quoted labels and preserves edge association", () => {
  const source = [
    "flowchart BT",
    'a["API"]',
    'r["Redis"]',
    'q["Queue"]',
    'a -->|"p99 (ms) []{} & <meta>"| r',
    'r -. "latency | p95 []{}" .-> q',
    "class a green;",
    "class r amber;",
    "class q red;",
  ].join("\n");
  const parsed = parseAhmSource(source);
  const built = buildPeleAhmSource(parsed, { direction: "BT", lanes: true, theme: "portal" });
  assert.match(built.source, /a -->\s*\|".*"\|\s*r/);
  assert.match(built.source, /r \-\.->\s*\|".*\|.*"\|\s*q/);

  const reparsed = peleParse(built.source);
  assert.deepEqual(
    (reparsed.edges ?? []).map((edge) => ({
      from: edge.start,
      to: edge.end,
      dashed: edge.stroke === "dotted",
      label: edge.text ?? null,
    })),
    parsed.dependencies.map((dep) => ({ from: dep.from, to: dep.to, dashed: dep.dashed, label: dep.label }))
  );
});
