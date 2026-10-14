import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import { contentValue } from "../../visual/svg-embed.mjs";

export function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// Draw.io stores a page either as plain `<mxGraphModel>` or as URL-encoded raw-deflate base64.
// Both forms come out of the same editor depending on the `compressXml` configuration, so the
// reopen boundary has to accept either one.
export function inflateDiagrams(model) {
  return model.replace(
    /<diagram([^>]*)>([A-Za-z0-9+/=\s]+)<\/diagram>/g,
    (whole, attributes, payload) => {
      try {
        const inflated = inflateRawSync(Buffer.from(payload.trim(), "base64")).toString("binary");
        const xml = decodeURIComponent(inflated);
        return /<mxGraphModel\b/.test(xml) ? `<diagram${attributes}>${xml}</diagram>` : whole;
      } catch {
        return whole;
      }
    },
  );
}

// The embed is read through the one shared exact selector (`visual/svg-embed.mjs`), so a
// `data-content="…"` look-alike written before the real attribute can never answer for the model
// and a missing / duplicated / unterminated `content=` raises the same named error here as on every
// other extraction path. The `<mxfile>` + `<mxGraphModel>` gate below is a *content* check and is
// deliberately kept: it passed on the C-21 decoy, which is exactly why it is not a selector.
export function readDrawioSvgSource(svg, label) {
  let content;
  try {
    content = contentValue(svg);
  } catch (error) {
    throw new Error(`${label}: ${error.message}`, { cause: error });
  }
  const model = inflateDiagrams(decodeEntities(content));
  if (!/<mxfile\b/.test(model) || !/<mxGraphModel\b/.test(model)) {
    throw new Error(`invalid embedded Draw.io model in ${label}`);
  }
  return { svg, model };
}

export function readDrawioSvg(path) {
  return readDrawioSvgSource(readFileSync(path, "utf8"), path);
}

export function objectAttributes(model, role) {
  return [...model.matchAll(/<object\b([^>]*)>\s*<mxCell\b([^>]*)>/g)]
    .map((match) => {
      const object = attributes(match[1]);
      const cell = attributes(match[2]);
      if (!cell.id) cell.id = object.id;
      return { ...object, cell };
    })
    .filter((entry) => !role || entry.ahmRole === role);
}

export function attributes(source) {
  return Object.fromEntries([...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map((match) => [
    match[1],
    decodeEntities(match[2]),
  ]));
}

// Projects a native model onto the plain-object diagram shape the plugin's simulator consumes, so
// the rollup can be exercised against the real shipped artifact instead of a hand-made fixture.
export function diagramFromModel(model) {
  const cells = objectAttributes(model).filter((entry) => entry.ahmRole).map((entry) => ({
    id: entry.cell.id,
    role: entry.ahmRole,
    ahmId: entry.ahmId,
    localState: entry.ahmLocalState,
    computedState: entry.ahmComputedState,
    authoredState: entry.ahmAuthoredState,
    impact: entry.ahmImpact,
    aggregation: entry.ahmAggregation,
    owner: entry.ahmOwner,
    state: entry.ahmState,
    edgeImpact: entry.ahmRole === "dependency" ? entry.ahmImpact : null,
    source: entry.cell.source,
    target: entry.cell.target,
    style: entry.cell.style || "",
  })).filter((cell) => cell.role !== "legend" && cell.role !== "lane");
  return { cells };
}
