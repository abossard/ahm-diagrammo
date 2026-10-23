// swimlane-route.mjs — edge routing for the swimlane renderer.
//
// Two phases, because channel heights decide where the lanes sit and routes need final ys:
//   planRoutes  → classify edges, plan every x (ports, corridors, channel rows) and report each
//                 channel's height
//   realize     → given the stacked geometry, place label pills and emit one polyline per edge
//
// Channel g is the horizontal strip below lane g (g = -1 is the strip above lane 0).

import { textWidth, wrapText } from "./text.mjs";
import { assignTracks, corridorsOf, pickCorridorX } from "./layout.mjs";

const PILL_FS = 10.5;

// ---------- geometry / routing ----------
// A single-channel tracked edge whose two risers (exitLo, entryU) land this close together carries
// only the anti-collinearity bump the slot registry adds (one pitch = 6px) — a redundant jog around
// the label row, not real horizontal travel — so it is drawn as one straight vertical. 8 = one
// pitch + rounding headroom, and stays strictly below two pitches (12px): 12 is the smallest gap
// that can hide an intervening vertical, so a delta ≥ 12 signals a genuine obstacle/offset and is
// left orthogonal. Coupled to the slot registry's pitch — revisit both together if that changes.
const STRAIGHT_SNAP_DX = 8;

// True when a single-channel tracked edge's risers are near-aligned enough to collapse to one
// straight vertical at x = exitLo, AND that x still lands on the upper card ([uLo, uHi] = its slot
// range from nodeRange) so the straightened riser can't fall off the parent. Pure so the exact
// snap boundary can be exercised directly without contorting a diagram layout.
export function straightenTrackedX(exitLo, entryU, uLo, uHi) {
  return Math.abs(exitLo - entryU) <= STRAIGHT_SNAP_DX && exitLo >= uLo && exitLo <= uHi;
}

