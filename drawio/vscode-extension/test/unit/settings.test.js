// Unit tests for src/settings.js
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { mergeEntry, removeEntries } = require("../../src/settings");

const PREFIX = "abossard.ahm-diagrammo";

describe("mergeEntry", function () {
  it("appends to empty array", function () {
    var result = mergeEntry([], { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" }, PREFIX);
    assert.equal(result.length, 1);
  });

  it("preserves unrelated entries", function () {
    var seed = [{ file: "/other/foo.js" }, { file: "/another/bar.js" }];
    var ours = { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" };
    var result = mergeEntry(seed, ours, PREFIX);
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], seed[0]);
    assert.deepEqual(result[1], seed[1]);
    assert.deepEqual(result[2], ours);
  });

  it("removes stale version before appending", function () {
    var seed = [
      { file: "/other/foo.js" },
      { file: "/ext/abossard.ahm-diagrammo-0.0.9/old.js" }
    ];
    var ours = { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" };
    var result = mergeEntry(seed, ours, PREFIX);
    assert.equal(result.length, 2);
    assert.deepEqual(result[0], seed[0]);
    assert.deepEqual(result[1], ours);
  });

  it("double-enable adds exactly one entry", function () {
    var ours = { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" };
    var first = mergeEntry([], ours, PREFIX);
    var second = mergeEntry(first, ours, PREFIX);
    assert.equal(second.length, 1);
  });

  it("handles an unset setting", function () {
    var result = mergeEntry(undefined, { file: "/ext/abossard.ahm-diagrammo-0.1.0/p.js" }, PREFIX);
    assert.equal(result.length, 1);
  });

  it("rejects malformed setting values", function () {
    ["plugin.js", {}, 42, null].forEach(function (value) {
      assert.throws(
        function () {
          mergeEntry(value, { file: "/ext/abossard.ahm-diagrammo-0.1.0/p.js" }, PREFIX);
        },
        /expected Draw\.io setting to be an array/
      );
    });
  });

  it("preserves entries without file property", function () {
    var seed = [{ url: "https://example.com/lib.js" }];
    var ours = { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" };
    var result = mergeEntry(seed, ours, PREFIX);
    assert.equal(result.length, 2);
  });
});

describe("removeEntries", function () {
  it("removes only our entries", function () {
    var current = [
      { file: "/other/foo.js" },
      { file: "/ext/abossard.ahm-diagrammo-0.1.0/plugin.js" }
    ];
    var result = removeEntries(current, PREFIX);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], current[0]);
  });

  it("handles empty array", function () {
    assert.deepEqual(removeEntries([], PREFIX), []);
  });

  it("handles non-array", function () {
    assert.deepEqual(removeEntries(undefined, PREFIX), []);
  });

  it("is no-op when no matching entries", function () {
    var current = [{ file: "/other/foo.js" }];
    var result = removeEntries(current, PREFIX);
    assert.deepEqual(result, current);
  });

  it("removes entries by extensionPath (dev mode)", function () {
    var devPath = "/dev/project/vscode-extension";
    var current = [
      { file: "/other/foo.js" },
      { file: devPath + "/assets/plugin/ahm-diagrammo.plugin.js" }
    ];
    var result = removeEntries(current, PREFIX, devPath);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], current[0]);
  });
});
