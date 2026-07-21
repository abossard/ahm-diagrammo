// markdown-sync.mjs — pure transform for `diagrammo --sync-markdown`.
//
// Given a Markdown source string and, per rendered mermaid block, its already-computed
// { slug, openLine, closeLine, title, href }, rewrites each plain ```mermaid fence in place into
// a machine-owned "managed block": a visible SVG <img>, followed by a collapsed
// <details><summary>Mermaid source</summary> wrapping the original fence untouched — so GitHub
// renders the SVG while the raw/edit view keeps the Mermaid source live for further editing.
//
// Owns exactly: marker validation, the managed-block shape, href/alt-text formatting, and
// whole-span text replacement. Never touches the filesystem (the CLI does the atomic write) and
// never parses/renders Mermaid itself (reuses src/extract.mjs for fence detection, per the
// project's "don't reimplement Mermaid parsing" rule).
import { dirname, relative, resolve, sep } from "node:path";
import { extractBlocks } from "./extract.mjs";

const BEGIN_RE = /^<!--\s*diagrammo:sync\s+([a-z0-9-]+)\s*-->$/;
const END_RE = /^<!--\s*\/diagrammo:sync\s+([a-z0-9-]+)\s*-->$/;

// Broad "did the author *intend* this to be a managed marker" detector — matches even when
// BEGIN_RE/END_RE above don't, so a hand-edited marker with an unsafe slug (uppercase, underscore,
// empty), extra trailing tokens/attributes, or a missing/malformed comment close still fails
// loudly instead of silently falling through as ordinary prose (which would get re-wrapped into a
// second, nested managed block around the same fence). Anchored so a comment that merely mentions
// "diagrammo:sync" later in the line (ordinary prose) is never misclassified: the keyword must
// appear immediately after `<!--` (optionally with a leading `/`), and must be followed by
// whitespace, the comment's own closing `-->`, or end of line — never by another identifier
// character (so unrelated prose like "diagrammo:sync-like" is not flagged either).
const MARKER_INTENT_RE = /^<!--\s*\/?diagrammo:sync(?=\s|-->|$)/;

// ---------- path/text formatting ----------

// Relative Markdown image destination from the Markdown file's own directory to the emitted SVG.
// POSIX separators always; CommonMark angle-bracket form `<...>` when the path contains a space.
export function svgHref(mdFilePath, svgFilePath) {
  const mdDir = dirname(resolve(mdFilePath));
  const rel = relative(mdDir, resolve(svgFilePath));
  const posix = rel.split(sep).join("/");
  return /\s/.test(posix) ? `<${posix}>` : posix;
}

// Escape text for safe use as Markdown image alt text: backslash and brackets (which would
// otherwise end the alt early or need escaping per CommonMark link-text rules), newlines flattened
// to spaces (alt text is a single line).
export function escapeAltText(text) {
  return String(text).replace(/[\r\n]+/g, " ").trim()
    .replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

// ---------- EOL-preserving line split/join ----------

function splitLines(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = source.length > 0 && /\r?\n$/.test(source);
  const lines = source.split(/\r\n|\n/);
  if (hadTrailingNewline) lines.pop();
  return { lines, eol, hadTrailingNewline };
}

function joinLines(lines, eol, hadTrailingNewline) {
  return lines.join(eol) + (hadTrailingNewline ? eol : "");
}

// ---------- marker validation ----------

// Scans for `<!-- diagrammo:sync SLUG -->` / `<!-- /diagrammo:sync SLUG -->` marker pairs and
// validates them globally before anything is transformed: unmatched begin/end, nesting, mismatched
// slug, duplicate begin for the same slug, or a span that doesn't wrap exactly one mermaid fence
// all throw a clear error naming the slug/line — never guessed/repaired.
// Returns [{ slug, beginLine, endLine }] (1-based, inclusive) for well-formed spans.
export function validateManagedSpans(source) {
  const { lines } = splitLines(source);
  const spans = [];
  const seenSlugs = new Set();
  let open = null; // { slug, line }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const beginMatch = line.match(BEGIN_RE);
    const endMatch = line.match(END_RE);
    if (beginMatch) {
      const slug = beginMatch[1];
      if (open) {
        throw new Error(`markdown-sync: begin marker for "${slug}" at line ${i + 1} nests inside unclosed "${open.slug}" opened at line ${open.line} — malformed managed block`);
      }
      if (seenSlugs.has(slug)) {
        throw new Error(`markdown-sync: duplicate managed slug "${slug}" — a begin marker for it already appeared earlier in the file`);
      }
      seenSlugs.add(slug);
      open = { slug, line: i + 1 };
    } else if (endMatch) {
      const slug = endMatch[1];
      if (!open) {
        throw new Error(`markdown-sync: end marker for "${slug}" at line ${i + 1} has no matching begin marker — malformed managed block`);
      }
      if (open.slug !== slug) {
        throw new Error(`markdown-sync: mismatched slug — begin marker "${open.slug}" at line ${open.line} closed by end marker "${slug}" at line ${i + 1}`);
      }
      spans.push({ slug, beginLine: open.line, endLine: i + 1 });
      open = null;
    } else if (MARKER_INTENT_RE.test(line)) {
      // This preflight check runs before any SVG/manifest/gallery/Markdown/temp write for the
      // file — fail loudly here rather than let a malformed marker be treated as ordinary prose
      // and silently re-wrapped into a second, nested managed block around the same fence.
      throw new Error(`markdown-sync: line ${i + 1} looks like a managed marker but is not a valid one ("${line}") — expected exactly <!-- diagrammo:sync SLUG --> or <!-- /diagrammo:sync SLUG --> with SLUG restricted to the charset [a-z0-9-]+ (lowercase letters, digits, hyphens only, non-empty) — malformed managed block, refusing to guess/repair`);
    }
  }
  if (open) {
    throw new Error(`markdown-sync: begin marker for "${open.slug}" at line ${open.line} is missing its end marker — malformed managed block`);
  }
  for (const span of spans) {
    const inner = lines.slice(span.beginLine - 1, span.endLine).join("\n");
    const fenceCount = extractBlocks(inner).length;
    if (fenceCount !== 1) {
      throw new Error(`markdown-sync: managed span "${span.slug}" (lines ${span.beginLine}-${span.endLine}) must contain exactly one mermaid fence, found ${fenceCount} — malformed managed block`);
    }
  }
  return spans;
}

