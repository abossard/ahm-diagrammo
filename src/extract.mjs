// extract.mjs — pull mermaid blocks out of a Markdown file, along with per-block options.
//
// A block can carry options three ways (later sources win):
//   1. fence info string:      ```mermaid swimlane theme=midnight
//   2. YAML frontmatter:       ---\n title: Checkout \n diagrammo:\n   theme: candy\n ---
//   3. directive comments:     %%| theme: midnight
//
// All three are invisible to GitHub/VS Code mermaid preview: the fence language stays `mermaid`,
// mermaid itself understands frontmatter, and `%%` lines are mermaid comments.

// ---------- tiny YAML subset (maps by indentation, "- " lists, inline [a, b], scalars) ----------
export function parseYamlite(text) {
  const lines = text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#"));
  let i = 0;
  function parseBlock(indent) {
    const isList = lines[i] != null && lineIndent(lines[i]) === indent && lines[i].trim().startsWith("- ");
    const out = isList ? [] : {};
    while (i < lines.length) {
      const line = lines[i], ind = lineIndent(line), t = line.trim();
      if (ind < indent) break;
      if (ind > indent) { i++; continue; } // over-indented stray; skip
      if (t.startsWith("- ")) {
        if (!Array.isArray(out)) break;
        out.push(scalar(t.slice(2).trim())); i++; continue;
      }
      const m = t.match(/^([\w][\w .\/-]*)\s*:\s*(.*)$/);
      if (!m) { i++; continue; }
      const key = m[1].trim();
      i++;
      if (m[2] !== "") { out[key] = scalar(m[2]); continue; }
      // empty value: nested block if the next line is deeper, else null
      if (i < lines.length && lineIndent(lines[i]) > ind) out[key] = parseBlock(lineIndent(lines[i]));
      else out[key] = null;
    }
    return out;
  }
  return parseBlock(lines.length ? lineIndent(lines[0]) : 0);
}
function lineIndent(l) { return l.length - l.trimStart().length; }
function scalar(v) {
  v = v.trim();
  if (/^".*"$/.test(v) || /^'.*'$/.test(v)) return v.slice(1, -1);
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(",").map((x) => scalar(x)) : [];
  }
  if (v === "true" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "off" || v === "no") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

// ---------- option sources ----------
const RENDERERS = new Set(["auto", "swimlane", "mermaid"]);

// fence info string after "mermaid": bare words match a renderer or theme name; key=value otherwise
export function parseFenceInfo(info, themeNames, issues = null, line = null) {
  const opts = {};
  for (const tok of (info || "").replace(/[{}]/g, " ").trim().split(/\s+/).filter(Boolean)) {
    const kv = tok.match(/^([\w-]+)=(.*)$/);
    if (kv) {
      opts[kv[1]] = scalar(kv[2].replace(/^["']|["']$/g, ""));
      continue;
    }
    const w = tok.toLowerCase();
    if (RENDERERS.has(w)) opts.renderer = w;
    else if (themeNames.includes(w)) opts.theme = w;
    else if (issues) issues.push({ level: "warn", message: `fence token "${tok}" is neither a renderer (${[...RENDERERS].join("/")}) nor a theme (${themeNames.join("/")}) — ignored`, line });
  }
  return opts;
}

// %%| directives inside the block, one `key: value` per line
export function parseDirectives(code, issues = null, codeLine = 0) {
  const opts = {};
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\s*%%\|\s*(.+)$/);
    if (!m) continue;
    const kv = m[1].match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) opts[kv[1]] = scalar(kv[2]);
    else if (issues) issues.push({ level: "warn", message: `malformed directive "%%| ${m[1].trim()}" — expected "%%| key: value"`, line: codeLine + i });
  }
  return opts;
}

// frontmatter at the top of the block: returns { fm, body } (body = code without frontmatter)
export function splitFrontmatter(code) {
  const m = code.match(/^\s*---[ \t]*\n([\s\S]*?)\n[ \t]*---[ \t]*\n?/);
  if (!m) return { fm: null, body: code, raw: null };
  return { fm: parseYamlite(m[1]), body: code.slice(m[0].length), raw: m[0] };
}

