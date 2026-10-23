const PATH_TOKEN_RE = /([AaCcHhLlMmQqSsTtVvZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;

function fmt(value) {
  return Number(value.toFixed(2)).toString();
}

function nextToken(tokens, i, command) {
  const value = tokens[i];
  if (value == null || typeof value === "string") {
    throw new Error(`path parse failed: command ${command} missing numeric parameters`);
  }
  return value;
}

function parsePath(pathData) {
  const tokens = [];
  for (const match of String(pathData).matchAll(PATH_TOKEN_RE)) {
    tokens.push(match[1] ?? Number(match[2]));
  }
  if (tokens.length === 0) {
    throw new Error("path parse failed: empty path data");
  }

  const commands = [];
  let i = 0;
  let command = null;
  let current = { x: 0, y: 0 };
  let subpathStart = null;

  const readPoint = (relative, op) => {
    const x = Number(nextToken(tokens, i, op));
    i += 1;
    const y = Number(nextToken(tokens, i, op));
    i += 1;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error(`path parse failed: command ${op} contains non-finite coordinates`);
    }
    return relative
      ? { x: current.x + x, y: current.y + y }
      : { x, y };
  };

  while (i < tokens.length) {
    if (typeof tokens[i] === "string") {
      command = tokens[i];
      i += 1;
    } else if (command == null) {
      throw new Error("path parse failed: path must start with a command");
    }
    const relative = command === command.toLowerCase();
    const op = command.toUpperCase();

    if (op === "M") {
      const first = readPoint(relative, command);
      commands.push({ type: "M", x: first.x, y: first.y });
      current = first;
      subpathStart = { ...first };
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const next = readPoint(relative, command);
        commands.push({ type: "L", x: next.x, y: next.y });
        current = next;
      }
      continue;
    }

    if (op === "L") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const next = readPoint(relative, command);
        commands.push({ type: "L", x: next.x, y: next.y });
        current = next;
      }
      continue;
    }

    if (op === "H") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const value = Number(nextToken(tokens, i, command));
        i += 1;
        const x = relative ? current.x + value : value;
        const next = { x, y: current.y };
        commands.push({ type: "L", x: next.x, y: next.y });
        current = next;
      }
      continue;
    }

    if (op === "V") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const value = Number(nextToken(tokens, i, command));
        i += 1;
        const y = relative ? current.y + value : value;
        const next = { x: current.x, y };
        commands.push({ type: "L", x: next.x, y: next.y });
        current = next;
      }
      continue;
    }

    if (op === "C") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c1 = readPoint(relative, command);
        const c2 = readPoint(relative, command);
        const end = readPoint(relative, command);
        commands.push({ type: "C", c1, c2, x: end.x, y: end.y });
        current = end;
      }
      continue;
    }

    if (op === "Q") {
      while (i < tokens.length && typeof tokens[i] !== "string") {
        const c = readPoint(relative, command);
        const end = readPoint(relative, command);
        commands.push({ type: "Q", c, x: end.x, y: end.y });
        current = end;
      }
      continue;
    }

    if (op === "Z") {
      if (!subpathStart) throw new Error("path parse failed: Z without a subpath start");
      commands.push({ type: "Z" });
      current = { ...subpathStart };
      continue;
    }

    if (op === "S" || op === "T" || op === "A") {
      throw new Error(`path parse failed: unsupported path command ${command}`);
    }

    throw new Error(`path parse failed: unknown path command ${command}`);
  }

  return commands;
}

function length(a, b) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function appendLine(points, to) {
  points.push({ x: to.x, y: to.y });
}

