import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (...parts) => readFileSync(join(ROOT, ...parts), "utf8");
const json = (...parts) => JSON.parse(read(...parts));

test("Claude and Copilot expose one shared diagrammo skill", () => {
  const pkg = json("package.json");
  const copilot = json("plugin.json");
  const claude = json(".claude-plugin", "plugin.json");
  const marketplace = json(".claude-plugin", "marketplace.json");
  const expectedSkills = ["./skills/"];

  for (const manifest of [copilot, claude]) {
    assert.equal(manifest.name, pkg.name);
    assert.equal(manifest.version, pkg.version);
    assert.equal(typeof manifest.description, "string");
    assert.ok(manifest.description.length > 0);
    assert.deepEqual(manifest.skills, expectedSkills);
  }

  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, pkg.name);
  assert.equal(marketplace.plugins[0].version, pkg.version);
  assert.equal(marketplace.plugins[0].source, "./");

  const sharedSkill = join(ROOT, "skills", "diagrammo", "SKILL.md");
  assert.equal(existsSync(sharedSkill), true);
  for (const duplicate of [
    join(ROOT, ".claude-plugin", "skills", "diagrammo", "SKILL.md"),
    join(ROOT, ".github", "plugin", "skills", "diagrammo", "SKILL.md"),
  ]) {
    assert.equal(existsSync(duplicate), false, `duplicate skill source: ${duplicate}`);
  }
});

test("the diagrammo skill uses the packaged CLI and verifies its outputs", () => {
  const skill = read("skills", "diagrammo", "SKILL.md");
  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/);

  assert.ok(frontmatter, "SKILL.md needs YAML frontmatter");
  assert.match(frontmatter[1], /^name: diagrammo$/m);
  assert.match(frontmatter[1], /^description: .+$/m);
  assert.match(skill, /npx --yes ahm-diagrammo/);
  assert.match(skill, /--list/);
  assert.match(skill, /inspect before render/i);
  assert.match(skill, /manifest\.json/);
  assert.match(skill, /\.svg/);
  assert.match(skill, /verify/i);
  assert.match(skill, /do not reimplement/i);
  assert.match(skill, /missing or invalid/i);
});
