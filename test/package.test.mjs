import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_JSON_PATH = join(ROOT, "package.json");
const LOCK_PATH = join(ROOT, "package-lock.json");
const EXPECTED_PACKED_FILES = [
  "LICENSE",
  "README.md",
  "bin/diagrammo.mjs",
  "examples/README.md",
  "examples/hero-source.mmd",
  "examples/nested-metadata.json",
  "examples/nested-source-ancestor-stress.mmd",
  "examples/nested-source-stress.mmd",
  "examples/nested-source.mmd",
  "examples/render-nested-views.mjs",
  "examples/source-to-svg.mjs",
  "examples/sync-markdown/README.md",
  "examples/sync-markdown/assets/notification-delivery-platform-health.svg",
  "hero.md",
  "kitchen-sink.md",
  "package.json",
  "pills-stress.md",
  "src/ahm-render.mjs",
  "src/ahm-card-plan.mjs",
  "src/ahm-nested-model.mjs",
  "src/route-presentation.mjs",
  "src/ahm-tokens.mjs",
  "src/ahm.css",
  "src/diag.mjs",
  "src/document.mjs",
  "src/extract.mjs",
  "src/font-metrics.mjs",
  "src/health-model.mjs",
  "src/index.mjs",
  "src/layout.mjs",
  "src/managed-source.mjs",
  "src/markdown-sync.mjs",
  "src/mermaid.mjs",
  "src/render.mjs",
  "src/swimlane.mjs",
  "src/text.mjs",
  "src/themes.mjs",
  "svg/hero.svg",
  "svg/kitchen-sink.svg",
  "svg/pele/hero.svg",
  "svg/pele/kitchen-sink.svg",
  "svg/pele/pills-stress.svg",
  "svg/pills-stress.svg",
].sort();

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result;
}

test("package exports the CLI aliases, every renderer and the stylesheet asset contract", async () => {
  const pkg = readJson(PKG_JSON_PATH);
  assert.equal(pkg.exports["."], "./src/index.mjs");
  assert.equal(pkg.exports["./styles.css"], "./src/ahm.css");
  assert.deepEqual(pkg.bin, { diagrammo: "bin/diagrammo.mjs", "ahm-diagrammo": "bin/diagrammo.mjs" });

  const index = await import(pathToFileURL(join(ROOT, "src", "index.mjs")).href);
  assert.equal(typeof index.renderAhm, "function");
  assert.equal(typeof index.getAhmPalette, "function");
  assert.ok(Array.isArray(index.AHM_ENTITY_STATES));
  assert.ok(Array.isArray(index.AHM_SIGNAL_STATES));
  for (const name of ["renderDiagram", "resolveRenderer", "prepareDocuments", "renderSwimlane", "renderMermaid", "extractBlocks"]) {
    assert.equal(typeof index[name], "function", name);
  }
});

test("package pins pele to exact registry dependency and lockfile tarball", () => {
  const pkg = readJson(PKG_JSON_PATH);
  assert.equal(pkg.dependencies.pele, "1.6.0");

  const lock = readJson(LOCK_PATH);
  assert.equal(lock.packages[""].dependencies.pele, "1.6.0");
  assert.equal(lock.packages["node_modules/pele"].version, "1.6.0");
  assert.match(lock.packages["node_modules/pele"].resolved, /^https:\/\/registry\.npmjs\.org\/pele\/-\/pele-1\.6\.0\.tgz$/);
  assert.match(lock.packages["node_modules/pele"].integrity, /^sha512-/);
});

test("fresh subprocess import/render works with guarded effect APIs and throws actionable diagnostics", () => {
  const script = `
    import fs from "node:fs";
    import net from "node:net";
    import http from "node:http";
    import https from "node:https";
    import dns from "node:dns";
    import childProcess from "node:child_process";

    const fail = (name) => () => { throw new Error(name + " must not be called by renderAhm"); };
    fs.writeFileSync = fail("fs.writeFileSync");
    fs.appendFileSync = fail("fs.appendFileSync");
    fs.rmSync = fail("fs.rmSync");
    fs.mkdirSync = fail("fs.mkdirSync");
    childProcess.spawn = fail("child_process.spawn");
    childProcess.spawnSync = fail("child_process.spawnSync");
    childProcess.exec = fail("child_process.exec");
    childProcess.execFile = fail("child_process.execFile");
    net.connect = fail("net.connect");
    net.createConnection = fail("net.createConnection");
    http.request = fail("http.request");
    https.request = fail("https.request");
    dns.lookup = fail("dns.lookup");
    globalThis.fetch = fail("fetch");
    globalThis.XMLHttpRequest = class { constructor() { throw new Error("XMLHttpRequest must not be called by renderAhm"); } };
    globalThis.window = undefined;
    globalThis.document = undefined;
    globalThis.OffscreenCanvas = undefined;

    const { renderAhm } = await import("ahm-diagrammo");
    const good = renderAhm(
      [
        "flowchart TB",
        'child["Child"]',
        'parent["Parent"]',
        'sig["Latency = 3 ms (healthy)"]:::blue',
        "sig --> child",
        "child --> parent",
        "class child green;",
        "class parent amber;",
      ].join("\\n"),
      { legend: false, direction: "TB", lanes: false, idPrefix: "effect-guard" }
    );
    if (!good.svg.startsWith("<svg")) throw new Error("expected svg output");
    let badMessage = "";
    try {
      renderAhm("flowchart TB\\na --> missingNode\\nclass a green;", { legend: false });
    } catch (error) {
      badMessage = String(error?.message || "");
    }
    if (!/dangling edge/i.test(badMessage)) throw new Error("expected actionable dangling-edge diagnostic");
    console.log("effect-guard-ok");
  `;

  const result = run(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, NODE_PATH: join(ROOT, "node_modules") },
  });
  assert.match(result.stdout, /effect-guard-ok/);
});

