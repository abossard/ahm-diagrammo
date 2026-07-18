// app.mjs — DOM wiring for the editor: dropdown, textarea, live preview, and ZIP export. Contains
// no parsing/rendering/export logic of its own; delegates to convert.mjs, examples.mjs,
// markdown-preview.mjs, and export-zip.mjs.
import { EXAMPLES, loadExample } from "./examples.mjs";
import { convertMarkdown } from "./convert.mjs";
import { renderMarkdownPreview } from "./markdown-preview.mjs";
import { buildDiagramZip } from "./export-zip.mjs";
import { getTheme } from "../src/themes.mjs";

const select = document.getElementById("example-select");
const editor = document.getElementById("editor");
const output = document.getElementById("output");
const status = document.getElementById("status");
const exportButton = document.getElementById("export-zip");

let latestResults = [];
let exportInFlight = false;

applyThemeVariables(getTheme("portal"));
populateExamples();
render();
loadSelected(); // show a non-empty starting point without changing the dropdown's option count

select.addEventListener("change", loadSelected);
editor.addEventListener("input", render);
exportButton.addEventListener("click", handleExportClick);

function populateExamples() {
  for (const ex of EXAMPLES) {
    const opt = document.createElement("option");
    opt.value = ex.path;
    opt.textContent = ex.label;
    select.appendChild(opt);
  }
}

async function loadSelected() {
  const path = select.value;
  if (!path) return;
  setStatus(`Loading ${path}…`);
  try {
    editor.value = await loadExample(path);
    render();
    setStatus(`Loaded ${path}`);
  } catch (e) {
    setStatus(e.message, true);
  }
}

function render() {
  latestResults = convertMarkdown(editor.value);
  renderMarkdownPreview(editor.value, latestResults, output);
  updateExportButton();
}

async function handleExportClick() {
  if (exportInFlight) return; // re-entrancy guard: one export at a time
  const healthCount = latestResults.filter((r) => r.kind === "health").length;
  if (healthCount === 0) return; // nothing to export; the control is already disabled

  exportInFlight = true;
  updateExportButton();
  setStatus("Exporting ZIP…");
  try {
    const { bytes, count, skipped } = await buildDiagramZip(latestResults);
    downloadZip(bytes);
    const skippedNote = skipped > 0 ? ` (${skipped} unsupported/error block${skipped === 1 ? "" : "s"} skipped)` : "";
    setStatus(`Exported ${count} diagram${count === 1 ? "" : "s"} as ZIP${skippedNote}`);
  } catch (e) {
    setStatus(`Export failed: ${e.message}`, true);
  } finally {
    exportInFlight = false;
    updateExportButton();
  }
}

function downloadZip(bytes) {
  const blob = new Blob([bytes], { type: "application/zip" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "diagrams.zip";
  a.click();
  URL.revokeObjectURL(url);
}

function updateExportButton() {
  const healthCount = latestResults.filter((r) => r.kind === "health").length;
  exportButton.disabled = exportInFlight || healthCount === 0;
  exportButton.textContent =
    healthCount === 0 ? "Export ZIP (nothing to export)" : `Export ZIP (${healthCount} diagram${healthCount === 1 ? "" : "s"})`;
}

function setStatus(text, isError = false) {
  status.textContent = text;
  status.classList.toggle("error", isError);
}

function applyThemeVariables(theme) {
  const root = document.documentElement.style;
  root.setProperty("--bg", theme.bg);
  root.setProperty("--band", theme.band);
  root.setProperty("--ink", theme.ink);
  root.setProperty("--muted", theme.muted);
  root.setProperty("--hair", theme.hair);
  root.setProperty("--accent", theme.state.signal.border);
  root.setProperty("--unhealthy", theme.state.unhealthy.dot);
}
