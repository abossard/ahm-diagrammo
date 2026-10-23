import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as fontkit from "fontkit";

// Bundled fonts only: native rasterization never reads the host's system fonts.
const DEFAULT_FONT_SET = {
  family: "Unifont",
  files: [
    "./test/assets/fonts/unifont-18.0.01.otf",
    "./test/assets/fonts/unifont_upper-18.0.01.otf",
  ],
  hashes: [
    "88d0a14d4aa9a96419720b39ba5da921a59560d76d4ec7d523acc06ed85cd3c2",
    "472201e45a050bff4c7658208b8c73e34ebce3764b287a5a46c7774038ef9391",
  ],
};

function splitList(value) {
  return String(value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function resolveNativeFontConfig(env = process.env) {
  const envFiles = splitList(env.AHM_TEST_FONT_FILES);
  const envHashes = splitList(env.AHM_TEST_FONT_SHA256);
  const envFamily = env.AHM_TEST_FONT_FAMILY?.trim();
  const useEnv = envFiles.length > 0 || envHashes.length > 0 || Boolean(envFamily);

  const files = useEnv ? envFiles : DEFAULT_FONT_SET.files;
  const hashes = useEnv ? envHashes : DEFAULT_FONT_SET.hashes;
  const family = useEnv ? (envFamily || "AHM Test Font") : DEFAULT_FONT_SET.family;

  assert.ok(files.length > 0, "native font config requires AHM_TEST_FONT_FILES or the bundled Unifont fonts");
  assert.equal(
    hashes.length,
    files.length,
    "native font config requires one SHA256 per file via AHM_TEST_FONT_SHA256"
  );

  const resolved = files.map((file, index) => {
    assert.equal(existsSync(file), true, `missing required native font at ${file}`);
    const actualHash = sha256File(file);
    assert.equal(
      actualHash,
      hashes[index],
      `font hash mismatch at ${file}; set AHM_TEST_FONT_FILES/AHM_TEST_FONT_SHA256 to explicit pinned files for this host`
    );
    return {
      path: file,
      sha256: actualHash,
    };
  });

  return {
    family,
    files: resolved.map((font) => font.path),
    manifest: resolved,
    source: useEnv ? "environment" : "bundled-unifont",
  };
}

export function assertCodepointsCovered(fontConfig, codepoints) {
  const fonts = fontConfig.files.map((path) => ({ path, font: fontkit.openSync(path) }));
  const uncovered = [];
  const coverage = [];

  for (const codepoint of codepoints) {
    const hit = fonts.find(({ font }) => {
      const glyph = font.glyphForCodePoint(codepoint);
      return glyph && glyph.id !== 0;
    });
    if (!hit) {
      uncovered.push(codepoint);
      coverage.push({ codepoint, covered: false, fontPath: null, glyphId: 0 });
      continue;
    }
    const glyph = hit.font.glyphForCodePoint(codepoint);
    coverage.push({ codepoint, covered: true, fontPath: hit.path, glyphId: glyph.id });
  }

  assert.equal(
    uncovered.length,
    0,
    `missing non-.notdef glyph coverage for codepoints: ${uncovered.map((cp) => `U+${cp.toString(16).toUpperCase()}`).join(", ")}`
  );

  return coverage;
}
