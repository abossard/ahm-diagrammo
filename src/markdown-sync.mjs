// Managed Markdown rewriting and path formatting. Codec exports remain compatible with old callers.
import { dirname, relative, resolve, sep } from "node:path";
import {
  escapeCommentTerminator, decodeManagedSpans, validateManagedSpans, splitLines, joinLines,
} from "./managed-source.mjs";
export {
  escapeCommentTerminator, unescapeCommentTerminator, decodeManagedSpans,
  assertBlocksEncodable, validateManagedSpans, preferredIdentities,
} from "./managed-source.mjs";

export function svgHref(mdFilePath, svgFilePath, imageFormat = "commonmark") {
  const mdDir = dirname(resolve(mdFilePath));
  const rel = relative(mdDir, resolve(svgFilePath));
  const posix = rel.split(sep).join("/");
  if (imageFormat === "learn") return posix;
  return /\s/.test(posix) ? `<${posix}>` : posix;
}

export function escapeAltText(text) {
  return String(text).replace(/[\r\n]+/g, " ").trim()
    .replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

export function escapeLearnAttr(text) {
  return String(text).replace(/[\r\n]+/g, " ").trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildManagedBlockLines({ slug, altText, href, fenceLines, imageFormat = "commonmark" }) {
  const encodedFence = escapeCommentTerminator(fenceLines.join("\n")).split("\n");
  const learnHref = escapeLearnAttr(href);
  const visible = imageFormat === "learn"
    ? `:::image type="content" source="${learnHref}" alt-text="${altText}" lightbox="${learnHref}" border="false":::`
    : `![${altText}](${href})`;
  return [
    `<!-- diagrammo:sync ${slug} -->`,
    visible,
    "",
    "<!-- diagrammo:source",
    ...encodedFence,
    "-->",
    `<!-- /diagrammo:sync ${slug} -->`,
  ];
}

// Locations refer to the line-preserving decoded source. Managed markers keep their original slug.
export function syncMarkdown(source, blocks, { imageFormat = "commonmark" } = {}) {
  const decoded = decodeManagedSpans(source);
  const { lines, eol, hadTrailingNewline } = splitLines(decoded);
  const spans = validateManagedSpans(decoded);
  const spanContaining = (openLine, closeLine) =>
    spans.find((s) => s.beginLine <= openLine && closeLine <= s.endLine);

  const edits = blocks.map((b) => {
    const wrapping = spanContaining(b.openLine, b.closeLine);
    const slug = wrapping ? wrapping.slug : b.slug;
    const start = wrapping ? wrapping.beginLine : b.openLine;
    const end = wrapping ? wrapping.endLine : b.closeLine;
    const fenceLines = lines.slice(b.openLine - 1, b.closeLine);
    const rawAlt = [b.alt, b.title].find((t) => t != null && String(t).trim()) ?? "Mermaid diagram";
    const altText = imageFormat === "learn" ? escapeLearnAttr(rawAlt) : escapeAltText(rawAlt);
    const block = buildManagedBlockLines({ slug, altText, href: b.href, fenceLines, imageFormat });
    return { start, end, block };
  });
  edits.sort((a, b) => b.start - a.start);

  const out = lines.slice();
  for (const e of edits) out.splice(e.start - 1, e.end - e.start + 1, ...e.block);
  return joinLines(out, eol, hadTrailingNewline);
}
