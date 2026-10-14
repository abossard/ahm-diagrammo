// Extension-host integration tests: V-02, V-03, V-04, V-09
"use strict";
const vscode = require("vscode");
const assert = require("assert");
const path = require("path");
const fs = require("fs");
const os = require("os");

// In dev mode the extension path is the local tree, not an installed path.
// Identify "our" entries by matching the plugin filename.
function isOurEntry(entry) {
  return entry && typeof entry.file === "string" &&
    entry.file.indexOf("ahm-diagrammo.plugin.js") >= 0 ||
    entry && typeof entry.file === "string" &&
    entry.file.indexOf("ahm-diagrammo.xml") >= 0;
}

function isOurPluginEntry(entry) {
  return entry && typeof entry.file === "string" &&
    entry.file.indexOf("ahm-diagrammo.plugin.js") >= 0;
}

function isOurLibEntry(entry) {
  return entry && typeof entry.file === "string" &&
    entry.file.indexOf("ahm-diagrammo.xml") >= 0;
}

function waitForActiveTab(uri, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var timer;
    var subscription;

    function readTargetTab() {
      var tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (tab && tab.input instanceof vscode.TabInputCustom &&
          tab.input.uri.toString() === uri.toString()) {
        clearTimeout(timer);
        if (subscription) subscription.dispose();
        resolve(tab);
        return true;
      }
      return false;
    }

    subscription = vscode.window.tabGroups.onDidChangeTabs(readTargetTab);
    timer = setTimeout(function () {
      subscription.dispose();
      reject(new Error("Draw.io editor did not open " + uri.fsPath));
    }, timeoutMs);
    readTargetTab();
  });
}