// ---------- stable identity ----------

// Computes, from a Markdown source, the stable slug each already-managed block must keep (its
// first-generated identity, taken from the managed marker — never re-derived from the fence's
// current heading/title) plus the full list of managed slugs present in this file. Used by the
// CLI to preflight and reserve every existing identity *before* any block in the complete input
// set is rendered or a new slug is derived, so a heading/title edit or resyncing a subset of a
// previously multi-file sync can never rename or overwrite another block's asset.
// Throws (via validateManagedSpans) on any malformed managed marker — never guessed/repaired.
// Returns { spans, slugs, byOpenLine } — byOpenLine maps a fence's exact open line (1-based, the
// same numbering extractBlocks() reports as `line`) to its span's stable slug.
export function preferredIdentities(source) {
  const spans = validateManagedSpans(source);
  const { lines } = splitLines(source);
  const byOpenLine = new Map();
  const slugs = [];
  for (const span of spans) {
    const inner = lines.slice(span.beginLine - 1, span.endLine).join("\n");
    const [innerBlock] = extractBlocks(inner);
    byOpenLine.set(span.beginLine - 1 + innerBlock.line, span.slug);
    slugs.push(span.slug);
  }
  return { spans, slugs, byOpenLine };
}

// ---------- managed-block shape ----------

function buildManagedBlockLines({ slug, altText, href, fenceLines }) {
  return [
    `<!-- diagrammo:sync ${slug} -->`,
    `![${altText}](${href})`,
    "",
    "<details>",
    "<summary>Mermaid source</summary>",
    "",
    ...fenceLines,
    "",
    "</details>",
    `<!-- /diagrammo:sync ${slug} -->`,
  ];
}

// ---------- main transform ----------

// blocks: [{ slug, openLine, closeLine, title, href }] — openLine/closeLine are the current
// (pre-transform) 1-based line numbers of the mermaid fence's own open/close lines, exactly as
// extractBlocks() reports them on this same `source` (fence detection is indifferent to any
// existing HTML wrapper, so this holds whether the fence is bare or already inside a managed
// block from a previous run).
export function syncMarkdown(source, blocks) {
  const { lines, eol, hadTrailingNewline } = splitLines(source);
  const spans = validateManagedSpans(source);
  const spanContaining = (openLine, closeLine) =>
    spans.find((s) => s.beginLine <= openLine && closeLine <= s.endLine);

  const edits = blocks.map((b) => {
    const wrapping = spanContaining(b.openLine, b.closeLine);
    // An existing managed span's marker slug is the block's stable, first-generated identity —
    // authoritative over whatever the fence's heading/title would derive today. Renaming a
    // heading or editing an in-fence title=/name= must never rename or orphan the managed asset;
    // the CLI is expected to have already resolved `b.slug` to this same identity via
    // preferredIdentities()/extractBlocks()'s `preferred` map, but this stays authoritative here
    // too so the pure transform can never regress into rejecting/renaming a valid managed span.
    const slug = wrapping ? wrapping.slug : b.slug;
    const start = wrapping ? wrapping.beginLine : b.openLine;
    const end = wrapping ? wrapping.endLine : b.closeLine;
    const fenceLines = lines.slice(b.openLine - 1, b.closeLine);
    const altText = escapeAltText(b.title && String(b.title).trim() ? b.title : "Mermaid diagram");
    const block = buildManagedBlockLines({ slug, altText, href: b.href, fenceLines });
    return { start, end, block };
  });
  edits.sort((a, b) => b.start - a.start); // bottom-up: earlier spans' line numbers stay valid

  const out = lines.slice();
  for (const e of edits) out.splice(e.start - 1, e.end - e.start + 1, ...e.block);
  return joinLines(out, eol, hadTrailingNewline);
}
