// mermaid-cli path e2e — skipped automatically when no Chrome/Chromium is available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const hasChrome = [
  process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
  "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].some((p) => p && existsSync(p));
const hasMmdc = existsSync(join(ROOT, "node_modules", ".bin", "mmdc"));

test("renderMermaid produces a themed SVG for a sequence diagram", { skip: !hasChrome || !hasMmdc ? "chrome or mmdc unavailable" : false }, async () => {
  const { renderMermaid } = await import("../src/mermaid.mjs");
  const { svg } = renderMermaid("sequenceDiagram\n  A->>B: hello\n  B-->>A: world", { theme: "slate" });
  assert.match(svg, /<svg/);
  assert.match(svg, /hello/);
  assert.doesNotMatch(svg, /foreignObject/); // Learn-safe: native text only
});

test("renderMermaid surfaces mmdc failures with the underlying reason", { skip: !hasChrome || !hasMmdc ? "chrome or mmdc unavailable" : false }, async () => {
  const { renderMermaid } = await import("../src/mermaid.mjs");
  assert.throws(
    () => renderMermaid("thisIsNotAMermaidDiagramType\n  at all", { theme: "portal" }),
    /mmdc failed after 3 attempts/
  );
});
