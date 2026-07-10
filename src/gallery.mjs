// gallery.mjs — a small self-contained HTML index of everything a run produced.
export function galleryHtml(entries, { source } = {}) {
  const cards = entries.map((e) => `
    <figure>
      <a href="${e.svg}"><img src="${e.svg}" alt="${escapeHtml(e.title)}" loading="lazy"></a>
      <figcaption>
        <strong>${escapeHtml(e.title)}</strong>
        <span>${e.renderer} · ${escapeHtml(e.theme)}${e.nodes ? ` · ${e.nodes} nodes` : ""}</span>
      </figcaption>
    </figure>`).join("\n");
  return `<!doctype html>
<meta charset="utf-8">
<title>diagrammo gallery${source ? ` — ${escapeHtml(source)}` : ""}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: "Segoe UI", -apple-system, sans-serif; margin: 2rem; background: #faf9f8; color: #242424; }
  @media (prefers-color-scheme: dark) { body { background: #1b1a19; color: #f3f2f1; } figure { background: #232120 !important; border-color: #3b3a39 !important; } }
  h1 { font-size: 1.3rem; } h1 small { font-weight: 400; opacity: .6; }
  main { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 1.2rem; }
  figure { margin: 0; background: #fff; border: 1px solid #e6e4e2; border-radius: 12px; padding: .8rem; overflow: hidden; }
  figure img { width: 100%; height: auto; display: block; border-radius: 6px; }
  figcaption { display: flex; justify-content: space-between; gap: 1rem; margin-top: .6rem; font-size: .85rem; }
  figcaption span { opacity: .6; white-space: nowrap; }
</style>
<h1>diagrammo <small>${entries.length} diagram${entries.length === 1 ? "" : "s"}${source ? ` from ${escapeHtml(source)}` : ""}</small></h1>
<main>
${cards}
</main>
`;
}
function escapeHtml(t) { return String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
