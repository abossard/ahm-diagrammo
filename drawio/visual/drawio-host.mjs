// Boots the *same* Draw.io build the VS Code extension loads
// (hediet.vscode-drawio-1.9.0/drawio/src/main/webapp) inside puppeteer, drives it through the
// embed JSON protocol, and exposes the live `editorUi.editor.graph`.
//
// The webapp is served over loopback because app.min.js loads dozens of same-origin resources that
// file:// blocks. Every request outside 127.0.0.1 is aborted, so the harness stays offline.

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import puppeteer from "puppeteer";
import { contentValue } from "./svg-embed.mjs";

export const WEBAPP = "/Users/abossard/.vscode/extensions/hediet.vscode-drawio-1.9.0"
  + "/drawio/src/main/webapp";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MIME = {
  ".js": "text/javascript", ".css": "text/css", ".html": "text/html",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".gif": "image/gif", ".txt": "text/plain", ".xml": "application/xml",
};

function hostPage(pluginSource) {
  return `<!DOCTYPE html><html><head><base href="/index.html"/>
<meta charset="utf-8"/>
<script>
  var editorUi, ahmMessages = [], ahmPending = {};
  var opener = { postMessage: function (raw) {
    var message = typeof raw === "string" ? JSON.parse(raw) : raw;
    ahmMessages.push(message);
    if (message.event === "init") ahmPending.init = true;
    if (message.event === "export") ahmPending.export = message;
    if (message.event === "configure") {
      // Mirrors the config object the VS Code extension answers with, compressXml:false included.
      // That flag only affects Draw.io's file serialisation; the embed export used here hardcodes
      // the compressed form (app.min.js @8449332), so the saved content= is deflated either way.
      window.ahmSend({ action: "configure", config: { compressXml: false, customFonts: [], defaultFonts: [] } });
    }
  } };
  Object.defineProperty(window, "opener", { value: opener });
  window.ahmSend = function (message) {
    var event = new Event("message");
    event.source = opener;
    event.data = JSON.stringify(message);
    var focus = window.focus;
    window.focus = function () {};
    try { window.dispatchEvent(event); } finally { window.focus = focus; }
  };
  var urlParams = {
    embed: "1", configure: "1", proto: "json", ui: "kennedy", dark: "0",
    "high-contrast": "0", lang: "en", noSaveBtn: "1", noExitBtn: "1", chrome: "1",
    offline: "1", stealth: "1", "svg-warning": "0",
  };
  var isLocalStorage = false;
  Object.defineProperty(window, "mxIsElectron", { value: false });
  function mxscript(src, onLoad, id, dataAppKey, noWrite) {
    var s = document.createElement("script");
    s.setAttribute("type", "text/javascript");
    s.setAttribute("src", src);
    if (id != null) s.setAttribute("id", id);
    if (onLoad != null) s.onload = onLoad;
    document.getElementsByTagName("script")[0].parentNode.insertBefore(s, null);
  }
  function mxinclude(src) { mxscript(src); }
</script>
<link rel="stylesheet" type="text/css" href="styles/grapheditor.css"/>
<style>body{overflow:hidden;padding:0;margin:0;background:#ffffff}</style>
<script src="js/PreConfig.js"></script>
<script src="js/app.min.js"></script>
<script src="js/PostConfig.js"></script>
</head><body class="geEditor"><div id="geInfo"></div>
<script>
  // Mirrors the two prototype patches the VS Code extension applies before Draw.io boots:
  // it publishes the EditorUi instance globally and drops the removed "help" menu.
  Menus.prototype.defaultMenuItems = Menus.prototype.defaultMenuItems.filter(function (item) {
    return item !== "help";
  });
  EditorUi.prototype.addEmbedButtons = function () {};
  var ahmInit = EditorUi.prototype.init;
  EditorUi.prototype.init = function () { editorUi = this; return ahmInit.apply(this, arguments); };
  App.main();
${pluginSource ? "  var ahmPlugin = document.createElement(\"script\");\n  ahmPlugin.type = \"text/javascript\";\n  ahmPlugin.text = " + JSON.stringify(pluginSource) + ";\n  document.getElementsByTagName(\"head\")[0].appendChild(ahmPlugin);" : ""}
</script>
</body></html>`;
}

function serve(root, pluginSource) {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://127.0.0.1").pathname);
    if (path === "/ahm-render.html") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(hostPage(pluginSource));
      return;
    }
    const file = join(root, normalize(path).replace(/^(\.\.[/\\])+/, ""));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

