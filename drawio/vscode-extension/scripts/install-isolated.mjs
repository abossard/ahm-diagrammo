#!/usr/bin/env node
// V-02 proof: install the built VSIX into a fresh, isolated extensions/user-data pair and
// verify the extension host resolves it from that isolated directory (not the dev tree).
//
// Profiles:
//   positive        dependency installed, real VSIX  -> extension activates from isolated dir
//   missing-dep     dependency NOT installed, gallery disabled -> activation fails
//   corrupt-vsix    truncated VSIX                   -> install fails, extension not listed
//
// Usage: node scripts/install-isolated.mjs [--profile positive|missing-dep|corrupt-vsix|all]
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath, runTests } from "@vscode/test-electron";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(__dirname, "..");
const probePath = resolve(extRoot, "test/installed-probe");

// Short base path: VS Code's IPC socket lives under the user-data dir and dies past ~103 chars.
const base = join(homedir(), ".ahm-test", "iso");

const profileArgIndex = process.argv.indexOf("--profile");
const profile = profileArgIndex >= 0 ? process.argv[profileArgIndex + 1] : "all";

function builtVsix() {
  const found = readdirSync(extRoot).filter((f) => f.endsWith(".vsix"));
  if (found.length !== 1) throw new Error("expected exactly one built VSIX, found " + JSON.stringify(found));
  return resolve(extRoot, found[0]);
}

const vscodeExe = await downloadAndUnzipVSCode();
// The resolver injects its own test extensions/user-data dirs; drop them so each profile
// controls exactly one isolated pair.
const resolved = resolveCliArgsFromVSCodeExecutablePath(vscodeExe);
const cli = resolved[0];
const cliBaseArgs = [];
for (let i = 1; i < resolved.length; i++) {
  if (resolved[i] === "--extensions-dir" || resolved[i] === "--user-data-dir") { i++; continue; }
  cliBaseArgs.push(resolved[i]);
}

function cliRun(dirs, args) {
  return spawnSync(cli, [
    ...cliBaseArgs,
    "--extensions-dir", dirs.extensions,
    "--user-data-dir", dirs.userData,
    ...args,
  ], { encoding: "utf8" });
}

function freshDirs(name) {
  const dirs = { extensions: join(base, name, "ext"), userData: join(base, name, "ud") };
  rmSync(join(base, name), { recursive: true, force: true });
  mkdirSync(dirs.extensions, { recursive: true });
  mkdirSync(dirs.userData, { recursive: true });
  return dirs;
}

function fail(message) {
  console.error("FAIL: " + message);
  process.exitCode = 1;
}

function findExtHostLogs(dir) {
  if (!existsSync(dir)) return [];
  const found = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (name === "exthost.log") found.push(full);
    else if (statSync(full).isDirectory()) found.push(...findExtHostLogs(full));
  }
  return found;
}

async function runProbe(dirs, resultFile) {
  rmSync(resultFile, { force: true });
  let exitCode = 0;
  try {
    await runTests({
      vscodeExecutablePath: vscodeExe,
      extensionDevelopmentPath: probePath,
      extensionTestsPath: resolve(probePath, "probe.js"),
      extensionTestsEnv: { AHM_PROBE_RESULT: resultFile },
      launchArgs: ["--extensions-dir", dirs.extensions, "--user-data-dir", dirs.userData],
    });
  } catch (err) {
    exitCode = 1;
    console.log("  probe exited non-zero: " + err.message);
  }
  const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
  return { exitCode, result };
}

