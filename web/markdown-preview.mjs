import { marked } from "marked";
import DOMPurify from "dompurify";
import { prepareDocuments } from "../src/document.mjs";

export function secureNonce(webcrypto = globalThis.crypto) {
  if (!webcrypto || typeof webcrypto.randomUUID !== "function") {
    throw new Error("markdown-preview: secure Web Crypto (globalThis.crypto.randomUUID) is required to mint a render nonce");
  }
  return webcrypto.randomUUID();
}

// Replace prepared raw-source spans before parsing prose. No second Mermaid fence walk.
export function renderMarkdownSlots(markdown, nonceFactory = secureNonce, blocks = prepareDocuments([{ name: "editor", source: markdown }])[0].blocks) {
  const nonce = nonceFactory();
  const lines = markdown.split(/\r?\n/);
  const slots = [];
  const edits = new Map();
  for (const b of [...blocks].sort((a, b) => a.line - b.line)) {
    if (!b.location) continue;
    const { beginLine, endLine } = b.location;
    const slotId = `${nonce}-${slots.length}`;
    slots.push({ slotId, identity: b.identity });
    if (beginLine < 1 || endLine < beginLine || endLine > lines.length) {
      slots.at(-1).identity = null;
      continue;
    }
    const key = `${beginLine}:${endLine}`;
    if (!edits.has(key)) edits.set(key, { beginLine, endLine, placeholders: [] });
    const indent = lines[beginLine - 1].match(/^[ \t]*/)[0];
    edits.get(key).placeholders.push(`${indent}<div data-ahm-slot="${slotId}"></div>`);
  }
  for (const e of [...edits.values()].sort((a, b) => b.beginLine - a.beginLine)) {
    lines.splice(e.beginLine - 1, e.endLine - e.beginLine + 1, `\n${e.placeholders.join("\n\n")}\n`);
  }
  return { html: marked.parse(lines.join("\n")), nonce, slotCount: slots.length, slots };
}

export function mapSlotsToOutcomes({ slots }, results) {
  const byIdentity = new Map(results.map((r) => [r.identity, r]));
  return slots.map(({ slotId, identity }) => ({
    slotId,
    outcome: byIdentity.get(identity) ?? { kind: "unavailable", message: "Diagram unavailable (unknown prepared identity)." },
  }));
}

export function renderMarkdownPreview(markdown, results, container) {
  const prepared = renderMarkdownSlots(markdown, secureNonce, results);
  container.innerHTML = DOMPurify.sanitize(prepared.html);
  const doc = container.ownerDocument;
  for (const { slotId, outcome } of mapSlotsToOutcomes(prepared, results)) {
    // Exact nonce ownership survives sanitization and hostile source-authored HTML.
    const node = container.querySelector(`[data-ahm-slot="${slotId}"]`);
    if (node) node.replaceWith(outcomeToNode(outcome, doc));
    else container.appendChild(outcomeToNode({ kind: "unavailable", message: "Diagram unavailable (prepared source location missing)." }, doc));
  }
  for (const result of results.filter((r) => !r.location)) container.prepend(outcomeToNode(result, doc));
  return { resultCount: results.length, slotCount: prepared.slotCount };
}

function outcomeToNode(outcome, doc) {
  const section = doc.createElement("section");
  section.className = "diagram-result";
  if (outcome.identity) section.dataset.diagramId = outcome.identity;
  if (outcome.slug) section.dataset.slug = outcome.slug;
  if (outcome.kind === "health") {
    const wrap = doc.createElement("div");
    wrap.className = "svg-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", `${outcome.title || outcome.slug} diagram, scroll to see all content`);
    // SVG comes only from the trusted renderer. Sanitize the surrounding Markdown, not native text.
    wrap.innerHTML = outcome.svg;
    section.appendChild(wrap);
  }
  const diagnostics = outcome.diagnostics?.length ? outcome.diagnostics : outcome.kind === "health" ? [] : [
    { level: outcome.kind === "error" ? "error" : "warn", message: outcome.message, line: outcome.line },
  ];
  for (const d of diagnostics) {
    const p = doc.createElement("p");
    p.className = `message ${d.level === "error" ? "error" : "unsupported"}`;
    p.textContent = `${d.level === "error" ? "Error" : "Warning"}${d.line != null ? ` at line ${d.line}` : ""}: ${d.message}`;
    section.appendChild(p);
  }
  return section;
}
