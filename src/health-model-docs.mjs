import { slugify } from "./extract.mjs";
import { renderSwimlane } from "./swimlane.mjs";

const COLLECTIONS = [
  "entities",
  "relationships",
  "signalDefinitions",
  "authenticationSettings",
  "discoveryRules"
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resourceKey(resource) {
  return `${resource?.name ?? ""}\u0000${resource?.id ?? ""}\u0000${JSON.stringify(resource)}`;
}

export function normalizeSnapshot(snapshot) {
  if (!snapshot?.model || typeof snapshot.model !== "object" || Array.isArray(snapshot.model)) {
    throw new Error("model response must be a JSON object");
  }
  if (typeof snapshot.model.name !== "string" || snapshot.model.name.length === 0) {
    throw new Error("model response must include a name");
  }
  for (const collection of COLLECTIONS) {
    if (!Array.isArray(snapshot[collection])) {
      throw new Error(`${collection} response must be a JSON array`);
    }
    snapshot[collection].forEach((resource, index) => {
      if (!resource || typeof resource !== "object" || Array.isArray(resource)) {
        throw new Error(`${collection} response item ${index + 1} must be a JSON object`);
      }
    });
  }
  return {
    model: stableValue(snapshot.model),
    ...Object.fromEntries(COLLECTIONS.map((collection) => [
      collection,
      snapshot[collection].map(stableValue).sort((left, right) => compareText(resourceKey(left), resourceKey(right)))
    ]))
  };
}

function markdownText(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/`/g, "&#96;")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function displayValue(value) {
  if (typeof value === "string") return markdownText(value);
  if (value === null) return "null";
  return markdownText(JSON.stringify(value));
}

function flatten(value, path = "", rows = []) {
  if (Array.isArray(value)) {
    if (value.length === 0) rows.push([path, []]);
    value.forEach((item, index) => flatten(item, `${path}[${index}]`, rows));
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) rows.push([path, {}]);
    entries.forEach(([key, item]) => flatten(item, path ? `${path}.${key}` : key, rows));
  } else {
    rows.push([path, value]);
  }
  return rows;
}

function detailsTable(resource) {
  const rows = flatten(resource);
  return [
    "| Field | Value |",
    "|---|---|",
    ...rows.map(([path, value]) => `| ${markdownText(path)} | ${displayValue(value)} |`)
  ].join("\n");
}

function entitySignals(entity) {
  const rows = [];
  for (const [groupName, group] of Object.entries(entity.properties?.signalGroups ?? {})) {
    for (const signal of group?.signals ?? []) {
      rows.push({
        groupName,
        name: signal.name ?? "Unknown",
        displayName: signal.displayName ?? signal.name ?? "Unknown",
        state: signal.status?.healthState ?? "Unknown",
        value: signal.status?.value ?? "Unknown",
        error: signal.status?.error ?? "None"
      });
    }
  }
  return rows;
}

function collectionSection(title, resources) {
  const lines = [`## ${title} (${resources.length})`, ""];
  if (resources.length === 0) return [...lines, "_None._", ""];
  for (const resource of resources) {
    lines.push(`### ${markdownText(resource.name ?? resource.id ?? "Unnamed")}`, "", detailsTable(resource), "");
  }
  return lines;
}

function missingEntityNames(snapshot) {
  const known = new Set(snapshot.entities.map((entity) => String(entity.name ?? entity.id)));
  const missing = new Set();
  for (const relationship of snapshot.relationships) {
    for (const endpoint of [
      relationship.properties?.childEntityName,
      relationship.properties?.parentEntityName
    ]) {
      const name = endpoint == null ? "Unspecified entity" : String(endpoint);
      if (!known.has(name)) missing.add(name);
    }
  }
  return [...missing].sort(compareText);
}

function markdownDocument(snapshot) {
  const modelName = snapshot.model.name ?? "health-model";
  const lines = [
    `# Health Model: ${markdownText(modelName)}`,
    "",
    "## Model",
    "",
    detailsTable(snapshot.model),
    ""
  ];
  if (snapshot.entities.length === 0) {
    lines.push("> **Warning:** No entities were returned; the visualization contains one Unknown placeholder.", "");
  }
  for (const name of missingEntityNames(snapshot)) {
    lines.push(`> **Warning:** Relationship references missing entity "${markdownText(name)}"; the visualization renders it as Unknown.`, "");
  }
  lines.push(`## Entities (${snapshot.entities.length})`, "");

  if (snapshot.entities.length === 0) {
    lines.push("_None._", "");
  }
  for (const entity of snapshot.entities) {
    const properties = entity.properties ?? {};
    const signals = entitySignals(entity);
    lines.push(
      `### ${markdownText(entity.name ?? entity.id ?? "Unnamed")}`,
      "",
      `- **Display name:** ${displayValue(properties.displayName ?? entity.name ?? "Unknown")}`,
      `- **Health state:** ${displayValue(properties.healthState ?? "Unknown")}`,
      `- **Impact:** ${displayValue(properties.impact ?? "Unknown")}`,
      "",
      "#### Signals",
      ""
    );
    if (signals.length === 0) {
      lines.push("_None._", "");
    } else {
      lines.push(
        "| Group | Name | Display name | State | Value | Error |",
        "|---|---|---|---|---|---|",
        ...signals.map((signal) => `| ${displayValue(signal.groupName)} | ${displayValue(signal.name)} | ${displayValue(signal.displayName)} | ${displayValue(signal.state)} | ${displayValue(signal.value)} | ${displayValue(signal.error)} |`),
        ""
      );
    }
    lines.push("#### Configuration and details", "", detailsTable(entity), "");
  }

  lines.push(`## Relationships (${snapshot.relationships.length})`, "");
  if (snapshot.relationships.length === 0) {
    lines.push("_None._", "");
  }
  for (const relationship of snapshot.relationships) {
    const properties = relationship.properties ?? {};
    lines.push(
      `### ${markdownText(relationship.name ?? relationship.id ?? "Unnamed")}`,
      "",
      `- **Dependency:** ${displayValue(properties.childEntityName ?? "Unknown")} → ${displayValue(properties.parentEntityName ?? "Unknown")}`,
      "",
      detailsTable(relationship),
      ""
    );
  }

  lines.push(
    ...collectionSection("Signal definitions", snapshot.signalDefinitions),
    ...collectionSection("Authentication settings", snapshot.authenticationSettings),
    ...collectionSection("Discovery rules", snapshot.discoveryRules)
  );
  return `${lines.join("\n").trimEnd()}\n`;
}

function mermaidText(value) {
  return String(value)
    .replace(/\r?\n/g, " · ")
    .replace(/%%/g, "％％")
    .replace(/\\/g, "∖")
    .replace(/\[/g, "［")
    .replace(/\]/g, "］")
    .replace(/"/g, "”")
    .replace(/</g, "‹")
    .replace(/>/g, "›")
    .replace(/\(/g, "（")
    .replace(/\)/g, "）");
}

const DIAGNOSTIC_ESCAPE = "␛";
const DIAGNOSTIC_CODES = new Map([
  [DIAGNOSTIC_ESCAPE, "e"],
  [" ", "s"],
  ["\t", "t"],
  ["\r", "r"],
  ["\n", "n"],
  ["%", "p"],
  ["[", "o"],
  ["]", "c"],
  ['"', "q"],
  ["<", "l"],
  [">", "g"],
  ["(", "a"],
  [")", "z"]
]);

function mermaidDiagnostic(value) {
  return `${DIAGNOSTIC_ESCAPE}0${[...String(value)]
    .map((character) => {
      const code = DIAGNOSTIC_CODES.get(character);
      return code == null ? character : `${DIAGNOSTIC_ESCAPE}${code}`;
    })
    .join("")}`;
}

function mermaidState(value) {
  const state = String(value ?? "Unknown").toLowerCase();
  return ["healthy", "degraded", "unhealthy"].includes(state) ? state : "unknown";
}

function stateClass(value) {
  return { healthy: "green", degraded: "amber", unhealthy: "red" }[mermaidState(value)];
}

function graphSignals(entity) {
  const signals = [];
  for (const [groupName, group] of Object.entries(entity.properties?.signalGroups ?? {})) {
    for (const signal of group?.signals ?? []) signals.push({ groupName, signal });
  }
  return signals.sort((left, right) => {
    const leftKey = `${left.signal.name ?? ""}\u0000${left.signal.displayName ?? ""}\u0000${left.groupName}\u0000${JSON.stringify(left.signal)}`;
    const rightKey = `${right.signal.name ?? ""}\u0000${right.signal.displayName ?? ""}\u0000${right.groupName}\u0000${JSON.stringify(right.signal)}`;
    return compareText(leftKey, rightKey);
  });
}

export function snapshotToMermaid(snapshot) {
  const entityIds = new Map();
  const lines = ["flowchart BT"];
  const classes = { green: [], amber: [], red: [], blue: [] };

  snapshot.entities.forEach((entity, index) => {
    const id = `n${index}`;
    const name = entity.name ?? entity.id ?? `Unnamed entity ${index + 1}`;
    const displayName = entity.properties?.displayName;
    const label = displayName && displayName !== name
      ? `${mermaidText(name)}<br/>${mermaidText(displayName)}`
      : mermaidText(name);
    entityIds.set(String(name), id);
    lines.push(`${id}["${label}"]`);
    const healthClass = stateClass(entity.properties?.healthState);
    if (healthClass) classes[healthClass].push(id);
  });

  let nextId = snapshot.entities.length;
  if (snapshot.entities.length === 0) {
    lines.push(`n${nextId++}["No entities returned<br/>Unknown"]`);
  }
  for (const name of missingEntityNames(snapshot)) {
    const id = `n${nextId++}`;
    entityIds.set(name, id);
    lines.push(`${id}["Missing entity: ${mermaidText(name)}<br/>Unknown"]`);
  }

  for (const entity of snapshot.entities) {
    const entityId = entityIds.get(String(entity.name ?? entity.id));
    for (const { signal } of graphSignals(entity)) {
      const id = `n${nextId++}`;
      const name = mermaidText(signal.displayName ?? signal.name ?? "Signal").replace(/=/g, "＝");
      const status = signal.status ?? {};
      const value = status.value == null ? "Unknown" : mermaidText(status.value);
      const error = status.error == null ? "" : `; error: ${mermaidDiagnostic(status.error)}`;
      lines.push(`${id}["${name} = ${value}${error} (${mermaidState(status.healthState)})"]`);
      lines.push(`${id} --> ${entityId}`);
      classes.blue.push(id);
    }
  }

  for (const relationship of snapshot.relationships) {
    const child = entityIds.get(String(relationship.properties?.childEntityName));
    const parent = entityIds.get(String(relationship.properties?.parentEntityName));
    if (child && parent) lines.push(`${child} --> ${parent}`);
  }

  for (const [className, ids] of Object.entries(classes)) {
    if (ids.length) lines.push(`class ${ids.join(",")} ${className};`);
  }
  return lines.join("\n");
}

export function generateHealthModelDocs(snapshot, { theme = "portal" } = {}) {
  const normalized = normalizeSnapshot(snapshot);
  const modelName = String(normalized.model.name || "health-model");
  const mermaid = snapshotToMermaid(normalized);
  const { svg } = renderSwimlane(mermaid, { theme, title: modelName, minHeaderGap: 20 });
  return {
    slug: slugify(modelName),
    json: `${JSON.stringify(normalized, null, 2)}\n`,
    markdown: markdownDocument(normalized),
    mermaid,
    svg
  };
}
