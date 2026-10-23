// Swimlane engine tests: parsing diagnostics, folding semantics, and — the heart of it —
// geometric verification of every torture fixture: no overlaps, nothing hidden, nothing clipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderSwimlane, parseGraph, foldSignals, looksLikeHealthModel, CENTER_TIE_EPS } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { verifyGeometry, verifySvgString, countCrossings, manhattanLength, findUnownedJunctions } from "./helpers/geo.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (f) => readFileSync(join(FIX, f), "utf8");
const readRoot = (f) => readFileSync(join(ROOT, f), "utf8");

// ---------- parsing diagnostics ----------
test("parseGraph: classifies lines and reports unrecognized ones with line numbers", () => {
  const diag = new Diagnostics();
  const g = parseGraph("flowchart BT\na[One] --> b[Two]\nthis is garbage\nclass a green;", { diag, lineOffset: 10 });
  assert.equal(g.nodes.size, 2);
  assert.equal(g.edges.length, 1);
  const warn = diag.warnings.find((w) => w.message.includes("unrecognized"));
  assert.ok(warn, "expected an unrecognized-line warning");
  assert.equal(warn.line, 13); // lineOffset 10 + 3rd line
});

test("parseGraph: edge-like garbage gets the edge-syntax hint", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart BT\na ==> b", { diag });
  const warn = diag.warnings.find((w) => w.message.includes("unrecognized"));
  assert.match(warn.hint, /supported forms/);
});

test("parseGraph: warns on non-BT direction and unknown classes", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart LR\na --> b\nclass a sparkly;", { diag });
  assert.ok(diag.warnings.some((w) => w.message.includes('direction "LR"')));
  assert.ok(diag.warnings.some((w) => w.message.includes('class "sparkly"')));
});

test("parseGraph: subgraph and friends are reported as ignored", () => {
  const diag = new Diagnostics();
  parseGraph("flowchart BT\nsubgraph cluster\na --> b\nend", { diag });
  assert.ok(diag.warnings.some((w) => w.message.includes('ignored "subgraph"')));
});

test("foldSignals: explicit results and states survive; orphans are reported", () => {
  const diag = new Diagnostics();
  const g = parseGraph([
    "flowchart BT",
    's["P95 = 230 ms (degraded)<br/>Errors = 0.4%"] --> e[Entity]',
    'lonely["No target"]',
    "class s,lonely blue;",
    "class e amber;",
  ].join("\n"), { diag });
  foldSignals(g, diag);
  const rows = g.nodes.get("e").signals;
  assert.equal(rows[0].name, "P95");
  assert.equal(rows[0].result, "230 ms");
  assert.equal(rows[0].state, "degraded");
  assert.equal(rows[1].result, "0.4%");
  assert.equal(rows[1].state, "healthy");
  assert.ok(diag.warnings.some((w) => w.message.includes('"lonely"')));
});

test("renderSwimlane: zero-node block throws a useful error", () => {
  const diag = new Diagnostics();
  assert.throws(
    () => renderSwimlane("flowchart BT\ntotal --- garbage === here", { diag, baseLine: 100 }),
    /no nodes parsed.*unrecognized line/s
  );
});

test("looksLikeHealthModel detects health flowcharts only", () => {
  assert.equal(looksLikeHealthModel("flowchart BT\na-->b\nclass a green;"), true);
  assert.equal(looksLikeHealthModel("flowchart LR\na-->b\nclass a green;"), false);
  assert.equal(looksLikeHealthModel("sequenceDiagram\nA->>B: hi"), false);
});

// ---------- geometric verification of every fixture, in every theme for the worst one ----------
const fixtureFiles = readdirSync(FIX).filter((f) => f.startsWith("torture-"));
assert.ok(fixtureFiles.length >= 5, "expected torture fixtures");

for (const file of fixtureFiles) {
  const blocks = extractBlocks(read(file), THEME_NAMES);
  blocks.forEach((b, bi) => {
    test(`geometry: ${file} block ${bi + 1} (${b.slug})`, () => {
      const diag = new Diagnostics({ file });
      const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag, baseLine: b.codeLine - 1 });
      const geo = verifyGeometry(r);
      assert.deepEqual(geo, [], `geometry violations:\n  ${geo.join("\n  ")}`);
      const sv = verifySvgString(r.svg);
      assert.deepEqual(sv, [], `svg violations:\n  ${sv.join("\n  ")}`);
      // nothing may be silently hidden: any clipped text must carry a tooltip AND a warning
      const clippedWarns = diag.warnings.filter((w) => w.message.includes("clipped"));
      const tooltips = (r.svg.match(/<title>/g) || []).length;
      assert.ok(tooltips >= clippedWarns.length, "every clipped text needs a tooltip");
    });
  });
}

