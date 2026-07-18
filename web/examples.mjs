// examples.mjs — curated example Markdown files listed in the dropdown, fetched relative to the
// app's own page so GitHub Pages can serve them straight from the repository without copying.
export const EXAMPLES = [
  { path: "kitchen-sink.md", label: "kitchen-sink.md — Kitchen sink health model" },
  { path: "pills-stress.md", label: "pills-stress.md — Pills stress test" },
  { path: "examples/showcase.md", label: "examples/showcase.md — diagrammo showcase" },
  { path: "docs/how-it-works.md", label: "docs/how-it-works.md — How ahm-diagrammo works" },
];

export async function loadExample(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`failed to load ${path}: ${res.status} ${res.statusText}`);
  return res.text();
}
