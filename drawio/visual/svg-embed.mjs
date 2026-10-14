// One exact selector for the Draw.io model embedded in a `.drawio.svg`, shared by **every** path
// that reads that embed: the reopen path in `visual/render-native.mjs`, `readDrawioSvg` in
// `test/helpers/artifact.mjs`, the `NC-13a` payload proof and the export presence check in
// `visual/drawio-host.mjs`. Before C-21 each of those carried its own `svg.match(/\bcontent="…"/)`,
// and with a **complete valid** decoy the failure was silent, not loud: the naive regex selected a
// `data-content="&lt;mxfile … agent=&quot;DECOY-A&quot;&gt;<real payload>"` attribute written in
// front of the real one, every consumer gate passed on it, and the returned model was the decoy's
// (measured as `P-C21-1`…`P-C21-4`). Duplication was the defect, so this module is the one
// definition; a second local copy is a regression, not a convenience.
//
// This module is deliberately **import-free and pure**. It reads no file, touches no global, holds
// no state and imports nothing. That is load-bearing twice: it makes an import cycle impossible
// (`visual/render-native.mjs` already imports `test/helpers/artifact.mjs`, which imports this), and
// it is what lets `NC-68`'s kill controls read this very source, apply one named transform and
// import the result through a `data:text/javascript` URL without writing a file anywhere.
//
// The selection is **structural and byte-exact**, never a substring and never a loose regex, and
// there is no DOM or XML parse anywhere: the whole point of the proof it serves is that it is made
// on the bytes Draw.io wrote, so a reserialisation would replace the proof with a projection of it.
// The chain is: the outer `<svg>` opening tag, then the attribute whose name **is** `content`
// inside that tag, then the escaped root `&lt;mxfile … &gt;` open tag which must be the value's
// first bytes and its only root, then the one `agent=&quot;…&quot;` attribute inside that root tag.
// Every structural failure throws a distinct named error rather than degrading into a looser match.

const SVG_OPEN = "<svg";
const CONTENT_NAME = "content";
const CONTENT_ASSIGN = '="';
const ROOT_OPEN = "&lt;mxfile";
const ROOT_CLOSE = "&lt;/mxfile&gt;";
const TAG_OPEN = "&lt;";
const TAG_CLOSE = "&gt;";
const AGENT_OPEN = "agent=&quot;";
const AGENT_QUOTE = "&quot;";
const AGENT_NORMALISED = `${AGENT_OPEN}(normalised)${AGENT_QUOTE}`;
// XML's own whitespace set, which is what separates one attribute from the next. A name is an
// attribute name only when the byte in front of it is one of these.
const XML_SPACE = " \t\r\n";
const isSpace = (character) => character !== undefined && XML_SPACE.includes(character);

// The bounds of the outer `<svg …>` **opening tag**, read off the raw bytes. Measured on all three
// exports (`P-C20-1`): the tag carries no attribute value with a raw `>` — the embedded model is
// entity-escaped, so its `&gt;` are not `>` — and the tag's first raw `>` is the byte after the
// `content` attribute's closing quote. So the first raw `>` is the end of the opening tag, and
// nothing looser is assumed than what the export was measured to emit.
export function svgOpenTagSpan(text) {
  const start = text.indexOf(SVG_OPEN);
  if (start < 0 || !(isSpace(text[start + SVG_OPEN.length]) || text[start + SVG_OPEN.length] === ">")) {
    throw new Error("outer <svg> element: no opening tag");
  }
  const end = text.indexOf(">", start + SVG_OPEN.length);
  if (end < 0) throw new Error("outer <svg> element: the opening tag is not terminated by >");
  return { start, end };
}

// The attribute named exactly `content` on that opening tag: the byte in front of the name is XML
// whitespace, so `data-content=` is a different attribute and not a match, `xcontent=` is not a
// match either, and exactly one such attribute is required. The value is bound to the matching
// closing quote of the quote character the bytes actually opened with, and that closer must still
// lie inside the same opening tag — the bound that turns a deleted closing quote into a named error
// instead of a silent rebind to a quote in the rendered body (`P-C20-5`).
export function contentAttribute(text) {
  const tag = svgOpenTagSpan(text);
  const found = [];
  for (let at = text.indexOf(CONTENT_NAME, tag.start); at >= 0 && at < tag.end;
    at = text.indexOf(CONTENT_NAME, at + 1)) {
    if (!isSpace(text[at - 1])) continue;
    if (text.startsWith(CONTENT_ASSIGN, at + CONTENT_NAME.length)) found.push(at);
  }
  if (found.length === 0) {
    throw new Error('content attribute: the outer <svg> opening tag carries no content="…"');
  }
  if (found.length > 1) {
    throw new Error(`content attribute: the outer <svg> opening tag carries ${found.length} `
      + 'content="…" attributes');
  }
  const quote = text[found[0] + CONTENT_NAME.length + 1];
  const valueAt = found[0] + CONTENT_NAME.length + CONTENT_ASSIGN.length;
  const valueEnd = text.indexOf(quote, valueAt);
  if (valueEnd < 0 || valueEnd > tag.end) throw new Error("content attribute: unterminated value");
  return { tag, at: found[0], valueAt, valueEnd };
}

