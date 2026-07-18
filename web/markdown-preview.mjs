// markdown-preview.mjs — renders the editor's full Markdown source (prose + inline diagrams) for
// the preview pane. Two pure, Node-safe helpers own parsing/placeholder/ordering logic and never
// touch the DOM or call DOMPurify.sanitize; the browser-only orchestrator wires them together with
// DOMPurify and real DOM node replacement. Imports only marked/dompurify (via the import map in the
// browser, via node_modules in Node) — never src/index.mjs.
import { marked, Renderer } from "marked";
import DOMPurify from "dompurify";

// Narrow renderer: claims only `mermaid`-led fences (matching extract.mjs's fence-open rule in
// spirit — info string starts with the literal word "mermaid"), emitting a placeholder tagged
// with this call's nonce and the fence's ordinal position. Every other code fence falls back to
// the inherited default rendering unchanged.
class SlotRenderer extends Renderer {
  constructor(nonce, options) {
    super(options);
    this.nonce = nonce;
    this.slotCount = 0;
  }

  code(token) {
    const first = (token.lang || "").trim().split(/\s+/)[0];
    if (first !== "mermaid") return super.code(token);
    const slotId = `${this.nonce}-${this.slotCount++}`;
    return `<div data-ahm-slot="${slotId}"></div>`;
  }
}

// Default nonce factory: mints a fresh, unpredictable per-render nonce from the browser's Web
// Crypto (globalThis.crypto.randomUUID). It throws loud when secure Web Crypto is unavailable
// rather than silently minting a weak/predictable nonce (Math.random, a timestamp, a counter, or a
// static token would let source-authored text forge or collide with a slot). The Web Crypto source
// is a defaulted parameter purely so Node tests can prove this guard without mutating any global —
// this module never imports node:crypto and stays browser-safe. Note: Node 18 ESM does not expose a
// Web Crypto global, so Node callers inject their own fresh crypto-backed factory instead (see
// renderMarkdownSlots); the browser and Node 20+ resolve globalThis.crypto here.
export function secureNonce(webcrypto = globalThis.crypto) {
  if (!webcrypto || typeof webcrypto.randomUUID !== "function") {
    throw new Error(
      "markdown-preview: secure Web Crypto (globalThis.crypto.randomUUID) is required to mint a render nonce",
    );
  }
  return webcrypto.randomUUID();
}

// Pure, Node-safe: runs marked once with a fresh unpredictable per-call nonce so source-authored
// text cannot forge or collide with a slot from another render call. The nonce factory is injected
// (default: secureNonce, i.e. the browser's Web Crypto) so Node tests — whose ESM has no Web Crypto
// global on v18 — can pass a fresh crypto-backed factory without this module importing node:crypto.
// Returns the rendered HTML (pre-sanitize) plus the nonce and the number of mermaid slots emitted,
// in document order.
export function renderMarkdownSlots(markdown, nonceFactory = secureNonce) {
  const nonce = nonceFactory();
  const renderer = new SlotRenderer(nonce);
  const html = marked.parse(markdown, { renderer });
  return { html, nonce, slotCount: renderer.slotCount };
}

// Pure, Node-safe: maps each ordered slot id to convertMarkdown's own per-block outcome
// descriptor. Never throws on a slotCount/results.length mismatch (the marked fence tokenizer and
// extract.mjs's fence-open regex are independently written and could in principle diverge on an
// edge case) — every slot instead degrades to an "unavailable" descriptor, since pairing a
// mismatched count 1:1 could silently show the wrong diagram in the wrong slot.
export function mapSlotsToOutcomes({ nonce, slotCount }, results) {
  if (slotCount !== results.length) {
    return Array.from({ length: slotCount }, (_, i) => ({
      slotId: `${nonce}-${i}`,
      outcome: { kind: "unavailable", message: "Diagram unavailable (rendering mismatch)." },
    }));
  }
  return results.map((r, i) => ({ slotId: `${nonce}-${i}`, outcome: toOutcome(r) }));
}

function toOutcome(r) {
  if (r.kind === "health") return { kind: "health", svg: r.svg, slug: r.slug };
  if (r.kind === "unsupported") return { kind: "unsupported", message: r.message };
  return { kind: "error", message: r.message };
}

// Browser-only orchestrator: sanitizes only the surrounding marked HTML (DOMPurify's default,
// non-SVG profile — never the trusted renderSwimlane SVG, never DOMPurify's svg/svgFilters
// profile), parses the sanitized HTML into `container`, then replaces each current-nonce slot
// node (located in DOM order, never by post-sanitize string matching) with either a fragment built
// from the trusted SVG or a textContent-created message node. Not imported by Node tests.
export function renderMarkdownPreview(markdown, results, container) {
  const { html, nonce, slotCount } = renderMarkdownSlots(markdown);
  const clean = DOMPurify.sanitize(html);
  container.innerHTML = clean;

  const slots = mapSlotsToOutcomes({ nonce, slotCount }, results);
  const doc = container.ownerDocument;
  const slotNodes = container.querySelectorAll(`[data-ahm-slot^="${nonce}-"]`);
  slotNodes.forEach((node, i) => {
    node.replaceWith(outcomeToNode(slots[i].outcome, doc));
  });

  return { resultCount: results.length, slotCount };
}

function outcomeToNode(outcome, doc) {
  if (outcome.kind === "health") {
    const wrap = doc.createElement("div");
    wrap.className = "svg-wrap";
    // Trusted: outcome.svg is emitted by renderSwimlane (existing library code), never sanitized.
    wrap.innerHTML = outcome.svg;
    return wrap;
  }
  const p = doc.createElement("p");
  p.className = `message ${outcome.kind === "error" ? "error" : "unsupported"}`;
  p.textContent = outcome.kind === "error" ? `Render error: ${outcome.message}` : outcome.message;
  return p;
}
