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
const main = document.querySelector("main");
const maximizeEditorButton = document.getElementById("maximize-editor");
const maximizeOutputButton = document.getElementById("maximize-output");

let latestResults = [];
let exportInFlight = false;
let sourceIntent = 0;
let sourceRevision = 0;
let exportRevision = null;
let maximizeActivator = null; // button that triggered the current maximize, for Escape focus return

applyThemeVariables(getTheme("portal"));
populateExamples();
render();
loadSelected(); // show a non-empty starting point without changing the dropdown's option count

select.addEventListener("change", loadSelected);
editor.addEventListener("input", () => {
  sourceIntent++;
  sourceRevision++;
  render();
  const warnings = latestResults.reduce((n, r) => n + r.diagnostics.filter((d) => d.level === "warn").length, 0);
  const errors = latestResults.filter((r) => r.kind === "error").length;
  const exporting = exportInFlight ? `Exporting ZIP from revision ${exportRevision}; ` : "";
  setStatus(`${exporting}Preview revision ${sourceRevision}${warnings ? `, ${warnings} warning(s)` : ""}${errors ? `, ${errors} error(s)` : ""}`, errors > 0);
});
exportButton.addEventListener("click", handleExportClick);
maximizeEditorButton.addEventListener("click", () => togglePaneMaximize("editor", maximizeEditorButton));
maximizeOutputButton.addEventListener("click", () => togglePaneMaximize("output", maximizeOutputButton));
document.addEventListener("keydown", handleMaximizeKeydown);

function togglePaneMaximize(pane, activatorButton) {
  const isActive = main.dataset.maximized === pane;
  setMaximizedPane(isActive ? null : pane, isActive ? null : activatorButton);
}

function setMaximizedPane(pane, activatorButton) {
  if (pane) {
    main.dataset.maximized = pane;
  } else {
    delete main.dataset.maximized;
  }
  maximizeActivator = pane ? activatorButton : null;
  syncMaximizeButton(maximizeEditorButton, "editor", "Maximize editor");
  syncMaximizeButton(maximizeOutputButton, "output", "Maximize preview");
}

function syncMaximizeButton(button, pane, restLabel) {
  const active = main.dataset.maximized === pane;
  button.textContent = active ? "Restore split view" : restLabel;
  button.setAttribute("aria-pressed", String(active));
}

function handleMaximizeKeydown(event) {
  if (event.key !== "Escape" || !main.dataset.maximized) return;
  const activator = maximizeActivator;
  setMaximizedPane(null, null);
  activator?.focus();
}

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
  const intent = ++sourceIntent;
  setStatus(`Loading ${path}…`);
  try {
    const source = await loadExample(path);
    if (intent !== sourceIntent || path !== select.value) return;
    editor.value = source;
    sourceRevision++;
    render();
    setStatus(`Loaded ${path} (revision ${sourceRevision})`);
  } catch (e) {
    if (intent !== sourceIntent || path !== select.value) return;
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

  const capturedResults = latestResults;
  const capturedRevision = sourceRevision;
  exportInFlight = true;
  exportRevision = capturedRevision;
  updateExportButton();
  setStatus(`Exporting ZIP from revision ${capturedRevision}…`);
  try {
    const { bytes, count, skipped } = await buildDiagramZip(capturedResults);
    downloadZip(bytes);
    const skippedNote = skipped > 0 ? ` (${skipped} unsupported/error block${skipped === 1 ? "" : "s"} skipped)` : "";
    const currentNote = sourceRevision !== capturedRevision ? `; editor is now revision ${sourceRevision}` : "";
    setStatus(`Exported ${count} diagram${count === 1 ? "" : "s"} as ZIP from revision ${capturedRevision}${skippedNote}${currentNote}`);
  } catch (e) {
    setStatus(`Export failed for revision ${capturedRevision}: ${e.message}`, true);
  } finally {
    exportInFlight = false;
    exportRevision = null;
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
