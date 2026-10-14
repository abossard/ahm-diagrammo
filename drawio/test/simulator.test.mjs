import assert from "node:assert/strict";
import test from "node:test";
import { dependency, entity, loadPlugin, model, signal } from "./helpers/plugin.mjs";

test("EARS-05 Standard contributes every state unchanged", () => {
  const plugin = loadPlugin();
  for (const state of plugin.STATES) {
    const diagram = model([
      entity("child", state, "standard"),
      entity("parent", "Unknown"),
      dependency("child-parent", "child", "parent", "standard"),
    ]);
    plugin.recalculate(diagram);
    assert.equal(diagram.cells.find((cell) => cell.ahmId === "parent").computedState, state);
  }
});

test("EARS-06 Limited caps adverse contribution", () => {
  const plugin = loadPlugin();
  const cases = [
    ["Healthy", "Healthy"],
    ["Degraded", "Healthy"],
    ["Unhealthy", "Degraded"],
    ["Unknown", "Unknown"],
  ];
  for (const [state, expected] of cases) {
    const diagram = model([
      entity("child", state, "limited"),
      entity("parent", "Unknown"),
      dependency("child-parent", "child", "parent", "limited"),
    ]);
    plugin.recalculate(diagram);
    assert.equal(diagram.cells.find((cell) => cell.ahmId === "parent").computedState, expected);
    assert.notEqual(diagram.cells.find((cell) => cell.ahmId === "parent").computedState, "Unhealthy");
  }
});

test("EARS-07 Suppressed preserves child state and leaves parent healthy", () => {
  const plugin = loadPlugin();
  for (const state of plugin.STATES) {
    const diagram = model([
      entity("child", state, "suppressed"),
      entity("parent", "Healthy"),
      dependency("child-parent", "child", "parent", "suppressed"),
    ]);
    plugin.recalculate(diagram);
    assert.equal(diagram.cells.find((cell) => cell.ahmId === "child").computedState, state);
    assert.equal(diagram.cells.find((cell) => cell.ahmId === "parent").computedState, "Healthy");
  }
});

test("EARS-07 impact is relationship-specific for a multi-parent child", () => {
  const plugin = loadPlugin();
  const diagram = model([
    entity("child", "Unhealthy"),
    entity("standard-parent"),
    entity("suppressed-parent"),
    dependency("standard-edge", "child", "standard-parent", "standard"),
    dependency("suppressed-edge", "child", "suppressed-parent", "suppressed"),
  ]);
  plugin.recalculate(diagram);
  assert.equal(diagram.cells.find((cell) => cell.ahmId === "child").computedState, "Unhealthy");
  assert.equal(diagram.cells.find((cell) => cell.ahmId === "standard-parent").computedState, "Unhealthy");
  assert.equal(diagram.cells.find((cell) => cell.ahmId === "suppressed-parent").computedState, "Healthy");
});

test("EARS-08 worst-of is order-independent and ignores mixed Unknown", () => {
  const plugin = loadPlugin();
  const cases = [
    {
      name: "one unhealthy wins unequal healthy majority",
      local: "Healthy",
      inputs: ["Healthy", "Healthy", "Unhealthy", "Degraded"],
      expected: "Unhealthy",
    },
    {
      name: "one degraded wins over three healthy",
      local: "Healthy",
      inputs: ["Healthy", "Degraded", "Healthy", "Healthy"],
      expected: "Degraded",
    },
    {
      name: "known input wins over multiple unknown",
      local: "Unknown",
      inputs: ["Unknown", "Healthy", "Unknown"],
      expected: "Healthy",
    },
    {
      name: "all unknown remains unknown",
      local: "Unknown",
      inputs: ["Unknown", "Unknown"],
      expected: "Unknown",
    },
  ];
  for (const fixture of cases) {
    const cells = [entity("parent", fixture.local)];
    fixture.inputs.forEach((state, index) => cells.push(signal(`signal-${index}`, "parent", state)));
    const diagram = model(cells);
    plugin.recalculate(diagram);
    assert.equal(
      diagram.cells.find((cell) => cell.ahmId === "parent").computedState,
      fixture.expected,
      fixture.name,
    );
    const reversed = model([entity("parent", fixture.local), ...cells.slice(1).reverse()]);
    plugin.recalculate(reversed);
    assert.equal(reversed.cells.find((cell) => cell.ahmId === "parent").computedState, fixture.expected);
  }
});
