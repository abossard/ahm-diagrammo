// markdown-sync.mjs — pure transform for `diagrammo --sync-markdown`.
//
// Given a Markdown source string and, per rendered mermaid block, its already-computed
// { slug, openLine, closeLine, title, href }, rewrites each plain ```mermaid fence in place into
// a machine-owned "managed block": a visible SVG <img>, followed by a *fully hidden* HTML comment
// wrapping the original fence — its literal `-->` terminators escaped to `--&gt;` so the comment
// never closes early — so GitHub (and any CommonMark-conformant renderer) shows only the <img>
// while the raw/edit view keeps the Mermaid source live, byte-recoverable, and fully editable.
//
// Owns exactly: marker validation, the escape/decode codec, the managed-block shape, href/alt-text
// formatting, and whole-span text replacement. Never touches the filesystem (the CLI does the
// atomic write) and never parses/renders Mermaid itself (reuses src/extract.mjs for fence
// detection, per the project's "don't reimplement Mermaid parsing" rule) — every call site that
// needs *real* Mermaid text runs it through decodeManagedSpans() first, never raw/escaped text.
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

// ---------- hidden-source comment: escape/decode codec ----------
//
// A managed block is three independent, self-closed, non-nested HTML comments: the begin marker
// (above), a single "hidden-source" comment wrapping the escaped fence (below), and the end marker
// (above). None of them is ever nested inside another — CommonMark's HTML-comment production ends
// at the *first* line containing the literal string "-->" (spec 0.31.2), so a comment can never
// safely wrap another comment, or arbitrary Mermaid text containing a real "-->", without either
// truncating early (leaking the remainder as visible content) or being truncated by an inner one.

// The literal HTML-entity-encoded stand-in for a comment terminator. A real "-->" inside the
// hidden-source comment's body would end it early; every literal occurrence is escaped to this
// 6-character token first, which itself contains no ">" character and so can never be mistaken for
// (or itself prematurely close) a comment.
const RESERVED_TOKEN = "--&gt;";

// Reversible, minimal codec for hiding a Mermaid fence's *exact* text inside an HTML comment:
// escapes only the literal 3-character substring "-->" — never "--" alone, never context-sensitive,
// never a broad HTML-entity decode — to the 6-character RESERVED_TOKEN. Throws if the input already
// contains that token: decoding it back later would be ambiguous (unable to tell "the codec's own
// escape marker" apart from "literal --&gt; the author actually typed"), so such input is rejected
// outright, before any write, rather than silently mis-decoded on a later read.
export function escapeCommentTerminator(text) {
  if (text.includes(RESERVED_TOKEN)) {
    throw new Error(`markdown-sync: fence text already contains the reserved token "${RESERVED_TOKEN}" — cannot safely hide it inside an HTML comment (decoding it back later would be ambiguous); remove or rename this literal text before syncing`);
  }
  return text.split("-->").join(RESERVED_TOKEN);
}

// Exact inverse of escapeCommentTerminator. Safe to call on any text that function produced:
// encoding already refuses any input that contains the reserved token, so every occurrence found
// here is necessarily the codec's own escape marker, never a coincidental pre-existing one — this
// is why decoding never needs (and must never do) a broad HTML-entity decode.
export function unescapeCommentTerminator(text) {
  return text.split(RESERVED_TOKEN).join("-->");
}

// The hidden-source comment's own open marker line. Deliberately carries no "-->" on this same
// line — it must stay open across the fence lines that follow, closing only at the first
// subsequent line containing a literal "-->" (which, by construction, is the dedicated closing
// line decodeManagedSpans()/buildManagedBlockLines() below always place right after the fence).
const SOURCE_OPEN_RE = /^<!--\s*diagrammo:source\s*$/;
// Broad intent detector, same philosophy as MARKER_INTENT_RE: catches a line that clearly attempts
// to open a hidden-source comment but doesn't match the strict shape above (extra tokens, wrong
// case, a stray slug) so it fails loudly instead of being silently treated as ordinary prose.
const SOURCE_INTENT_RE = /^<!--\s*diagrammo:source\b/;

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

// ---------- decode: recover real Mermaid text from any hidden-source comment ----------

