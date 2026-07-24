// Swimlane engine tests: parsing diagnostics, folding semantics, and — the heart of it —
// geometric verification of every torture fixture: no overlaps, nothing hidden, nothing clipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderSwimlane, parseGraph, foldSignals, looksLikeHealthModel } from "../src/swimlane.mjs";
import { extractBlocks } from "../src/extract.mjs";
import { THEME_NAMES, THEMES } from "../src/themes.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (f) => readFileSync(join(FIX, f), "utf8");

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

// determinism: same input, same output
test("rendering is deterministic", () => {
  const [b] = extractBlocks(read("torture-dense.md"), THEME_NAMES);
  const a = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  const c = renderSwimlane(b.code, { theme: "portal", title: "x" }).svg;
  assert.equal(a, c);
});

// ---------- status pill vs header text (regression: long subtitle slid under the pill) ----------
// The header qualifier (subtitle) shares its row with the right-aligned status pill. The card is
// sized to reserve the pill's horizontal band plus a gap; these tests hold that contract at the
// render boundary. See fix: measureNode's HEADER_SAFETY weight buffer for regular-weight text.
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
    const url = "data:text/html;charset=utf-8," + encodeURIComponent(page);
    const dom = execFileSync(CHROME, ["--headless", "--no-sandbox", "--disable-gpu", "--dump-dom", url], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
    const m = dom.match(/\{"subRight".*?\}/s);
    assert.ok(m, "could not read getBBox measurements from Chrome");
    const { subRight, pillX } = JSON.parse(m[0]);
    const gap = pillX - subRight;
    assert.ok(gap >= 12, `real-render gap ${gap.toFixed(2)}px must be >= 12 (subtitle right ${subRight.toFixed(1)}, pill left ${pillX.toFixed(1)})`);
  });
