// Plugin fingerprint helper. Reads assets/manifest.json for the sha256.
"use strict";
var crypto = require("crypto");
var fs = require("fs");
var path = require("path");

function computeSha256(filePath) {
  var content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function readManifest(extensionPath) {
  var manifestPath = path.join(extensionPath, "assets", "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

function pluginFingerprint(extensionPath) {
  var manifest = readManifest(extensionPath);
  if (manifest && manifest.pluginSha256) return manifest.pluginSha256;
  var pluginPath = path.join(extensionPath, "assets", "plugin", "ahm-diagrammo.plugin.js");
  if (!fs.existsSync(pluginPath)) return null;
  return computeSha256(pluginPath);
}

module.exports = { computeSha256, readManifest, pluginFingerprint };
