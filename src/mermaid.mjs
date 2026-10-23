// mermaid.mjs — themed Mermaid -> SVG via Pele, for every block the health-model renderers don't
// claim (sequence, state, class, ER, plain flowcharts, ...). Pure code, no browser.
//
// Keeps the original Mermaid shapes and applies the selected theme: classDefs named
// blue/green/amber/red/purple are remapped to the theme's state palette, everything else is
// themed through Pele's CSS variables, which are resolved to concrete values so the SVG renders
// the same inside <img> (Microsoft Learn) as inline. Text stays native <text>/<tspan>.

import { render as peleRender } from "pele";
import { splitFrontmatter, stripDiagrammoKey } from "./extract.mjs";
import { getTheme } from "./themes.mjs";
import { textWidth } from "./text.mjs";

const FONT_FAMILY = "Segoe UI, -apple-system, BlinkMacSystemFont, Helvetica, Arial, sans-serif";

// opts: { theme: name|object, background }  →  { svg, width, height }
export function renderMermaid(code, opts = {}) {
  const theme = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  let rendered;
  try {
    // classDef bodies for the article's five class names, in this theme.
    const s = theme.state, tx = theme.ink;
    const classDefs = {
      blue:   `classDef blue fill:${s.signal.fill},stroke:${s.signal.border},stroke-width:2px,color:${tx};`,
      green:  `classDef green fill:${s.healthy.fill},stroke:${s.healthy.border},stroke-width:2.5px,color:${tx};`,
      amber:  `classDef amber fill:${s.degraded.fill},stroke:${s.degraded.border},stroke-width:2.5px,color:${tx};`,
      red:    `classDef red fill:${s.unhealthy.fill},stroke:${s.unhealthy.border},stroke-width:2.5px,color:${tx};`,
      purple: `classDef purple fill:${s.alt.fill},stroke:${s.alt.border},stroke-width:2px,color:${tx};`,
    };
    const { raw, body } = splitFrontmatter(code);
    const themedBody = body
      .split("\n")
      .map((l) => {
        if (/^\s*%%\|/.test(l)) return null; // drop diagrammo directives
        const m = l.match(/^(\s*)classDef\s+(\w+)\s+/);
        if (m && classDefs[m[2]]) return m[1] + classDefs[m[2]];
        if (/^\s*%%\s*mermaid\s*$/.test(l)) return null; // drop editor marker comment
        // Strip the HTML <div> wrappers used only for left-align; keep <br/> line breaks.
        return l.replace(/<div[^>]*>/g, "").replace(/<\/div>/g, "");
      })
      .filter((l) => l !== null)
      .join("\n");
    // keep mermaid-native frontmatter (title, config), drop our diagrammo key
    // Text is measured with the renderer's own glyph metrics. Without a measurer Pele measures on a
    // canvas whenever one exists, i.e. with the host's installed fonts. Style flags: 1 bold, 4 mono.
    const measurer = {
      width: (text, size, style = 0) => (style & 4
        ? [...String(text)].length * 0.6 * size
        : textWidth(text, size, style & 1 ? 600 : 400)),
    };
    rendered = peleRender((raw ? stripDiagrammoKey(raw) : "") + themedBody, { responsive: false, links: false, images: false, measurer });
  } catch (e) {
    throw new Error(`pele failed: ${e.message}`);
  }

  // Static colors. Pele writes var(--pele-x,fallback) into the root style as private --_x
  // properties and points every fill/stroke at var(--_x). Resolve both levels against this
  // theme's Pele variables (unlisted ones keep Pele's own fallback), then drop the
  // custom-property declarations.
  const vars = {
    bg: theme.bg,
    fg: theme.ink,
    muted: theme.muted,
    line: theme.muted,
    surface: theme.band,
    "surface-alt": theme.state.signal.fill,
    border: theme.state.unknown.border,
    accent: theme.state.signal.border,
    font: FONT_FAMILY,
    radius: "8px",
  };
  let svg = rendered.svg.replace(/var\(--pele-([\w-]+),([^()]*)\)/g, (_m, name, fallback) => vars[name] ?? fallback);
  const privates = new Map();
  for (const decl of (svg.match(/^<svg\b[^>]*\sstyle="([^"]*)"/)?.[1] ?? "").split(";")) {
    const m = decl.match(/^\s*(--_[\w-]+)\s*:\s*(.+?)\s*$/);
    if (m) privates.set(m[1], m[2]);
  }
  svg = svg.replace(/var\((--_[\w-]+)\)/g, (m, name) => privates.get(name) ?? m);
  svg = svg.replace(/\sstyle="([^"]*)"/g, (_m, style) => {
    const kept = style.split(";").map((d) => d.trim()).filter((d) => d && !d.startsWith("--"));
    return kept.length ? ` style="${kept.join(";")}"` : "";
  });
  const leftover = svg.match(/var\(--[\w-]+[^)]*\)/);
  if (leftover) throw new Error(`pele output kept an unresolved CSS variable: ${leftover[0]}`);

  const background = opts.background || (theme.name === "midnight" ? theme.bg : "transparent");
  if (background !== "transparent") {
    const fill = String(background).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
    svg = svg.replace(/^(<svg\b[^>]*>)/, `$1<rect width="100%" height="100%" fill="${fill}"/>`);
  }
  return { svg, width: rendered.width, height: rendered.height };
}