// Remove only the `diagrammo:` key (and its indented children) from a frontmatter block,
// keeping mermaid-native keys like title/config untouched.
export function stripDiagrammoKey(rawFrontmatter) {
  const lines = rawFrontmatter.split("\n");
  const out = [];
  let skipIndent = -1;
  for (const l of lines) {
    if (skipIndent >= 0) {
      if (l.trim() && lineIndent(l) > skipIndent) continue;
      skipIndent = -1;
    }
    if (/^(\s*)diagrammo\s*:\s*$/.test(l) || /^(\s*)diagrammo\s*:\s+\S/.test(l)) {
      skipIndent = lineIndent(l); continue;
    }
    out.push(l);
  }
  // frontmatter reduced to just the fences? drop it entirely
  const inner = out.filter((l) => l.trim() && !/^\s*---\s*$/.test(l));
  return inner.length ? out.join("\n") : "";
}

// ---------- markdown walk ----------
export function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "diagram";
}

export const KNOWN_OPTIONS = ["renderer", "theme", "title", "subtitle", "name", "lanes", "legend", "background"];

// Returns [{ slug, heading, info, code, options, line, codeLine, issues }]
//   code     — block body with frontmatter kept (renderers decide what to strip)
//   options  — merged per-block options (fence info < frontmatter < directives)
//   line     — 1-based line number of the opening fence
//   codeLine — 1-based line number of the first code line (fence line + 1)
//   issues   — [{ level, message, line }] option-level problems (unknown keys, bad values)
export function extractBlocks(md, themeNames = []) {
  const lines = md.split("\n");
  const blocks = [];
  let heading = "diagram", inBlock = false, buf = [], info = "", openLine = 0, used = new Map();
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h && !inBlock) heading = h[1].trim();
    const open = line.match(/^\s*(`{3,}|~{3,})\s*mermaid\b(.*)$/);
    if (!inBlock && open) { inBlock = true; buf = []; info = open[2].trim(); openLine = li + 1; continue; }
    if (inBlock && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
      inBlock = false;
      blocks.push(buildBlock({ heading, info, code: buf.join("\n"), line: openLine, themeNames, used }));
      continue;
    }
    if (inBlock) buf.push(line);
  }
  if (inBlock) {
    const blk = buildBlock({ heading, info, code: buf.join("\n"), line: openLine, themeNames, used });
    blk.issues.push({ level: "warn", message: "mermaid fence is never closed (``` missing) — using everything up to end of file", line: openLine });
    blocks.push(blk);
  }
  return blocks;
}

function buildBlock({ heading, info, code, line, themeNames, used }) {
  const issues = [];
  const { fm } = splitFrontmatter(code);
  const fence = parseFenceInfo(info, themeNames, issues, line);
  const fmOpts = fm && typeof fm === "object" && !Array.isArray(fm) ? extractFmOptions(fm) : {};
  const directives = parseDirectives(code, issues, line + 1);
  const options = { ...fence, ...fmOpts, ...directives };
  for (const src of [fmOpts, directives]) {
    for (const k of Object.keys(src)) {
      if (!KNOWN_OPTIONS.includes(k) && k !== "title")
        issues.push({ level: "warn", message: `unknown option "${k}" (known: ${KNOWN_OPTIONS.join(", ")})`, line });
    }
  }
  if (options.renderer != null && !["auto", "swimlane", "mermaid"].includes(String(options.renderer).toLowerCase()))
    issues.push({ level: "error", message: `unknown renderer "${options.renderer}" (use auto, swimlane, or mermaid)`, line });
  if (options.theme != null && themeNames.length && !themeNames.includes(String(options.theme).toLowerCase()))
    issues.push({ level: "error", message: `unknown theme "${options.theme}" (themes: ${themeNames.join(", ")})`, line });
  if (options.lanes != null && !Array.isArray(options.lanes))
    issues.push({ level: "warn", message: `"lanes" should be a list, e.g. lanes: [Root, Flows, Services] — got ${JSON.stringify(options.lanes)}`, line });
  const base = slugify(options.name || options.title || heading);
  const n = (used.get(base) || 0) + 1; used.set(base, n);
  return { slug: n === 1 ? base : `${base}-${n}`, heading, info, code, options, line, codeLine: line + 1, issues };
}

function extractFmOptions(fm) {
  const opts = {};
  if (typeof fm.title === "string") opts.title = fm.title;
  const d = fm.diagrammo;
  if (d && typeof d === "object" && !Array.isArray(d)) Object.assign(opts, d);
  else if (typeof d === "string") opts.renderer = d;
  return opts;
}
