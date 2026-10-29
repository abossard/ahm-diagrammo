const SUPPORTED_FONT_ASCII_ADVANCE = Object.freeze({
  " ": 0.5, "!": 0.5, "\"": 0.5, "#": 0.556152, "$": 0.556152, "%": 0.88916, "&": 0.666992, "'": 0.5, "(": 0.5, ")": 0.5, "*": 0.5, "+": 0.583984, ",": 0.5, "-": 0.5, ".": 0.5, "/": 0.5,
  "0": 0.556152, "1": 0.556152, "2": 0.556152, "3": 0.556152, "4": 0.556152, "5": 0.556152, "6": 0.556152, "7": 0.556152, "8": 0.556152, "9": 0.556152, ":": 0.5, ";": 0.5, "<": 0.583984, "=": 0.583984, ">": 0.583984, "?": 0.556152, "@": 1.015137,
  A: 0.666992, B: 0.666992, C: 0.722168, D: 0.722168, E: 0.666992, F: 0.61084, G: 0.777832, H: 0.722168, I: 0.5, J: 0.5, K: 0.666992, L: 0.556152, M: 0.833008, N: 0.722168, O: 0.777832, P: 0.666992, Q: 0.777832, R: 0.722168, S: 0.666992, T: 0.61084, U: 0.722168, V: 0.666992, W: 0.943848, X: 0.666992, Y: 0.666992, Z: 0.61084,
  "[": 0.5, "\\": 0.5, "]": 0.5, "^": 0.5, _: 0.556152, "`": 0.5,
  a: 0.556152, b: 0.556152, c: 0.5, d: 0.556152, e: 0.556152, f: 0.5, g: 0.556152, h: 0.556152, i: 0.5, j: 0.5, k: 0.5, l: 0.5, m: 0.833008, n: 0.556152, o: 0.556152, p: 0.556152, q: 0.556152, r: 0.5, s: 0.5, t: 0.5, u: 0.556152, v: 0.5, w: 0.722168, x: 0.5, y: 0.5, z: 0.5,
  "{": 0.5, "|": 0.5, "}": 0.5, "~": 0.583984,
});

export const AHM_TEXT_METRIC_PROVENANCE = Object.freeze({
  generator: "fontkit 2.x",
  sourceFonts: [
    {
      path: "/System/Library/Fonts/Supplemental/Arial.ttf",
      postscriptName: "ArialMT",
      unitsPerEm: 2048,
      sha256: "525979822591a3447cfc49d943d6f7683508e25543407871c0ed8fed05fd2bd9",
    },
    {
      path: "./test/assets/fonts/unifont-18.0.01.otf",
      postscriptName: "Unifont",
      unitsPerEm: 16,
      sha256: "88d0a14d4aa9a96419720b39ba5da921a59560d76d4ec7d523acc06ed85cd3c2",
    },
    {
      path: "./test/assets/fonts/unifont_upper-18.0.01.otf",
      postscriptName: "UnifontUpper",
      unitsPerEm: 16,
      sha256: "472201e45a050bff4c7658208b8c73e34ebce3764b287a5a46c7774038ef9391",
    },
  ],
  strategy: "ascii uses per-glyph max advance across supported fonts; non-ascii fallback uses conservative 1em where needed",
  coveredCodepoints: "U+0020..U+007E",
});

const CARD_BASE = Object.freeze({
  topPad: 10,
  bottomPad: 8,
  sidePad: 10,
  sectionGap: 8,
  titleSize: 14,
  qualifierSize: 12,
  headerSize: 12,
  bodySize: 12,
  stateSize: 12,
  badgeSize: 12,
  titleLineHeight: 16,
  bodyLineHeight: 14,
  tableHeaderHeight: 20,
  rowPadY: 9,
  minNameWidth: 145,
  minValueWidth: 70,
  minStateWidth: 88,
  minTableWidth: 320,
  maxTableWidth: 400,
});

