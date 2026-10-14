// sync-assets determinism (V-14): repeated runs are byte-identical, and a missing
// source-of-truth file fails loudly without leaving a partial asset tree.
"use strict";
const { describe, it, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const extRoot = path.join(__dirname, "..", "..");
const drawioRoot = path.join(extRoot, "..");
const script = path.join(extRoot, "scripts", "sync-assets.mjs");
// .vscode-test/ is already gitignored, so fixtures never reach the working-tree listing.
const fixtureBase = path.join(extRoot, ".vscode-test", "sync-fixture-" + process.pid);

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function manifestOf(dir) {
  const rows = [];
  (function walk(current) {
    fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .forEach((entry) => {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) walk(full);
        else rows.push(path.relative(dir, full) + " " + sha256File(full));
      });
  }(dir));
  return rows.sort().join("\n");
}

function makeFixture(name, omit) {
  const root = path.join(fixtureBase, name);
  fs.mkdirSync(path.join(root, "plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "library"), { recursive: true });
  fs.mkdirSync(path.join(root, "vscode-extension", "plugin-src"), { recursive: true });
  const copies = [
    ["ahm-health.js", path.join(drawioRoot, "plugin", "ahm-health.js"), path.join(root, "plugin", "ahm-health.js")],
    ["ahm-diagrammo.xml", path.join(drawioRoot, "library", "ahm-diagrammo.xml"), path.join(root, "library", "ahm-diagrammo.xml")],
    ["ahm-authoring.js", path.join(extRoot, "plugin-src", "ahm-authoring.js"), path.join(root, "vscode-extension", "plugin-src", "ahm-authoring.js")]
  ];
  copies.forEach(function (row) {
    if (row[0] === omit) return;
    fs.copyFileSync(row[1], row[2]);
  });
  return root;
}

after(function () {
  fs.rmSync(fixtureBase, { recursive: true, force: true });
});

describe("sync-assets determinism", function () {
  it("two consecutive default runs produce byte-identical assets", function () {
    const assetsDir = path.join(extRoot, "assets");

    const first = spawnSync("node", [script], { cwd: extRoot, encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    const manifest1 = manifestOf(assetsDir);

    const second = spawnSync("node", [script], { cwd: extRoot, encoding: "utf8" });
    assert.equal(second.status, 0, second.stderr);
    const manifest2 = manifestOf(assetsDir);

    assert.equal(manifest1, manifest2, "assets/ manifest differs between run 1 and run 2");
    assert.ok(manifest1.includes("manifest.json "), "manifest.json missing from the hashed set");
  });

  it("manifest.json records no time-varying field", function () {
    const raw = fs.readFileSync(path.join(extRoot, "assets", "manifest.json"), "utf8");
    assert.ok(!/generatedAt|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(raw),
      "manifest still carries a timestamp: " + raw);
    const parsed = JSON.parse(raw);
    assert.deepEqual(Object.keys(parsed).sort(), ["librarySha256", "pluginSha256", "sources"]);
  });

  ["ahm-health.js", "ahm-authoring.js", "ahm-diagrammo.xml"].forEach(function (missing) {
    it("exits non-zero and writes nothing when " + missing + " is missing", function () {
      const root = makeFixture("missing-" + missing, missing);
      const run = spawnSync("node", [script, "--root", root], { cwd: extRoot, encoding: "utf8" });
      assert.notEqual(run.status, 0, "expected non-zero exit, got " + run.status);
      assert.ok(run.stderr.includes(missing),
        "stderr does not name the missing file: " + run.stderr);
      assert.equal(fs.existsSync(path.join(root, "vscode-extension", "assets")), false,
        "partial asset tree was written despite the missing source");
    });
  });

  it("a complete fixture tree does produce assets, so the negative path is not vacuous", function () {
    const root = makeFixture("complete", null);
    const run = spawnSync("node", [script, "--root", root], { cwd: extRoot, encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    const fixtureAssets = path.join(root, "vscode-extension", "assets");
    assert.ok(fs.existsSync(fixtureAssets), "complete fixture produced no assets");
    assert.equal(
      manifestOf(fixtureAssets),
      manifestOf(path.join(extRoot, "assets")),
      "relocated run does not match the default-tree bytes"
    );
  });
});
