import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAhmCss, getAhmPalette } from "../src/ahm-tokens.mjs";
import { THEMES } from "../src/themes.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CSS_PATH = join(ROOT, "src", "ahm.css");

test("getAhmPalette preserves canonical theme token data", () => {
  const portal = getAhmPalette("portal");
  assert.equal(portal.entity.healthy.border, "#a0d8a0");
  assert.equal(portal.entity.degraded.accent, "#c26a00");
  assert.equal(portal.entity.unhealthy.fill, "#faeceb");
  assert.equal(portal.entity.unknown.dash, "4 3");
  assert.equal(portal.entity.standby.accent, "#8661c5");
  assert.equal(portal.signal.healthy.fill, "#f2f8f2");
  assert.equal(portal.signal.unknown.accent, "#8a8886");

  const midnight = getAhmPalette("midnight");
  assert.equal(midnight.entity.healthy.accent, THEMES.midnight.state.healthy.dot);
  assert.equal(midnight.entity.standby.fill, THEMES.midnight.state.alt.fill);
  assert.equal(midnight.signal.degraded.border, THEMES.midnight.state.degraded.border);

  const candy = getAhmPalette("candy");
  assert.equal(candy.entity.unhealthy.accent, THEMES.candy.state.unhealthy.dot);
  assert.equal(candy.signal.unknown.fill, THEMES.candy.state.unknown.fill);

  const slate = getAhmPalette("slate");
  assert.equal(slate.entity.healthy.border, THEMES.slate.state.healthy.border);
  assert.equal(slate.signal.healthy.fill, THEMES.slate.state.healthy.fill);
});

test("getAhmPalette supports validated color-only overrides", () => {
  const base = getAhmPalette("portal");
  const overridden = getAhmPalette("portal", {
    canvas: { ink: "#111111" },
    entity: { healthy: { border: "#010203", accent: "#aabbcc" } },
    signal: { unknown: { fill: "#ddeeff" } },
  });

  assert.equal(overridden.canvas.ink, "#111111");
  assert.equal(overridden.entity.healthy.border, "#010203");
  assert.equal(overridden.entity.healthy.accent, "#aabbcc");
  assert.equal(overridden.entity.healthy.fill, base.entity.healthy.fill);
  assert.equal(overridden.signal.unknown.fill, "#ddeeff");
  assert.equal(overridden.signal.unknown.border, base.signal.unknown.border);
  assert.equal(overridden.entity.unknown.dash, "4 3");
});

test("getAhmPalette rejects invalid themes and malformed overrides", () => {
  assert.throws(() => getAhmPalette("nope"), /unknown theme/i);
  assert.throws(
    () => getAhmPalette("portal", { canvas: { outline: "#111111" } }),
    /unsupported color override key "canvas\.outline"/
  );
  assert.throws(
    () => getAhmPalette("portal", { entity: { standby: { dash: "1 1" } } }),
    /unsupported color override key "entity\.standby\.dash"/
  );
  assert.throws(
    () => getAhmPalette("portal", { signal: { standby: { fill: "#ffffff" } } }),
    /unsupported signal state override "standby"/
  );
  assert.throws(
    () => getAhmPalette("portal", { entity: { healthy: { border: "green" } } }),
    /invalid color literal for "entity\.healthy\.border"/
  );
});

test("ahm.css stays scoped and matches generated token CSS", () => {
  const css = readFileSync(CSS_PATH, "utf8").trim();
  assert.doesNotMatch(css, /(^|[\s,{])\.pele\b/);
  assert.match(css, /\.ahm-root/);
  assert.equal(css, getAhmCss().trim());
});