export const BASELINE_METRICS = Object.freeze({
  ascentRatio: 0.8,
  descentRatio: 0.2,
});

export function createAhmTextMeasurer() {
  return {
    width(text, size, style = {}) {
      const safeSize = Number.isFinite(size) && size > 0 ? size : 12;
      const weight = Number(style.fontWeight ?? style.weight ?? 400);
      const weightFactor = Number.isFinite(weight) && weight >= 600 ? 1.03 : 1;
      let units = 0;
      for (const ch of String(text ?? "")) {
        let advance = SUPPORTED_FONT_ASCII_ADVANCE[ch];
        if (advance == null) {
          const cp = ch.codePointAt(0);
          if (cp == null) advance = 0.56;
          else if (/\p{Cc}|\p{Cf}/u.test(ch) || /\p{Mark}/u.test(ch)) advance = 0;
          else if (/\p{Emoji_Presentation}/u.test(ch) || /\p{Extended_Pictographic}/u.test(ch)
            || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)
            || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0xff00 && cp <= 0xffef)) advance = 1;
          else advance = 0.62;
        }
        units += advance;
      }
      return units * safeSize * weightFactor;
    },
  };
}

function wrapTextToWidth(text, maxWidth, size, style, measurer) {
  const widthOf = (value) => measurer.width(value, size, style);
  const lines = [];
  const parts = String(text ?? "").split(/\n/);
  for (const part of parts) {
    const line = part.trim();
    if (!line) {
      lines.push("");
      continue;
    }
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push(line);
      continue;
    }
    const out = [];
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (widthOf(candidate) <= maxWidth) {
        current = candidate;
        continue;
      }
      if (current) out.push(current);
      if (widthOf(word) <= maxWidth) {
        current = word;
        continue;
      }
      // hard-break an oversized word at grapheme boundaries
      const graphemes = typeof Intl !== "undefined" && Intl.Segmenter
        ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(word)].map((piece) => piece.segment)
        : Array.from(word);
      let chunk = "";
      for (const char of graphemes) {
        const next = `${chunk}${char}`;
        if (chunk && widthOf(next) > maxWidth) {
          out.push(chunk);
          chunk = char;
        } else {
          chunk = next;
        }
      }
      if (chunk) out.push(chunk);
      current = "";
    }
    if (current) out.push(current);
    for (const wrapped of (out.length ? out : [line])) lines.push(wrapped);
  }
  return lines.length ? lines : [""];
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function signalValue(row) {
  if (row.valueKind === "missing") return "∅";
  if (row.valueKind === "empty") return "[empty]";
  return row.value ?? "";
}

