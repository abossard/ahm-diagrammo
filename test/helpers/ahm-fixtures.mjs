import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_DIR = join(dirname(dirname(fileURLToPath(import.meta.url))), "fixtures", "ahm");

export const AHM_DIRECTIONS = ["TB", "TD", "BT", "LR", "RL"];

export const POSITIVE_FIXTURES = [
  "hero-main.mmd",
  "kitchen-sink-main.mmd",
  "pills-stress-main.mmd",
  "long-labels.mmd",
  "text-extremes.mmd",
  "dense-multi-parent.mmd",
  "weird-single-node.mmd",
  "weird-cycle-self-loop.mmd",
];

export const NEGATIVE_FIXTURES = [
  "weird-orphan-signal-to-signal.mmd",
];

export function readAhmFixture(name) {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

