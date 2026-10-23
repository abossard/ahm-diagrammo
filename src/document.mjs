// One calculation for both hosts: decode, options, identities, locations and renderer selection.
import { extractBlocks, reserveSlug } from "./extract.mjs";
import { decodeManagedDocument, preferredIdentities, assertBlocksEncodable } from "./managed-source.mjs";
import { resolveRenderer } from "./render.mjs";
import { THEME_NAMES } from "./themes.mjs";

export function prepareDocuments(inputs, defaults = {}, { sync = false } = {}) {
  const used = new Map();
  const owners = new Map();
  const pending = inputs.map(({ name, source }) => {
    const doc = { name, source, markdown: source, blocks: [], diagnostics: [] };
    let identities, sourceSpans;
    try {
      const decoded = decodeManagedDocument(source);
      const { markdown } = decoded;
      sourceSpans = decoded.sourceSpans;
      doc.markdown = markdown;
      identities = preferredIdentities(markdown);
      for (const slug of identities.slugs) {
        if (owners.has(slug)) {
          throw Object.assign(new Error(`managed slug "${slug}" is already used by ${owners.get(slug)} — duplicate managed identity targeting the same output directory (at line ${identities.spans.find((s) => s.slug === slug).beginLine})`), { batch: true });
        }
        owners.set(slug, name);
        reserveSlug(used, slug);
      }
    } catch (e) {
      doc.diagnostics.push({ level: "error", message: e.message, line: Number(e.message.match(/\bline (\d+)/)?.[1]) || null, origin: "document", scope: e.batch ? "batch" : "document" });
    }
    return { doc, identities, sourceSpans };
  });
  for (const { doc, identities, sourceSpans } of pending) {
    if (doc.diagnostics.length) continue;
    doc.blocks = extractBlocks(doc.markdown, THEME_NAMES, used, identities.byOpenLine).map((b) => {
      const effectiveOptions = {
        ...defaults, ...b.options,
        title: b.options.title ?? b.heading,
        theme: b.options.theme || defaults.theme || "portal",
        renderer: b.options.renderer || defaults.renderer || "auto",
      };
      const renderer = resolveRenderer(effectiveOptions.renderer, b.code);
      const end = b.closeLine ?? doc.source.split("\n").length;
      const span = [...identities.spans, ...sourceSpans].find((s) => s.beginLine <= b.line && end <= s.endLine);
      return {
        ...b, effectiveOptions, renderer,
        identity: `${doc.name}:${b.line}:${b.slug}`,
        location: { beginLine: span?.beginLine ?? b.line, endLine: span?.endLine ?? end },
        issues: b.issues.map((i) => ({ ...i, origin: "document" })),
      };
    });
    if (sync) {
      try { assertBlocksEncodable(doc.markdown, doc.blocks); }
      catch (e) { doc.diagnostics.push({ level: "error", message: e.message, line: Number(e.message.match(/\bline (\d+)/)?.[1]) || null, origin: "document" }); }
    }
  }
  return pending.map(({ doc }) => doc);
}
