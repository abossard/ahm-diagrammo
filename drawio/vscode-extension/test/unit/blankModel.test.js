// Unit tests for src/blankModel.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EMPTY_DRAWIO_SVG, defaultFileName } = require("../../src/blankModel");

describe("EMPTY_DRAWIO_SVG", function () {
  it("is valid XML starting with <?xml", function () {
    assert.ok(EMPTY_DRAWIO_SVG.startsWith("<?xml"));
  });

  it("contains <svg> element", function () {
    assert.ok(EMPTY_DRAWIO_SVG.includes("<svg"));
  });

  it("embeds an empty native Draw.io model", function () {
    assert.ok(EMPTY_DRAWIO_SVG.includes('content="&lt;mxfile'));
    assert.ok(EMPTY_DRAWIO_SVG.includes("&lt;mxGraphModel"));
    assert.ok(EMPTY_DRAWIO_SVG.includes("&lt;mxCell id=&quot;1&quot; parent=&quot;0&quot;/&gt;"));
  });

  it("contains no ahmRole or ahmId", function () {
    assert.ok(!EMPTY_DRAWIO_SVG.includes("ahmRole"));
    assert.ok(!EMPTY_DRAWIO_SVG.includes("ahmId"));
  });
});

describe("defaultFileName", function () {
  it("ends with .drawio.svg", function () {
    assert.ok(defaultFileName().endsWith(".drawio.svg"));
  });

  it("starts with ahm-model-", function () {
    assert.ok(defaultFileName().startsWith("ahm-model-"));
  });
});
