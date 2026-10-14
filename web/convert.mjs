// convert.mjs — turn Markdown source into per-block render results for the browser editor.
// Pure logic, no DOM access: reuses the existing src/*.mjs exports for all parsing, health-model
// detection, and SVG rendering — never reimplements them. Runs identically in Node and browser.
import { prepareDocuments } from "../src/document.mjs";
import { renderSwimlane } from "../src/swimlane.mjs";
import { getTheme } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";

export const UNSUPPORTED_MESSAGE =
  'This block is not a recognized health model (needs "flowchart BT" with blue/green/amber/red/purple ' +
  "classDefs). Only ahm-diagrammo swimlane conversion runs in-browser; other Mermaid diagram types " +
  "(sequence, state, class, ER, plain flowcharts) need the CLI's mermaid-cli renderer, which cannot run in a browser.";

// One block's outcome: { slug, title, line, code, kind: "health" | "unsupported" | "error", svg?, theme?, meta?, message? }
export function convertMarkdown(markdown, defaults = {}) {
  const [doc] = prepareDocuments([{ name: "editor", source: markdown }], { theme: "portal", ...defaults });
  if (doc.diagnostics.length) {
    return doc.diagnostics.map((d) => ({
      identity: `${doc.name}:document:${d.line}`, kind: "error",
      line: d.line, message: d.message, diagnostics: [d],
    }));
  }
  return doc.blocks.map(classifyBlock);
}

function classifyBlock(b) {
  const { title, theme: themeName } = b.effectiveOptions;
  const diagnostics = b.issues.slice();
  const base = { slug: b.slug, title, line: b.line, code: b.code, identity: b.identity, location: b.location, diagnostics };
  const diag = new Diagnostics();
  try {
    if (diagnostics.some((d) => d.level === "error")) throw new Error(diagnostics.filter((d) => d.level === "error").map((d) => d.message).join("; "));
    if (b.renderer === "mermaid") {
      diagnostics.push({ level: "warn", message: UNSUPPORTED_MESSAGE, line: b.line, origin: "browser" });
      return { ...base, kind: "unsupported", message: UNSUPPORTED_MESSAGE };
    }
    const theme = getTheme(themeName);
    const options = b.effectiveOptions;
    const r = renderSwimlane(b.code, {
      theme,
      title,
      subtitle: options.subtitle,
      lanes: options.lanes,
      legend: options.legend,
      laneLabels: options.laneLabels,
      diag,
      baseLine: b.codeLine - 1,
    });
    diagnostics.push(...diag.items.filter((d) => d.level !== "info").map((d) => ({ ...d, origin: "renderer" })));
    return {
      ...base,
      kind: "health",
      svg: r.svg,
      theme: themeName,
      meta: { nodes: r.nodes, lanes: r.lanes, w: r.W, h: r.H },
    };
  } catch (e) {
    diagnostics.push(...diag.items.filter((d) => d.level !== "info").map((d) => ({ ...d, origin: "renderer" })));
    if (!diagnostics.some((d) => d.level === "error")) {
      diagnostics.push({ level: "error", message: e.message, line: b.line, origin: "renderer" });
    }
    return { ...base, kind: "error", message: e.message };
  }
}
