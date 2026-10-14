// Canonical form of a native Draw.io model, and the drift report built on top of it.
//
// A shipped `examples/*.drawio.svg` is a build output: the generator emits the model, Draw.io's own
// `xmlsvg` export writes the body around it. Draw.io re-serialises the model on that path, so a
// byte comparison would fail on serialisation noise alone. This module folds exactly the
// serialisation differences Draw.io was *measured* to introduce and keeps everything else
// significant, so "the artifact disagrees with its source" becomes a testable statement.
//
// Normalisation contract — each rule exists because of a measured Draw.io behaviour:
//
//   style        key order is not significant   Draw.io re-emits style keys in its own order
//   connectable  default "1" is filled in       the generator emits connectable="1"; Draw.io omits it
//   geometry     x/y/width/height default 0     Draw.io omits zero-valued geometry attributes
//   relative     default "0" is filled in       same omission rule, on the relative flag
//   host/page    excluded                       <mxfile host/agent/modified/etag/version> and the
//                                               <mxGraphModel> view attributes dx/dy/pageScale/
//                                               pageWidth/pageHeight/pageVisible are editor state
//
// Everything else — every `ahm*` attribute, every label, every style key/value, parent,
// vertex/edge, source/target, every geometry number, the relative flag and the `<mxPoint>` set — is
// compared. Importing this module has no side effects.

import { createHash } from "node:crypto";

// `<mxGraphModel>` attributes Draw.io writes from the current editor viewport rather than from the
// model. Measured on hero/pills-stress: the generator emits neither pageScale nor pageWidth/
// pageHeight, and Draw.io's export adds `pageScale="1" pageWidth="850" pageHeight="1100"` plus its
// own dx/dy scroll state.
const VIEW_ATTRIBUTES = new Set([
  "dx", "dy", "pageScale", "pageWidth", "pageHeight", "pageVisible",
]);

const TAG = /<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g;
const ATTRIBUTE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;

export function decodeXml(value) {
  return String(value)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attributesOf(source) {
  const out = {};
  for (const match of String(source).matchAll(ATTRIBUTE)) out[match[1]] = decodeXml(match[2]);
  return out;
}

// A style is an unordered set of `key=value` pairs plus bare shape flags; Draw.io re-emits them in
// its own order, so the canonical form is the sorted set.
function canonicalStyle(style) {
  return String(style || "").split(";").map((part) => part.trim()).filter(Boolean).sort().join(";");
}

const number = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(Math.round(parsed * 1000) / 1000) : String(value);
};

// The semantic payload of an `<object>` wrapper: every attribute except the id, which is compared
// as the cell key. Rendered as one stable string so a drift report can name the field.
function semantic(data) {
  return Object.entries(data)
    .filter(([key]) => key !== "id")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("|");
}