function flattenPath(pathData, samples = 24) {
  const commands = parsePath(pathData);
  const points = [];
  let current = { x: 0, y: 0 };
  let subpathStart = null;
  for (const command of commands) {
    if (command.type === "M") {
      current = { x: command.x, y: command.y };
      subpathStart = { ...current };
      points.push({ ...current });
      continue;
    }
    if (command.type === "L") {
      appendLine(points, command);
      current = { x: command.x, y: command.y };
      continue;
    }
    if (command.type === "C") {
      const { c1, c2 } = command;
      for (let i = 1; i <= samples; i += 1) {
        const t = i / samples;
        const mt = 1 - t;
        const x = (mt ** 3) * current.x + 3 * (mt ** 2) * t * c1.x + 3 * mt * (t ** 2) * c2.x + (t ** 3) * command.x;
        const y = (mt ** 3) * current.y + 3 * (mt ** 2) * t * c1.y + 3 * mt * (t ** 2) * c2.y + (t ** 3) * command.y;
        points.push({ x, y });
      }
      current = { x: command.x, y: command.y };
      continue;
    }
    if (command.type === "Q") {
      const { c } = command;
      for (let i = 1; i <= samples; i += 1) {
        const t = i / samples;
        const mt = 1 - t;
        const x = (mt ** 2) * current.x + 2 * mt * t * c.x + (t ** 2) * command.x;
        const y = (mt ** 2) * current.y + 2 * mt * t * c.y + (t ** 2) * command.y;
        points.push({ x, y });
      }
      current = { x: command.x, y: command.y };
      continue;
    }
    if (command.type === "Z") {
      if (!subpathStart) throw new Error("path projection failed: Z without subpath start");
      appendLine(points, subpathStart);
      current = { ...subpathStart };
      continue;
    }
    throw new Error(`path projection failed: unsupported command ${command.type}`);
  }
  const deduped = [];
  for (const point of points) {
    const prev = deduped[deduped.length - 1];
    if (!prev || Math.abs(prev.x - point.x) > 1e-9 || Math.abs(prev.y - point.y) > 1e-9) {
      deduped.push(point);
    }
  }
  return deduped;
}

function buildPolylineLengths(points) {
  const cumulative = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + length(points[i - 1], points[i]));
  }
  return { cumulative, total: cumulative[cumulative.length - 1] ?? 0 };
}