export function planEntityCard(entity, measurer, options = {}) {
  const requested = Number.isFinite(options.fontSize) && options.fontSize > 0 ? options.fontSize : 16;
  const textScale = requested / 16;
  const geometryScale = Math.max(1, textScale);
  const scaled = (value, scale, label) => {
    const raw = value * scale;
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`render failed: fontSize produced invalid ${label} geometry`);
    }
    if (raw > Number.MAX_SAFE_INTEGER / 1024) {
      throw new Error(`render failed: fontSize is too large for safe ${label} geometry`);
    }
    return raw;
  };
  const constants = {
    ...CARD_BASE,
    topPad: scaled(CARD_BASE.topPad, geometryScale, "topPad"),
    bottomPad: scaled(CARD_BASE.bottomPad, geometryScale, "bottomPad"),
    sidePad: scaled(CARD_BASE.sidePad, geometryScale, "sidePad"),
    sectionGap: scaled(CARD_BASE.sectionGap, geometryScale, "sectionGap"),
    titleSize: scaled(CARD_BASE.titleSize, textScale, "titleSize"),
    qualifierSize: scaled(CARD_BASE.qualifierSize, textScale, "qualifierSize"),
    headerSize: scaled(CARD_BASE.headerSize, textScale, "headerSize"),
    bodySize: scaled(CARD_BASE.bodySize, textScale, "bodySize"),
    stateSize: scaled(CARD_BASE.stateSize, textScale, "stateSize"),
    badgeSize: scaled(CARD_BASE.badgeSize, textScale, "badgeSize"),
    titleLineHeight: scaled(CARD_BASE.titleLineHeight, geometryScale, "titleLineHeight"),
    bodyLineHeight: scaled(CARD_BASE.bodyLineHeight, geometryScale, "bodyLineHeight"),
    tableHeaderHeight: scaled(CARD_BASE.tableHeaderHeight, geometryScale, "tableHeaderHeight"),
    rowPadY: scaled(CARD_BASE.rowPadY, geometryScale, "rowPadY"),
    minNameWidth: scaled(CARD_BASE.minNameWidth, geometryScale, "minNameWidth"),
    minValueWidth: scaled(CARD_BASE.minValueWidth, geometryScale, "minValueWidth"),
    minStateWidth: scaled(CARD_BASE.minStateWidth, geometryScale, "minStateWidth"),
    minTableWidth: scaled(CARD_BASE.minTableWidth, geometryScale, "minTableWidth"),
    maxTableWidth: scaled(CARD_BASE.maxTableWidth, geometryScale, "maxTableWidth"),
    badgeHeight: scaled(20, geometryScale, "badgeHeight"),
    badgeRadius: scaled(10, geometryScale, "badgeRadius"),
    badgeTextYOffset: scaled(14, geometryScale, "badgeTextYOffset"),
    headerTextYOffset: scaled(13, geometryScale, "headerTextYOffset"),
    bodyTextYOffset: scaled(13, geometryScale, "bodyTextYOffset"),
    stateDotRadius: scaled(3.2, geometryScale, "stateDotRadius"),
    stateDotXOffset: scaled(8, geometryScale, "stateDotXOffset"),
    stateTextXOffset: scaled(14, geometryScale, "stateTextXOffset"),
    cellPadX: scaled(6, geometryScale, "cellPadX"),
    clipPadX: scaled(4, geometryScale, "clipPadX"),
    clipPadY: scaled(2, geometryScale, "clipPadY"),
    minClipSpan: scaled(4, geometryScale, "minClipSpan"),
    badgeGapX: scaled(10, geometryScale, "badgeGapX"),
    minHeaderTextWidth: scaled(96, geometryScale, "minHeaderTextWidth"),
  };
  const tableHeaders = options.tableHeaders !== false;
  // values: false drops the Value column; degraded/unhealthy names are drawn bold in their place
  const values = options.values !== false;
  const nameWeight = (row) => (!values && (row.state === "degraded" || row.state === "unhealthy") ? 600 : 500);
  const title = entity.presentation?.title ?? entity.label ?? "";
  const qualifier = entity.presentation?.qualifier ?? "";
  const badgeText = `${entity.state.slice(0, 1).toUpperCase()}${entity.state.slice(1)}`;
  const stateLabels = entity.signals.map((row) => `${row.state.slice(0, 1).toUpperCase()}${row.state.slice(1)}`);

  const measuredName = entity.signals.length
    ? Math.max(...entity.signals.map((row) => measurer.width(row.name, constants.bodySize, { fontWeight: nameWeight(row) })))
    : 0;
  const measuredValue = entity.signals.length && values
    ? Math.max(...entity.signals.map((row) => measurer.width(signalValue(row), constants.bodySize, { fontWeight: 500 })))
    : 0;
  const measuredState = stateLabels.length
    ? Math.max(...stateLabels.map((label) => measurer.width(label, constants.stateSize, { fontWeight: 600 })))
    : 0;

  const headerNameDemand = tableHeaders ? Math.ceil(measurer.width("Signal", constants.headerSize, { fontWeight: 600 }) + (constants.cellPadX * 2)) : 0;
  const headerValueDemand = tableHeaders && values ? Math.ceil(measurer.width("Value", constants.headerSize, { fontWeight: 600 }) + (constants.cellPadX * 2)) : 0;
  const headerStateDemand = tableHeaders ? Math.ceil(measurer.width("State", constants.headerSize, { fontWeight: 600 }) + (constants.cellPadX * 2)) : 0;
  const signalScale = Math.max(1, constants.bodySize / CARD_BASE.bodySize);
  const targetName = Math.ceil(Math.max(measuredName + (12 * signalScale), headerNameDemand));
  const targetValue = values ? Math.ceil(Math.max(measuredValue + (12 * signalScale), headerValueDemand)) : 0;
  const targetState = Math.ceil(Math.max(measuredState + (24 * signalScale), headerStateDemand));
  const tableWidth = clamp(targetName + targetValue + targetState, 1, constants.maxTableWidth);
  // fit the columns to the table width: grow name, then state, then value; shrink name, then
  // value, then state, each down to its minimum
  const columns = { name: targetName, value: targetValue, state: targetState };
  const columnTotal = targetName + targetValue + targetState;
  if (columnTotal < tableWidth) {
    let extra = tableWidth - columnTotal;
    const growName = Math.min(extra, 28);
    columns.name += growName;
    extra -= growName;
    const growState = Math.min(extra, 16);
    columns.state += growState;
    extra -= growState;
    columns.value += extra;
  } else if (columnTotal > tableWidth) {
    let deficit = columnTotal - tableWidth;
    const shrinkName = Math.min(deficit, Math.max(0, columns.name - constants.minNameWidth));
    columns.name -= shrinkName;
    deficit -= shrinkName;
    const shrinkValue = Math.min(deficit, Math.max(0, columns.value - constants.minValueWidth));
    columns.value -= shrinkValue;
    deficit -= shrinkValue;
    columns.state = Math.max(constants.minStateWidth, columns.state - deficit);
  }
  const badgeMinWidth = 70 * (constants.badgeSize / CARD_BASE.badgeSize);
  const measuredBadgeWidth = Math.ceil(measurer.width(badgeText, constants.badgeSize, { fontWeight: 600 }) + 18);
  const badgeWidthNoSignal = Math.max(badgeMinWidth, measuredBadgeWidth);
  const noSignalLeftBudget = Math.max(
    1,
    Math.ceil(measurer.width(title, constants.titleSize, { fontWeight: 700 }) + 8),
    Math.ceil(measurer.width(qualifier, constants.qualifierSize, { fontWeight: 500 }) + 8),
  );
  const noSignalContentWidth = Math.ceil(badgeWidthNoSignal + constants.badgeGapX + noSignalLeftBudget);
  const widestWord = (text, size, weight) => Math.max(0, ...String(text).split(/\s+/).filter(Boolean).map((w) => measurer.width(w, size, { fontWeight: weight })));
  const headerWordDemand = Math.ceil(measuredBadgeWidth + constants.badgeGapX + Math.max(widestWord(title, constants.titleSize, 700), widestWord(qualifier, constants.qualifierSize, 500)) + 8);
  const contentWidth = entity.signals.length > 0 ? Math.max(tableWidth, headerWordDemand) : noSignalContentWidth;
  const cardWidth = contentWidth + (constants.sidePad * 2);

  const badgeWidth = clamp(measuredBadgeWidth, badgeMinWidth, contentWidth);
  const headerTextWidth = Math.max(1, contentWidth - badgeWidth - constants.badgeGapX);
  const titleLines = wrapTextToWidth(title, headerTextWidth, constants.titleSize, { fontWeight: 700 }, measurer);
  const qualifierLines = qualifier
    ? wrapTextToWidth(qualifier, headerTextWidth, constants.qualifierSize, { fontWeight: 500 }, measurer)
    : [];

  const titleAscent = constants.titleSize * BASELINE_METRICS.ascentRatio;
  const qualifierAscent = constants.qualifierSize * BASELINE_METRICS.ascentRatio;
  const titleBlockHeight = constants.titleSize + Math.max(0, titleLines.length - 1) * constants.titleLineHeight;
  const qualifierBlockHeight = qualifierLines.length > 0
    ? (constants.qualifierSize + Math.max(0, qualifierLines.length - 1) * constants.bodyLineHeight)
    : 0;
  const qualifierGap = qualifierLines.length > 0 ? 4 : 0;
  const textBlockHeight = titleBlockHeight + qualifierGap + qualifierBlockHeight;
  const badgeHeight = constants.badgeHeight;
  const headerHeight = Math.max(textBlockHeight, badgeHeight);
  let y = constants.topPad;
  const headerTextTop = y + ((headerHeight - textBlockHeight) / 2);
  const titleY = headerTextTop + titleAscent;
  let qualifierY = null;
  if (qualifierLines.length > 0) {
    const qualifierTop = headerTextTop + titleBlockHeight + qualifierGap;
    qualifierY = qualifierTop + qualifierAscent;
  }
  const badgeY = y;
  const badgeX = contentWidth - badgeWidth;
  y += headerHeight + constants.sectionGap;

  const rows = [];
  if (entity.signals.length > 0) {
    for (let i = 0; i < entity.signals.length; i += 1) {
      const row = entity.signals[i];
      const value = values ? signalValue(row) : "";
      const stateLabel = `${row.state.slice(0, 1).toUpperCase()}${row.state.slice(1)}`;
      const nameLines = wrapTextToWidth(row.name, columns.name - 10, constants.bodySize, { fontWeight: nameWeight(row) }, measurer);
      const valueLines = values ? wrapTextToWidth(value, columns.value - 10, constants.bodySize, { fontWeight: 500 }, measurer) : [];
      const lineCount = Math.max(nameLines.length, valueLines.length, 1);
      const textBlockHeight = constants.bodySize + Math.max(0, lineCount - 1) * constants.bodyLineHeight;
      const rowHeight = Math.max(23 * (constants.bodySize / CARD_BASE.bodySize), textBlockHeight + constants.rowPadY);
      rows.push({
        i,
        row,
        value,
        stateLabel,
        nameWeight: nameWeight(row),
        nameLines,
        valueLines,
        lineCount,
        rowHeight,
      });
    }
  }

  const tableY = y;
  const headerBandHeight = (entity.signals.length > 0 && tableHeaders) ? constants.tableHeaderHeight : 0;
  const tableHeight = entity.signals.length > 0
    ? headerBandHeight + rows.reduce((sum, row) => sum + row.rowHeight, 0)
    : 0;
  const headerBottom = constants.topPad + headerHeight;
  const cardHeight = entity.signals.length > 0
    ? tableY + tableHeight + constants.bottomPad
    : (headerBottom + constants.bottomPad);
  const geometrySlack = Math.abs(constants.bodySize - CARD_BASE.bodySize) > 1e-9
    ? Math.max(0.5, constants.bodySize * 0.2)
    : 0;

  const semanticLineCount = titleLines.length
    + qualifierLines.length
    + 1
    + (entity.signals.length > 0 ? (1 + rows.reduce((sum, row) => sum + row.lineCount, 0)) : 0);

  return {
    cardWidth,
    cardHeight: cardHeight + geometrySlack,
    contentWidth,
    badgeText,
    badgeWidth,
    badgeX,
    titleLines,
    qualifierLines,
    titleY,
    qualifierY,
    badgeY,
    tableY,
    tableHeight,
    tableHeaders,
    values,
    columns,
    rows,
    semanticLineCount,
    constants,
  };
}

export function alignPlanToReservationGrid(plan, calibration) {
  const lineHeight = Math.max(1, calibration.lineHeight);
  const padY = Math.max(0, calibration.padY);
  const targetHeight = padY + Math.ceil(Math.max(1, plan.cardHeight - padY) / lineHeight) * lineHeight;
  const slack = Math.max(0, targetHeight - plan.cardHeight);
  if (slack === 0) return plan;
  return {
    ...plan,
    cardHeight: targetHeight,
    reservationSlack: slack,
  };
}
