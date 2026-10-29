// render.mjs — the one place a Mermaid block becomes SVG, whichever look is asked for.
//   swimlane  health model → Azure-portal style swimlane figure (src/swimlane.mjs)
//   pele      health model → Pele AHM signal-table look (src/ahm-render.mjs)
//   mermaid   any Mermaid diagram → themed Pele rendering (src/mermaid.mjs)
// auto picks swimlane for health models; pele and auto fall back to mermaid for everything else.
import { splitFrontmatter, RENDERERS } from "./extract.mjs";
import { looksLikeHealthModel, renderSwimlane } from "./swimlane.mjs";
import { renderAhm } from "./ahm-render.mjs";
import { renderMermaid } from "./mermaid.mjs";
import { getTheme } from "./themes.mjs";
import { Diagnostics } from "./diag.mjs";

export function resolveRenderer(requested, code) {
  const r = String(requested || "auto").toLowerCase();
  if (r === "auto") return looksLikeHealthModel(code) ? "swimlane" : "mermaid";
  if (r === "pele") return looksLikeHealthModel(code) ? "pele" : "mermaid";
  return r;
}

// opts: { renderer, theme, title, subtitle, lanes, legend, values, laneLabels, background, diag, baseLine }
//   →  { renderer, svg, width, height, nodes?, lanes? }
export function renderDiagram(code, opts = {}) {
  const renderer = resolveRenderer(opts.renderer, code);
  const theme = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  const diag = opts.diag || new Diagnostics();
  if (renderer === "swimlane") {
    const r = renderSwimlane(code, {
      theme, title: opts.title, subtitle: opts.subtitle,
      lanes: opts.lanes, legend: opts.legend, values: opts.values, laneLabels: opts.laneLabels,
      diag, baseLine: opts.baseLine,
    });
    return { renderer, svg: r.svg, width: r.W, height: r.H, nodes: r.nodes, lanes: r.lanes };
  }
  if (renderer === "pele") {
    // renderAhm reads plain flowchart source: no frontmatter, no diagrammo directives, and no
    // classDef colors (they only tint Mermaid previews; AHM colors come from the theme).
    const source = splitFrontmatter(code).body
      .split("\n")
      .filter((l) => !/^\s*(%%\||classDef\s)/.test(l))
      .join("\n");
    const r = renderAhm(source, { theme: theme.name, lanes: true, legend: opts.legend !== false, values: opts.values !== false });
    for (const d of r.diagnostics) {
      if (typeof d === "string") diag.info(d);
      else diag.add(d.level, d.message);
    }
    return { renderer, svg: r.svg, width: r.width, height: r.height };
  }
  if (renderer === "mermaid") {
    const r = renderMermaid(code, { theme, background: opts.background });
    return { renderer, svg: r.svg, width: r.width, height: r.height };
  }
  throw new Error(`unknown renderer "${opts.renderer}" (use ${RENDERERS.join(", ")})`);
}