export function projectLabelCenterToRelaxedPath(nativePathData, relaxedPathData, labelCenter, options = {}) {
  const samples = Number.isFinite(options.samples) ? Math.max(8, Math.floor(options.samples)) : 24;
  const x = Number(labelCenter?.x);
  const y = Number(labelCenter?.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new Error("path projection failed: invalid label center");
  }
  const nativePoints = flattenPath(nativePathData, samples);
  const relaxedPoints = flattenPath(relaxedPathData, samples);
  if (nativePoints.length < 2 || relaxedPoints.length < 2) {
    throw new Error("path projection failed: insufficient path points");
  }

  // progress (0..1) of the native-path point nearest to the label center
  const nativeLengths = buildPolylineLengths(nativePoints);
  let progress = 0;
  let distance = Number.POSITIVE_INFINITY;
  if (nativeLengths.total > 1e-9) {
    for (let i = 0; i < nativePoints.length - 1; i += 1) {
      const a = nativePoints[i];
      const b = nativePoints[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const den = (dx * dx) + (dy * dy);
      if (den <= 1e-9) continue;
      const t = clamp((((x - a.x) * dx) + ((y - a.y) * dy)) / den, 0, 1);
      const px = a.x + (dx * t);
      const py = a.y + (dy * t);
      const dist = Math.hypot(x - px, y - py);
      if (dist < distance) {
        const arc = nativeLengths.cumulative[i] + (Math.hypot(px - a.x, py - a.y));
        progress = arc / nativeLengths.total;
        distance = dist;
      }
    }
  }

  // the point at the same progress along the relaxed path
  const { cumulative, total } = buildPolylineLengths(relaxedPoints);
  let projected = relaxedPoints[relaxedPoints.length - 1];
  if (total <= 1e-9) {
    projected = { x: relaxedPoints[0]?.x ?? 0, y: relaxedPoints[0]?.y ?? 0 };
  } else {
    const target = clamp(progress, 0, 1) * total;
    for (let i = 0; i < relaxedPoints.length - 1; i += 1) {
      const a = relaxedPoints[i];
      const b = relaxedPoints[i + 1];
      const start = cumulative[i];
      const end = cumulative[i + 1];
      if (target > end && i < relaxedPoints.length - 2) continue;
      const t = clamp((target - start) / Math.max(1e-9, end - start), 0, 1);
      projected = {
        x: a.x + ((b.x - a.x) * t),
        y: a.y + ((b.y - a.y) * t),
      };
      break;
    }
  }
  return {
    x: projected.x,
    y: projected.y,
    progress,
    nativeDistance: distance,
  };
}

function normalize(vec) {
  const mag = Math.hypot(vec.x, vec.y);
  if (mag <= 1e-9) return null;
  return { x: vec.x / mag, y: vec.y / mag };
}

function dot(a, b) {
  return (a.x * b.x) + (a.y * b.y);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function estimateEndpointCurvature(start, c1, c2, end, atEnd = false) {
  const p0 = atEnd ? end : start;
  const p1 = atEnd ? c2 : c1;
  const p2 = atEnd ? c1 : c2;
  const p3 = atEnd ? start : end;
  const d1 = { x: 3 * (p1.x - p0.x), y: 3 * (p1.y - p0.y) };
  const d2 = {
    x: 6 * (p2.x - (2 * p1.x) + p0.x),
    y: 6 * (p2.y - (2 * p1.y) + p0.y),
  };
  const den = Math.pow((d1.x * d1.x) + (d1.y * d1.y), 1.5);
  if (den <= 1e-9) return null;
  return Math.abs((d1.x * d2.y) - (d1.y * d2.x)) / den;
}

function maxHandleInBounds(origin, dir, minX, minY, maxX, maxY) {
  const limits = [];
  if (Math.abs(dir.x) > 1e-9) {
    limits.push(((dir.x > 0 ? maxX : minX) - origin.x) / dir.x);
  }
  if (Math.abs(dir.y) > 1e-9) {
    limits.push(((dir.y > 0 ? maxY : minY) - origin.y) / dir.y);
  }
  const finite = limits.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length === 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.min(...finite));
}

export function relaxOrthogonalPath(pathData, options = {}) {
  const minCornerRadius = Number.isFinite(options.minCornerRadius) ? options.minCornerRadius : 18;
  const maxCornerRadius = Number.isFinite(options.maxCornerRadius) ? options.maxCornerRadius : 44;
  if (minCornerRadius <= 0 || maxCornerRadius <= 0 || minCornerRadius > maxCornerRadius) {
    throw new Error("invalid route presentation options: expected 0 < minCornerRadius <= maxCornerRadius");
  }

  const commands = parsePath(pathData);
  const points = [];
  let current = { x: 0, y: 0 };
  for (const command of commands) {
    if (command.type === "M" || command.type === "L") {
      points.push({ start: { ...current }, end: { x: command.x, y: command.y }, command });
      current = { x: command.x, y: command.y };
    } else if (command.type === "C") {
      points.push({ start: { ...current }, end: { x: command.x, y: command.y }, command });
      current = { x: command.x, y: command.y };
    } else if (command.type === "Q") {
      points.push({ start: { ...current }, end: { x: command.x, y: command.y }, command });
      current = { x: command.x, y: command.y };
    }
  }

  let relaxedCorners = 0;
  let eligibleCorners = 0;
  let firstReason = "no-adjacent-linear-legs";
  for (let i = 0; i < points.length; i += 1) {
    const previous = points[i - 1] ?? null;
    const currentSegment = points[i];
    const next = points[i + 1] ?? null;
    const currentCommand = currentSegment.command;
    if (currentCommand.type !== "C") continue;
    const hasPrevLine = previous?.command?.type === "L";
    const hasNextLine = next?.command?.type === "L";
    if (!hasPrevLine && !hasNextLine) continue;
    eligibleCorners += 1;

    let start = { ...currentSegment.start };
    let end = { ...currentSegment.end };
    const incomingDir = hasPrevLine ? normalize({ x: start.x - previous.start.x, y: start.y - previous.start.y }) : null;
    const outgoingDir = hasNextLine ? normalize({ x: next.end.x - end.x, y: next.end.y - end.y }) : null;
    if ((hasPrevLine && !incomingDir) || (hasNextLine && !outgoingDir)) {
      firstReason = "insufficient-adjacent-leg-length";
      continue;
    }

    const originalChord = length(start, end);
    const sameDirection = hasPrevLine && hasNextLine && dot(incomingDir, outgoingDir) >= 0.95;
    let geometryShifted = false;
    if (sameDirection && originalChord >= (minCornerRadius * 8)) {
      const legBefore = length(previous.start, start);
      const legAfter = length(end, next.end);
      const trimBefore = Math.max(0, Math.min(legBefore - 0.5, legBefore * 0.85));
      const trimAfter = Math.max(0, Math.min(legAfter - 0.5, legAfter * 0.85));
      if (trimBefore > 0.5) {
        start = {
          x: start.x - (incomingDir.x * trimBefore),
          y: start.y - (incomingDir.y * trimBefore),
        };
      }
      if (trimAfter > 0.5) {
        end = {
          x: end.x + (outgoingDir.x * trimAfter),
          y: end.y + (outgoingDir.y * trimAfter),
        };
      }
      if (trimBefore > 0.5 || trimAfter > 0.5) {
        if (hasPrevLine) {
          previous.command.x = start.x;
          previous.command.y = start.y;
          previous.end = { ...start };
        }
        if (hasNextLine) {
          next.start = { ...end };
        }
        currentSegment.start = { ...start };
        currentSegment.end = { ...end };
        currentCommand.x = end.x;
        currentCommand.y = end.y;
        geometryShifted = true;
      }
    }

    const currentInLen = length(start, currentCommand.c1);
    const currentOutLen = length(end, currentCommand.c2);
    if (!Number.isFinite(currentInLen) || !Number.isFinite(currentOutLen)) {
      firstReason = "non-finite-cubic-controls";
      continue;
    }

    const chord = length(start, end);
    if (!Number.isFinite(chord) || chord <= 1) {
      firstReason = "short-cubic-span";
      continue;
    }

    const existingInDir = normalize({ x: currentCommand.c1.x - start.x, y: currentCommand.c1.y - start.y });
    const existingOutDir = normalize({ x: end.x - currentCommand.c2.x, y: end.y - currentCommand.c2.y });
    const inDir = incomingDir
      ? ((existingInDir && dot(existingInDir, incomingDir) >= 0.6) ? existingInDir : incomingDir)
      : existingInDir;
    const outDir = outgoingDir
      ? ((existingOutDir && dot(existingOutDir, outgoingDir) >= 0.6) ? existingOutDir : outgoingDir)
      : existingOutDir;
    if (!inDir || !outDir) {
      firstReason = "unsupported-cubic-tangent-shape";
      continue;
    }
    if (hasPrevLine && hasNextLine && dot(inDir, outDir) <= -0.98) {
      firstReason = "u-turn-cubic";
      continue;
    }

    const legBefore = hasPrevLine ? length(previous.start, start) : null;
    const legAfter = hasNextLine ? length(end, next.end) : null;
    const chordCap = chord * 0.47;
    const corridorMinX = Math.min(previous?.start?.x ?? start.x, start.x, currentCommand.c1.x, currentCommand.c2.x, end.x, next?.end?.x ?? end.x);
    const corridorMinY = Math.min(previous?.start?.y ?? start.y, start.y, currentCommand.c1.y, currentCommand.c2.y, end.y, next?.end?.y ?? end.y);
    const corridorMaxX = Math.max(previous?.start?.x ?? start.x, start.x, currentCommand.c1.x, currentCommand.c2.x, end.x, next?.end?.x ?? end.x);
    const corridorMaxY = Math.max(previous?.start?.y ?? start.y, start.y, currentCommand.c1.y, currentCommand.c2.y, end.y, next?.end?.y ?? end.y);
    const dynamicCap = sameDirection ? Math.max(chord * 0.2, maxCornerRadius) : maxCornerRadius;
    const maxInByBounds = maxHandleInBounds(start, inDir, corridorMinX, corridorMinY, corridorMaxX, corridorMaxY);
    const maxOutByBounds = maxHandleInBounds(end, { x: -outDir.x, y: -outDir.y }, corridorMinX, corridorMinY, corridorMaxX, corridorMaxY);
    const maxInGrow = hasPrevLine
      ? Math.min(dynamicCap, maxInByBounds, Math.max(currentInLen, chordCap))
      : Math.min(currentInLen, maxInByBounds);
    const maxOutGrow = hasNextLine
      ? Math.min(dynamicCap, maxOutByBounds, Math.max(currentOutLen, chordCap))
      : Math.min(currentOutLen, maxOutByBounds);
    const inTarget = Math.max(currentInLen, sameDirection ? (minCornerRadius * 2) : minCornerRadius);
    const outTarget = Math.max(currentOutLen, sameDirection ? (minCornerRadius * 2) : minCornerRadius);
    const nextInLen = hasPrevLine && maxInGrow + 0.01 >= currentInLen ? Math.min(inTarget, maxInGrow) : currentInLen;
    const nextOutLen = hasNextLine && maxOutGrow + 0.01 >= currentOutLen ? Math.min(outTarget, maxOutGrow) : currentOutLen;

    let solvedInLen = nextInLen;
    let solvedOutLen = nextOutLen;
    if (sameDirection) {
      const radiusTarget = Math.max(minCornerRadius * 2, Math.min(chord * 0.09, 120));
      const kappaTarget = 1 / radiusTarget;
      solvedInLen = clamp(solvedInLen, currentInLen, maxInGrow);
      solvedOutLen = clamp(solvedOutLen, currentOutLen, maxOutGrow);
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const c1 = { x: start.x + (inDir.x * solvedInLen), y: start.y + (inDir.y * solvedInLen) };
        const c2 = { x: end.x - (outDir.x * solvedOutLen), y: end.y - (outDir.y * solvedOutLen) };
        const startKappa = estimateEndpointCurvature(start, c1, c2, end, false);
        const endKappa = estimateEndpointCurvature(start, c1, c2, end, true);
        const startOk = startKappa == null || startKappa <= kappaTarget;
        const endOk = endKappa == null || endKappa <= kappaTarget;
        if (startOk && endOk) break;
        if (!startOk) {
          solvedInLen = Math.min(maxInGrow, solvedInLen * 1.2);
        }
        if (!endOk) {
          solvedOutLen = Math.min(maxOutGrow, solvedOutLen * 1.2);
        }
      }
    }

    const changedIn = solvedInLen > currentInLen + 0.5;
    const changedOut = solvedOutLen > currentOutLen + 0.5;
    if (!changedIn && !changedOut && !geometryShifted) {
      firstReason = "already-smooth-or-constrained";
      continue;
    }

    if (changedIn || changedOut) {
      currentCommand.c1 = {
        x: start.x + (inDir.x * solvedInLen),
        y: start.y + (inDir.y * solvedInLen),
      };
      currentCommand.c2 = {
        x: end.x - (outDir.x * solvedOutLen),
        y: end.y - (outDir.y * solvedOutLen),
      };
    }
    relaxedCorners += 1;
  }

  const path = commands.map((command) => {
    if (command.type === "M" || command.type === "L") {
      return `${command.type}${fmt(command.x)},${fmt(command.y)}`;
    }
    if (command.type === "C") {
      return `C${fmt(command.c1.x)},${fmt(command.c1.y)} ${fmt(command.c2.x)},${fmt(command.c2.y)} ${fmt(command.x)},${fmt(command.y)}`;
    }
    if (command.type === "Q") {
      return `Q${fmt(command.c.x)},${fmt(command.c.y)} ${fmt(command.x)},${fmt(command.y)}`;
    }
    if (command.type === "Z") return "Z";
    throw new Error(`path serialize failed: unsupported command ${command.type}`);
  }).join("");
  return {
    path,
    changed: relaxedCorners > 0,
    relaxedCorners,
    reason: relaxedCorners > 0
      ? "relaxed-cubic-tangents"
      : (eligibleCorners > 0 ? firstReason : "no-eligible-cubic-segment"),
  };
}
