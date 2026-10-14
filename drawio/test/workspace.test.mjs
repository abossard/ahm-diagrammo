import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("workspace exposes only relative full-editor customization", () => {
  const workspace = JSON.parse(readFileSync(resolve(root, "ahm-diagrammo.code-workspace"), "utf8"));
  assert.deepEqual(workspace.folders, [{ path: "." }]);
  assert.deepEqual(workspace.extensions.recommendations, ["hediet.vscode-drawio"]);
  assert.deepEqual(workspace.settings["hediet.vscode-drawio.plugins"], [
    { file: "${workspaceFolder}/plugin/ahm-health.js" },
  ]);
  assert.deepEqual(workspace.settings["hediet.vscode-drawio.customLibraries"], [
    {
      entryId: "general",
      libName: "AHM Diagrammo",
      file: "${workspaceFolder}/library/ahm-diagrammo.xml",
    },
  ]);
  assert.equal(workspace.settings["hediet.vscode-drawio.simpleLabels"], true);
  assert.equal(workspace.settings["workbench.editorAssociations"]["*.drawio.svg"], "hediet.vscode-drawio-text");
  assert.equal(workspace.settings["hediet.vscode-drawio.colorNames"].F2F8F2, "Healthy");
  assert.deepEqual(
    workspace.settings["hediet.vscode-drawio.customColorSchemes"][0].map((scheme) => scheme.title),
    ["Healthy", "Degraded", "Unhealthy", "Unknown", "Metric"],
  );
  assert.doesNotMatch(JSON.stringify(workspace), /\/Users\/|[A-Z]:\\/);
});

test("README documents first-load trust and full editor", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8").replace(/\s+/g, " ");
  for (const phrase of [
    "ahm-diagrammo.code-workspace",
    "full **Draw.io** editor",
    "fingerprinted plugin",
    "AHM Diagrammo",
    "AHM Health Model",
    "prompt again",
  ]) assert.match(readme, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
});

// Extracts the raw (unflattened) body of a level-2 "## <heading>" markdown section, bounded to
// the next "## " heading or end of file, so disclosure assertions cannot be vacuously satisfied
// by unrelated prose elsewhere in the document (e.g. the setup steps also mention
// "legend"/"shape data"). Callers that only need whitespace-collapsed text should pass the
// result through `flatten()`.
function extractRawSection(markdown, heading) {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headingLine = markdown.match(new RegExp(`^## ${escapedHeading}[ \\t]*$`, "m"));
  assert.ok(headingLine, `README is missing a "## ${heading}" section`);
  const bodyStart = headingLine.index + headingLine[0].length;
  const nextHeadingIndex = markdown.indexOf("\n## ", bodyStart);
  const body = nextHeadingIndex === -1 ? markdown.slice(bodyStart) : markdown.slice(bodyStart, nextHeadingIndex);
  return body.trim();
}

function flatten(markdown) {
  return markdown.replace(/\s+/g, " ").trim();
}

// Splits a raw markdown section into its top-level "- " list items, joining each item's wrapped
// continuation lines. This lets a disclosure assertion be scoped to one specific bullet instead
// of the whole section, so a phrase that only coincidentally appears in an unrelated bullet
// cannot vacuously satisfy the assertion (see C-05 / F15).
function extractBullets(rawSection) {
  const bullets = [];
  let current = null;
  for (const line of rawSection.split("\n")) {
    if (/^- /.test(line)) {
      if (current !== null) bullets.push(current);
      current = line;
    } else if (current !== null) {
      current += " " + line;
    }
  }
  if (current !== null) bullets.push(current);
  return bullets.map(flatten);
}

test("README Known limitations section discloses every required editable-canvas gap", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const rawSection = extractRawSection(readme, "Known limitations");
  const section = flatten(rawSection);

  // C-06: the shipped body is Draw.io's own export and the extension rewrites the whole file on
  // save. Scoped to the bullet that makes that claim so an unrelated mention cannot satisfy it.
  const bodyBullet = extractBullets(rawSection).find((bullet) => /\.drawio\.svg/i.test(bullet));
  assert.ok(bodyBullet, 'README Known limitations is missing a ".drawio.svg" bullet');
  assert.match(bodyBullet, /export/i);
  assert.match(bodyBullet, /save/i);
  assert.match(bodyBullet, /replace|rewrite/i);
  assert.match(bodyBullet, /shape data/i);
  assert.match(bodyBullet, /provisional|next save/i);
  assert.match(bodyBullet, /lane label/i);
  assert.match(bodyBullet, /legend/i);
  assert.match(bodyBullet, /\bdot\b/i);
  assert.match(bodyBullet, /\bbar\b/i);
  assert.match(bodyBullet, /connector/i);
  assert.match(bodyBullet, /color/i);

  // Compression: a VS Code save can deflate the embedded model, and the reopen boundary handles it.
  assert.match(section, /compress|deflate/i);
  assert.match(section, /content="/i);

  // Recalculation: authored Unknown/Standby is preserved, but the rollup is still live.
  const recalcBullet = extractBullets(rawSection).find((bullet) => /recalculat/i.test(bullet));
  assert.ok(recalcBullet, "README Known limitations is missing a recalculation bullet");
  assert.match(recalcBullet, /standby/i);
  assert.match(recalcBullet, /unknown/i);
  assert.match(recalcBullet, /authored/i);

  // Visual tooling stays optional and `npm test` inherits the prerequisite.
  assert.match(section, /puppeteer/i);
  assert.match(section, /chrome/i);
  assert.match(section, /optional/i);
  assert.match(section, /npm test/i);
  assert.match(section, /native-render/i);

  // The superseded curated-preview claims must not come back.
  assert.doesNotMatch(section, /curated preview|hand-drawn preview|preview render/i);

  // Negative guards: realistic overclaims this section must never make.
  assert.doesNotMatch(
    section,
    /pixel[- ]?identical|native[- ]?canvas[- ]?equivalent|visually identical|identical to the portal render/i,
  );
  assert.doesNotMatch(
    section,
    /cross[- ]?platform|fully portable|portable across|runs[- ]?anywhere|works on any os|platform[- ]?independent/i,
  );
});