test("geometry: pill flood stays clean in every theme", () => {
  const [b] = extractBlocks(read("torture-pills.md"), THEME_NAMES);
  for (const theme of Object.keys(THEMES)) {
    const r = renderSwimlane(b.code, { theme, title: b.heading });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `theme ${theme}:\n  ${geo.join("\n  ")}`);
  }
});

test("torture-text: long content wraps instead of vanishing", () => {
  const [b] = extractBlocks(read("torture-text.md"), THEME_NAMES);
  const diag = new Diagnostics();
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag });
  // the 2350 ms measurement and the unicode row must be present in the SVG text
  assert.match(r.svg, /2350 ms/);
  assert.match(r.svg, /99\.9%/);
  assert.match(r.svg, /日本語サービス/);
  // XML-special characters must be escaped, not dropped
  assert.match(r.svg, /&lt;entities&gt;/);
  assert.doesNotMatch(r.svg, /<entities>/);
});

test("entity titles remain complete beyond the card width cap", () => {
  const multiWord = "Payment gateway with a very long descriptive name that remains visible across every wrapped line in the entity header";
  const singleToken = "QueueProcessorWithoutBreaks".repeat(8);
  const diag = new Diagnostics();
  const r = renderSwimlane([
    "flowchart BT",
    `a["${multiWord}"] --> root[Root]`,
    `b["${singleToken}"] --> root`,
    "class a,b,root green;",
  ].join("\n"), { theme: "portal", title: "Long entity titles", diag });

  const visibleText = [...r.svg.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/g)]
    .map((m) => m[1].replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<[^>]+>/g, ""))
    .join("")
    .replace(/\s/g, "");

  assert.ok(visibleText.includes(multiWord.replace(/\s/g, "")));
  assert.ok(visibleText.includes(singleToken));
  assert.doesNotMatch(r.svg, /…/);
  assert.ok(!diag.warnings.some((w) => w.message.includes("entity name")));
  assert.deepEqual(verifyGeometry(r), []);
  assert.deepEqual(verifySvgString(r.svg), []);
});

test("torture-weird: cycles, self-loops, orphan signals render with warnings, verify clean", () => {
  const blocks = extractBlocks(read("torture-weird.md"), THEME_NAMES);
  assert.equal(blocks.length, 4);
  for (const b of blocks) {
    const diag = new Diagnostics();
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, diag });
    const geo = verifyGeometry(r);
    assert.deepEqual(geo, [], `${b.slug}:\n  ${geo.join("\n  ")}`);
  }
  // the cycle block specifically warns
  const cyc = blocks.find((b) => b.slug.includes("cycle"));
  const diag = new Diagnostics();
  renderSwimlane(cyc.code, { theme: "portal", diag });
  assert.ok(diag.warnings.some((w) => w.message.includes("cycle")), "cycle warning expected");
  assert.ok(diag.warnings.some((w) => w.message.includes("self-loop")), "self-loop warning expected");
});

test("custom lanes and legend-off are honored", () => {
  const code = "flowchart BT\na[Child] --> b[Parent]\nclass a green;\nclass b amber;\nclassDef green x;\nclassDef amber x;";
  const r = renderSwimlane(code, { theme: "portal", lanes: ["Top", "Bottom"], legend: false, title: "t" });
  assert.match(r.svg, />Top</);
  assert.match(r.svg, />Bottom</);
  assert.doesNotMatch(r.svg, />Legend</);
  const geo = verifyGeometry(r);
  assert.deepEqual(geo, []);
});

// determinism: same input, same output.
test("rendering is deterministic", () => {
  const [b] = extractBlocks(read("torture-dense.md"), THEME_NAMES);
  const a = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  const c = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  assert.equal(a, c);
});

const FORMER_INTERACTIVE_OPTIONS = [
  ["absent", {}],
  ["false", { interactive: false }],
  ["true", { interactive: true }],
  ["wrong type", { interactive: "true" }],
];
const ANIMATION_HOOK = /data-ahm-(?:entity|signal|edge|edge-label|qualifier|logic|part|route-segment|route-members|port)=/;

