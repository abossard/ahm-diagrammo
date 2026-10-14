// AHM Diagrammo VS Code extension entry point. CommonJS.
"use strict";
var vscode = require("vscode");
var path = require("path");
var fs = require("fs");
var settings = require("./settings");
var blankModel = require("./blankModel");
var fingerprint = require("./fingerprint");

var EXT_ID_PREFIX = "abossard.ahm-diagrammo";

function pluginEntry(extensionPath) {
  return { file: path.join(extensionPath, "assets", "plugin", "ahm-diagrammo.plugin.js") };
}

function libraryEntry(extensionPath) {
  return {
    entryId: "ahmDiagrammoLibrary",
    libName: "AHM Diagrammo",
    file: path.join(extensionPath, "assets", "library", "ahm-diagrammo.xml")
  };
}

function getConfig() {
  return vscode.workspace.getConfiguration("hediet.vscode-drawio");
}

// Core enable logic. Accepts explicit ConfigurationTarget for non-interactive invocation.
async function enableCore(extensionPath, target) {
  var pluginFile = pluginEntry(extensionPath).file;
  if (!fs.existsSync(pluginFile)) {
    throw new Error("AHM Diagrammo: plugin asset not found at " + pluginFile);
  }

  var config = getConfig();

  var inspected = config.inspect("plugins");
  var current = (target === vscode.ConfigurationTarget.Global
    ? (inspected && inspected.globalValue)
    : (inspected && inspected.workspaceValue));
  var merged = settings.mergeEntry(current, pluginEntry(extensionPath), EXT_ID_PREFIX);

  var libInspected = config.inspect("customLibraries");
  var libCurrent = (target === vscode.ConfigurationTarget.Global
    ? (libInspected && libInspected.globalValue)
    : (libInspected && libInspected.workspaceValue));
  var libMerged = settings.mergeEntry(libCurrent, libraryEntry(extensionPath), EXT_ID_PREFIX);

  await config.update("plugins", merged, target);
  await config.update("customLibraries", libMerged, target);

  return fingerprint.pluginFingerprint(extensionPath);
}

// Core disable logic.
async function disableCore(extensionPath, target) {
  var config = getConfig();

  var inspected = config.inspect("plugins");
  var current = (target === vscode.ConfigurationTarget.Global
    ? (inspected && inspected.globalValue)
    : (inspected && inspected.workspaceValue)) || [];
  var cleaned = settings.removeEntries(current, EXT_ID_PREFIX, extensionPath);
  await config.update("plugins", cleaned.length ? cleaned : undefined, target);

  var libInspected = config.inspect("customLibraries");
  var libCurrent = (target === vscode.ConfigurationTarget.Global
    ? (libInspected && libInspected.globalValue)
    : (libInspected && libInspected.workspaceValue)) || [];
  var libCleaned = settings.removeEntries(libCurrent, EXT_ID_PREFIX, extensionPath);
  await config.update("customLibraries", libCleaned.length ? libCleaned : undefined, target);
}

// Formats an unknown rejection value for the user. `vscode.openWith` can reject with a
// non-Error (a string, or an object without `message`), so `.message` must not be assumed.
function describeOpenFailure(err) {
  if (err && typeof err.message === "string" && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return String(err);
}

// Core newModel logic. Accepts explicit URI for non-interactive invocation.
async function newModelCore(uri) {
  var content = Buffer.from(blankModel.EMPTY_DRAWIO_SVG, "utf8");
  await vscode.workspace.fs.writeFile(uri, content);
  vscode.commands.executeCommand("vscode.openWith", uri, "hediet.vscode-drawio-text")
    .then(undefined, function (err) {
      vscode.window.showErrorMessage(
        "AHM Diagrammo: failed to open model: " + describeOpenFailure(err));
    });
}

function activate(context) {
  var extensionPath = context.extensionUri.fsPath;

  context.subscriptions.push(
    // Optional arg: { target: vscode.ConfigurationTarget }
    vscode.commands.registerCommand("ahmDiagrammo.enable", async function (args) {
      var target;
      if (args && args.target !== undefined) {
        target = args.target;
      } else {
        var targets = [
          { label: "Global (User Settings)", target: vscode.ConfigurationTarget.Global },
          { label: "Workspace", target: vscode.ConfigurationTarget.Workspace }
        ];
        var pick = await vscode.window.showQuickPick(targets, {
          placeHolder: "Where should AHM Diagrammo be enabled?"
        });
        if (!pick) return;
        target = pick.target;
      }

      try {
        var fp = await enableCore(extensionPath, target);
        if (!args || !args.target) {
          vscode.window.showInformationMessage(
            "AHM Diagrammo enabled. Plugin fingerprint (sha256): " + (fp || "unknown") +
            ". You will be prompted to trust the plugin when Draw.io opens.",
            "Reload Window"
          ).then(function (choice) {
            if (choice === "Reload Window") {
              vscode.commands.executeCommand("workbench.action.reloadWindow");
            }
          });
        }
      } catch (err) {
        vscode.window.showErrorMessage(err.message);
        throw err;
      }
    }),

    // Optional arg: { target: vscode.ConfigurationTarget }
    vscode.commands.registerCommand("ahmDiagrammo.disable", async function (args) {
      var target;
      if (args && args.target !== undefined) {
        target = args.target;
      } else {
        var targets = [
          { label: "Global (User Settings)", target: vscode.ConfigurationTarget.Global },
          { label: "Workspace", target: vscode.ConfigurationTarget.Workspace }
        ];
        var pick = await vscode.window.showQuickPick(targets, {
          placeHolder: "Where should AHM Diagrammo be disabled?"
        });
        if (!pick) return;
        target = pick.target;
      }

      await disableCore(extensionPath, target);

      if (!args || !args.target) {
        vscode.window.showInformationMessage("AHM Diagrammo disabled.", "Reload Window").then(function (choice) {
          if (choice === "Reload Window") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        });
      }
    }),

    // Optional arg: { uri: vscode.Uri }
    vscode.commands.registerCommand("ahmDiagrammo.newModel", async function (args) {
      var uri;
      if (args && args.uri) {
        uri = args.uri;
      } else {
        var defaultUri = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders[0]
          ? vscode.workspace.workspaceFolders[0].uri
          : undefined;

        uri = await vscode.window.showSaveDialog({
          defaultUri: defaultUri ? vscode.Uri.joinPath(defaultUri, blankModel.defaultFileName()) : undefined,
          filters: { "Draw.io SVG": ["drawio.svg"] },
          title: "Create New AHM Health Model"
        });
        if (!uri) return;
      }

      try {
        await newModelCore(uri);
      } catch (err) {
        vscode.window.showErrorMessage("AHM Diagrammo: failed to create model: " + err.message);
        throw err;
      }
    }),

    vscode.commands.registerCommand("ahmDiagrammo.showFingerprint", function () {
      var fp = fingerprint.pluginFingerprint(extensionPath);
      if (fp) {
        vscode.window.showInformationMessage("AHM Diagrammo plugin fingerprint (sha256): " + fp);
      } else {
        vscode.window.showWarningMessage("AHM Diagrammo: plugin asset not found. Run sync-assets first.");
      }
    })
  );
}

function deactivate() {}

module.exports = { activate, deactivate, describeOpenFailure };
