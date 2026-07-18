// app.mjs — DOM wiring for the editor: dropdown, textarea, and live-render output. Contains no
// parsing/rendering logic of its own; delegates everything to convert.mjs and examples.mjs.
import { EXAMPLES, loadExample } from "./examples.mjs";
import { convertMarkdown } from "./convert.mjs";
import { getTheme } from "../src/themes.mjs";

const select = document.getElementById("example-select");
const editor = document.getElementById("editor");
const output = document.getElementById("output");
const status = document.getElementById("status");

applyThemeVariables(getTheme("portal"));
populateExamples();
render();
loadSelected(); // show a non-empty starting point without changing the dropdown's option count

select.addEventListener("change", loadSelected);
editor.addEventListener("input", render);

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
  output.textContent = "";
  const results = convertMarkdown(editor.value);
  if (results.length === 0) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No mermaid blocks found in this Markdown yet.";
    output.appendChild(p);
    return;
  }
  for (const r of results) output.appendChild(renderBlock(r));
}

function renderBlock(r) {
  const section = document.createElement("section");
  section.className = `block block-${r.kind}`;

  const h = document.createElement("h3");
  h.textContent = r.title;
  section.appendChild(h);

  if (r.kind === "health") {
    const wrap = document.createElement("div");
    wrap.className = "svg-wrap";
    // Trusted: r.svg is emitted by renderSwimlane (existing library code), not raw user HTML.
    wrap.innerHTML = r.svg;
    section.appendChild(wrap);
  } else if (r.kind === "unsupported") {
    const p = document.createElement("p");
    p.className = "message unsupported";
    p.textContent = r.message;
    section.appendChild(p);
  } else {
    const p = document.createElement("p");
    p.className = "message error";
    p.textContent = `Render error: ${r.message}`;
    section.appendChild(p);
  }
  return section;
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