// ctx: { g, lane, laneNodes, X, size, diag }. Returns { chanH(g), realize({ chanTop, box }) }.
// realize returns { routes: [{ e, pts }] in draw order, pills: [{ e, x, y, w, h, lines, clipped }] }.
export function planRoutes({ g, lane, laneNodes, X, size, diag }) {

  // ----- classify edges -----
  const bundlesByParent = new Map(); // parentId -> [edge]
  const tracked = [];                // { e, u, l, sameLane, reverse, pill }
  for (const e of g.edges) {
    if (e.from === e.to) { diag.warn(`self-loop on "${e.from}" is not drawn`, { line: e.line }); continue; }
    const lu = lane.get(e.to), ll = lane.get(e.from);
    if (lu === ll) {
      diag.warn(`edge ${e.from} → ${e.to} connects nodes in the same lane — routed over the top of the lane`, { line: e.line });
      tracked.push({ e, u: lu, l: ll, sameLane: true, pill: !!e.label });
    } else if (lu > ll) {
      diag.warn(`edge ${e.from} → ${e.to} points downward (child sits above its parent) — drawn bottom-up`, { line: e.line });
      tracked.push({ e, u: ll, l: lu, reverse: true, pill: !!e.label });
    } else if (ll - lu === 1 && !e.label && !e.dashed) {
      if (!bundlesByParent.has(e.to)) bundlesByParent.set(e.to, []);
      bundlesByParent.get(e.to).push(e);
    } else {
      tracked.push({ e, u: lu, l: ll, pill: !!e.label });
    }
  }

  // ----- corridor + slot planning (x only; ys come after channel heights are known) -----
  const corridorCache = new Map(); // lane -> corridors (gaps between that lane's cards)
  const corridorTaken = new Map(); // lane -> xs
  // One vertical-x registry per channel: every riser/trunk/stub in a channel draws from the same
  // pool, so two verticals of different edges can never be collinear. Each caller stays inside its
  // own card footprint via [lo, hi].
  const usedSlotXs = new Map(); // channel -> xs[]
  const slots = (chan, want, lo, hi, pitch = 6) => {
    if (!usedSlotXs.has(chan)) usedSlotXs.set(chan, []);
    const xs = usedSlotXs.get(chan);
    let x = Math.min(hi, Math.max(lo, want));
    for (let k = 0; k < 120; k++) {
      const step = Math.ceil(k / 2) * pitch * (k % 2 ? 1 : -1);
      const cand = Math.min(hi, Math.max(lo, x + step));
      if (xs.every((u) => Math.abs(u - cand) >= pitch - 0.5)) { xs.push(cand); return cand; }
    }
    xs.push(x); return x; // saturated: accept (cards are wide enough in practice)
  };
  const nodeRange = (id) => { const s = size.get(id); return [X.get(id) - s.w / 2 + 12, X.get(id) + s.w / 2 - 12]; };
  const topSlot = (chan, id, want) => { const [lo, hi] = nodeRange(id); return slots(chan, want, lo, hi); };
  const botSlot = (chan, id, want) => { const [lo, hi] = nodeRange(id); return slots(chan, want, lo, hi); };

  // bundles first (they own the space right under their parent)
  const bundlePlans = [];
  for (const [pid, es] of bundlesByParent) {
    const chan = lane.get(pid);
    const pcx = X.get(pid), pw = size.get(pid).w;
    const kids = es.map((e) => ({ e, cx: X.get(e.from), cw: size.get(e.from).w })).sort((a, b) => a.cx - b.cx);
    for (const k of kids) {
      const oMin = Math.max(k.cx - k.cw / 2 + 12, pcx - pw / 2 + 12);
      const oMax = Math.min(k.cx + k.cw / 2 - 12, pcx + pw / 2 - 12);
      k.straight = oMin <= oMax;
      if (k.straight) k.oMin = oMin, k.oMax = oMax;
    }
    const straights = kids.filter((k) => k.straight);
    straights.forEach((k, j) => {
      const centered = pcx - ((straights.length - 1) * 3) / 2 + j * 3;
      const want = Math.min(k.oMax, Math.max(k.oMin, centered));
      k.x = slots(chan, want, k.oMin, k.oMax, 3);
    });
    const sides = kids.filter((k) => !k.straight);
    [...sides].sort((a, b) => Math.abs(b.cx - pcx) - Math.abs(a.cx - pcx)).forEach((k, rank) => { k.rank = rank; });
    sides.forEach((k) => {
      const side = k.cx < pcx ? -1 : 1;
      k.entryX = botSlot(chan, pid, pcx + side * (pw / 2 - 14) - side * k.rank * 4);
      k.stubX = topSlot(chan, k.e.from, k.cx);
    });
    bundlePlans.push({ pid, kids, maxRank: sides.length ? Math.max(...sides.map((k) => k.rank)) : -1, chan });
  }

  // tracked edges: corridor chain bottom-up, then entry/exit slots.
  // A child with several tracked edges spreads its exits toward each edge's parent, so sibling
  // risers don't hug each other (a wide pill would otherwise cover its sibling's line).
  const trackedPerChild = new Map();
  const trackedSiblingPlacement = new Map();
  const siblingSideGroups = new Map();
  for (const t of tracked) {
    if (t.sameLane) continue;
    const lo = t.reverse ? t.e.to : t.e.from;
    const up = t.reverse ? t.e.from : t.e.to;
    trackedPerChild.set(lo, (trackedPerChild.get(lo) || 0) + 1);
    if (!siblingSideGroups.has(lo)) siblingSideGroups.set(lo, { left: [], right: [] });
    const side = Math.sign(X.get(up) - X.get(lo)) < 0 ? "left" : "right";
    siblingSideGroups.get(lo)[side].push({ edge: t.e, parentX: X.get(up) });
  }
  for (const groups of siblingSideGroups.values()) {
    groups.left.sort((a, b) => a.parentX - b.parentX).forEach((entry, index, arr) => {
      trackedSiblingPlacement.set(entry.edge, { side: -1, index, count: arr.length });
    });
    groups.right.sort((a, b) => b.parentX - a.parentX).forEach((entry, index, arr) => {
      trackedSiblingPlacement.set(entry.edge, { side: 1, index, count: arr.length });
    });
  }
  for (const t of tracked) {
    const [uNode, loNode] = t.sameLane
      ? [t.e.to, t.e.from]
      : (t.reverse ? [t.e.from, t.e.to] : [t.e.to, t.e.from]);
    t.uNode = uNode; t.loNode = loNode;
    t.chan = t.sameLane ? t.u - 1 : t.u;      // channel adjacent to the upper node
    t.pillChan = t.sameLane ? t.chan : t.l - 1; // pills live nearest the child (see assignTracks)
    if (t.sameLane) {
      t.exitLo = topSlot(t.chan, loNode, X.get(uNode));
      t.exitU = topSlot(t.chan, uNode, X.get(loNode));
      t.channels = [{ g: t.chan, xBelow: t.exitLo, xAbove: t.exitU }];
    } else {
      const ucx = X.get(uNode), locx = X.get(loNode);
      t.corr = {}; // laneIdx -> x
      for (let j = t.l - 1; j > t.u; j--) {
        const frac = (t.l - j) / (t.l - t.u);
        const want = locx + (ucx - locx) * frac;
        if (!corridorCache.has(j)) corridorCache.set(j, corridorsOf(laneNodes[j].map((id) => ({ id, x: X.get(id) - size.get(id).w / 2, w: size.get(id).w }))));
        if (!corridorTaken.has(j)) corridorTaken.set(j, []);
        const x = pickCorridorX(corridorCache.get(j), want, corridorTaken.get(j));
        if (x != null) corridorTaken.get(j).push(x);
        t.corr[j] = x ?? want; // no corridor: fall back (verifier will flag if it matters)
      }
      t.entryU = botSlot(t.u, uNode, t.corr[t.u + 1] ?? locx);
      // Exit at the child's own center when it has a single tracked edge (keeps risers spread out
      // across children); when the child has several, pull each exit toward its parent so sibling
      // risers separate. Lane-skippers aim at their first corridor.
      const loW = size.get(loNode).w;
      let spread = locx;
      const placement = trackedSiblingPlacement.get(t.e);
      if (!(trackedPerChild.get(loNode) <= 1) && placement) {
        const span = Math.max(0, loW / 2 - 14);
        const step = placement.count > 1 ? Math.min(44, span / (placement.count - 1)) : 0;
        const offset = placement.side < 0 ? placement.index * step : -placement.index * step;
        const edgeX = locx + placement.side * span + offset;
        spread = Math.max(locx - span, Math.min(locx + span, edgeX));
      }
      t.exitLo = topSlot(t.l - 1, loNode, t.corr[t.l - 1] ?? spread);
      t.channels = [];
      for (let gph = t.u; gph <= t.l - 1; gph++) {
        const xAbove = gph === t.u ? t.entryU : t.corr[gph];
        const xBelow = gph === t.l - 1 ? t.exitLo : t.corr[gph + 1];
        t.channels.push({ g: gph, xBelow, xAbove });
      }
    }
    if (t.pill) {
      // long labels wrap to two lines: a 300px pill can never dodge risers ~200px apart,
      // a 160px one can — and the full text stays visible
      let wrap = wrapText(t.e.label, 170, PILL_FS, { weight: 600, maxLines: 2 });
      if (wrap.clipped) wrap = wrapText(t.e.label, 280, PILL_FS, { weight: 600, maxLines: 2 });
      if (wrap.clipped) diag.warn(`edge label "${t.e.label.slice(0, 40)}…" is too long even wrapped — clipped (full text kept as tooltip)`);
      t.pillLines = wrap.lines;
      t.pillClipped = wrap.clipped;
      t.pillW = Math.max(...wrap.lines.map((l) => textWidth(l, PILL_FS, 600))) + 20;
      t.pillH = wrap.lines.length === 1 ? 20 : 33;
    }
  }

  // ----- per-channel structure: bus levels (bundles) + track rows (tracked edges) -----
  const chanIdx = new Set();
  for (const t of tracked) t.channels.forEach((c) => chanIdx.add(c.g));
  for (const b of bundlePlans) chanIdx.add(b.chan);
  const chans = new Map(); // g -> { busLevels, items, rows, h }
  for (const gph of chanIdx) chans.set(gph, { busLevels: 0, items: [] });

  // side-bus horizontals are interval-colored ACROSS parents so buses of different parents
  // sharing a y can never overlap collinearly
  for (const gph of chanIdx) {
    const busItems = [];
    for (const b of bundlePlans) {
      if (b.chan !== gph) continue;
      for (const k of b.kids) {
        if (k.straight) continue;
        busItems.push({ id: k, xL: Math.min(k.stubX, k.entryX) - 4, xR: Math.max(k.stubX, k.entryX) + 4 });
      }
    }
    if (busItems.length) {
      const { levelOf, count } = assignTracks(busItems.map((it, i) => ({ ...it, id: i })));
      busItems.forEach((it, i) => { it.id.busLevel = levelOf.get(i); });
      chans.get(gph).busLevels = count;
    }
  }

  for (const t of tracked) {
    for (const c of t.channels) {
      const isPill = t.pill && c.g === t.pillChan;
      // pill pad covers the slide overhang (pw/2−10 past either segment end) plus margin
      const pad = isPill ? Math.max(16, t.pillW - 6) : 6;
      chans.get(c.g).items.push({
        t, cRef: c,
        xL: Math.min(c.xBelow, c.xAbove) - pad,
        xR: Math.max(c.xBelow, c.xAbove) + pad,
        pill: isPill,
        span: Math.abs(c.xAbove - c.xBelow),
      });
    }
  }
  for (const [, c] of chans) {
    const uniq = c.items.map((it, i) => ({ id: i, xL: it.xL, xR: it.xR, pill: it.pill, order: -it.span }));
    const { levelOf, count, pillLevels, plainLevels } = assignTracks(uniq);
    c.plainLevels = plainLevels;
    uniq.forEach((u, i) => { c.items[i].level = levelOf.get(u.id); });
    c.rows = [];
    for (let i = 0; i < count; i++) {
      const isPillRow = i >= count - pillLevels;
      // pill rows grow to fit their tallest (possibly two-line) pill
      const tallest = Math.max(20, ...c.items.filter((it) => it.level === i && it.pill).map((it) => it.t.pillH || 20));
      c.rows.push({ h: isPillRow ? tallest + 7 : 12 });
    }
    const busH = c.busLevels ? 10 + c.busLevels * 4 : (count ? 6 : 0);
    c.busH = busH;
    c.h = busH + c.rows.reduce((a, r) => a + r.h, 0) + (count || c.busLevels ? 10 : 0);
  }
  const chanH = (gph) => chans.get(gph)?.h || 0;

  function realize({ chanTop, box }) {
    const rowY = (gph, level) => {
      const c = chans.get(gph);
      let y = chanTop(gph) + (c.busH || 6);
      for (let i = 0; i < level; i++) y += c.rows[i].h;
      return y + c.rows[level].h / 2;
    };

    // ----- vertical bookkeeping (recomputable: crossings depend on row assignment) -----
    const gEnd = (gph, side) => (side === "below" ? chanTop(gph) + chanH(gph) : chanTop(gph));
    const itemFor = (t, c) => chans.get(c.g).items.find((it) => it.t === t && it.cRef === c);
    function collectVerticals() {
      const map = new Map(); // g -> [{x, y1, y2, owner}]
      const add = (gph, x, y1, y2, owner) => {
        if (!map.has(gph)) map.set(gph, []);
        map.get(gph).push({ x, y1: Math.min(y1, y2), y2: Math.max(y1, y2), owner });
      };
      for (const b of bundlePlans) {
        const pb = box.get(b.pid), busBase = chanTop(b.chan) + 6;
        for (const k of b.kids) {
          const cb = box.get(k.e.from);
          if (k.straight) add(b.chan, k.x, pb.bottom, cb.top, k.e);
          else {
            const busY = busBase + k.busLevel * 4;
            add(b.chan, k.stubX, busY, cb.top, k.e);
            add(b.chan, k.entryX, pb.bottom, busY, k.e);
          }
        }
      }
      for (const t of tracked) {
        if (t.sameLane) {
          const c = t.channels[0], y = rowY(c.g, itemFor(t, c).level);
          add(c.g, t.exitLo, y, gEnd(c.g, "below"), t.e);
          add(c.g, t.exitU, y, gEnd(c.g, "below"), t.e);
          continue;
        }
        let prevX = t.exitLo;
        for (let i = t.channels.length - 1; i >= 0; i--) {
          const c = t.channels[i], y = rowY(c.g, itemFor(t, c).level);
          add(c.g, prevX, y, gEnd(c.g, "below"), t.e);      // riser below this row
          add(c.g, c.xAbove, gEnd(c.g, "above"), y, t.e);   // continuation above this row
          prevX = c.xAbove;
        }
      }
      return map;
    }

    // slide simulation: best x for a pill along its horizontal (with overhang), given verticals
    function slidePill(pw, anchor, segX, y, verts, ownerEdge, ph = 20) {
      const halfH = ph / 2;
      const near = verts.filter((v) => v.owner !== ownerEdge && v.y1 < y + halfH && v.y2 > y - halfH);
      const lo = Math.min(segX[0], anchor), hi = Math.max(segX[1], anchor);
      const overhang = Math.max(0, pw / 2 - 10);
      const domLo = lo - overhang, domHi = hi + overhang;
      const conflicts = (x) => near.reduce((k, v) => k + (Math.abs(v.x - x) < pw / 2 + 3 ? 1 : 0), 0);
      let bestX = Math.min(domHi, Math.max(domLo, anchor)), bestC = conflicts(bestX), bestD = Infinity;
      if (bestC > 0) {
        const cands = [domLo, domHi];
        for (let x = domLo; x < domHi; x += 4) cands.push(x);
        for (const v of near) cands.push(v.x + pw / 2 + 3.5, v.x - pw / 2 - 3.5); // just past each crosser
        for (const c of cands) {
          if (c < domLo - 1e-9 || c > domHi + 1e-9) continue;
          const k = conflicts(c), d = Math.abs(c - anchor);
          if (k < bestC || (k === bestC && d < bestD)) { bestX = c; bestC = k; bestD = d; }
        }
      }
      return { x: bestX, conflicts: bestC };
    }
    // ----- pill placement, one mechanism: each pill tries its own row first, then every other
    // pill row of its channel (row order changes which risers/trunks cross it — a purely
    // combinatorial move), keeping the row with the fewest slide conflicts. Final xs are computed
    // in a second sweep so every pill sees the settled row assignment.
    const pillTs = tracked.filter((t) => t.pill);
    const pillGeom = (t) => {
      const c = t.channels.find((cc) => cc.g === t.pillChan);
      const item = itemFor(t, c);
      return { item, segX: [Math.min(c.xBelow, c.xAbove), Math.max(c.xBelow, c.xAbove)], anchor: c.xBelow };
    };
    const placedPills = [];
    for (const t of pillTs) {
      const pg = pillGeom(t);
      const chan = chans.get(t.pillChan);
      const orig = pg.item.level;
      const tryRows = [orig, ...chan.rows.map((_, i) => i).filter((i) => i >= chan.plainLevels && i !== orig)];
      let best = null;
      for (const row of tryRows) {
        pg.item.level = row;
        const verts = collectVerticals().get(t.pillChan) || [];
        const sim = slidePill(t.pillW, pg.anchor, pg.segX, rowY(t.pillChan, row), verts, t.e, t.pillH);
        const overlaps = placedPills.filter((p) =>
          p.chan === t.pillChan &&
          p.row === row &&
          Math.abs(p.x - sim.x) < (p.w + t.pillW) / 2 + 2
        ).length;
        const cand = { row, x: sim.x, c: sim.conflicts, overlaps, d: Math.abs(sim.x - pg.anchor) };
        if (
          !best ||
          cand.overlaps < best.overlaps ||
          (cand.overlaps === best.overlaps && cand.c < best.c) ||
          (cand.overlaps === best.overlaps && cand.c === best.c && cand.d < best.d)
        ) best = cand;
        if (cand.overlaps === 0 && cand.c === 0) break;
      }
      pg.item.level = best.row;
      placedPills.push({ chan: t.pillChan, row: best.row, x: best.x, w: t.pillW });
    }
    const pills = [];
    const settledVerts = collectVerticals();
    for (const t of pillTs) {
      const pg = pillGeom(t);
      const y = rowY(t.pillChan, pg.item.level);
      const sim = slidePill(t.pillW, pg.anchor, pg.segX, y, settledVerts.get(t.pillChan) || [], t.e, t.pillH);
      if (sim.conflicts > 0)
        diag.warn(`label pill "${t.e.label}" could not fully avoid crossing connectors — it may sit on one`);
      pills.push({ e: t.e, x: sim.x, y, w: t.pillW, h: t.pillH, lines: t.pillLines, clipped: t.pillClipped });
    }

    // ----- polylines from the final assignment (draw order: bundles by severity, then tracked) -----
    const routes = [];
    const stateRank = { healthy: 0, unknown: 1, degraded: 2, unhealthy: 3, alt: 1, signal: 1 };

    for (const b of bundlePlans) {
      const pb = box.get(b.pid);
      const busBase = chanTop(b.chan) + 6;
      for (const k of [...b.kids].sort((a, b2) => stateRank[g.nodes.get(a.e.from).state] - stateRank[g.nodes.get(b2.e.from).state])) {
        const cb = box.get(k.e.from);
        const pts = k.straight
          ? [{ x: k.x, y: cb.top }, { x: k.x, y: pb.bottom }]
          : [{ x: k.stubX, y: cb.top }, { x: k.stubX, y: busBase + k.busLevel * 4 }, { x: k.entryX, y: busBase + k.busLevel * 4 }, { x: k.entryX, y: pb.bottom }];
        routes.push({ e: k.e, pts });
      }
    }

    for (const t of tracked) {
      let pts;
      if (t.sameLane) {
        const cLo = box.get(t.loNode), cU = box.get(t.uNode);
        const y = rowY(t.chan, itemFor(t, t.channels[0]).level);
        pts = [{ x: t.exitLo, y: cLo.top }, { x: t.exitLo, y }, { x: t.exitU, y }, { x: t.exitU, y: cU.top }];
      } else {
        const cLo = box.get(t.loNode), cU = box.get(t.uNode);
        pts = [{ x: t.exitLo, y: cLo.top }];
        let prevX = t.exitLo;
        for (let i = t.channels.length - 1; i >= 0; i--) {
          const c = t.channels[i];
          const y = rowY(c.g, itemFor(t, c).level);
          pts.push({ x: prevX, y }, { x: c.xAbove, y });
          prevX = c.xAbove;
        }
        pts.push({ x: t.entryU, y: cU.bottom });
        pts = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
        // Near-aligned single-channel risers: collapse the redundant label-row jog to a straight
        // vertical at the child's exit x (= the pill anchor, so the pill stays centred on the line).
        if (t.channels.length === 1) {
          const [uLo, uHi] = nodeRange(t.uNode);
          if (straightenTrackedX(t.exitLo, t.entryU, uLo, uHi))
            pts = [{ x: t.exitLo, y: cLo.top }, { x: t.exitLo, y: cU.bottom }];
        }
      }
      routes.push({ e: t.e, pts });
    }
    return { routes, pills };
  }

  return { chanH, realize };
}