async function positive() {
  console.log("\n=== profile: positive ===");
  const dirs = freshDirs("positive");
  const vsix = builtVsix();

  const dep = cliRun(dirs, ["--install-extension", "hediet.vscode-drawio", "--force"]);
  if (dep.status !== 0) throw new Error("dependency install failed: " + dep.stdout + dep.stderr);
  const own = cliRun(dirs, ["--install-extension", vsix, "--force"]);
  if (own.status !== 0) throw new Error("VSIX install failed: " + own.stdout + own.stderr);
  console.log(own.stdout.trim());

  const listed = cliRun(dirs, ["--list-extensions", "--show-versions"]).stdout.trim().split("\n");
  console.log("  installed: " + JSON.stringify(listed));
  if (!listed.some((l) => l.startsWith("abossard.ahm-diagrammo@"))) fail("own extension not listed");
  if (!listed.some((l) => l.startsWith("hediet.vscode-drawio@"))) fail("dependency not listed");

  const { exitCode, result } = await runProbe(dirs, join(base, "positive-result.json"));
  console.log("  probe: " + JSON.stringify(result));
  if (exitCode !== 0) fail("positive probe exited non-zero");
  if (!result) return fail("positive probe wrote no result");
  if (!result.active) fail("extension did not activate");
  if (!result.extensionPath.startsWith(dirs.extensions)) {
    fail("resolved from " + result.extensionPath + ", expected under " + dirs.extensions);
  }
  if (result.extensionPath.indexOf(extRoot + "/src") >= 0) fail("resolved to the dev tree");
  if (!result.dependencyActive) fail("dependency not active");
  if (!result.assetsPresent) fail("packaged assets missing from the installed copy");

  const logs = findExtHostLogs(join(dirs.userData, "logs"));
  if (!logs.length) fail("no exthost.log produced");
  logs.forEach((logFile) => {
    const offending = readFileSync(logFile, "utf8").split("\n")
      .filter((line) => /Cannot activate|Activating extension .* failed|\[error\]/.test(line));
    console.log("  " + logFile.slice(dirs.userData.length) + ": " + offending.length + " offending lines");
    if (offending.length) fail("exthost.log: " + offending.slice(0, 3).join(" | "));
  });
  console.log("  PASS: activated from " + result.extensionPath);
}

async function missingDep() {
  console.log("\n=== profile: missing-dep ===");
  const dirs = freshDirs("missing-dep");
  const vsix = builtVsix();

  // `--install-extension <vsix>` auto-resolves extensionDependencies from the gallery, and the
  // CLI refuses to uninstall a dependency while its dependent is installed ("Cannot uninstall
  // 'Draw.io Integration' extension. 'AHM Diagrammo' extension depends on this."). The
  // dependency is therefore removed directly from the isolated profile: its directory is
  // deleted and its entry dropped from extensions.json.
  const own = cliRun(dirs, ["--install-extension", vsix, "--force"]);
  console.log("  install status=" + own.status + " " + own.stdout.trim());

  readdirSync(dirs.extensions)
    .filter((name) => name.startsWith("hediet.vscode-drawio"))
    .forEach((name) => {
      rmSync(join(dirs.extensions, name), { recursive: true, force: true });
      console.log("  removed dependency directory " + name);
    });
  const registry = join(dirs.extensions, "extensions.json");
  const entries = JSON.parse(readFileSync(registry, "utf8"));
  const kept = entries.filter((e) => !(e.identifier && e.identifier.id === "hediet.vscode-drawio"));
  writeFileSync(registry, JSON.stringify(kept) + "\n");
  console.log("  registry entries " + entries.length + " -> " + kept.length);

  const listed = cliRun(dirs, ["--list-extensions"]).stdout.trim().split("\n").filter(Boolean);
  console.log("  installed: " + JSON.stringify(listed));
  if (listed.some((l) => l.startsWith("hediet.vscode-drawio"))) {
    fail("dependency was auto-resolved; profile is not dependency-free");
  }

  const { result } = await runProbe(dirs, join(base, "missing-dep-result.json"));
  console.log("  probe: " + JSON.stringify(result));
  if (!result) return fail("missing-dep probe wrote no result");
  if (result.dependencyPresent) fail("dependency unexpectedly present");
  if (result.active) fail("extension activated despite the missing dependency");
  console.log("  PASS: dependency absent and extension did not activate");
}

async function corruptVsix() {
  console.log("\n=== profile: corrupt-vsix ===");
  const dirs = freshDirs("corrupt");
  const truncated = join(base, "corrupt", "truncated.vsix");
  const bytes = readFileSync(builtVsix());
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  console.log("  truncated " + bytes.length + " -> " + Math.floor(bytes.length / 2) + " bytes");

  const run = cliRun(dirs, ["--install-extension", truncated, "--force"]);
  console.log("  status=" + run.status);
  console.log("  " + (run.stderr || run.stdout).trim().split("\n").slice(0, 3).join(" | "));
  if (run.status === 0) fail("truncated VSIX installed successfully");
  const listed = cliRun(dirs, ["--list-extensions"]).stdout.trim();
  if (listed.indexOf("abossard.ahm-diagrammo") >= 0) fail("corrupt extension is listed as installed");
  console.log("  PASS: install rejected, not listed");
}

const profiles = { positive, "missing-dep": missingDep, "corrupt-vsix": corruptVsix };
const selected = profile === "all" ? Object.keys(profiles) : [profile];
for (const name of selected) {
  if (!profiles[name]) throw new Error("unknown profile: " + name);
  await profiles[name]();
}
console.log(process.exitCode ? "\ninstall-isolated: FAILED" : "\ninstall-isolated: all profiles passed");
