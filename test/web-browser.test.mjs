import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { unzipSync } from "fflate";
import { buildSite } from "../scripts/build-pages.mjs";
import { syncMarkdown, escapeCommentTerminator } from "../src/markdown-sync.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CHROME = [
  process.env.PUPPETEER_EXECUTABLE_PATH, process.env.CHROME_PATH,
  "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find((p) => p && existsSync(p));
const health = '# Captured\n\n```mermaid midnight\nflowchart BT\nsig["Latency = 230 ms"] --> child["Original child<br/>degraded"]\nchild --> root["Root<br/>healthy"]\nclass sig blue;\nclass child amber;\nclass root green;\n```\n';
const sequence = '# Sequence\n\n```mermaid\nsequenceDiagram\nA->>B: hi\n```\n';
const broken = '# Broken\n\n```mermaid\nflowchart BT\nunrecognized graph text\nclass missing green;\n```\n';
let browser, socket, server, scratch, base, serial = 0;
const waiting = new Map();
const responses = new Map();

function command(method, params = {}, sessionId) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15000);
    waiting.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

before(async () => {
  assert.ok(CHROME, "native browser proof requires installed Chrome/Chromium");
  scratch = mkdtempSync(join(ROOT, ".browser-proof-"));
  const site = join(scratch, "site");
  buildSite({ outRoot: site });
  server = createServer((req, res) => {
    const relative = decodeURIComponent(new URL(req.url, "http://local").pathname).replace(/^\/ahm-diagrammo\//, "");
    const controlled = responses.get(relative);
    if (controlled) return controlled(req, res);
    const path = resolve(site, relative || "index.html");
    if (!path.startsWith(site + "/")) { res.writeHead(404).end(); return; }
    try {
      const content = readFileSync(path);
      const type = path.endsWith(".mjs") || path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200, { "Content-Type": type });
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/ahm-diagrammo/`;
  browser = spawn(CHROME, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${join(scratch, "profile")}`], { stdio: ["ignore", "ignore", "pipe"] });
  const endpoint = await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not expose DevTools")), 15000);
    browser.stderr.on("data", (data) => {
      text += data.toString();
      const match = text.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    browser.once("error", reject);
  });
  socket = new WebSocket(endpoint);
  socket.on("message", (data) => {
    const message = JSON.parse(data.toString());
    const entry = waiting.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  await new Promise((r, reject) => { socket.once("open", r); socket.once("error", reject); });
  mkdirSync(join(scratch, "downloads"));
  await command("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: join(scratch, "downloads") });
});

after(async () => {
  socket?.close();
  if (browser && browser.exitCode === null) {
    browser.kill();
    await new Promise((r) => browser.once("exit", r));
  }
  if (server) await new Promise((r) => server.close(r));
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

async function page() {
  const { targetId } = await command("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
  const evaluate = async (expression) => {
    const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ": " + result.exceptionDetails.exception?.description);
    return result.result.value;
  };
  await command("Page.enable", {}, sessionId);
  await command("Page.navigate", { url: base }, sessionId);
  return {
    evaluate, sessionId,
    close: () => command("Target.closeTarget", { targetId }),
    wait: async (expression) => {
      for (let i = 0; i < 100; i++) {
        if (await evaluate(expression)) return;
        await new Promise((r) => setTimeout(r, 50));
      }
      const state = await evaluate("({status:document.querySelector('#status')?.textContent,example:document.querySelector('#example-select')?.value,focus:document.activeElement?.id})");
      throw new Error(`Native browser condition not met: ${expression}; state=${JSON.stringify(state)}`);
    },
    edit: (source) => evaluate(`document.querySelector('#editor').value=${JSON.stringify(source)}; document.querySelector('#editor').dispatchEvent(new Event('input',{bubbles:true}));`),
    select: (path) => evaluate(`document.querySelector('#example-select').value=${JSON.stringify(path)}; document.querySelector('#example-select').dispatchEvent(new Event('change',{bubbles:true}));`),
  };
}

async function ready(p) {
  await p.wait("document.querySelector('#status')?.textContent.startsWith('Loaded')");
}

test("native Pages: startup shows editable default, prose, SVG and enabled download", async () => {
  const p = await page();
  try {
    await ready(p);
    assert.equal(await p.evaluate("document.querySelectorAll('textarea').length"), 1);
    assert.ok(await p.evaluate("document.querySelector('#editor').value.includes('flowchart BT')"));
    assert.ok(await p.evaluate("!!document.querySelector('#output h1, #output h2') && !!document.querySelector('#output svg text')"));
    assert.equal(await p.evaluate("document.querySelector('#export-zip').disabled"), false);
  } finally { await p.close(); }
});

test("native Pages: failed startup load leaves a usable editor and readable error", async () => {
  responses.set("kitchen-sink.md", (_, res) => res.writeHead(503).end("unavailable"));
  const p = await page();
  try {
    await p.wait("document.querySelector('#status')?.classList.contains('error')");
    assert.match(await p.evaluate("document.querySelector('#status').textContent"), /503/);
    await p.edit(health);
    assert.ok(await p.evaluate("!!document.querySelector('#output svg')"));
    assert.equal(await p.evaluate("document.querySelector('#export-zip').disabled"), false);
  } finally { responses.clear(); await p.close(); }
});

const minimalHealth = "```mermaid\nflowchart BT\na[A]\nclass a green;\n```\n";
const inspectedHealth = '# Valid\n\n```mermaid\nflowchart BT\nsig["Latency = 230 ms"] --> child["Child<br/>degraded"]\nchild --> root["Root<br/>healthy"]\nclass sig blue;\nclass child amber;\nclass root green;\n```\n';
for (const [label, source, labels, literal, insideList, error, slugs] of [
  ["inline backticks", "```inline```\n\n" + inspectedHealth, ["Child"], "inline", false, null, ["valid"]],
  ["literal incomplete marker", "````markdown\n<!-- diagrammo:sync example -->\n````\n\n" + inspectedHealth, ["Child"], "<!-- diagrammo:sync example -->", false, null, ["valid"]],
  ["shared hidden envelope", "Before\n\n<!-- diagrammo:source\n" + escapeCommentTerminator(inspectedHealth + "\n" + inspectedHealth.replace("# Valid", "# Checkout").replace("```mermaid", "```mermaid midnight")) + "\n-->\n\nAfter\n", ["Child", "Child"], null, false, null, ["valid", "checkout"]],
  ["list ownership", "- First\n\n" + inspectedHealth.split("\n").map((l) => "    " + l).join("\n") + "\n- Second\n", ["Child"], null, true, null, ["diagram"]],
  ["genuine incomplete marker", "<!-- diagrammo:sync x -->\n\n" + minimalHealth, [], null, false, /Error at line 1:.*missing its end marker/],
]) {
  test(`native Pages correction: ${label}`, async () => {
    const p = await page();
    try {
      await ready(p);
      await p.edit(source);
      const observed = await p.evaluate(`({
        source:document.querySelector('#editor').value,
        labels:[...document.querySelectorAll('#output svg')].map(n=>[...n.querySelectorAll('text')].map(t=>t.textContent)),
        results:[...document.querySelectorAll('#output .diagram-result')].map(n=>({slug:n.dataset.slug,insideList:!!n.closest('li')})),
        text:document.querySelector('#output').textContent,
        codes:[...document.querySelectorAll('#output pre code, #output p code')].map(n=>n.textContent),
        lists:[...document.querySelectorAll('#output ul')].map(n=>[...n.children].map(li=>li.textContent)),
        exportDisabled:document.querySelector('#export-zip').disabled
      })`);
      console.log("NATIVE CORRECTION", label, JSON.stringify(observed));
      assert.equal(observed.source, source);
      assert.equal(observed.labels.length, labels.length);
      labels.forEach((text, i) => assert.ok(observed.labels[i].includes(text)));
      if (slugs) assert.deepEqual(observed.results.map((r) => r.slug), slugs);
      assert.equal(observed.exportDisabled, labels.length === 0);
      if (literal) assert.ok(observed.codes.some((text) => text.includes(literal)));
      if (source.startsWith("Before")) {
        assert.match(observed.text, /Before[\s\S]*After/);
        assert.equal(observed.results.length, 2);
      }
      if (insideList) {
        assert.equal(observed.results[0].insideList, true);
        assert.equal(observed.lists.length, 1);
        assert.equal(observed.lists[0].length, 2);
        assert.match(observed.lists[0][0], /^First/);
        assert.equal(observed.lists[0][1].trim(), "Second");
      }
      if (error) assert.match(observed.text, error);
      else assert.doesNotMatch(observed.text, /Diagram unavailable|Error at line/);
    } finally { await p.close(); }
  });
}

for (const lateFailure of [false, true]) {
  test(`native Pages: out-of-order example ${lateFailure ? "failure" : "success"} cannot overwrite newer choice`, async () => {
    const p = await page();
    let oldResponse;
    try {
      await ready(p);
      responses.set("pills-stress.md", (_, res) => { oldResponse = res; });
      responses.set("examples/showcase.md", (_, res) => res.writeHead(200).end(health.replace("Original child", "New selection")));
      await p.select("pills-stress.md");
      for (let i = 0; !oldResponse && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(oldResponse);
      await p.select("examples/showcase.md");
      await p.wait("document.querySelector('#editor').value.includes('New selection')");
      const before = await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML,document.querySelector('#status').textContent]");
      oldResponse.writeHead(lateFailure ? 500 : 200).end(health.replace("Original child", "Stale selection"));
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML,document.querySelector('#status').textContent]"), before);
    } finally { oldResponse?.end(); responses.clear(); await p.close(); }
  });
}

for (const lateFailure of [false, true]) {
  test(`native Pages: edits during fetch survive late ${lateFailure ? "failure" : "success"}`, async () => {
    const p = await page();
    let response;
    try {
      await ready(p);
      responses.set("pills-stress.md", (_, res) => { response = res; });
      await p.select("pills-stress.md");
      for (let i = 0; !response && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
      assert.ok(response);
      await p.edit(health.replace("Original child", "Typed intent"));
      const before = await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML,document.querySelector('#status').textContent]");
      response.writeHead(lateFailure ? 500 : 200).end(health);
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML,document.querySelector('#status').textContent]"), before);
      assert.doesNotMatch(before[2], /^Loading/, "typing must own the visible status");
    } finally { response?.end(); responses.clear(); await p.close(); }
  });
}

test("native Pages: managed hidden and legacy source, mixed results, source diagnostics and hostile HTML", async () => {
  const p = await page();
  try {
    await ready(p);
    const managed = syncMarkdown(health, [{ slug: "permanent", openLine: 3, closeLine: 10, title: "Captured", href: "old.svg" }]);
    const legacy = `<!-- diagrammo:sync legacy -->\n<details>\n${health.replace("# Captured", "# Legacy")}\n</details>\n<!-- /diagrammo:sync legacy -->`;
    const source = `Before\n\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>\n<div data-ahm-slot="forged-0"></div>\n\n\`\`\`\`markdown\n${health}\`\`\`\`\n\n${managed}\nBetween\n\n${sequence}\n${broken}\n${legacy}\nAfter\n`;
    await p.edit(source);
    assert.deepEqual(await p.evaluate("[...document.querySelectorAll('.diagram-result')].map(n=>[n.dataset.slug,!!n.querySelector('svg'),n.textContent.includes('Warning'),n.textContent.includes('Error')])"), [
      ["permanent", true, false, false], ["sequence", false, true, false], ["broken", false, true, true], ["legacy", true, false, false],
    ]);
    assert.equal(await p.evaluate("window.pwned === true || !!document.querySelector('#output script, #output [onerror]')"), false);
    assert.equal(await p.evaluate("document.querySelectorAll('#output img, #output details').length"), 1);
    assert.equal(await p.evaluate("document.querySelectorAll('#output pre code.language-markdown').length"), 1);
    assert.ok(await p.evaluate("document.querySelector('#output').textContent.includes('Before') && document.querySelector('#output').textContent.includes('Between') && document.querySelector('#output').textContent.includes('After')"));
    const mixedSvg = await p.evaluate("document.querySelector('[data-slug=permanent] svg').outerHTML");
    await p.edit(source.replace(managed, managed.replace("Original child", "Edited managed child")));
    assert.notEqual(await p.evaluate("document.querySelector('[data-slug=permanent] svg').outerHTML"), mixedSvg);
    await p.edit(health.replace("flowchart BT", "%%| malformed\nflowchart BT\nignored graph line"));
    assert.ok(await p.evaluate("!!document.querySelector('#output svg')"));
    assert.match(await p.evaluate("document.querySelector('#output').textContent"), /Warning at line 4: malformed directive/);
    assert.match(await p.evaluate("document.querySelector('#output').textContent"), /Warning at line 6: unrecognized line/);
    for (const option of ["theme=invalid", "renderer=invalid"]) {
      await p.edit(health.replace("mermaid midnight", `mermaid ${option}`) + "\n" + health);
      assert.equal(await p.evaluate("document.querySelectorAll('#output svg').length"), 1);
      assert.match(await p.evaluate("document.querySelector('.diagram-result').textContent"), /Error at line 3: unknown/);
    }
    const hiddenWarning = "Intro\n\n" + managed.replace("flowchart BT", "%%| malformed\nflowchart BT\nignored managed line");
    await p.edit(hiddenWarning);
    for (const [text, message] of [["%%| malformed", "malformed directive"], ["ignored managed line", "unrecognized line"]]) {
      const line = hiddenWarning.split("\n").findIndex((l) => l === text) + 1;
      assert.match(await p.evaluate("document.querySelector('[data-slug=permanent]').textContent"), new RegExp(`Warning at line ${line}: ${message}`));
    }
    const malformed = "<!-- diagrammo:source wrong -->\n" + health;
    await p.edit(malformed);
    assert.equal(await p.evaluate("document.querySelector('#editor').value"), malformed);
    assert.match(await p.evaluate("document.querySelector('#output').textContent"), /Error at line 1:.*malformed managed block/);
  } finally { await p.close(); }
});

test("native Pages: ZIP captures one revision during edits, uses prepared names and real PNGs", async () => {
  const p = await page();
  try {
    await ready(p);
    await p.edit(health + "\n" + health);
    await p.evaluate(`window.zipBytes=null; const create=URL.createObjectURL; URL.createObjectURL=function(blob){if(blob.type==='application/zip') blob.arrayBuffer().then(b=>window.zipBytes=[...new Uint8Array(b)]); return create.call(this,blob)}; HTMLAnchorElement.prototype.click=function(){}; const original=HTMLCanvasElement.prototype.toBlob; HTMLCanvasElement.prototype.toBlob=function(...args){if(!window.releasePng)window.releasePng=()=>original.apply(this,args);else original.apply(this,args)}; document.querySelector('#export-zip').click();`);
    await p.wait("typeof window.releasePng === 'function'");
    const svgBefore = await p.evaluate("[...document.querySelectorAll('#output svg')].map(n=>n.outerHTML)");
    const exportingStatus = await p.evaluate("document.querySelector('#status').textContent");
    const capturedRevision = exportingStatus.match(/revision (\d+)/)[1];
    await p.edit(health.replace("Original child", "Newer edited child"));
    await p.evaluate("window.releasePng()");
    await p.wait("!!window.zipBytes && document.querySelector('#status').textContent.startsWith('Exported')");
    const entries = unzipSync(new Uint8Array(await p.evaluate("window.zipBytes")));
    assert.deepEqual(Object.keys(entries).sort(), ["captured-2.png", "captured-2.svg", "captured.png", "captured.svg"]);
    for (const [i, slug] of ["captured", "captured-2"].entries()) {
      const svg = new TextDecoder().decode(entries[`${slug}.svg`]);
      assert.match(svg, /Original child/);
      assert.doesNotMatch(svg, /Newer edited child/);
      assert.ok(svgBefore[i].includes("Original child"));
      assert.deepEqual([...entries[`${slug}.png`].slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    }
    assert.match(await p.evaluate("document.querySelector('#status').textContent"), new RegExp(`from revision ${capturedRevision}; editor is now revision`));
    const expectedPngs = await p.evaluate(`(async()=>{const {convertMarkdown}=await import('./web/convert.mjs');const {svgToPngBytes}=await import('./web/export-zip.mjs');return await Promise.all(convertMarkdown(${JSON.stringify(health + "\n" + health)}).map(async r=>[...await svgToPngBytes(r.svg,r.meta.w,r.meta.h)]))})()`);
    for (const [i, slug] of ["captured", "captured-2"].entries()) assert.deepEqual([...entries[`${slug}.png`]], expectedPngs[i]);
    assert.equal(await p.evaluate("document.querySelector('#export-zip').disabled"), false);
    assert.ok(await p.evaluate("document.querySelector('#editor').value.includes('Newer edited child') && document.querySelector('#output').textContent.includes('Newer edited child')"));
  } finally { await p.close(); }
});

test("native Pages: export failure restores controls and preserves source/preview", async () => {
  const p = await page();
  try {
    await ready(p);
    await p.edit(health);
    const before = await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML]");
    await p.evaluate("window.originalToBlob=HTMLCanvasElement.prototype.toBlob;HTMLCanvasElement.prototype.toBlob=function(cb){cb(null)};document.querySelector('#export-zip').click()");
    await p.wait("document.querySelector('#status').textContent.startsWith('Export failed')");
    assert.deepEqual(await p.evaluate("[document.querySelector('#editor').value,document.querySelector('#output').innerHTML]"), before);
    assert.equal(await p.evaluate("document.querySelector('#export-zip').disabled"), false);
    await p.evaluate("HTMLCanvasElement.prototype.toBlob=window.originalToBlob;document.querySelector('#export-zip').click()");
    await p.wait("document.querySelector('#status').textContent.startsWith('Exported')");
    const file = join(scratch, "downloads/diagrams.zip");
    for (let i = 0; !existsSync(file) && i < 100; i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(file), "Chrome writes the actual downloaded ZIP");
    assert.deepEqual(Object.keys(unzipSync(readFileSync(file))).sort(), ["captured.png", "captured.svg"]);
  } finally { await p.close(); }
});

for (const width of [1200, 360]) {
  test(`native Pages: keyboard, readable complete diagrams and maximize at ${width}px`, async () => {
    const p = await page();
    try {
      await command("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1, mobile: false }, p.sessionId);
      await ready(p);
      await p.edit(health);
      const key = async (key, code, windowsVirtualKeyCode) => {
        const text = key === "Enter" ? "\r" : key.length === 1 ? key : "";
        await command("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key, code, windowsVirtualKeyCode, ...(text ? { text } : {}) }, p.sessionId);
        await command("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode }, p.sessionId);
      };
      await command("Page.bringToFront", {}, p.sessionId);
      await p.evaluate("document.querySelector('#example-select').focus()");
      await key("p", "KeyP", 80);
      await p.wait("document.querySelector('#example-select').value !== 'kitchen-sink.md' && document.querySelector('#status').textContent.startsWith('Loaded '+document.querySelector('#example-select').value)");
      await key("Tab", "Tab", 9);
      assert.equal(await p.evaluate("document.activeElement.id"), "export-zip");
      await p.evaluate("document.querySelector('#editor').focus();document.querySelector('#editor').select()");
      await command("Input.insertText", { text: health }, p.sessionId);
      assert.equal(await p.evaluate("document.querySelector('#editor').value"), health);
      await p.evaluate("document.querySelector('#maximize-editor').focus()");
      await key("Enter", "Enter", 13);
      assert.equal(await p.evaluate("document.querySelector('main').dataset.maximized"), "editor");
      await key("Escape", "Escape", 27);
      assert.equal(await p.evaluate("document.activeElement.id"), "maximize-editor");
      await p.evaluate("document.querySelector('#maximize-output').focus()");
      await key("Enter", "Enter", 13);
      assert.equal(await p.evaluate("document.querySelector('main').dataset.maximized"), "output");
      const layout = await p.evaluate(`(()=>{const w=document.querySelector('.svg-wrap'),s=w.querySelector('svg'),o=document.querySelector('#output');return {pageFits:document.documentElement.scrollWidth<=innerWidth, font:getComputedStyle(s.querySelector('text')).fontSize, fullHeight:s.getBoundingClientRect().height>=Number(s.getAttribute('height'))-1, scrollable:w.scrollWidth>=s.getBoundingClientRect().width-1, outputWidth:o.clientWidth, selectWidth:document.querySelector('#example-select').getBoundingClientRect().width, editorLabel:document.querySelector('#editor').getAttribute('aria-labelledby'), diagramTab:w.tabIndex}})()`);
      assert.ok(layout.pageFits);
      assert.ok(parseFloat(layout.font) >= 10, "diagram text remains readable rather than shrinking to fit");
      assert.ok(layout.fullHeight, "complete diagram retains its native height");
      assert.ok(layout.scrollable);
      assert.equal(layout.diagramTab, 0);
      assert.equal(layout.editorLabel, "editor-label");
      if (width === 360) {
        assert.ok(layout.selectWidth >= 180, "selected example filename must be readable");
        await p.evaluate("document.querySelector('.svg-wrap').focus()");
        await key("ArrowRight", "ArrowRight", 39);
        await p.wait("document.querySelector('.svg-wrap').scrollLeft > 0");
        if (process.env.C0_ARTIFACTS_DIR) {
          const { data } = await command("Page.captureScreenshot", { format: "png" }, p.sessionId);
          writeFileSync(join(process.env.C0_ARTIFACTS_DIR, "c0-editor-360.png"), Buffer.from(data, "base64"));
        }
      }
      await key("Escape", "Escape", 27);
      assert.equal(await p.evaluate("document.activeElement.id"), "maximize-output");
      await p.evaluate("HTMLAnchorElement.prototype.click=function(){};document.querySelector('#export-zip').focus()");
      await key("Enter", "Enter", 13);
      await p.wait("document.querySelector('#status').textContent.startsWith('Exported')");
    } finally { await p.close(); }
  });
}

test("native Pages: unchanged publication specimens retain complete native SVG canvases", async () => {
  const p = await page();
  try {
    await ready(p);
    for (const [name, source] of [
      ["hero", readFileSync(join(ROOT, "hero.md"), "utf8")],
      ["kitchen-sink", readFileSync(join(ROOT, "kitchen-sink.md"), "utf8")],
      ["pills-stress", readFileSync(join(ROOT, "pills-stress.md"), "utf8")],
      ["pipeline", readFileSync(join(ROOT, "docs/how-it-works.md"), "utf8")],
      ["comparison-current", readFileSync(join(ROOT, "README.md"), "utf8")],
    ]) {
      await p.edit(source);
      assert.ok(await p.evaluate("!!document.querySelector('#output svg text') && !document.querySelector('#output svg foreignObject')"));
      const svg = await p.evaluate("document.querySelector('#output svg').outerHTML");
      await command("Page.setDocumentContent", { frameId: (await command("Page.getFrameTree", {}, p.sessionId)).frameTree.frame.id, html: `<html><body style="margin:0">${svg}</body></html>` }, p.sessionId);
      const dimensions = await p.evaluate("({width:Number(document.querySelector('svg').getAttribute('width')),height:Number(document.querySelector('svg').getAttribute('height'))})");
      assert.ok(await p.evaluate("document.querySelector('svg').textContent.includes('Legend')"));
      assert.ok(await p.evaluate("[...document.querySelectorAll('svg text')].find(n=>n.textContent==='Legend').getBBox().y > Number(document.querySelector('svg').getAttribute('height'))-60"));
      if (process.env.C0_ARTIFACTS_DIR) {
        const { data } = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, ...dimensions, scale: 1 } }, p.sessionId);
        writeFileSync(join(process.env.C0_ARTIFACTS_DIR, `c0-${name}.png`), Buffer.from(data, "base64"));
      }
      await command("Page.navigate", { url: base }, p.sessionId);
      await ready(p);
    }
    const svg = readFileSync(join(ROOT, "svg/compare-diagrammo.svg"), "utf8");
    await command("Page.setDocumentContent", { frameId: (await command("Page.getFrameTree", {}, p.sessionId)).frameTree.frame.id, html: `<html><body style="margin:0">${svg}</body></html>` }, p.sessionId);
    const dimensions = await p.evaluate("({width:Number(document.querySelector('svg').getAttribute('width')),height:Number(document.querySelector('svg').getAttribute('height'))})");
    if (process.env.C0_ARTIFACTS_DIR) {
      const { data } = await command("Page.captureScreenshot", { format: "png", captureBeyondViewport: true, clip: { x: 0, y: 0, ...dimensions, scale: 1 } }, p.sessionId);
      writeFileSync(join(process.env.C0_ARTIFACTS_DIR, "c0-comparison.png"), Buffer.from(data, "base64"));
    }
  } finally { await p.close(); }
});
