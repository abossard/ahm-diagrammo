#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { generateHealthModelDocs } from "../src/health-model-docs.mjs";
import { getTheme, THEME_NAMES } from "../src/themes.mjs";

const pexecFile = promisify(execFile);

const HELP = `ahm-health-docs — document an existing Azure Monitor Health Model

Usage:
  ahm-health-docs --resource-group <name> --model <name> [options]

Options:
  -g, --resource-group <name>  Azure resource group
  -m, --model <name>           Azure Monitor Health Model name
  -s, --subscription <id>      Azure subscription name or ID
  -o, --out <dir>              output directory (default: ./health-model-docs)
  -t, --theme <name>           ${THEME_NAMES.join(" | ")} (default: portal)
  -h, --help                   show this help

Uses the exact plural namespace "az monitor health-models" and emits
<model-slug>.json, <model-slug>.md, and <model-slug>.svg.

The JSON and Markdown can contain Azure resource IDs, tags, identity details,
and operational status. Review all generated files before publishing them.
`;

function parseArgs(argv) {
  const args = { out: "health-model-docs", theme: "portal" };
  const options = new Map([
    ["-g", "resourceGroup"], ["--resource-group", "resourceGroup"],
    ["-m", "model"], ["--model", "model"],
    ["-s", "subscription"], ["--subscription", "subscription"],
    ["-o", "out"], ["--out", "out"],
    ["-t", "theme"], ["--theme", "theme"]
  ]);
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "-h" || value === "--help") {
      args.help = true;
      continue;
    }
    const key = options.get(value);
    if (!key) throw new Error(`unknown option ${value}`);
    if (argv[index + 1] == null) throw new Error(`option ${value} requires a value`);
    args[key] = argv[++index];
  }
  return args;
}

const COMMANDS = [
  ["model", ["show"]],
  ["entities", ["entity", "list"]],
  ["relationships", ["relationship", "list"]],
  ["signalDefinitions", ["signal-definition", "list"]],
  ["authenticationSettings", ["authentication-setting", "list"]],
  ["discoveryRules", ["discovery-rule", "list"]]
];

async function readAzure(args) {
  const az = process.env.AZURE_CLI_PATH || "az";
  const snapshot = {};
  const diagnostics = [];
  for (const [key, command] of COMMANDS) {
    const argv = [
      "monitor", "health-models", ...command,
      "--resource-group", args.resourceGroup,
      "--health-model-name", args.model,
      "--output", "json",
      "--only-show-errors"
    ];
    if (args.subscription) argv.push("--subscription", args.subscription);
    const commandName = `az monitor health-models ${command.join(" ")}`;
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await pexecFile(az, argv, { maxBuffer: 50 * 1024 * 1024 }));
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`${commandName} failed: Azure CLI executable "${az}" was not found`);
      }
      const detail = error.stderr?.trim() || error.message;
      throw new Error(`${commandName} failed: ${detail}`);
    }
    const diagnostic = stderr.trim();
    if (diagnostic) diagnostics.push(`${commandName}: ${diagnostic}`);
    try {
      snapshot[key] = JSON.parse(stdout);
    } catch (error) {
      const suffix = diagnostic ? `; Azure CLI stderr: ${diagnostic}` : "";
      throw new Error(`${commandName} returned invalid JSON: ${error.message}${suffix}`);
    }
  }
  return { snapshot, diagnostics };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(HELP);
      return;
    }
    if (!args.resourceGroup || !args.model) {
      throw new Error("--resource-group and --model are required");
    }
    getTheme(args.theme);
    const { snapshot, diagnostics } = await readAzure(args);
    let artifacts;
    try {
      artifacts = generateHealthModelDocs(snapshot, { theme: args.theme });
    } catch (error) {
      const suffix = diagnostics.length ? `; Azure CLI stderr: ${diagnostics.join("; ")}` : "";
      throw new Error(`${error.message}${suffix}`);
    }
    const out = resolve(args.out);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${artifacts.slug}.json`), artifacts.json, "utf8");
    writeFileSync(join(out, `${artifacts.slug}.md`), artifacts.markdown, "utf8");
    writeFileSync(join(out, `${artifacts.slug}.svg`), artifacts.svg, "utf8");
    console.log(`Documented ${args.model} in ${out}`);
  } catch (error) {
    const detail = error.stderr?.trim();
    console.error(`error: ${detail || error.message}`);
    process.exitCode = 1;
  }
}

await main();
