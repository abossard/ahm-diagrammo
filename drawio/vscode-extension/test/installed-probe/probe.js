// Extension-host probe for V-02. Runs as its own development extension so that
// abossard.ahm-diagrammo can only resolve to the copy installed in the isolated
// extensions directory. Writes its findings to AHM_PROBE_RESULT and fails the run
// when the positive expectations are not met.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const EXPECTED_COMMANDS = [
  "ahmDiagrammo.disable",
  "ahmDiagrammo.enable",
  "ahmDiagrammo.newModel",
  "ahmDiagrammo.showFingerprint",
];

async function run() {
  const target = vscode.extensions.getExtension("abossard.ahm-diagrammo");
  const dependency = vscode.extensions.getExtension("hediet.vscode-drawio");

  const result = {
    present: !!target,
    dependencyPresent: !!dependency,
    dependencyActive: false,
    active: false,
    extensionPath: target ? target.extensionUri.fsPath : null,
    assetsPresent: false,
    commands: [],
  };

  if (target) {
    try {
      await target.activate();
      result.active = target.isActive;
    } catch (err) {
      result.activationError = String(err && err.message ? err.message : err);
    }
    const assetDir = path.join(result.extensionPath, "assets");
    result.assetsPresent =
      fs.existsSync(path.join(assetDir, "plugin", "ahm-diagrammo.plugin.js")) &&
      fs.existsSync(path.join(assetDir, "library", "ahm-diagrammo.xml")) &&
      fs.existsSync(path.join(assetDir, "manifest.json"));
    const all = await vscode.commands.getCommands(true);
    result.commands = all.filter((c) => c.indexOf("ahmDiagrammo.") === 0).sort();
  }

  if (dependency) {
    try {
      await dependency.activate();
      result.dependencyActive = dependency.isActive;
    } catch (err) {
      result.dependencyActivationError = String(err && err.message ? err.message : err);
    }
  }

  const out = process.env.AHM_PROBE_RESULT;
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  }

  if (!result.present || !result.active || !result.assetsPresent ||
      JSON.stringify(result.commands) !== JSON.stringify(EXPECTED_COMMANDS)) {
    throw new Error("probe expectations not met: " + JSON.stringify(result));
  }
}

module.exports = { run };