// Scans for `<!-- diagrammo:source` ... `-->` hidden-source comments — independent of, and never
// requiring, valid begin/end identity markers around them, so it can run unconditionally on every
// file the CLI reads, whether or not `--sync-markdown` is active — and returns a decoded view of
// the *whole* document: identical byte-for-byte everywhere except that each such comment's interior
// lines have been unescaped back to real Mermaid text. This is the single normalization step every
// call site that needs real Mermaid text (extractBlocks() for rendering, syncMarkdown() for
// rebuilding a span) must go through — never fed raw/escaped text directly, and never a broad
// HTML-entity decode of anything outside a recognized hidden-source comment's own span. A line
// that clearly intends to open one but doesn't match the strict shape, or one that opens but never
// finds a closing "-->" line, fails loudly (malformed managed block) rather than silently passing
// escaped text through as if it were real Mermaid. A bare/plain fence or an old `<details>`-shape
// fence has no hidden-source comment at all, so it passes through this function unchanged.
export function decodeManagedSpans(source) {
  const { lines, eol, hadTrailingNewline } = splitLines(source);
  const out = lines.slice();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (SOURCE_OPEN_RE.test(line)) {
      let close = -1;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].includes("-->")) { close = j; break; }
      }
      if (close === -1) {
        throw new Error(`markdown-sync: hidden-source comment opened at line ${i + 1} is missing its closing "-->" — malformed managed block`);
      }
      for (let k = i + 1; k < close; k++) out[k] = unescapeCommentTerminator(lines[k]);
      i = close;
    } else if (SOURCE_INTENT_RE.test(line)) {
      throw new Error(`markdown-sync: line ${i + 1} looks like a hidden-source marker but is not a valid one ("${lines[i]}") — expected exactly "<!-- diagrammo:source" alone on its own line — malformed managed block, refusing to guess/repair`);
    }
  }
  return joinLines(out, eol, hadTrailingNewline);
}

// Preflight guard: given an already-decoded source and its already-extracted mermaid blocks
// (`.line`/`.closeLine` as extractBlocks() reports them), throws if ANY block's raw fence text
// already contains the reserved encoded token — before any SVG/manifest/gallery/Markdown write
// happens for this file. Mirrors the same per-block guard buildManagedBlockLines() applies during
// the real rebuild, so a file with several blocks and an ambiguous one deep inside it fails here,
// before the first block's SVG is ever written, not partway through the render loop.
export function assertBlocksEncodable(source, blocks) {
  const { lines } = splitLines(source);
  for (const b of blocks) {
    const end = b.closeLine ?? b.line;
    const fenceText = lines.slice(b.line - 1, end).join("\n");
    try {
      escapeCommentTerminator(fenceText);
    } catch (e) {
      throw new Error(`${e.message} (fence at line ${b.line})`);
    }
  }
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

// Three independent, self-closed, non-nested HTML comments — begin marker, hidden-source, end
// marker — with the visible `![alt](href)` image sitting outside all of them. The fence's own
// text (delimiters + body) is escaped as one unit via escapeCommentTerminator() before being
// embedded, so this throws (never silently mis-encodes) if that text already contains the
// reserved token — the same guard assertBlocksEncodable() lets the CLI run as an early preflight.
function buildManagedBlockLines({ slug, altText, href, fenceLines }) {
  const encodedFence = escapeCommentTerminator(fenceLines.join("\n")).split("\n");
  return [
    `<!-- diagrammo:sync ${slug} -->`,
    `![${altText}](${href})`,
    "",
    "<!-- diagrammo:source",
    ...encodedFence,
    "-->",
    `<!-- /diagrammo:sync ${slug} -->`,
  ];
}

// ---------- main transform ----------

// blocks: [{ slug, openLine, closeLine, title, href }] — openLine/closeLine are the current
// (pre-transform) 1-based line numbers of the mermaid fence's own open/close lines, exactly as
// extractBlocks() reports them on a *decoded* view of this same `source` (fence detection is
// indifferent to any existing HTML wrapper, so this holds whether the fence is bare, inside an old
// `<details>`-shape span, or inside a hidden-source comment from a previous run).
export function syncMarkdown(source, blocks) {
  // Decode first: an existing hidden-source comment's fence body is escaped on disk, and every
  // call site here (line-splicing below, and buildManagedBlockLines()'s own re-encode) must see
  // real Mermaid text — never escaped text — so an edit made directly inside the hidden comment,
  // or a plain re-run of an unmodified block, round-trips correctly instead of double-encoding.
  // A no-op for bare fences and old `<details>`-shape spans, which were never encoded.
  const decoded = decodeManagedSpans(source);
  const { lines, eol, hadTrailingNewline } = splitLines(decoded);
  const spans = validateManagedSpans(decoded);
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
