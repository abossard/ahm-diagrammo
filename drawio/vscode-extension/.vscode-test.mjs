// @vscode/test-cli configuration
import { defineConfig } from "@vscode/test-cli";
import { join } from "node:path";
import { homedir } from "node:os";

// Use a short path to avoid Unix socket EINVAL (max ~103 chars)
const shortBase = join(homedir(), ".ahm-test");

export default defineConfig({
  files: "test/integration/suite/**/*.test.js",
  mocha: { timeout: 30000 },
  installExtensions: ["hediet.vscode-drawio"],
  launchArgs: [
    "--user-data-dir", join(shortBase, "ud"),
  ],
});
