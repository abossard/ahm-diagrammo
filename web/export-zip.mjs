// export-zip.mjs — browser-generated ZIP export: one .svg and .png per successfully rendered
// (health-kind) diagram. buildDiagramZip is DOM-free (accepts an injected rasterizer, defaulting
// to the real Canvas-based svgToPngBytes) so its entry-map/archive logic is Node-testable with a
// stub; only svgToPngBytes itself touches the DOM/Canvas and is browser-only.
import { zipSync, strToU8 } from "fflate";

// Real, browser-only rasterizer: renders svgString to a same-origin <canvas> sized exactly to the
// SVG's own explicit width/height (never the default 300x150 fallback), then reads back PNG bytes.
// No network fetch — the SVG is decoded from a local object URL, not a remote request.
export async function svgToPngBytes(svgString, width, height) {
  const svgBlob = new Blob([svgString], { type: "image/svg+xml" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const img = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob produced no blob"))), "image/png");
    });
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("failed to decode diagram SVG for rasterization"));
    img.src = url;
  });
}

// DOM-free: builds the {slug.svg, slug.png} entry map for every health-kind result (unsupported/
// error results are omitted) and archives it with fflate.zipSync. Reuses each result's existing
// unique `slug` (src/extract.mjs's own disambiguation) as the base filename — no second scheme.
// `rasterize` is injected so this logic is Node-testable with a stub; production callers omit it
// and get the real Canvas-based svgToPngBytes.
export async function buildDiagramZip(results, { rasterize = svgToPngBytes } = {}) {
  const healthResults = results.filter((r) => r.kind === "health");
  const skipped = results.length - healthResults.length;
  if (healthResults.length === 0) {
    return { bytes: null, count: 0, skipped };
  }
  const entries = {};
  for (const r of healthResults) {
    entries[`${r.slug}.svg`] = strToU8(r.svg);
    entries[`${r.slug}.png`] = await rasterize(r.svg, r.meta.w, r.meta.h);
  }
  const bytes = zipSync(entries);
  return { bytes, count: healthResults.length, skipped };
}