export async function withDrawio(run, { plugin = null } = {}) {
  if (!existsSync(resolve(WEBAPP, "js/app.min.js"))) {
    throw new Error(`bundled Draw.io webapp missing at ${WEBAPP}`);
  }
  const server = await serve(WEBAPP, plugin);
  const port = server.address().port;
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: existsSync(CHROME) ? CHROME : undefined,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--font-render-hinting=none"],
  });
  try {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (message) => logs.push(`${message.type()}: ${message.text()}`));
    page.on("requestfailed", (request) => logs.push(`requestfailed: ${request.url()}`));
    page.on("response", (response) => {
      if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`);
    });
    page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
    await page.setRequestInterception(true);
    const escaped = [];
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith(`http://127.0.0.1:${port}/`)) return request.continue();
      if (url.startsWith("data:") || url.startsWith("blob:")) return request.continue();
      escaped.push(url);
      return request.abort();
    });
    await page.setViewport({ width: 1700, height: 1400, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/ahm-render.html`, { waitUntil: "load" });
    try {
      await page.waitForFunction(
        () => typeof editorUi !== "undefined" && editorUi && editorUi.editor && editorUi.editor.graph,
        { timeout: 60000 },
      );
    } catch (error) {
      throw new Error(`Draw.io boot failed: ${error.message}\n${logs.slice(0, 25).join("\n")}\nstate: ${JSON.stringify(await page.evaluate(() => ({ hasApp: typeof App, hasEditorUi: typeof EditorUi, ui: typeof editorUi, msgs: (window.ahmMessages||[]).map((m) => m.event || m.action), status: (document.getElementById("geStatus")||{}).textContent })))}\nescaped: ${escaped.slice(0, 5).join(", ")}`);
    }
    return await run(page, { escaped, logs });
  } finally {
    await browser.close();
    server.close();
  }
}

export async function loadModel(page, xml) {
  await page.evaluate((model) => {
    window.ahmPending.loaded = false;
    window.ahmSend({ action: "load", xml: model, autosave: 0 });
    window.ahmPending.loaded = true;
  }, xml);
  await page.waitForFunction(() => {
    const graph = editorUi.editor.graph;
    return graph.getModel().getChildCount(graph.getDefaultParent()) > 0;
  }, { timeout: 30000 });
  await page.evaluate(() => {
    const graph = editorUi.editor.graph;
    graph.view.setScale(1);
    graph.refresh();
  });
  await new Promise((done) => setTimeout(done, 350));
}

// Drives Draw.io's own `{action:"export", format:"xmlsvg"}` handler — byte-for-byte the call the
// VS Code extension makes in `exportAsSvgWithEmbeddedXml()` before it replaces the whole .svg file.
//
// The result is returned **unmodified**, including Draw.io's compressed `content=` payload
// (`app.min.js` @8449332 hardcodes `getFileData(..., uncompressed=false)` for the embed export).
// Earlier revisions substituted a readable `content=` here; that made the round-trip proof describe
// the harness's own variant instead of the bytes VS Code writes, so the substitution is gone and
// `test/helpers/artifact.mjs` inflates the payload at the reopen boundary instead.
// "The export carries the model" is the same question as "which attribute is the model", so it is
// asked through the one shared exact selector instead of with a local loose regex over the whole
// string. That loose test was green on an export carrying only a `data-content` look-alike
// (`P-C21-4`); this one raises the shared module's own named error instead of a consumer-local
// message.
export function assertEmbeddedModelPresent(svg, label) {
  void label;
  contentValue(svg);
  return svg;
}

export async function exportXmlSvg(page) {
  const data = await page.evaluate(async () => {
    window.ahmPending.export = null;
    window.ahmSend({ action: "export", format: "xmlsvg", background: "#ffffff", scale: 1, border: 8 });
    for (let tick = 0; tick < 600; tick++) {
      if (window.ahmPending.export) return window.ahmPending.export.data;
      await new Promise((done) => setTimeout(done, 50));
    }
    return null;
  });
  if (!data) throw new Error("draw.io xmlsvg export produced no data");
  const svg = Buffer.from(data.replace(/^data:image\/svg\+xml;base64,/, ""), "base64").toString("utf8");
  return assertEmbeddedModelPresent(svg, "draw.io export");
}