for (const [name, formerOption] of FORMER_INTERACTIVE_OPTIONS) {
  test(`former interactive option ${name} produces the same deterministic static SVG`, () => {
    const [b] = extractBlocks(readRoot("kitchen-sink.md"), THEME_NAMES);
    const options = { theme: "portal", title: "Kitchen sink health model" };
    const expected = renderSwimlane(b.code, options);
    const result = renderSwimlane(b.code, { ...options, ...formerOption });
    const repeated = renderSwimlane(b.code, { ...options, ...formerOption });

    assert.equal(result.svg, expected.svg);
    assert.equal(repeated.svg, expected.svg);
    assert.equal(Object.hasOwn(result, "animation"), false);
    assert.doesNotMatch(result.svg, ANIMATION_HOOK);
  });
}

// ---------- laneLabels: optional lane-label gutter, a second width-reclaim lever (C18-C20) ----------
// Genuine lane-label texts are the only debug.texts entries with no `container` field that sit
// near the canvas's right edge (every other text source — title, subtitle, legend, card/pill
// content — either carries a container or sits far from that edge) — a black-box boundary,
// not an internal read, that also sidesteps a real fixture coincidence: kitchen-sink.md's root
// entity is itself literally named "Workload root", the same string as the default lane-0 label.
function laneLabelTexts(r) {
  return r.debug.texts.filter((t) => !t.container && t.x > r.W - 250);
}

test("laneLabels (C18): unset is identical to explicitly true — shown by default, mirroring legend's own shape", () => {
  const [b] = extractBlocks(readRoot("kitchen-sink.md"), THEME_NAMES);
  const title = "Kitchen sink health model";
  const unset = renderSwimlane(b.code, { theme: "portal", title });
  const explicitTrue = renderSwimlane(b.code, { theme: "portal", title, laneLabels: true });
  assert.equal(unset.svg, explicitTrue.svg, "unset laneLabels must render byte-identically to an explicit true");
  assert.ok(laneLabelTexts(unset).length > 0, "expected lane-label text to be present by default");
});

test("laneLabels: false (C19) removes label text and its gutter while preserving band fills/hairlines and every graph-semantic guarantee, and (C20) reclaims measurable row budget", () => {
  for (const { file, read: readFixture, title } of [
    { file: "kitchen-sink.md", read: readRoot, title: "Kitchen sink health model" },
    { file: "torture-dense.md", read, title: "x" },
  ]) {
    const [b] = extractBlocks(readFixture(file), THEME_NAMES);
    const on = renderSwimlane(b.code, { theme: "portal", title });
    const off = renderSwimlane(b.code, { theme: "portal", title, laneLabels: false });

    // C19: label text and its gutter gone; band rects + hairlines (structural lane grouping)
    // and every graph-semantic guarantee (node/edge counts, geometry) unchanged.
    assert.ok(laneLabelTexts(on).length > 0, `${file}: expected label text with labels on`);
    assert.equal(laneLabelTexts(off).length, 0, `${file}: expected zero label text with labels off`);
    const bandRects = (s) => (s.match(/<rect x="0" y="[\d.]+" width=/g) || []).length;
    const hairlines = (s) => (s.match(/<line x1="0"/g) || []).length;
    assert.equal(bandRects(off.svg), bandRects(on.svg), `${file}: band rect count must be unchanged`);
    assert.equal(hairlines(off.svg), hairlines(on.svg), `${file}: hairline count must be unchanged`);
    assert.equal(off.nodes, on.nodes, `${file}: node count must be unchanged`);
    const edgeKeys = (r) => new Set(r.debug.segs.map((s) => s.edge)).size;
    assert.equal(edgeKeys(off), edgeKeys(on), `${file}: distinct edge count must be unchanged`);
    assert.deepEqual(verifyGeometry(off), []);
    assert.deepEqual(verifySvgString(off.svg), []);

    // C20: labels-off never needs MORE physical rows than labels-on, and
    // reclaims measurable width.
    assert.ok(off.lanes <= on.lanes, `${file}: labels-off must not need MORE physical rows (${off.lanes} vs ${on.lanes})`);
    assert.ok(off.W < on.W, `${file}: labels-off must render narrower (${off.W} vs ${on.W})`);
  }
});

