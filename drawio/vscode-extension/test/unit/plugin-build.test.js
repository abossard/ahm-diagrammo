// Plugin build shape (C-23.1): the packaged plugin asset is exactly
// health bytes + one LF + authoring bytes, and the recorded digest agrees.
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const extRoot = path.join(__dirname, "..", "..");
const healthSrc = path.join(extRoot, "..", "plugin", "ahm-health.js");
const authoringSrc = path.join(extRoot, "plugin-src", "ahm-authoring.js");
const assetPath = path.join(extRoot, "assets", "plugin", "ahm-diagrammo.plugin.js");
const manifestPath = path.join(extRoot, "assets", "manifest.json");

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function firstDiffOffset(a, b) {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : len;
}

const health = fs.readFileSync(healthSrc);
const authoring = fs.readFileSync(authoringSrc);
const expected = Buffer.concat([health, Buffer.from("\n"), authoring]);

describe("plugin build shape", function () {
  it("asset equals health + one LF + authoring, byte for byte", function () {
    const actual = fs.readFileSync(assetPath);
    assert.equal(actual.length, expected.length,
      "asset length " + actual.length + " != expected " + expected.length);
    assert.equal(firstDiffOffset(actual, expected), -1,
      "first byte mismatch at offset " + firstDiffOffset(actual, expected));
    assert.ok(actual.equals(expected));
  });

  it("separator between the two sources is exactly one LF", function () {
    const actual = fs.readFileSync(assetPath);
    assert.equal(actual[health.length], 0x0a, "byte at health boundary is not LF");
    assert.equal(actual[health.length + 1], authoring[0],
      "authoring source does not start immediately after the single LF");
  });

  it("recorded manifest digest equals sha256 of the reconstructed buffer", function () {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.pluginSha256, sha256(expected));
    assert.equal(manifest.sources["ahm-health.js"], sha256(health));
    assert.equal(manifest.sources["ahm-authoring.js"], sha256(authoring));
  });

  // Wrong-input controls: each mutation must be rejected by the same comparison
  // the happy path uses, and must name the mismatch.
  const mutations = [
    { name: "separator removed", buf: () => Buffer.concat([health, authoring]) },
    { name: "separator doubled", buf: () => Buffer.concat([health, Buffer.from("\n\n"), authoring]) },
    { name: "separator is CRLF", buf: () => Buffer.concat([health, Buffer.from("\r\n"), authoring]) },
    { name: "sources concatenated in reverse order", buf: () => Buffer.concat([authoring, Buffer.from("\n"), health]) }
  ];

  mutations.forEach(function (mutation) {
    it("rejects a build whose " + mutation.name, function () {
      const bad = mutation.buf();
      assert.ok(!bad.equals(expected), mutation.name + " must not equal the expected build");
      assert.notEqual(sha256(bad), sha256(expected),
        mutation.name + " produced a colliding digest");
      const offset = firstDiffOffset(bad, expected);
      assert.ok(offset >= 0, mutation.name + " reported no mismatch offset");
    });
  });
});
