// Loads the shipped browser plugin (`plugin/ahm-health.js`) inside Node through `node:vm`.
//
// Draw.io loads that file as a plain browser script, so it cannot be imported as ESM. The source is
// an IIFE over a single `root` global, so it is compiled inside a wrapper that shadows `globalThis`
// with a bare sandbox object. That keeps the load side-effect free — the plugin's only top-level
// action is publishing `AhmHealthPluginFactory` onto the sandbox, and the `Draw.loadPlugin`
// bootstrap never fires because the sandbox has no `Draw` — while leaving the code in *this* realm,
// so the objects it returns (`PILL`, `pillGeometry()`'s result, `recalculate()`'s model) are
// ordinary host objects. A separate `vm` context would hand back cross-realm objects whose
// prototypes differ from the caller's, which silently breaks `deepStrictEqual` and `instanceof` for
// every consumer of this boundary.
//
// This is the single boundary through which Node-side code — the generator and the test suite —
// reaches the plugin's semantics, so `worstOf` / `rollup` / `contribution` and the pill contract
// exist exactly once in the repository.
//
// `sandbox` is the object the plugin sees as its `root`. Passing one in lets a caller declare the
// browser globals the plugin looks up by name — the mxChange constructors it classifies edits
// against — so that classification can be exercised through the shipped code rather than a copy.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import vm from "node:vm";

export const PLUGIN_FILE = resolve(import.meta.dirname, "../plugin/ahm-health.js");

export function loadPlugin(source = readFileSync(PLUGIN_FILE, "utf8"), sandbox = { console }) {
  const wrapped = `(function (globalThis, window, self) {\n${source}\n})`;
  vm.runInThisContext(wrapped, { filename: "ahm-health.js" })(sandbox, sandbox, sandbox);
  if (typeof sandbox.AhmHealthPluginFactory !== "function") {
    throw new Error("plugin/ahm-health.js published no AhmHealthPluginFactory");
  }
  return sandbox.AhmHealthPluginFactory();
}
