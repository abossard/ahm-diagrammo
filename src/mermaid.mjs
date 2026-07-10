// mermaid.mjs — themed Mermaid -> SVG via mermaid-cli (mmdc), for every block the swimlane
// renderer doesn't claim (sequence, state, class, ER, plain flowcharts, ...).
//
// Keeps the original Mermaid shapes and applies the selected theme: classDefs named
// blue/green/amber/red/purple are remapped to the theme's state palette, everything else is
// themed through mermaid's own themeVariables. Output is Learn-safe (htmlLabels:false, so all
// text is native <text>/<tspan> and renders inside <img>).

import { readFileSync, writeFileSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { splitFrontmatter, stripDiagrammoKey } from "./extract.mjs";
import { getTheme, mermaidClassDefs, mermaidConfig } from "./themes.mjs";

const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ---------- find a runnable mmdc + a Chrome for it ----------
function findMmdc() {
  for (const p of [
    join(PKG_ROOT, "node_modules", ".bin", "mmdc"),
    join(process.cwd(), "node_modules", ".bin", "mmdc"),
  ]) if (existsSync(p)) return { cmd: p, args: [] };
  try {
    execFileSync("mmdc", ["--version"], { stdio: "ignore" });
    return { cmd: "mmdc", args: [] };
  } catch { /* not on PATH */ }
  // last resort: let npx fetch it (one-time cost, cached afterwards)
  return { cmd: "npx", args: ["-y", "-p", "@mermaid-js/mermaid-cli", "mmdc"] };
}

function findChrome() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    "/opt/pw-browsers/chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null; // let puppeteer use its own bundled browser
}

let session = null; // lazy, shared across blocks in one run
function getSession() {
  if (session) return session;
  const dir = mkdtempSync(join(tmpdir(), "diagrammo-"));
  const chrome = findChrome();
  const pcfg = join(dir, "puppeteer.json");
  writeFileSync(pcfg, JSON.stringify({
    ...(chrome ? { executablePath: chrome } : {}),
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  }));
  session = { dir, pcfg, mmdc: findMmdc(), configs: new Map() };
  process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
  return session;
}

function configFor(theme) {
  const s = getSession();
  if (!s.configs.has(theme.name)) {
    const p = join(s.dir, `mermaid-${theme.name}.json`);
    writeFileSync(p, JSON.stringify(mermaidConfig(theme), null, 2));
    s.configs.set(theme.name, p);
  }
  return s.configs.get(theme.name);
}

// ---------- source prep ----------
function themeBlock(code, theme) {
  const classDefs = mermaidClassDefs(theme);
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
  const fm = raw ? stripDiagrammoKey(raw) : "";
  return fm + themedBody;
}

// Post-process mmdc output to match the portal card: rounded corners + soft drop shadow.
function polishSvg(svg, theme) {
  const shadow =
    '<defs><filter id="ahmShadow" x="-20%" y="-20%" width="140%" height="140%">' +
    `<feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-color="#000000" flood-opacity="${theme.shadowOpacity + 0.02}"/>` +
    "</filter></defs>";
  svg = svg.replace(/(<svg\b[^>]*>)/, `$1${shadow}`);
  svg = svg.replace(
    /<rect class="basic label-container"/g,
    '<rect class="basic label-container" rx="12" ry="12" filter="url(#ahmShadow)"'
  );
  return svg;
}

// ---------- public API ----------
// opts: { theme: name|object, background }  →  { svg }
export function renderMermaid(code, opts = {}) {
  const theme = typeof opts.theme === "object" && opts.theme !== null ? opts.theme : getTheme(opts.theme);
  const s = getSession();
  const themed = themeBlock(code, theme);
  const tmpIn = join(s.dir, `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mmd`);
  const tmpOut = tmpIn.replace(/\.mmd$/, ".svg");
  writeFileSync(tmpIn, themed, "utf8");
  const background = opts.background || (theme.name === "midnight" ? theme.bg : "transparent");

  const ATTEMPTS = 3;
  let lastErr = "";
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      execFileSync(s.mmdc.cmd, [...s.mmdc.args, "-i", tmpIn, "-o", tmpOut, "-c", configFor(theme), "-p", s.pcfg, "-b", background], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const produced = readFileSync(tmpOut, "utf8");
      if (!produced.includes("</svg>")) throw new Error("incomplete SVG output");
      return { svg: polishSvg(produced, theme) };
    } catch (e) {
      lastErr = (e.stderr?.toString() || e.message || "unknown").split("\n").filter(Boolean).pop() || "unknown";
    }
  }
  throw new Error(`mmdc failed after ${ATTEMPTS} attempts: ${lastErr}`);
}