// `D-C21-2`: extracting the model needs the exact `content` **value** and nothing else, so the
// value selector is exposed separately from the root/agent chain — but it is the *same* attribute
// found by the *same* code, so a missing, duplicated or unterminated attribute raises exactly the
// same three named errors here as it does on the normalisation path. The value is returned as the
// raw escaped bytes; decoding and inflating belong to the consumer, not to the selector.
export function contentValue(text) {
  const { valueAt, valueEnd } = contentAttribute(text);
  return text.slice(valueAt, valueEnd);
}

// The root must be the content value's **first bytes**: a fake escaped root written in front of the
// real one was selected by position before C-20 (`P-C20-3`).
function assertRootIsFirstBytes(value) {
  if (!value.startsWith(ROOT_OPEN)) {
    throw new Error("root <mxfile> anchor: the content value does not begin with the escaped root "
      + "&lt;mxfile open tag");
  }
}

// …and it must be the value's only root, closed by the value's single trailing `&lt;/mxfile&gt;` —
// measured on all three exports (`P-C20-1`), so a second root appended after the real one is
// rejected instead of being tolerated silently.
function assertRootCount(value) {
  const roots = value.split(ROOT_OPEN).length - 1;
  if (roots !== 1) {
    throw new Error(`root <mxfile> anchor: the content value carries ${roots} escaped &lt;mxfile `
      + "open tags");
  }
  const closes = value.split(ROOT_CLOSE).length - 1;
  if (closes !== 1 || !value.endsWith(ROOT_CLOSE)) {
    throw new Error(`root <mxfile> anchor: the content value carries ${closes} &lt;/mxfile&gt; and `
      + "does not end with exactly one");
  }
}

// The absolute bounds of the escaped root open tag inside that content value: `start` at its
// `&lt;`, `end` at its terminating `&gt;`. An open tag cannot contain an unescaped `<`, so a root
// tag whose `&gt;` is missing is detected by the next `&lt;` arriving first instead of being
// silently extended over the `&lt;diagram` that follows it.
export function rootTagSpan(text) {
  const { valueAt, valueEnd } = contentAttribute(text);
  const value = text.slice(valueAt, valueEnd);
  assertRootIsFirstBytes(value);
  assertRootCount(value);
  const start = valueAt;
  const end = text.indexOf(TAG_CLOSE, start + ROOT_OPEN.length);
  const nextTag = text.indexOf(TAG_OPEN, start + ROOT_OPEN.length);
  if (end < 0 || end >= valueEnd || (nextTag >= 0 && nextTag < end)) {
    throw new Error("root <mxfile> anchor: the &lt;mxfile open tag is not terminated by &gt;");
  }
  return { start, end, text: text.slice(start, end + TAG_CLOSE.length) };
}

// `agent` is an attribute name inside that root open tag, not a suffix of one: the byte in front of
// it is XML whitespace, so `x-agent=` is a different attribute (the C-19 `/\bagent=/` boundary
// matched after the `-` and rejected a perfectly good export, `P-C20-6`). Exactly one is required,
// its value must be non-empty and must carry no escaped `&` entity — neither shape is something the
// three measured exports produce, so both are a tampering signal and fail loud rather than being
// normalised away silently (`P-C20-7`).
export function agentSpan(text) {
  const root = rootTagSpan(text);
  const inside = text.slice(root.start, root.end);
  const found = [];
  for (let at = inside.indexOf(AGENT_OPEN); at >= 0; at = inside.indexOf(AGENT_OPEN, at + 1)) {
    if (isSpace(inside[at - 1])) found.push(at);
  }
  if (found.length === 0) {
    throw new Error("root <mxfile> anchor: the root open tag carries no agent=&quot;…&quot;");
  }
  if (found.length > 1) {
    throw new Error(`root <mxfile> anchor: the root open tag carries ${found.length} `
      + "agent=&quot;…&quot; attributes");
  }
  const valueAt = found[0] + AGENT_OPEN.length;
  const valueEnd = inside.indexOf(AGENT_QUOTE, valueAt);
  if (valueEnd < 0) {
    throw new Error("root <mxfile> anchor: the agent attribute is not terminated by &quot;");
  }
  const value = inside.slice(valueAt, valueEnd);
  if (value.length === 0) throw new Error("root <mxfile> anchor: the agent value is empty");
  if (value.includes("&")) {
    throw new Error("root <mxfile> anchor: the agent value carries an escaped & entity");
  }
  const start = root.start + found[0];
  const length = valueEnd + AGENT_QUOTE.length - found[0];
  return { start, end: start + length, text: inside.slice(found[0], found[0] + length) };
}

export const agentOf = (text) => agentSpan(text).text.slice(AGENT_OPEN.length, -AGENT_QUOTE.length);

// The bytes on either side of the attribute, so "these two exports differ only inside `agent=…`"
// is asserted on the parts themselves and stays exact even if a future user agent is a different
// length than the one on disk.
export function splitAtAgent(text) {
  const span = agentSpan(text);
  return { head: text.slice(0, span.start), agent: span.text, tail: text.slice(span.end) };
}

export const AGENT_PLACEHOLDER = AGENT_NORMALISED;

export function normaliseAgent(text) {
  const span = agentSpan(text);
  return text.slice(0, span.start) + AGENT_NORMALISED + text.slice(span.end);
}

export function replaceAgent(text, agent) {
  const span = agentSpan(text);
  return {
    text: text.slice(0, span.start) + AGENT_OPEN + agent + AGENT_QUOTE + text.slice(span.end),
    at: span.start,
    was: agentOf(text),
  };
}
