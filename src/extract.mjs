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
export function parseFenceInfo(info, themeNames) {
  const opts = {};
  for (const tok of (info || "").replace(/[{}]/g, " ").trim().split(/\s+/).filter(Boolean)) {
    const kv = tok.match(/^([\w-]+)=(.*)$/);
    if (kv) { opts[kv[1]] = scalar(kv[2]); continue; }
    const w = tok.toLowerCase();
    if (RENDERERS.has(w)) opts.renderer = w;
    else if (themeNames.includes(w)) opts.theme = w;
  }
  return opts;
}

// %%| directives inside the block, one `key: value` per line
export function parseDirectives(code) {
  const opts = {};
  for (const line of code.split("\n")) {
    const m = line.match(/^\s*%%\|\s*(.+)$/);
    if (!m) continue;
    const kv = m[1].match(/^([\w-]+)\s*:\s*(.*)$/);
    if (kv) opts[kv[1]] = scalar(kv[2]);
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

// Returns [{ slug, heading, info, code, options }]
//   code    — block body with frontmatter kept (renderers decide what to strip)
//   options — merged per-block options (fence info < frontmatter < directives)
export function extractBlocks(md, themeNames = []) {
  const lines = md.split("\n");
  const blocks = [];
  let heading = "diagram", inBlock = false, buf = [], info = "", used = new Map();
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.*)/);
    if (h && !inBlock) heading = h[1].trim();
    const open = line.match(/^\s*(`{3,}|~{3,})\s*mermaid\b(.*)$/);
    if (!inBlock && open) { inBlock = true; buf = []; info = open[2].trim(); continue; }
    if (inBlock && /^\s*(`{3,}|~{3,})\s*$/.test(line)) {
      inBlock = false;
      const code = buf.join("\n");
      const { fm } = splitFrontmatter(code);
      const options = {
        ...parseFenceInfo(info, themeNames),
        ...(fm && typeof fm === "object" && !Array.isArray(fm) ? extractFmOptions(fm) : {}),
        ...parseDirectives(code),
      };
      const base = slugify(options.name || options.title || heading);
      const n = (used.get(base) || 0) + 1; used.set(base, n);
      blocks.push({ slug: n === 1 ? base : `${base}-${n}`, heading, info, code, options });
      continue;
    }
    if (inBlock) buf.push(line);
  }
  return blocks;
}

function extractFmOptions(fm) {
  const opts = {};
  if (typeof fm.title === "string") opts.title = fm.title;
  const d = fm.diagrammo;
  if (d && typeof d === "object" && !Array.isArray(d)) Object.assign(opts, d);
  else if (typeof d === "string") opts.renderer = d;
  return opts;
}