test("laneLabels: false drops a custom `lanes:` label the same way — it must not leak into the SVG", () => {
  const code = "flowchart BT\na[Child] --> b[Parent]\nclass a green;\nclass b amber;\nclassDef green x;\nclassDef amber x;";
  const r = renderSwimlane(code, { theme: "portal", lanes: ["Zeta layer", "Yolo tier"], laneLabels: false, title: "t" });
  assert.doesNotMatch(r.svg, /Zeta layer/);
  assert.doesNotMatch(r.svg, /Yolo tier/);
  assert.deepEqual(verifyGeometry(r), []);
});

// ---------- retained geometry and header safeguards ----------

// ---------- status pill vs header text (regression: long subtitle slid under the pill) ----------
// The header qualifier (subtitle) shares its row with the right-aligned status pill. The card is
// sized to reserve the pill's horizontal band plus a gap; these tests hold that contract at the
// render boundary. See fix: the card measurement's HEADER_SAFETY weight buffer for regular-weight text.
const HEADER_PILL_GAP = 12; // reserved estimator-space gap between subtitle right and pill left
const sameBox = (a, b) => a && b && Math.abs(a.x - b.x) < 0.6 && Math.abs(a.y - b.y) < 0.6;

function nodeParts(r, id) {
  const card = r.debug.cards.find((c) => c.id === id);
  const pill = r.debug.statusPills.find((p) => p.id === id);
  const texts = r.debug.texts.filter((t) => sameBox(t.container, card));
  return { card, pill, texts };
}

test("status pill clears the Shop subtitle in every theme and both lane modes (real consumer fixture)", () => {
  const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
  for (const theme of THEME_NAMES) {
    for (const laneLabels of [true, false]) {
      const tag = `${theme}/laneLabels=${laneLabels}`;
      const r = renderSwimlane(b.code, { theme, title: b.heading, laneLabels });
      assert.deepEqual(verifyGeometry(r), [], `geometry violations in ${tag}`);
      assert.deepEqual(verifySvgString(r.svg), [], `svg violations in ${tag}`);
      const { card, pill, texts } = nodeParts(r, "shop");
      assert.ok(card && pill, `missing shop card/pill in ${tag}`);
      const sub = texts.find((t) => t.text.includes("minimum healthy"));
      assert.ok(sub, `missing subtitle text in ${tag}`);
      assert.ok(sub.x + sub.w + HEADER_PILL_GAP <= pill.x + 0.5,
        `${tag}: subtitle right ${(sub.x + sub.w).toFixed(1)} + ${HEADER_PILL_GAP} exceeds pill left ${pill.x.toFixed(1)}`);
      assert.ok(pill.x >= card.x - 0.5 && pill.x + pill.w <= card.x + card.w + 0.5, `${tag}: pill escapes card`);
      assert.ok(sub.x + sub.w <= card.x + card.w + 0.5, `${tag}: subtitle escapes card`);
    }
  }
});

// state class -> the label the pill renders; drives pill width (Unhealthy is the widest)
const STATE_CASES = [["green", "Healthy"], ["amber", "Degraded"], ["red", "Unhealthy"], ["purple", "Standby"], [null, "Unknown"]];
const SUBTITLE_CASES = {
  none: { lines: [], marker: null },
  short: { lines: ["(active-active)"], marker: "active-active" },
  long: { lines: ["(active-active)", "(minimum healthy:", "min 2 of 3 regions)"], marker: "minimum healthy" },
  longTitle: { title: "Shop, commerce, and marketplace order fulfillment", lines: ["(active-active)"], marker: "active-active" },
};

function svcSource({ title = "Shop and commerce", lines = [], cls = "green" } = {}) {
  const label = [title, ...lines].join("<br/>");
  return [
    "flowchart BT",
    `    a["Upstream A<br/>Region A signal"] --> svc["${label}"]`,
    `    b["Upstream B<br/>Region B signal"] --> svc`,
    `    svc --> root["Contoso E-Shop<br/>healthy"]`,
    "    class a,b blue;",
    "    class root green;",
    cls ? `    class svc ${cls};` : "",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
    "    classDef amber fill:none,stroke:#F5A623;",
    "    classDef red fill:none,stroke:#D0021B;",
    "    classDef purple fill:none,stroke:#7B61FF;",
  ].join("\n");
}