// Parses one `<mxGraphModel>` (or a whole `<mxfile>`; the first model wins) into `{ view, cells }`.
// `cells` is a Map keyed by cell id — the same key Draw.io preserves across a save.
export function canonicalModel(xml) {
  const cells = new Map();
  let view = {};
  let pendingObject = null;
  let current = null;
  let inGeometry = false;
  let inPointArray = false;

  for (const match of String(xml).matchAll(TAG)) {
    const [, closing, name, rawAttributes, selfClosing] = match;
    const attributes = closing ? {} : attributesOf(rawAttributes);
    const empty = Boolean(selfClosing);

    if (name === "mxGraphModel" && !closing) {
      if (!Object.keys(view).length) {
        view = Object.fromEntries(Object.entries(attributes)
          .filter(([key]) => !VIEW_ATTRIBUTES.has(key)));
      }
      continue;
    }
    if (name === "object" || name === "UserObject") {
      if (closing) pendingObject = null;
      else if (!empty) pendingObject = attributes;
      continue;
    }
    if (name === "mxCell") {
      if (closing) { current = null; continue; }
      const data = pendingObject || {};
      const id = attributes.id ?? data.id;
      const geometry = {
        x: "0", y: "0", w: "0", h: "0", relative: "0", as: "geometry", points: [], terminals: {},
      };
      current = {
        id: String(id),
        sem: semantic(data),
        style: canonicalStyle(attributes.style),
        parent: attributes.parent ?? "",
        vertex: attributes.vertex ?? "0",
        edge: attributes.edge ?? "0",
        // Draw.io omits the default on export; the generator writes it out.
        connectable: attributes.connectable ?? "1",
        source: attributes.source ?? "",
        target: attributes.target ?? "",
        visible: attributes.visible ?? "1",
        geometry,
      };
      cells.set(current.id, current);
      if (empty) current = null;
      continue;
    }
    if (name === "mxGeometry" && current) {
      if (closing) { inGeometry = false; continue; }
      const geometry = current.geometry;
      geometry.x = number(attributes.x ?? 0);
      geometry.y = number(attributes.y ?? 0);
      geometry.w = number(attributes.width ?? 0);
      geometry.h = number(attributes.height ?? 0);
      geometry.relative = attributes.relative ?? "0";
      geometry.as = attributes.as ?? "geometry";
      inGeometry = !empty;
      continue;
    }
    if (name === "Array") {
      inPointArray = !closing && attributesOf(rawAttributes).as === "points";
      continue;
    }
    if (name === "mxPoint" && current && inGeometry) {
      const point = `${number(attributes.x ?? 0)},${number(attributes.y ?? 0)}`;
      if (inPointArray) current.geometry.points.push(point);
      else current.geometry.terminals[attributes.as ?? "point"] = point;
      continue;
    }
  }
  return { view, cells };
}

const FIELDS = [
  ["sem", (cell) => cell.sem],
  ["style", (cell) => cell.style],
  ["parent", (cell) => cell.parent],
  ["vertex", (cell) => cell.vertex],
  ["edge", (cell) => cell.edge],
  ["connectable", (cell) => cell.connectable],
  ["visible", (cell) => cell.visible],
  ["source", (cell) => cell.source],
  ["target", (cell) => cell.target],
  ["x", (cell) => cell.geometry.x],
  ["y", (cell) => cell.geometry.y],
  ["w", (cell) => cell.geometry.w],
  ["h", (cell) => cell.geometry.h],
  ["relative", (cell) => cell.geometry.relative],
  ["as", (cell) => cell.geometry.as],
  ["points", (cell) => cell.geometry.points.join(" ")],
  ["terminals", (cell) => JSON.stringify(cell.geometry.terminals)],
];

// Names the exact cells and the exact fields that differ, as `<cellId>: <field> built=… artifact=…`.
export function driftReport(builtXml, artifactXml) {
  const built = canonicalModel(builtXml);
  const artifact = canonicalModel(artifactXml);
  const report = [];
  for (const [key, value] of Object.entries(built.view)) {
    const other = artifact.view[key];
    if (other !== value) report.push(`<mxGraphModel>: ${key} built="${value}" artifact="${other}"`);
  }
  for (const [id, cell] of built.cells) {
    const other = artifact.cells.get(id);
    if (!other) { report.push(`${id}: missing built="present" artifact="absent"`); continue; }
    for (const [field, read] of FIELDS) {
      const a = read(cell);
      const b = read(other);
      if (a !== b) report.push(`${id}: ${field} built="${a}" artifact="${b}"`);
    }
  }
  for (const id of artifact.cells.keys()) {
    if (!built.cells.has(id)) report.push(`${id}: missing built="absent" artifact="present"`);
  }
  return report;
}

// Stable digest of the canonical model. Two models with the same digest are the same model up to
// the serialisation differences the contract above declares insignificant.
export function modelDigest(xml) {
  const { view, cells } = canonicalModel(xml);
  const payload = JSON.stringify({
    view: Object.fromEntries(Object.entries(view).sort(([a], [b]) => a.localeCompare(b))),
    cells: [...cells.keys()].sort().map((id) => {
      const cell = cells.get(id);
      return [id, ...FIELDS.map(([, read]) => read(cell))];
    }),
  });
  return createHash("sha256").update(payload).digest("hex");
}

export function cellCount(xml) {
  return canonicalModel(xml).cells.size;
}
