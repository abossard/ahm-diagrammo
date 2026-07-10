// text.mjs — approximate text measurement for layout, no browser required.
// Advance widths (per mille of font size) for the Helvetica/Arial/Segoe UI class of fonts.
// A small safety factor absorbs the difference between the table and the actual renderer,
// so measured boxes err on the roomy side — layout must never clip text.

const W = {
  " ": 278, "!": 278, '"': 355, "#": 556, "$": 556, "%": 889, "&": 667, "'": 191,
  "(": 333, ")": 333, "*": 389, "+": 584, ",": 278, "-": 333, ".": 278, "/": 278,
  "0": 556, "1": 556, "2": 556, "3": 556, "4": 556, "5": 556, "6": 556, "7": 556,
  "8": 556, "9": 556, ":": 278, ";": 278, "<": 584, "=": 584, ">": 584, "?": 556,
  "@": 1015, "A": 667, "B": 667, "C": 722, "D": 722, "E": 667, "F": 611, "G": 778,
  "H": 722, "I": 278, "J": 500, "K": 667, "L": 556, "M": 833, "N": 722, "O": 778,
  "P": 667, "Q": 778, "R": 722, "S": 667, "T": 611, "U": 722, "V": 667, "W": 944,
  "X": 667, "Y": 667, "Z": 611, "[": 278, "\\": 278, "]": 278, "^": 469, "_": 556,
  "`": 333, "a": 556, "b": 556, "c": 500, "d": 556, "e": 556, "f": 278, "g": 556,
  "h": 556, "i": 222, "j": 222, "k": 500, "l": 222, "m": 833, "n": 556, "o": 556,
  "p": 556, "q": 556, "r": 333, "s": 500, "t": 278, "u": 556, "v": 500, "w": 722,
  "x": 500, "y": 500, "z": 500, "{": 334, "|": 260, "}": 334, "~": 584,
  "…": 1000, "–": 556, "—": 1000, "‘": 222, "’": 222, "“": 333, "”": 333,
};
const SAFETY = 1.04;         // renderer fonts run slightly wider than the table
const BOLD = 1.05;           // bold advance ≈ 5% wider in this font class

function charW(ch) {
  const w = W[ch];
  if (w != null) return w;
  const cp = ch.codePointAt(0);
  // CJK, emoji, and other wide scripts ≈ 1em; everything else unknown ≈ 0.62em
  if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3)
      || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60)
      || (cp >= 0x1f000 && cp <= 0x1ffff) || (cp >= 0x2600 && cp <= 0x27bf))) return 1000;
  return 620;
}

// width in px of `text` at `fontSize`, `weight` >= 600 counts as bold
export function textWidth(text, fontSize, weight = 400) {
  let units = 0;
  for (const ch of String(text)) units += charW(ch);
  return (units / 1000) * fontSize * SAFETY * (weight >= 600 ? BOLD : 1);
}

// Greedy word wrap into at most maxLines lines of width <= maxW. Words longer than maxW are
// hard-broken so a line can never overflow. If the text doesn't fit, the last line is
// ellipsized and `clipped: true` is reported so callers can attach a tooltip + diagnostic.
export function wrapText(text, maxW, fontSize, { weight = 400, maxLines = 2 } = {}) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = "";
  const fits = (s) => textWidth(s, fontSize, weight) <= maxW;
  const pushCur = () => { if (cur) { lines.push(cur); cur = ""; } };

  for (let w of words) {
    while (!fits(w) && w.length > 1) {          // hard-break oversized words
      let cut = w.length - 1;
      while (cut > 1 && !fits(w.slice(0, cut))) cut--;
      pushCur();
      lines.push(w.slice(0, cut));
      w = w.slice(cut);
    }
    const cand = cur ? cur + " " + w : w;
    if (fits(cand)) cur = cand;
    else { pushCur(); cur = w; }
  }
  pushCur();

  if (lines.length <= maxLines) return { lines, clipped: false };
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1] + " " + lines.slice(maxLines).join(" ");
  while (last.length > 1 && !fits(last + "…")) last = last.slice(0, -1).trimEnd();
  kept[maxLines - 1] = last + "…";
  return { lines: kept, clipped: true };
}
