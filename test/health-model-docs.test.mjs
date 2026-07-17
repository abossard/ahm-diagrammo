import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { generateHealthModelDocs, normalizeSnapshot } from "../src/health-model-docs.mjs";
import { Diagnostics } from "../src/diag.mjs";
import { foldSignals, parseGraph, renderSwimlane } from "../src/swimlane.mjs";
import { textWidth } from "../src/text.mjs";
import { THEMES } from "../src/themes.mjs";
import { verifyGeometry, verifySvgString } from "./helpers/geo.mjs";

const pexec = promisify(execFile);
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, "bin", "health-model-docs.mjs");
const FIXTURE = join(ROOT, "test", "fixtures", "health-model-snapshot.json");
const FAKE_AZ = join(ROOT, "test", "fixtures", "fake-az.mjs");
const SNAPSHOT = JSON.parse(readFileSync(FIXTURE, "utf8"));
const HEALTH_DOC_SUBTITLE = "Signals live inside each entity; health rolls up to the workload root.";

function workspace(t) {
  const directory = mkdtempSync(join(ROOT, ".health-model-docs-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

async function runCli(args, env = {}) {
  try {
    const result = await pexec(process.execPath, [CLI, ...args], {
      env: {
        ...process.env,
        AZURE_CLI_PATH: FAKE_AZ,
        FAKE_AZ_FIXTURE: FIXTURE,
        ...env
      }
    });
    return { code: 0, ...result };
  } catch (error) {
    return {
      code: typeof error.code === "number" ? error.code : 1,
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? ""
    };
  }
}

function seedBundle(out) {
  mkdirSync(out, { recursive: true });
  const files = {
    "hm-orders.json": "existing-json\n",
    "hm-orders.md": "existing-markdown\n",
    "hm-orders.svg": "existing-svg\n",
    "unrelated.txt": "leave-this-alone\n"
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(out, name), content);
  return Object.fromEntries(Object.keys(files).map((name) => [name, readFileSync(join(out, name))]));
}

function assertBundleUnchanged(out, before) {
  assert.deepEqual(readdirSync(out).sort(), Object.keys(before).sort());
  assert.deepEqual(
    Object.fromEntries(Object.keys(before).map((name) => [name, readFileSync(join(out, name))])),
    before
  );
}

function oneNodeSnapshot({ signalName, value, diagnostic } = {}) {
  const signalGroups = signalName == null ? {} : {
    azureResource: {
      signals: [{
        name: signalName,
        displayName: signalName,
        status: {
          healthState: diagnostic == null ? "Unknown" : "Unhealthy",
          value,
          ...(diagnostic == null ? {} : { error: diagnostic })
        }
      }]
    }
  };
  return {
    model: { name: "narrow-health-model" },
    entities: [{
      name: "root",
      properties: {
        displayName: "Root",
        healthState: diagnostic == null ? "Unknown" : "Unhealthy",
        signalGroups
      }
    }],
    relationships: [],
    signalDefinitions: [],
    authenticationSettings: [],
    discoveryRules: []
  };
}

function svgTexts(svg) {
  return [...svg.matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/g)].map((match) => ({
    attributes: match[1],
    content: match[2]
      .replace(/<title>[\s\S]*?<\/title>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
  }));
}

function svgAttribute(attributes, name) {
  return attributes.match(new RegExp(`\\b${name}="([^"]+)"`))?.[1];
}

function contrastRatio(left, right) {
  const luminance = (hex) => {
    const channels = hex.slice(1).match(/../g).map((value) => {
      const channel = Number.parseInt(value, 16) / 255;
      return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("C1 acquisition uses the exact six plural health-models commands with argv isolation", async (t) => {
  const work = workspace(t);
  const log = join(work, "argv.jsonl");
  const out = join(work, "bundle");
  const resourceGroup = "rg-docs; echo not-a-shell";
  const model = "hm-orders";
  const subscription = "sub $(still-not-a-shell)";

  const result = await runCli([
    "--resource-group", resourceGroup,
    "--model", model,
    "--subscription", subscription,
    "--out", out
  ], { FAKE_AZ_LOG: log });

  assert.equal(result.code, 0, result.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
  const common = [
    "--resource-group", resourceGroup,
    "--health-model-name", model,
    "--output", "json",
    "--only-show-errors",
    "--subscription", subscription
  ];
  assert.deepEqual(calls, [
    ["monitor", "health-models", "show", ...common],
    ["monitor", "health-models", "entity", "list", ...common],
    ["monitor", "health-models", "relationship", "list", ...common],
    ["monitor", "health-models", "signal-definition", "list", ...common],
    ["monitor", "health-models", "authentication-setting", "list", ...common],
    ["monitor", "health-models", "discovery-rule", "list", ...common]
  ]);
});

test("C2 successful runs emit three non-empty byte-deterministic files", async (t) => {
  const work = workspace(t);
  const out = join(work, "bundle");
  const args = ["--resource-group", "rg-docs", "--model", "hm-orders", "--out", out];
  const paths = [".json", ".md", ".svg"].map((extension) => join(out, `hm-orders${extension}`));

  const first = await runCli(args);
  assert.equal(first.code, 0, first.stderr);
  const firstBytes = paths.map((path) => readFileSync(path));
  assert.ok(firstBytes.every((value) => value.length > 0));

  const second = await runCli(args);
  assert.equal(second.code, 0, second.stderr);
  assert.deepEqual(paths.map((path) => readFileSync(path)), firstBytes);
});

test("C3 rich current snapshot stays complete in sorted JSON and readable Markdown", () => {
  const normalized = normalizeSnapshot(SNAPSHOT);
  const artifacts = generateHealthModelDocs(SNAPSHOT);

  assert.deepEqual(normalized.entities.map(({ name }) => name), [
    "hm-orders", "orders-api", "orders-db", "orders-queue"
  ]);
  assert.deepEqual(JSON.parse(artifacts.json), normalized);
  assert.deepEqual(
    Object.fromEntries(["entities", "relationships", "signalDefinitions", "authenticationSettings", "discoveryRules"]
      .map((key) => [key, normalized[key].length])),
    { entities: 4, relationships: 3, signalDefinitions: 2, authenticationSettings: 1, discoveryRules: 0 }
  );

  for (const heading of [
    "Model", "Entities (4)", "Relationships (3)", "Signal definitions (2)",
    "Authentication settings (1)", "Discovery rules (0)"
  ]) {
    assert.ok(artifacts.markdown.includes(heading), `missing heading ${heading}`);
  }
  for (const resource of [
    normalized.model,
    ...normalized.entities,
    ...normalized.relationships,
    ...normalized.signalDefinitions,
    ...normalized.authenticationSettings
  ]) {
    assert.ok(artifacts.markdown.includes(resource.name), `missing resource ${resource.name}`);
  }
  for (const value of [
    "Healthy", "Degraded", "Unhealthy", "Maintenance",
    "Standard", "Limited", "Suppressed", "WorstOf", "azureResource",
    "api-latency", "api-errors", "queue-depth", "230 ms", "0.4%", "81",
    "threshold &gt; 200 &amp; sample &lt; 5", "No samples for 10 minutes",
    "orders-api → hm-orders", "orders-db → orders-api", "orders-queue → hm-orders"
  ]) {
    assert.ok(artifacts.markdown.includes(value), `missing Markdown value ${value}`);
  }
});

test("C4 Mermaid and themed native-text SVG contain every entity, relationship, state, and signal", () => {
  const artifacts = generateHealthModelDocs(SNAPSHOT, { theme: "midnight" });
  const diagnostics = new Diagnostics();
  const graph = parseGraph(artifacts.mermaid, { diag: diagnostics });

  assert.equal(graph.nodes.size, 7);
  assert.equal(graph.edges.length, 6);
  assert.equal(diagnostics.warnings.filter(({ message }) => message.startsWith("unrecognized")).length, 0);
  assert.deepEqual(
    [...graph.nodes.values()].filter(({ state }) => state !== "signal").map(({ state }) => state).sort(),
    ["degraded", "healthy", "unhealthy", "unknown"]
  );

  foldSignals(graph, diagnostics);
  assert.equal(graph.nodes.size, 4);
  assert.equal(graph.edges.length, 3);
  assert.equal([...graph.nodes.values()].flatMap(({ signals = [] }) => signals).length, 3);
  assert.deepEqual(
    graph.edges.map(({ from, to }) => [graph.nodes.get(from).lines[0], graph.nodes.get(to).lines[0]]).sort(),
    [
      ["orders-api", "hm-orders"],
      ["orders-db", "orders-api"],
      ["orders-queue", "hm-orders"]
    ]
  );

  const rendered = renderSwimlane(artifacts.mermaid, { theme: "midnight", title: "hm-orders" });
  assert.deepEqual(verifyGeometry(rendered), []);
  assert.deepEqual(verifySvgString(rendered.svg), []);
  assert.match(rendered.svg, /<text/);
  assert.doesNotMatch(rendered.svg, /foreignObject/);
  assert.match(rendered.svg, /#1b1a19/);
});

test("C10 narrow health-doc SVGs keep the measured subtitle and complete legend separated", () => {
  const snapshot = oneNodeSnapshot();
  const first = generateHealthModelDocs(snapshot, { theme: "midnight" });
  const second = generateHealthModelDocs(snapshot, { theme: "midnight" });
  const texts = svgTexts(first.svg);
  const subtitle = texts.find(({ content }) => content === HEALTH_DOC_SUBTITLE);
  const legend = texts.find(({ content }) => content === "Legend");

  assert.ok(subtitle, "health-doc subtitle must be present");
  assert.ok(legend, "complete health legend must be present");
  const subtitleRight = Number(svgAttribute(subtitle.attributes, "x"))
    + textWidth(HEALTH_DOC_SUBTITLE, 12);
  const legendRight = Number(svgAttribute(legend.attributes, "x"));
  const legendLeft = legendRight - textWidth("Legend", 11.5, 600);
  assert.ok(legendLeft - subtitleRight > 0, `header gap was ${legendLeft - subtitleRight}`);

  const defaultRender = renderSwimlane(first.mermaid, {
    theme: "midnight",
    title: snapshot.model.name
  });
  const generatedWidth = Number(first.svg.match(/^<svg\b[^>]*\bwidth="(\d+)"/)?.[1]);
  assert.ok(generatedWidth > defaultRender.W, "health-doc generation must opt into the wider header");
  assert.equal(first.svg, second.svg);
});

test("C11 long Azure signal diagnostics stay inside rendered entity cards", () => {
  const snapshot = structuredClone(SNAPSHOT);
  const signal = snapshot.entities.find(({ name }) => name === "orders-api")
    .properties.signalGroups.azureResource.signals[0];
  signal.status.value = "No current sample";
  signal.status.error = `${"Provider diagnostic detail ".repeat(30)}diagnostic-tail-marker`;

  const artifacts = generateHealthModelDocs(snapshot, { theme: "midnight" });
  const rendered = renderSwimlane(artifacts.mermaid, { theme: "midnight", title: "hm-orders" });

  assert.deepEqual(verifyGeometry(rendered), []);
  assert.match(rendered.svg, /diagnostic-tail-marker/);
});

const ERROR_PANEL_CASES = [
  {
    name: "provider metacharacters",
    theme: "portal",
    diagnostic: "Azure provider failed: threshold < 5 & source [prod] (attempt=2)"
  },
  {
    name: "long unbroken identifier",
    theme: "midnight",
    diagnostic: `${"ResourceIdentifierWithoutNaturalBreaks".repeat(16)}-tail-marker`
  },
  {
    name: "multi-line diagnostic",
    theme: "candy",
    diagnostic: "First diagnostic line\nSecond line with \"quoted\" value\nFinal %% marker"
  }
];

for (const scenario of ERROR_PANEL_CASES) {
  test(`C12 labelled signal error panel: ${scenario.name}`, () => {
    const signalName = "Availability probe";
    const value = "No current sample";
    const snapshot = oneNodeSnapshot({
      signalName,
      value,
      diagnostic: scenario.diagnostic
    });
    const artifacts = generateHealthModelDocs(snapshot, { theme: scenario.theme });
    const graph = parseGraph(artifacts.mermaid);
    foldSignals(graph);
    const [row] = [...graph.nodes.values()].flatMap(({ signals = [] }) => signals);

    assert.equal(row.name, signalName);
    assert.equal(row.result, value);
    assert.equal(row.error, scenario.diagnostic);
    assert.equal(row.state, "unhealthy");

    const rendered = renderSwimlane(artifacts.mermaid, {
      theme: scenario.theme,
      title: snapshot.model.name
    });
    const panelTag = rendered.svg.match(/<rect\b[^>]*data-role="signal-error-panel"[^>]*>/)?.[0];
    assert.ok(panelTag, "error panel border must be rendered");
    assert.equal(svgAttribute(panelTag, "fill"), THEMES[scenario.theme].state.unhealthy.fill);
    assert.equal(svgAttribute(panelTag, "stroke"), THEMES[scenario.theme].state.unhealthy.border);
    assert.ok(contrastRatio(THEMES[scenario.theme].ink, THEMES[scenario.theme].state.unhealthy.fill) >= 4.5);

    const errorLabel = svgTexts(rendered.svg).find(({ attributes }) =>
      svgAttribute(attributes, "data-role") === "signal-error-label");
    assert.equal(errorLabel?.content, "Error");
    const diagnosticText = svgTexts(rendered.svg)
      .filter(({ attributes }) => svgAttribute(attributes, "data-role") === "signal-error-line")
      .map(({ content }) => content)
      .join("");
    assert.equal(diagnosticText, scenario.diagnostic);
    const visibleText = svgTexts(rendered.svg).map(({ content }) => content).join(" ");
    assert.match(visibleText, /Availability probe/);
    assert.match(visibleText, /No current sample/);
    assert.doesNotMatch(rendered.svg, /foreignObject/i);
    assert.deepEqual(verifySvgString(rendered.svg), []);
    assert.deepEqual(verifyGeometry(rendered), []);
    assert.equal(
      artifacts.svg,
      generateHealthModelDocs(snapshot, { theme: scenario.theme }).svg,
      "error-panel rendering must be byte deterministic"
    );
  });
}

test("C10 long non-error signal names retain a positive gap from right-aligned results", () => {
  const signalName = "SignalNameWithoutNaturalBreaks".repeat(10);
  const snapshot = oneNodeSnapshot({ signalName, value: "Unknown" });
  const artifacts = generateHealthModelDocs(snapshot, { theme: "midnight" });
  const rendered = renderSwimlane(artifacts.mermaid, {
    theme: "midnight",
    title: snapshot.model.name
  });
  const nameBoxes = rendered.debug.texts.filter(({ role }) => role === "signal-name");
  const resultBoxes = rendered.debug.texts.filter(({ role }) => role === "signal-result");

  assert.ok(nameBoxes.length > 0);
  assert.ok(resultBoxes.length > 0);
  const gaps = [];
  for (const name of nameBoxes) {
    for (const result of resultBoxes) {
      if (name.y < result.y + result.h && result.y < name.y + name.h) {
        gaps.push(result.x - (name.x + name.w));
      }
    }
  }
  assert.ok(gaps.length > 0);
  assert.ok(Math.min(...gaps) > 0, `minimum signal/result gap was ${Math.min(...gaps)}`);
  assert.deepEqual(verifyGeometry(rendered), []);
});

const SPECIAL_TEXT_CASES = [
  {
    name: "pipes, ampersands, angles, and brackets",
    value: "Pipe | amp & angle <tag> [slot]",
    expectedMarkdown: "Pipe \\| amp &amp; angle &lt;tag&gt; \\[slot\\]",
    state: "Healthy"
  },
  {
    name: "quotes, backticks, and a line break",
    value: "\"quoted\" `code`\nnext line",
    expectedMarkdown: "\"quoted\" &#96;code&#96; next line",
    state: "Degraded"
  },
  {
    name: "Mermaid directive and class-shaped text",
    value: "%%{init}%%\nclass n999 green;\nn999[\"Injected\"]",
    expectedMarkdown: "%%{init}%% class n999 green; n999\\[\"Injected\"\\]",
    state: "Unhealthy"
  },
  {
    name: "slashes, arrows, and unknown provider state",
    value: "slash \\ and > quote\n--> x",
    expectedMarkdown: "slash \\\\ and &gt; quote --&gt; x",
    state: "Maintenance"
  }
];

for (const scenario of SPECIAL_TEXT_CASES) {
  test(`C5 safe text: ${scenario.name}`, () => {
    const snapshot = structuredClone(SNAPSHOT);
    const entity = snapshot.entities.find(({ name }) => name === "orders-db");
    const relationship = snapshot.relationships.find(({ name }) => name === "db-to-api");
    const signal = snapshot.entities.find(({ name }) => name === "orders-api")
      .properties.signalGroups.azureResource.signals[0];
    entity.name = scenario.value;
    entity.properties.displayName = scenario.value;
    entity.properties.healthState = scenario.state;
    entity.properties.tags = { exact: scenario.value };
    relationship.properties.childEntityName = scenario.value;
    signal.status.value = scenario.value;
    signal.status.error = scenario.value;

    const artifacts = generateHealthModelDocs(snapshot);
    const json = JSON.parse(artifacts.json);
    const exactEntity = json.entities.find(({ name }) => name === scenario.value);
    assert.equal(exactEntity.properties.displayName, scenario.value);
    assert.equal(exactEntity.properties.tags.exact, scenario.value);
    assert.equal(json.relationships.find(({ name }) => name === "db-to-api").properties.childEntityName, scenario.value);
    const exactSignal = json.entities.find(({ name }) => name === "orders-api")
      .properties.signalGroups.azureResource.signals[0];
    assert.equal(exactSignal.status.value, scenario.value);
    assert.equal(exactSignal.status.error, scenario.value);
    assert.ok(artifacts.markdown.includes(scenario.expectedMarkdown));

    const diagnostics = new Diagnostics();
    const graph = parseGraph(artifacts.mermaid, { diag: diagnostics });
    assert.equal(graph.nodes.size, 7);
    assert.equal(graph.edges.length, 6);
    assert.equal(diagnostics.warnings.filter(({ message }) =>
      message.startsWith("unrecognized") || message.startsWith("ignored")).length, 0);
    foldSignals(graph, diagnostics);
    assert.equal(graph.nodes.size, 4);
    assert.equal(graph.edges.length, snapshot.relationships.length);

    const rendered = renderSwimlane(artifacts.mermaid, { theme: "portal" });
    assert.deepEqual(verifySvgString(rendered.svg), []);
    assert.doesNotMatch(rendered.svg, /foreignObject|<script/i);
  });
}

test("C6 empty collections produce explicit None content and an Unknown placeholder", () => {
  const snapshot = {
    model: structuredClone(SNAPSHOT.model),
    entities: [],
    relationships: [],
    signalDefinitions: [],
    authenticationSettings: [],
    discoveryRules: []
  };

  const artifacts = generateHealthModelDocs(snapshot);
  assert.match(artifacts.markdown, /Entities \(0\)[\s\S]*_None\._/);
  assert.match(artifacts.markdown, /Warning:.*no entities.*Unknown/i);
  const graph = parseGraph(artifacts.mermaid);
  assert.equal(graph.nodes.size, 1);
  assert.equal(graph.edges.length, 0);
  assert.equal([...graph.nodes.values()][0].state, "unknown");
  assert.match([...graph.nodes.values()][0].lines.join(" "), /No entities returned.*Unknown/);
  assert.doesNotMatch(artifacts.mermaid, /class\s+\S+\s+green/);
  const rendered = renderSwimlane(artifacts.mermaid);
  assert.deepEqual(verifySvgString(rendered.svg), []);
});

test("C6 dangling relationships render an Unknown placeholder and a Markdown warning", () => {
  const snapshot = structuredClone(SNAPSHOT);
  snapshot.relationships.find(({ name }) => name === "db-to-api").properties.childEntityName = "ghost-service";

  const artifacts = generateHealthModelDocs(snapshot);
  assert.match(artifacts.markdown, /Warning:.*ghost-service.*Unknown/i);
  const graph = parseGraph(artifacts.mermaid);
  foldSignals(graph);
  assert.equal(graph.nodes.size, 5);
  assert.equal(graph.edges.length, snapshot.relationships.length);
  const placeholder = [...graph.nodes.values()].find(({ lines }) => lines.join(" ").includes("ghost-service"));
  assert.ok(placeholder);
  assert.equal(placeholder.state, "unknown");
  assert.match(placeholder.lines.join(" "), /Missing entity: ghost-service.*Unknown/);
  const rendered = renderSwimlane(artifacts.mermaid);
  assert.deepEqual(verifySvgString(rendered.svg), []);
});

const FAILED_COMMANDS = [
  "show",
  "entity list",
  "relationship list",
  "signal-definition list",
  "authentication-setting list",
  "discovery-rule list"
];

for (const command of FAILED_COMMANDS) {
  test(`C7 Azure failure at ${command} preserves every existing file`, async (t) => {
    const work = workspace(t);
    const out = join(work, "bundle");
    const before = seedBundle(out);
    const azureError = command === "show"
      ? "ERROR: (ResourceNotFound) Health model 'hm-orders' was not found."
      : command === "entity list"
        ? "ERROR: Please run 'az login' to setup account."
        : `ERROR: provider rejected ${command}`;

    const result = await runCli(
      ["--resource-group", "rg-docs", "--model", "hm-orders", "--out", out],
      { FAKE_AZ_FAIL_COMMAND: command, FAKE_AZ_ERROR: azureError }
    );

    assert.notEqual(result.code, 0);
    assert.ok(result.stderr.includes(`az monitor health-models ${command}`), result.stderr);
    assert.ok(result.stderr.includes(azureError), result.stderr);
    assert.doesNotMatch(result.stderr, /\n\s+at |node:internal/);
    assertBundleUnchanged(out, before);
  });
}

test("C7 unavailable az preserves existing files and gives an actionable error", async (t) => {
  const work = workspace(t);
  const out = join(work, "bundle");
  const before = seedBundle(out);

  const result = await runCli(
    ["--resource-group", "rg-docs", "--model", "hm-orders", "--out", out],
    { AZURE_CLI_PATH: join(work, "missing-az") }
  );

  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /az monitor health-models show.*not found/i);
  assert.doesNotMatch(result.stderr, /\n\s+at |node:internal/);
  assertBundleUnchanged(out, before);
});

test("C7 malformed and unexpected JSON preserve existing files", async (t) => {
  for (const [envName, command, reason] of [
    ["FAKE_AZ_MALFORMED_COMMAND", "relationship list", /invalid JSON/i],
    ["FAKE_AZ_UNEXPECTED_COMMAND", "entity list", /entities response must be a JSON array/i],
    ["FAKE_AZ_UNEXPECTED_COMMAND", "show", /model response must include a name/i],
    ["FAKE_AZ_UNEXPECTED_ITEM_COMMAND", "entity list", /entities response item 1 must be a JSON object/i]
  ]) {
    const work = workspace(t);
    const out = join(work, "bundle");
    const before = seedBundle(out);

    const result = await runCli(
      ["--resource-group", "rg-docs", "--model", "hm-orders", "--out", out],
      { [envName]: command }
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, reason);
    assert.doesNotMatch(result.stderr, /\n\s+at |node:internal/);
    assertBundleUnchanged(out, before);
  }
});

test("C9 successful Azure calls retain diagnostics for malformed and unexpected JSON", async (t) => {
  const diagnostic = "ERROR: extension emitted partial output";
  for (const [envName, command, reason] of [
    ["FAKE_AZ_MALFORMED_COMMAND", "relationship list", /invalid JSON/i],
    ["FAKE_AZ_UNEXPECTED_COMMAND", "entity list", /entities response must be a JSON array/i]
  ]) {
    const work = workspace(t);
    const out = join(work, "bundle");
    const before = seedBundle(out);

    const result = await runCli(
      ["--resource-group", "rg-docs", "--model", "hm-orders", "--out", out],
      {
        [envName]: command,
        FAKE_AZ_DIAGNOSTIC_COMMAND: command,
        FAKE_AZ_DIAGNOSTIC: diagnostic
      }
    );

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, reason);
    assert.ok(result.stderr.includes(diagnostic), result.stderr);
    assert.doesNotMatch(result.stderr, /\n\s+at |node:internal/);
    assertBundleUnchanged(out, before);
  }
});

test("C8 help, package metadata, and docs describe the complete safe CLI contract", async () => {
  const result = await runCli(["--help"]);
  assert.equal(result.code, 0, result.stderr);
  const requiredFlags = ["--resource-group", "--model", "--subscription", "--out", "--theme", "--help"];
  for (const text of [
    ...requiredFlags,
    "az monitor health-models", "<model-slug>.json", "<model-slug>.md", "<model-slug>.svg",
    "resource IDs", "tags", "identity details", "Review all generated files before publishing"
  ]) {
    assert.ok(result.stdout.includes(text), `help omits ${text}`);
  }

  const binary = readFileSync(CLI, "utf8");
  const parseArgsSource = binary.match(/function parseArgs[\s\S]*?\n}\n\nconst COMMANDS/)?.[0] ?? "";
  const binaryFlags = [...new Set(parseArgsSource.match(/--[a-z][a-z-]+/g) ?? [])].sort();
  const helpFlags = [...new Set(result.stdout.match(/--[a-z][a-z-]+/g) ?? [])].sort();
  assert.deepEqual(binaryFlags, requiredFlags.slice().sort());
  assert.deepEqual(helpFlags, binaryFlags);

  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  assert.equal(packageJson.bin["ahm-health-docs"], "bin/health-model-docs.mjs");
  for (const path of [join(ROOT, "README.md"), join(ROOT, "docs", "FEATURES.md")]) {
    const document = readFileSync(path, "utf8");
    for (const text of [
      "ahm-health-docs", "az monitor health-models", ...binaryFlags, ".json", ".md", ".svg"
    ]) {
      assert.ok(document.includes(text), `${path} omits ${text}`);
    }
    assert.match(document, /review.*before publishing/i);
  }
});

test("C8 a successful rerun replaces only the model bundle", async (t) => {
  const work = workspace(t);
  const out = join(work, "bundle");
  const before = seedBundle(out);

  const result = await runCli([
    "--resource-group", "rg-docs",
    "--model", "hm-orders",
    "--theme", "candy",
    "--out", out
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(out).sort(), Object.keys(before).sort());
  assert.deepEqual(readFileSync(join(out, "unrelated.txt")), before["unrelated.txt"]);
  for (const name of ["hm-orders.json", "hm-orders.md", "hm-orders.svg"]) {
    assert.notDeepEqual(readFileSync(join(out, name)), before[name], `${name} was not replaced`);
  }
});