for (const [cls, label] of STATE_CASES)
  for (const [subKey, sub] of Object.entries(SUBTITLE_CASES))
    for (const laneLabels of [true, false]) {
      const tag = `state=${label}/subtitle=${subKey}/laneLabels=${laneLabels}`;
      test(`header text clears the status pill (${tag})`, () => {
        const r = renderSwimlane(svcSource({ title: sub.title, lines: sub.lines, cls }), { theme: "portal", laneLabels });
        assert.deepEqual(verifyGeometry(r), [], `geometry violations in ${tag}`);
        assert.deepEqual(verifySvgString(r.svg), [], `svg violations in ${tag}`);
        const { card, pill, texts } = nodeParts(r, "svc");
        assert.ok(card && pill, `missing svc card/pill in ${tag}`);
        if (sub.marker) {
          const q = texts.find((t) => t.text.includes(sub.marker));
          assert.ok(q, `missing subtitle text in ${tag}`);
          assert.ok(q.x + q.w + HEADER_PILL_GAP <= pill.x + 0.5,
            `${tag}: subtitle right ${(q.x + q.w).toFixed(1)} + ${HEADER_PILL_GAP} exceeds pill left ${pill.x.toFixed(1)}`);
          assert.ok(q.x + q.w <= card.x + card.w + 0.5, `${tag}: subtitle escapes card`);
        } else {
          // no subtitle: the bold title (accurate metrics) must still stay left of the pill
          const title = texts.find((t) => t.text.includes("Shop"));
          assert.ok(title && title.x + title.w <= pill.x + 0.5, `${tag}: title overlaps pill`);
        }
        assert.ok(pill.x >= card.x - 0.5 && pill.x + pill.w <= card.x + card.w + 0.5, `${tag}: pill escapes card`);
      });
    }

test("a short subtitle that the title dominates never widens the card (no over-expansion)", () => {
  const w = (lines) => renderSwimlane(svcSource({ lines }), { theme: "portal" }).debug.cards.find((c) => c.id === "svc").w;
  assert.equal(w(["(active-active)"]), w([]),
    "a short subtitle must not force a wider card when the bold title already dominates the header width");
});

// Real-render proof: the estimator can only approximate glyph advances, so the actual browser
// getBBox is the ground truth that would have caught the original overlap. Skipped when no Chrome.
const CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
  "/opt/pw-browsers/chromium", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));