test("packed artifact matches explicit allowlist and installed examples render deterministically", () => {
  const tmp = mkdtempSync(join(tmpdir(), "ahm-pack-test-"));
  const packDir = join(tmp, "pack");
  const consumerDir = join(tmp, "consumer");
  try {
    run("mkdir", ["-p", packDir, consumerDir]);
    const pack = run("npm", ["pack", "--json", "--pack-destination", packDir]);
    const [entry] = JSON.parse(pack.stdout);
    const files = entry.files.map((row) => row.path).sort();
    assert.deepEqual(files, EXPECTED_PACKED_FILES);

    run("npm", ["init", "-y"], { cwd: consumerDir });
    run("npm", ["install", "--ignore-scripts", "--registry=https://registry.npmjs.org", join(packDir, entry.filename)], {
      cwd: consumerDir,
    });

    const sourcePath = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "hero-source.mmd");
    const scriptPath = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "source-to-svg.mjs");
    const svgOne = join(consumerDir, "hero.svg");
    const svgTwo = join(consumerDir, "hero-2.svg");
    run(process.execPath, [scriptPath, sourcePath, svgOne], { cwd: consumerDir });
    run(process.execPath, [scriptPath, sourcePath, svgTwo], { cwd: consumerDir });

    const one = readFileSync(svgOne);
    const two = readFileSync(svgTwo);
    assert.equal(Buffer.compare(one, two), 0, "expected identical bytes for identical input");
    assert.equal(existsSync(join(consumerDir, "node_modules", "ahm-diagrammo", "src", "ahm.css")), true);

    const heroMd = join(consumerDir, "node_modules", "ahm-diagrammo", "hero.md");
    for (const [alias, renderer] of [["diagrammo", "auto"], ["ahm-diagrammo", "pele"]]) {
      const bin = join(consumerDir, "node_modules", ".bin", alias);
      assert.equal(run(bin, ["--version"], { cwd: consumerDir }).stdout.trim(), readJson(PKG_JSON_PATH).version);
      const out = join(consumerDir, `cli-${renderer}`);
      const cli = run(bin, [heroMd, "-o", out, "-r", renderer, "--strict"], { cwd: consumerDir });
      assert.match(cli.stdout, renderer === "auto" ? /\[swimlane · portal\]/ : /\[pele · portal\]/);
      assert.equal(existsSync(join(out, "diagram.svg")), true, `${alias} -r ${renderer} wrote no svg`);
    }

    const nestedScript = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "render-nested-views.mjs");
    const nestedCanonicalSource = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "nested-source.mmd");
    const nestedAncestorStressSource = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "nested-source-ancestor-stress.mmd");
    const nestedStressSource = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "nested-source-stress.mmd");
    const nestedMetadata = join(consumerDir, "node_modules", "ahm-diagrammo", "examples", "nested-metadata.json");
    const nestedOut = join(consumerDir, "nested-views");
    run(process.execPath, [nestedScript, nestedCanonicalSource, nestedMetadata, nestedOut], { cwd: consumerDir });
    assert.equal(existsSync(join(nestedOut, "expanded.svg")), true, "expected canonical expanded nested svg");
    assert.equal(existsSync(join(nestedOut, "collapsed.svg")), true, "expected canonical collapsed nested svg");
    assert.equal(existsSync(join(nestedOut, "detail.svg")), true, "expected canonical detail nested svg");

    const nestedStressScript = `
      import { readFileSync } from "node:fs";
      import { renderAhm } from "ahm-diagrammo";
      const source = readFileSync(${JSON.stringify(nestedStressSource)}, "utf8");
      const metadata = JSON.parse(readFileSync(${JSON.stringify(nestedMetadata)}, "utf8"));
      const collapsed = renderAhm(source, {
        direction: "TB",
        lanes: true,
        legend: false,
        nested: { models: metadata.models, view: metadata.views.collapsed },
      });
      if (!collapsed.svg.startsWith("<svg")) throw new Error("expected collapsed stress render to succeed");
      let expandedError = "";
      let detailError = "";
      try {
        renderAhm(source, {
          direction: "TB",
          lanes: true,
          legend: false,
          nested: { models: metadata.models, view: metadata.views.expanded },
        });
      } catch (error) {
        expandedError = String(error?.message ?? "");
      }
      try {
        renderAhm(source, {
          direction: "TB",
          lanes: true,
          legend: false,
          nested: { models: metadata.models, view: metadata.views.detail },
        });
      } catch (error) {
        detailError = String(error?.message ?? "");
      }
      if (!/unsupported-model-group-self-edge:payments:expanded/.test(expandedError)) {
        throw new Error("expected expanded stress self-edge unsupported diagnostic");
      }
      if (!/unsupported-model-group-self-edge:payments:detail/.test(detailError)) {
        throw new Error("expected detail stress self-edge unsupported diagnostic");
      }
      console.log("nested-stress-contract-ok");
    `;
    const nestedStressResult = run(process.execPath, ["--input-type=module", "-e", nestedStressScript], {
      cwd: consumerDir,
      env: { ...process.env, NODE_PATH: join(consumerDir, "node_modules") },
    });
    assert.match(nestedStressResult.stdout, /nested-stress-contract-ok/);

    const nestedAncestorStressScript = `
      import { readFileSync } from "node:fs";
      import { renderAhm } from "ahm-diagrammo";
      const source = readFileSync(${JSON.stringify(nestedAncestorStressSource)}, "utf8");
      const metadata = JSON.parse(readFileSync(${JSON.stringify(nestedMetadata)}, "utf8"));
      let expandedError = "";
      let detailError = "";
      try {
        renderAhm(source, {
          direction: "TB",
          lanes: true,
          legend: false,
          nested: { models: metadata.models, view: metadata.views.expanded },
        });
      } catch (error) {
        expandedError = String(error?.message ?? "");
      }
      try {
        renderAhm(source, {
          direction: "TB",
          lanes: true,
          legend: false,
          nested: { models: metadata.models, view: metadata.views.detail },
        });
      } catch (error) {
        detailError = String(error?.message ?? "");
      }
      if (!/unsupported-model-group-ancestor-edge:ledger:payments:expanded/.test(expandedError)) {
        throw new Error("expected expanded stress ancestor-edge unsupported diagnostic");
      }
      if (!/unsupported-model-group-ancestor-edge:ledger:payments:detail/.test(detailError)) {
        throw new Error("expected detail stress ancestor-edge unsupported diagnostic");
      }
      console.log("nested-ancestor-stress-contract-ok");
    `;
    const nestedAncestorStressResult = run(process.execPath, ["--input-type=module", "-e", nestedAncestorStressScript], {
      cwd: consumerDir,
      env: { ...process.env, NODE_PATH: join(consumerDir, "node_modules") },
    });
    assert.match(nestedAncestorStressResult.stdout, /nested-ancestor-stress-contract-ok/);

    const tableHeadersScript = `
      import { renderAhm } from "ahm-diagrammo";
      const source = [
        "flowchart BT",
        'sig["Latency = 42 ms (healthy)"] --> svc["Service A<br/>healthy"]',
        'svc -->|roll-up, ok| root["Root<br/>degraded"]',
        "class sig blue;",
        "class svc green;",
        "class root amber;",
      ].join("\\n");
      const withHeaders = renderAhm(source, { direction: "BT", lanes: true, legend: false, tableHeaders: true, idPrefix: "with-headers" }).svg;
      const withoutHeaders = renderAhm(source, { direction: "BT", lanes: true, legend: false, tableHeaders: false, idPrefix: "without-headers" }).svg;
      const hasHeader = (svg) => svg.includes("ahm-signal-table-header");
      const rowCount = (svg) => (svg.match(/ahm-signal-row/g) || []).length;
      const labelCount = (svg) => (svg.match(/pele-edge-label/g) || []).length;
      const firstTableOutlineHeight = (svg) => {
        const match = svg.match(/ahm-signal-table-outline[^>]*height=\\"([0-9.]+)\\"/);
        return Number(match?.[1] || 0);
      };

      if (!hasHeader(withHeaders)) throw new Error("expected table header group when tableHeaders=true");
      if (hasHeader(withoutHeaders)) throw new Error("unexpected table header group when tableHeaders=false");
      if (rowCount(withoutHeaders) === 0) throw new Error("tableHeaders=false must keep signal data rows");
      if (!withoutHeaders.includes("Service A")) throw new Error("tableHeaders=false must keep entity title text");
      if (!withoutHeaders.includes("entity-state-healthy")) throw new Error("tableHeaders=false must keep entity health badge/state semantics");
      if (labelCount(withoutHeaders) !== labelCount(withHeaders)) throw new Error("tableHeaders=false must keep edge label semantics");
      if (!(firstTableOutlineHeight(withoutHeaders) < firstTableOutlineHeight(withHeaders))) {
        throw new Error("tableHeaders=false must remove reserved table-header height relative to tableHeaders=true");
      }
      console.log("table-headers-false-ok");
    `;
    const tableHeadersResult = run(process.execPath, ["--input-type=module", "-e", tableHeadersScript], {
      cwd: consumerDir,
      env: { ...process.env, NODE_PATH: join(consumerDir, "node_modules") },
    });
    assert.match(tableHeadersResult.stdout, /table-headers-false-ok/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
