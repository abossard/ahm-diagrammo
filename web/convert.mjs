// convert.mjs — turn Markdown source into per-block render results for the browser editor.
// Pure logic, no DOM access: reuses the existing src/*.mjs exports for all parsing, health-model
// detection, and SVG rendering — never reimplements them. Runs identically in Node and browser.
import { extractBlocks } from "../src/extract.mjs";
import { looksLikeHealthModel, renderSwimlane } from "../src/swimlane.mjs";
import { getTheme, THEME_NAMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";

export const UNSUPPORTED_MESSAGE =
  'This block is not a recognized health model (needs "flowchart BT" with blue/green/amber/red/purple ' +
  "classDefs). Only ahm-diagrammo swimlane conversion runs in-browser; other Mermaid diagram types " +
  "(sequence, state, class, ER, plain flowcharts) need the CLI's mermaid-cli renderer, which cannot run in a browser.";

// One block's outcome: { slug, title, line, code, kind: "health" | "unsupported" | "error", svg?, meta?, message? }
export function convertMarkdown(markdown, { theme: defaultTheme = "portal" } = {}) {
  const blocks = extractBlocks(markdown, THEME_NAMES);
  return blocks.map((b) => classifyBlock(b, defaultTheme));
}

function classifyBlock(b, defaultTheme) {
  const title = b.options.title ?? b.heading;
  const base = { slug: b.slug, title, line: b.line, code: b.code };

  if (!looksLikeHealthModel(b.code)) {
    return { ...base, kind: "unsupported", message: UNSUPPORTED_MESSAGE };
  }

  const themeName = b.options.theme || defaultTheme;
  try {
    const theme = getTheme(themeName);
    const diag = new Diagnostics();
    const r = renderSwimlane(b.code, {
      theme,
      title,
      subtitle: b.options.subtitle,
      lanes: b.options.lanes,
      legend: b.options.legend,
      maxWidth: b.options.maxWidth,
      laneLabels: b.options.laneLabels,
      diag,
      baseLine: b.codeLine - 1,
    });
    return { ...base, kind: "health", svg: r.svg, theme: themeName, meta: { nodes: r.nodes, lanes: r.lanes, w: r.W, h: r.H } };
  } catch (e) {
    return { ...base, kind: "error", message: e.message };
  }
}