suite("AHM Diagrammo extension-host", function () {
  this.timeout(30000);
  var v03Seed;
  var createdModelPath;
  var v03FixtureDir;

  test("V-02: extension is present and activates", async function () {
    var ext = vscode.extensions.getExtension("abossard.ahm-diagrammo");
    assert.ok(ext, "extension should be found");
    if (!ext.isActive) await ext.activate();
    assert.ok(ext.isActive, "extension should be active");
  });

  test("V-02: commands are registered", async function () {
    var commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("ahmDiagrammo.enable"), "enable command registered");
    assert.ok(commands.includes("ahmDiagrammo.disable"), "disable command registered");
    assert.ok(commands.includes("ahmDiagrammo.newModel"), "newModel command registered");
    assert.ok(commands.includes("ahmDiagrammo.showFingerprint"), "showFingerprint command registered");
  });

  test("V-03: enable appends plugin+library, preserves existing entries", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");

    // Clean slate
    await config.update("plugins", undefined, vscode.ConfigurationTarget.Global);
    await config.update("customLibraries", undefined, vscode.ConfigurationTarget.Global);
    await config.update("theme", "min", vscode.ConfigurationTarget.Global);

    // Seed valid foreign entries so Draw.io can load them without test-profile noise.
    v03FixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "ahm-foreign-settings-"));
    var foreignPluginPath = path.join(v03FixtureDir, "plugin.js");
    var foreignLibraryPath = path.join(v03FixtureDir, "library.xml");
    fs.writeFileSync(foreignPluginPath, "Draw.loadPlugin(function () {});\n");
    fs.writeFileSync(foreignLibraryPath, "<mxlibrary>[]</mxlibrary>\n");
    var foreignPlugin = [{ file: foreignPluginPath }];
    var foreignLib = [{ entryId: "otherLib", libName: "Other", file: foreignLibraryPath }];
    await config.update("plugins", foreignPlugin, vscode.ConfigurationTarget.Global);
    await config.update("customLibraries", foreignLib, vscode.ConfigurationTarget.Global);
    v03Seed = {
      plugins: JSON.parse(JSON.stringify(config.inspect("plugins").globalValue)),
      customLibraries: JSON.parse(JSON.stringify(config.inspect("customLibraries").globalValue)),
      theme: config.inspect("theme").globalValue
    };

    // Enable with explicit target (bypasses QuickPick)
    await vscode.commands.executeCommand("ahmDiagrammo.enable", {
      target: vscode.ConfigurationTarget.Global
    });

    // Inspect after enable
    var postPlugins = config.inspect("plugins").globalValue;
    var postLibs = config.inspect("customLibraries").globalValue;

    var ourPlugins = postPlugins.filter(isOurPluginEntry);
    assert.strictEqual(ourPlugins.length, 1, "exactly one AHM plugin entry");

    var ourLibs = postLibs.filter(isOurLibEntry);
    assert.strictEqual(ourLibs.length, 1, "exactly one AHM library entry");
    assert.deepStrictEqual(postPlugins, foreignPlugin.concat(ourPlugins),
      "plugin setting is seed plus exactly one AHM entry");
    assert.deepStrictEqual(postLibs, foreignLib.concat(ourLibs),
      "library setting is seed plus exactly one AHM entry");
    assert.strictEqual(config.inspect("theme").globalValue, v03Seed.theme,
      "theme setting remains byte-identical");

    // Plugin file path exists on disk
    assert.ok(fs.existsSync(ourPlugins[0].file), "plugin asset file exists at " + ourPlugins[0].file);
  });

  test("V-03: double-enable adds exactly one entry", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");

    // Enable again
    await vscode.commands.executeCommand("ahmDiagrammo.enable", {
      target: vscode.ConfigurationTarget.Global
    });

    var plugins = config.inspect("plugins").globalValue;
    var ours = plugins.filter(isOurPluginEntry);
    assert.strictEqual(ours.length, 1, "still exactly one AHM plugin after double-enable");
  });

  test("V-03: enable removes stale version path", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");

    // Inject a stale version entry
    var current = config.inspect("plugins").globalValue || [];
    current.push({ file: "/old/path/abossard.ahm-diagrammo-0.0.1/assets/plugin/ahm-diagrammo.plugin.js" });
    await config.update("plugins", current, vscode.ConfigurationTarget.Global);

    // Re-enable: should remove stale and add current
    await vscode.commands.executeCommand("ahmDiagrammo.enable", {
      target: vscode.ConfigurationTarget.Global
    });

    var after = config.inspect("plugins").globalValue;
    var stale = after.filter(function (e) {
      return e.file && e.file.indexOf("0.0.1") >= 0;
    });
    assert.strictEqual(stale.length, 0, "stale version entry removed");

    var ours = after.filter(isOurPluginEntry);
    assert.strictEqual(ours.length, 1, "current version present");
  });

  test("V-03: disable restores pre-enable state exactly", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");

    // Disable
    await vscode.commands.executeCommand("ahmDiagrammo.disable", {
      target: vscode.ConfigurationTarget.Global
    });

    assert.deepStrictEqual(config.inspect("plugins").globalValue, v03Seed.plugins,
      "plugins restored exactly to pre-enable state");
    assert.deepStrictEqual(config.inspect("customLibraries").globalValue, v03Seed.customLibraries,
      "libraries restored exactly to pre-enable state");
    assert.strictEqual(config.inspect("theme").globalValue, v03Seed.theme,
      "theme restored exactly to pre-enable state");
  });

  test("V-04: newModel creates blank file and opens Draw.io editor", async function () {
    // Create a task-local scratch directory under the workspace
    var ext = vscode.extensions.getExtension("abossard.ahm-diagrammo");
    var extPath = ext.extensionUri.fsPath;
    var scratchDir = path.join(extPath, ".vscode-test", "scratch-" + Date.now());
    fs.mkdirSync(scratchDir, { recursive: true });
    var targetUri = vscode.Uri.file(path.join(scratchDir, "test-model.drawio.svg"));
    createdModelPath = targetUri.fsPath;

    // Invoke newModel with explicit URI (bypasses SaveDialog)
    await vscode.commands.executeCommand("ahmDiagrammo.newModel", { uri: targetUri });

    // File must exist
    assert.ok(fs.existsSync(targetUri.fsPath), "file created at " + targetUri.fsPath);

    // File must contain no ahmRole/ahmId attributes
    var content = fs.readFileSync(targetUri.fsPath, "utf8");
    assert.ok(!content.includes("ahmRole"), "no ahmRole in blank model");
    assert.ok(!content.includes("ahmId"), "no ahmId in blank model");

    // The file should be valid SVG
    assert.ok(content.includes("<svg"), "file contains SVG root");

    // Wait for the custom editor tab, not for the webview's long-running open command.
    var tab = await waitForActiveTab(targetUri, 15000);
    assert.ok(tab, "new model has an active editor tab");
    assert.ok(tab.input instanceof vscode.TabInputCustom, "active tab is a TabInputCustom");
    assert.strictEqual(tab.input.viewType, "hediet.vscode-drawio-text",
      "editor viewType is Draw.io");
    assert.strictEqual(tab.input.uri.toString(), targetUri.toString(),
      "Draw.io editor opened the created model");
  });

  test("V-09: disable when never enabled is a no-op", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");

    // Clean slate
    await config.update("plugins", undefined, vscode.ConfigurationTarget.Global);
    await config.update("customLibraries", undefined, vscode.ConfigurationTarget.Global);

    // Snapshot
    var prePlug = config.inspect("plugins").globalValue;
    var preLib = config.inspect("customLibraries").globalValue;

    // Disable when never enabled: must be silent no-op
    await vscode.commands.executeCommand("ahmDiagrammo.disable", {
      target: vscode.ConfigurationTarget.Global
    });

    var postPlug = config.inspect("plugins").globalValue;
    var postLib = config.inspect("customLibraries").globalValue;

    assert.deepStrictEqual(postPlug, prePlug, "plugins unchanged after disable-when-never-enabled");
    assert.deepStrictEqual(postLib, preLib, "libs unchanged after disable-when-never-enabled");
  });

  test("V-09: disable removes all AHM paths from config", async function () {
    // Enable first
    await vscode.commands.executeCommand("ahmDiagrammo.enable", {
      target: vscode.ConfigurationTarget.Global
    });

    // Verify our entries are present
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");
    var prePlug = config.inspect("plugins").globalValue || [];
    assert.ok(prePlug.filter(isOurPluginEntry).length > 0, "AHM entry present before disable");

    // Then disable
    await vscode.commands.executeCommand("ahmDiagrammo.disable", {
      target: vscode.ConfigurationTarget.Global
    });

    var postPlug = config.inspect("plugins").globalValue || [];
    var postLib = config.inspect("customLibraries").globalValue || [];

    // No AHM entries remain
    assert.strictEqual(postPlug.filter(isOurPluginEntry).length, 0,
      "no AHM plugin path in settings after disable");
    assert.strictEqual(postLib.filter(isOurLibEntry).length, 0,
      "no AHM library path in settings after disable");
    var associations = vscode.workspace.getConfiguration("workbench")
      .inspect("editorAssociations").globalValue;
    var settingsBytes = JSON.stringify({
      plugins: postPlug,
      customLibraries: postLib,
      editorAssociations: associations
    });
    assert.ok(!/abossard\.ahm-diagrammo/.test(settingsBytes),
      "no AHM install path remains in Draw.io or editor-association settings");
    var diagramBytes = fs.readFileSync(createdModelPath, "utf8");
    assert.ok(!/(?:\/Users\/|[A-Z]:\\)/.test(diagramBytes),
      "diagram bytes contain no absolute machine path");
  });

  // ── C-23.6: narrow public-boundary tests ──

  // vscode.openWith can reject with a value that is not an Error; the handler must not
  // assume `.message`. No public command seam can force that rejection deterministically,
  // so the production formatter itself is driven directly.
  [
    { name: "Error", value: new Error("boom"), expected: "boom" },
    { name: "string", value: "plain string rejection", expected: "plain string rejection" },
    { name: "object without message", value: { code: 7 }, expected: "[object Object]" },
    { name: "undefined", value: undefined, expected: "undefined" },
    { name: "Error with empty message", value: new Error(""), expected: "Error" }
  ].forEach(function (testCase) {
    test("C-23.6: open rejection is described for " + testCase.name, function () {
      var extModule = require(path.join(
        vscode.extensions.getExtension("abossard.ahm-diagrammo").extensionUri.fsPath,
        "src", "extension.js"));
      var described = extModule.describeOpenFailure(testCase.value);
      assert.strictEqual(typeof described, "string");
      assert.strictEqual(described, testCase.expected);
    });
  });

  test("C-23.6: newModel rejects when the target cannot be written", async function () {
    var extPath = vscode.extensions.getExtension("abossard.ahm-diagrammo").extensionUri.fsPath;
    // package.json is a file, so writing "under" it cannot succeed.
    var badUri = vscode.Uri.file(path.join(extPath, "package.json", "nested.drawio.svg"));
    var rejected = null;
    try {
      await vscode.commands.executeCommand("ahmDiagrammo.newModel", { uri: badUri });
    } catch (err) {
      rejected = err;
    }
    assert.ok(rejected, "newModel resolved for an unwritable target");
    assert.ok(!fs.existsSync(badUri.fsPath), "no partial file left behind");
  });

  // Malformed stored settings must abort enable before any write.
  [
    { name: "string", value: "not-an-array" },
    { name: "object", value: { file: "x" } },
    { name: "number", value: 42 }
  ].forEach(function (testCase) {
    test("C-23.6: malformed plugins (" + testCase.name + ") is preserved byte-for-byte", async function () {
      var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");
      await config.update("plugins", testCase.value, vscode.ConfigurationTarget.Global);
      var before = JSON.stringify(config.inspect("plugins").globalValue);

      var failed = null;
      try {
        await vscode.commands.executeCommand("ahmDiagrammo.enable", {
          target: vscode.ConfigurationTarget.Global
        });
      } catch (err) {
        failed = err;
      }
      assert.ok(failed, "enable succeeded against a malformed setting");

      var after = vscode.workspace.getConfiguration("hediet.vscode-drawio")
        .inspect("plugins").globalValue;
      assert.strictEqual(JSON.stringify(after), before,
        "stored plugins value changed: " + before + " -> " + JSON.stringify(after));
      await config.update("plugins", undefined, vscode.ConfigurationTarget.Global);
    });
  });

  test("C-23.6: disable-when-never-enabled performs no observable write", async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");
    await config.update("plugins", undefined, vscode.ConfigurationTarget.Global);
    await config.update("customLibraries", undefined, vscode.ConfigurationTarget.Global);

    var udIndex = process.argv.indexOf("--user-data-dir");
    var userDataDir = udIndex >= 0 ? process.argv[udIndex + 1] : null;
    var settingsFile = userDataDir ? path.join(userDataDir, "User", "settings.json") : null;
    var hasFile = !!settingsFile && fs.existsSync(settingsFile);
    var before = hasFile ? fs.readFileSync(settingsFile) : null;

    await vscode.commands.executeCommand("ahmDiagrammo.disable", {
      target: vscode.ConfigurationTarget.Global
    });
    await new Promise(function (r) { setTimeout(r, 500); });

    var post = vscode.workspace.getConfiguration("hediet.vscode-drawio");
    assert.strictEqual(post.inspect("plugins").globalValue, undefined);
    assert.strictEqual(post.inspect("customLibraries").globalValue, undefined);
    if (hasFile) {
      assert.ok(before.equals(fs.readFileSync(settingsFile)),
        "settings.json bytes changed on a no-op disable");
    }
  });

  // Cleanup
  suiteTeardown(async function () {
    var config = vscode.workspace.getConfiguration("hediet.vscode-drawio");
    await config.update("plugins", undefined, vscode.ConfigurationTarget.Global);
    await config.update("customLibraries", undefined, vscode.ConfigurationTarget.Global);
    await config.update("theme", undefined, vscode.ConfigurationTarget.Global);
    if (createdModelPath) {
      try { fs.unlinkSync(createdModelPath); } catch (e) { /* ok */ }
      try { fs.rmdirSync(path.dirname(createdModelPath)); } catch (e) { /* ok */ }
    }
    if (v03FixtureDir) {
      try { fs.unlinkSync(path.join(v03FixtureDir, "plugin.js")); } catch (e) { /* ok */ }
      try { fs.unlinkSync(path.join(v03FixtureDir, "library.xml")); } catch (e) { /* ok */ }
      try { fs.rmdirSync(v03FixtureDir); } catch (e) { /* ok */ }
    }
  });
});
