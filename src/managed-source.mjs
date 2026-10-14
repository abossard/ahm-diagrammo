// Browser-safe managed-source codec and identity validation. Line counts never change on decode.
import { extractBlocks, markdownFenceOpening, closesMarkdownFence } from "./extract.mjs";

const BEGIN_RE = /^<!--\s*diagrammo:sync\s+([a-z0-9-]+)\s*-->$/;
const END_RE = /^<!--\s*\/diagrammo:sync\s+([a-z0-9-]+)\s*-->$/;
const MARKER_INTENT_RE = /^<!--\s*\/?diagrammo:sync(?=\s|-->|$)/;
const RESERVED_TOKEN = "--&gt;";
const SOURCE_OPEN_RE = /^<!--\s*diagrammo:source\s*$/;
const SOURCE_INTENT_RE = /^<!--\s*diagrammo:source\b/;

export function escapeCommentTerminator(text) {
  if (text.includes(RESERVED_TOKEN)) {
    throw new Error(`markdown-sync: fence text already contains the reserved token "${RESERVED_TOKEN}" — cannot safely hide it inside an HTML comment (decoding it back later would be ambiguous); remove or rename this literal text before syncing`);
  }
  return text.split("-->").join(RESERVED_TOKEN);
}

export function unescapeCommentTerminator(text) {
  return text.split(RESERVED_TOKEN).join("-->");
}

export function splitLines(source) {
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const hadTrailingNewline = source.length > 0 && /\r?\n$/.test(source);
  const lines = source.split(/\r\n|\n/);
  if (hadTrailingNewline) lines.pop();
  return { lines, eol, hadTrailingNewline };
}

export function joinLines(lines, eol, hadTrailingNewline) {
  return lines.join(eol) + (hadTrailingNewline ? eol : "");
}

export function decodeManagedDocument(source) {
  const { lines, eol, hadTrailingNewline } = splitLines(source);
  const out = lines.slice();
  const sourceSpans = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      if (closesMarkdownFence(lines[i], fence)) fence = null;
      continue;
    }
    const opening = markdownFenceOpening(lines[i]);
    if (opening) { fence = opening.marker; continue; }
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
      sourceSpans.push({ beginLine: i + 1, endLine: close + 1 });
      i = close;
    } else if (SOURCE_INTENT_RE.test(line)) {
      throw new Error(`markdown-sync: line ${i + 1} looks like a hidden-source marker but is not a valid one ("${lines[i]}") — expected exactly "<!-- diagrammo:source" alone on its own line — malformed managed block, refusing to guess/repair`);
    }
  }
  return { markdown: joinLines(out, eol, hadTrailingNewline), sourceSpans };
}

export function decodeManagedSpans(source) {
  return decodeManagedDocument(source).markdown;
}

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

export function validateManagedSpans(source) {
  const { lines } = splitLines(source);
  const spans = [];
  const seenSlugs = new Set();
  let open = null;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    if (fence) {
      if (closesMarkdownFence(lines[i], fence)) fence = null;
      continue;
    }
    const opening = markdownFenceOpening(lines[i]);
    if (opening) { fence = opening.marker; continue; }
    const line = lines[i].trim();
    const beginMatch = line.match(BEGIN_RE);
    const endMatch = line.match(END_RE);
    if (beginMatch) {
      const slug = beginMatch[1];
      if (open) {
        throw new Error(`markdown-sync: begin marker for "${slug}" at line ${i + 1} nests inside unclosed "${open.slug}" opened at line ${open.line} — malformed managed block`);
      }
      if (seenSlugs.has(slug)) {
        throw Object.assign(new Error(`markdown-sync: duplicate managed slug "${slug}" — a begin marker for it already appeared earlier in the file (at line ${i + 1})`), { batch: true });
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
