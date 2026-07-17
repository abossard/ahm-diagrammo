#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const command = argv.slice(2, argv.indexOf("--resource-group")).join(" ");
const fixture = JSON.parse(readFileSync(process.env.FAKE_AZ_FIXTURE, "utf8"));

if (process.env.FAKE_AZ_LOG) {
  appendFileSync(process.env.FAKE_AZ_LOG, `${JSON.stringify(argv)}\n`);
}

if (process.env.FAKE_AZ_DIAGNOSTIC_COMMAND === command) {
  console.error(process.env.FAKE_AZ_DIAGNOSTIC || "ERROR: extension emitted partial output");
}
if (process.env.FAKE_AZ_FAIL_COMMAND === command) {
  console.error(process.env.FAKE_AZ_ERROR || "ERROR: Please run 'az login' to setup account.");
  process.exit(1);
}
if (process.env.FAKE_AZ_MALFORMED_COMMAND === command) {
  process.stdout.write("{not-json");
  process.exit(0);
}
if (process.env.FAKE_AZ_UNEXPECTED_COMMAND === command) {
  process.stdout.write(JSON.stringify({ value: [] }));
  process.exit(0);
}
if (process.env.FAKE_AZ_UNEXPECTED_ITEM_COMMAND === command) {
  process.stdout.write("[null]");
  process.exit(0);
}

const outputs = {
  show: fixture.model,
  "entity list": fixture.entities,
  "relationship list": fixture.relationships,
  "signal-definition list": fixture.signalDefinitions,
  "authentication-setting list": fixture.authenticationSettings,
  "discovery-rule list": fixture.discoveryRules
};

if (!(command in outputs)) {
  console.error(`ERROR: unsupported fake command: ${command}`);
  process.exit(2);
}
process.stdout.write(JSON.stringify(outputs[command]));