function dumpChromeDom(page, flags, maxBuffer) {
  const dir = mkdtempSync(join(tmpdir(), "diagrammo-browser-test-"));
  try {
    const file = join(dir, "page.html");
    writeFileSync(file, page);
    return execFileSync(CHROME, [...flags, pathToFileURL(file).href], { encoding: "utf8", maxBuffer });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("browser: kitchen-sink route/card/pill geometry is disjoint and every rendered extent stays inside the SVG",
  { skip: !CHROME ? "no Chrome/Chromium available" : false }, () => {
    const [b] = extractBlocks(readRoot("kitchen-sink.md"), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title: "Kitchen sink health model" });
    const page = `<!doctype html><meta charset="utf-8"><style>body{margin:0}</style><body>${r.svg}<script>
      const svg=document.querySelector('svg'), svgRect=svg.getBoundingClientRect();
      const content=[...svg.children].find(el=>el.matches('g[transform]')&&el.querySelector(':scope > g[fill="none"]'));
      const cardModel=${JSON.stringify(r.debug.cards)}, pillModel=${JSON.stringify(r.debug.pills)}, segModel=${JSON.stringify(r.debug.segs)};
      const cards=[...content.querySelectorAll(':scope > g[filter="url(#cs)"] > rect')].map((el,i)=>({id:cardModel[i].id,el,rect:el.getBoundingClientRect()}));
      const pills=[...content.querySelectorAll(':scope > g[stroke="none"]')].map((el,i)=>({id:pillModel[i].edge,el,rect:el.getBoundingClientRect()}));
      const paths=[...content.querySelector(':scope > g[fill="none"]').querySelectorAll(':scope > path')];
      const inside=(p,r,pad=0)=>p.x>r.left+pad&&p.x<r.right-pad&&p.y>r.top+pad&&p.y<r.bottom-pad;
      const overlap=(a,b,pad=0)=>a.left+pad<b.right&&b.left+pad<a.right&&a.top+pad<b.bottom&&b.top+pad<a.bottom;
      const point=svg.createSVGPoint(), routeCard=[], routePill=[];
      for(const path of paths){
        const len=path.getTotalLength(), ctm=path.getScreenCTM(), modelCtm=path.getCTM();
        const endpoint=(distance)=>{const q=path.getPointAtLength(distance);return q.matrixTransform(modelCtm)};
        const start=endpoint(0),end=endpoint(len),near=(p,s)=>
          (Math.abs(p.x-s.x1)<.1&&Math.abs(p.y-s.y1)<.1)||(Math.abs(p.x-s.x2)<.1&&Math.abs(p.y-s.y2)<.1);
        const candidateEdges=[...new Set(segModel.filter(s=>near(start,s)).map(s=>s.edge))];
        const id=candidateEdges.find(edge=>segModel.some(s=>s.edge===edge&&near(end,s)))||candidateEdges[0];
        const samples=[]; for(let d=0;d<len;d+=0.75)samples.push(d); samples.push(len);
        for(const d of samples){
          const q=path.getPointAtLength(d); point.x=q.x; point.y=q.y;
          const p=point.matrixTransform(ctm);
          for(const card of cards) if(inside(p,card.rect,2)) routeCard.push(id+'×'+card.id);
          for(const pill of pills) if(pill.id!==id&&inside(p,pill.rect,1)) routePill.push(id+'×'+pill.id);
        }
      }
      const cardPill=[], pillPill=[];
      for(const card of cards)for(const pill of pills)if(overlap(card.rect,pill.rect,1))cardPill.push(card.id+'×'+pill.id);
      for(let i=0;i<pills.length;i++)for(let j=i+1;j<pills.length;j++)if(overlap(pills[i].rect,pills[j].rect,1))pillPill.push(pills[i].id+'×'+pills[j].id);
      const scale=svgRect.width/svg.viewBox.baseVal.width, outside=[];
      const extents=[
        ...cards.map(x=>({name:'card:'+x.id,rect:x.rect})),
        ...pills.map(x=>({name:'pill:'+x.id,rect:x.el.getBoundingClientRect()})),
        ...[...svg.querySelectorAll('text')].map((el,i)=>({name:'text:'+i,rect:el.getBoundingClientRect()})),
        ...paths.map((el,i)=>{const r=el.getBoundingClientRect(),h=(parseFloat(getComputedStyle(el).strokeWidth)||0)*scale/2;return{name:'route:'+i,rect:{left:r.left-h,right:r.right+h,top:r.top-h,bottom:r.bottom+h}}}),
      ];
      for(const x of extents)if(x.rect.left<svgRect.left-.5||x.rect.right>svgRect.right+.5||x.rect.top<svgRect.top-.5||x.rect.bottom>svgRect.bottom+.5)outside.push(x.name);
      const suppressed=pills.find(x=>x.el.textContent.includes('suppressed'));
      document.body.textContent=JSON.stringify({routeCard:[...new Set(routeCard)],routePill:[...new Set(routePill)],cardPill,pillPill,outside,suppressedInside:!!suppressed&&!outside.includes('pill:'+suppressed.id)});
    <\/script></body>`;
    const dom = dumpChromeDom(page, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom"], 10 * 1024 * 1024);
    const m = dom.match(/\{"routeCard".*?\}/s);
    assert.ok(m, "could not read kitchen-sink DOM geometry from Chrome");
    assert.deepEqual(JSON.parse(m[0]), {
      routeCard: [], routePill: [], cardPill: [], pillPill: [], outside: [], suppressedInside: true,
    });
  });

test("browser: the Shop subtitle's real glyph box clears the status pill by >= 12px",
  { skip: !CHROME ? "no Chrome/Chromium available" : false }, () => {
    const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
    const page = `<!doctype html><meta charset="utf-8"><body>${r.svg}<script>
      const texts=[...document.querySelectorAll('text')];
      const sub=texts.find(t=>t.textContent.includes('minimum healthy'));
      const sb=sub.getBBox();
      const pill=[...document.querySelectorAll('rect')].filter(x=>x.getAttribute('rx')==='9')
        .map(x=>({x:+x.getAttribute('x'),y:+x.getAttribute('y')}))
        .sort((p,q)=>Math.abs(p.y-sb.y)-Math.abs(q.y-sb.y))[0];
      document.body.textContent=JSON.stringify({subRight:sb.x+sb.width,pillX:pill.x});
    <\/script></body>`;
    const dom = dumpChromeDom(page, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom"], 10 * 1024 * 1024);
    const m = dom.match(/\{"subRight".*?\}/s);
    assert.ok(m, "could not read getBBox measurements from Chrome");
    const { subRight, pillX } = JSON.parse(m[0]);
    const gap = pillX - subRight;
    assert.ok(gap >= 12, `real-render gap ${gap.toFixed(2)}px must be >= 12 (subtitle right ${subRight.toFixed(1)}, pill left ${pillX.toFixed(1)})`);
  });

// ---------- bounded subtitle wrapping (v3.1.3) ----------
// Supersedes v3.1.2's width-only fix: a subtitle wider than a bounded text column now WRAPS at
// word boundaries and the card grows TALLER, instead of the card widening to fit one long line.
// The title still drives one-line minimum width; the pill stays clear; nothing is ever truncated.
const CARD_MAX_W = 480;
const svgHeight = (svg) => Number(svg.match(/height="(\d+)"/)[1]);
const SUB1 = "single region";
const SUB2 = "active-active · minimum healthy: · min 2 of 3 regions";
const SUB3 = "active-active across many regions · minimum healthy is min 2 of 3 regions worldwide plus standby";
const UNBROKEN_TOKEN = "supercalifragilisticexpialidocioushyperultramegatokenthatcannotbebrokenonspaces";

// A middle-lane service with its own signal row (so its card height is not clamped) plus a leaf
// lane below and a root lane above — exercises coherent downstream shift when the middle grows.
function dsSource(sub) {
  const mid = ["Mid service", "healthy", ...(sub ? [sub] : [])].join("<br/>");
  return [
    "flowchart BT",
    `    leafSig["Leaf availability<br/>Region signal"] --> leaf["Leaf node<br/>healthy"]`,
    `    leaf --> mid["${mid}"]`,
    `    midSig["Mid availability<br/>Region signal"] --> mid`,
    `    mid --> root["Root service<br/>healthy"]`,
    "    class leafSig,midSig blue;",
    "    class leaf,mid,root green;",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
  ].join("\n");
}

test("a long subtitle wraps to >=2 lines and the card stays within the bounded width (no widen-to-fit)", () => {
  const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
  const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
  const shop = r.debug.cards.find((c) => c.id === "shop");
  assert.ok(shop.qualLines >= 2, `expected a wrapped subtitle, got ${shop.qualLines} line(s)`);
  assert.ok(shop.w < CARD_MAX_W, `card must not hit the max width (got ${shop.w})`);
  // header width is bounded: headerFixed(Healthy≈114.3) + SUBTITLE_MAX_W*HEADER_SAFETY ⇒ ~294px
  assert.ok(shop.w <= 295, `subtitle must not widen the card past the bounded column (got ${shop.w})`);
  assert.doesNotMatch(r.svg, /…/, "subtitle is never truncated");
});

test("subtitle line count grows headerH by exactly 11px per line, deterministically", () => {
  const card = (sub) => renderSwimlane(svcSource({ lines: sub ? [sub] : [] }), { theme: "portal" })
    .debug.cards.find((c) => c.id === "svc");
  const c1 = card(SUB1), c2 = card(SUB2), c3 = card(SUB3);
  assert.deepEqual([c1.qualLines, c2.qualLines, c3.qualLines], [1, 2, 3], "fixtures must wrap to 1/2/3 lines");
  assert.equal(c2.headerH - c1.headerH, 11, "2 lines grows one line-height over 1 line");
  assert.equal(c3.headerH - c1.headerH, 22, "3 lines grows two line-heights over 1 line");
  const a = renderSwimlane(svcSource({ lines: [SUB2] }), { theme: "portal" }).svg;
  const d = renderSwimlane(svcSource({ lines: [SUB2] }), { theme: "portal" }).svg;
  assert.equal(a, d, "re-render is byte-identical");
});

test("a taller card shifts every following lane, edge, and the footer down by the exact same delta", () => {
  const g = (r, id) => r.debug.cards.find((c) => c.id === id);
  const r1 = renderSwimlane(dsSource(SUB1), { theme: "portal", laneLabels: false });
  const r2 = renderSwimlane(dsSource(SUB2), { theme: "portal", laneLabels: false });
  const D = g(r2, "mid").h - g(r1, "mid").h;
  assert.ok(D > 0, "the growing card must actually get taller");
  assert.equal(g(r2, "mid").y - g(r1, "mid").y, 0, "the growing card's own top does not move");
  assert.equal(g(r2, "leaf").y - g(r1, "leaf").y, D, "the lane below shifts down by the delta");
  assert.equal(g(r2, "root").y - g(r1, "root").y, 0, "the lane above does not move");
  assert.equal(svgHeight(r2.svg) - svgHeight(r1.svg), D, "the footer/total height shifts by the delta");
  assert.deepEqual(verifyGeometry(r2), [], "edges stay connected and nothing overlaps after growth");
  assert.deepEqual(verifySvgString(r2.svg), []);
});

test("subtitle bbox (real Chrome): every wrapped line clears the status pill by >= 12px",
  { skip: !CHROME ? "no Chrome/Chromium available" : false }, () => {
    const [b] = extractBlocks(read("shop-commerce-pill.md"), THEME_NAMES);
    const r = renderSwimlane(b.code, { theme: "portal", title: b.heading, laneLabels: false });
    const page = `<!doctype html><meta charset="utf-8"><body>${r.svg}<script>
      const texts=[...document.querySelectorAll('text')];
      const subs=texts.filter(t=>/active-active|minimum healthy|regions|min/.test(t.textContent));
      const pills=[...document.querySelectorAll('rect')].filter(x=>x.getAttribute('rx')==='9')
        .map(x=>({x:+x.getAttribute('x'),y:+x.getAttribute('y')}));
      const out=subs.map(t=>{const bb=t.getBBox();
        const pill=pills.slice().sort((p,q)=>Math.abs(p.y-bb.y)-Math.abs(q.y-bb.y))[0];
        return {text:t.textContent,gap:pill.x-(bb.x+bb.width)};});
      document.body.textContent=JSON.stringify(out);
    <\/script></body>`;
    const dom = dumpChromeDom(page, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom"], 10 * 1024 * 1024);
    const m = dom.match(/\[.*\]/s);
    assert.ok(m, "could not read getBBox measurements from Chrome");
    const lines = JSON.parse(m[0]);
    assert.ok(lines.length >= 2, `expected >=2 wrapped subtitle lines, got ${lines.length}`);
    for (const l of lines)
      assert.ok(l.gap >= 12, `line "${l.text}" real gap ${l.gap.toFixed(2)}px must be >= 12`);
  });

test("nodes in one lane wrapping to different line counts: lane sizes to the tallest, none overlap", () => {
  const code = [
    "flowchart BT",
    `    sA["Sig A<br/>Region signal"] --> nodeA["Node A<br/>${SUB2}"]`,
    `    sB["Sig B<br/>Region signal"] --> nodeB["Node B<br/>${SUB1}"]`,
    "    nodeA --> root[\"Root<br/>healthy\"]",
    "    nodeB --> root",
    "    class sA,sB blue;",
    "    class nodeA,nodeB,root green;",
    "    classDef blue fill:none,stroke:#4A90D9;",
    "    classDef green fill:none,stroke:#7ED321;",
  ].join("\n");
  const r = renderSwimlane(code, { theme: "portal", laneLabels: false });
  const A = r.debug.cards.find((c) => c.id === "nodeA"), B = r.debug.cards.find((c) => c.id === "nodeB");
  assert.equal(A.lane, B.lane, "both nodes share a lane");
  assert.ok(A.qualLines > B.qualLines, "the two nodes wrap to different line counts");
  const lane = r.debug.lanes[A.lane];
  assert.ok(lane.h >= Math.max(A.h, B.h) - 0.5, "lane sizes to the tallest card");
  assert.deepEqual(verifyGeometry(r), [], "no node/pill/subtitle overlaps another");
});

test("a long unbroken token hard-breaks inside the column: no ellipsis, no widening past the cap", () => {
  const r = renderSwimlane(svcSource({ lines: [UNBROKEN_TOKEN] }), { theme: "portal" });
  const svc = r.debug.cards.find((c) => c.id === "svc");
  assert.ok(svc.qualLines >= 2, `over-long token must hard-break across lines (got ${svc.qualLines})`);
  assert.ok(svc.w < CARD_MAX_W, `token must not widen the card to the max (got ${svc.w})`);
  assert.doesNotMatch(r.svg, /…/, "hard-break never ellipsizes");
  const { texts, card } = nodeParts(r, "svc");
  const joined = texts.filter((t) => sameBox(t.container, card)).map((t) => t.text).join("");
  assert.ok(joined.includes(UNBROKEN_TOKEN), "the full token survives, split across lines");
});
