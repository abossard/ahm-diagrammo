// Doc-contract test for README.md (V-11)
"use strict";
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const readme = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");

describe("README doc contract", function () {
  var requiredSections = [
    "## Install",
    "## Enable",
    "## Create a New Model",
    "## Authoring Walkthrough",
    "### Add an Entity",
    "### Add a Signal",
    "### Connect a Dependency",
    "### Create a Swimlane",
    "### Add a Legend",
    "## Disable"
  ];

  requiredSections.forEach(function (section, i) {
    it("has section: " + section, function () {
      assert.ok(readme.includes(section), "missing section: " + section);
      // Order check: each section should appear after the previous
      if (i > 0) {
        var prevIdx = readme.indexOf(requiredSections[i - 1]);
        var curIdx = readme.indexOf(section);
        assert.ok(curIdx > prevIdx, section + " should appear after " + requiredSections[i - 1]);
      }
    });
  });

  it("mentions 'demonstration only' for examples", function () {
    assert.ok(readme.toLowerCase().includes("demonstration only"), "should label examples as demonstration only");
  });

  it("mentions trust prompt", function () {
    assert.ok(readme.toLowerCase().includes("trust prompt"), "should mention trust prompt");
  });

  it("does not contain absolute local paths", function () {
    assert.ok(!readme.match(/\/Users\/|[A-Z]:\\/), "should not contain absolute paths");
  });
});
