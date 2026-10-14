// Unit tests for src/fingerprint.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const { computeSha256 } = require("../../src/fingerprint");

describe("computeSha256", function () {
  it("computes correct sha256 of a known file", function () {
    var testFile = path.join(__dirname, "..", "..", "package.json");
    var result = computeSha256(testFile);
    assert.equal(typeof result, "string");
    assert.equal(result.length, 64);
  });
});
