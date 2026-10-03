import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { assertHydrationArtifact } from "./assert-hydration-artifact.mjs";

const root = new URL("../", import.meta.url);
const outputPath = new URL(".output/public/index.html", root);
const template = await readFile(outputPath, "utf8");
const appOutlet = "<!--takosumi-prerender-outlet-->";
const hydrationOutlet = "<!--takosumi-hydration-bootstrap-outlet-->";

if (template.split(appOutlet).length !== 2) {
  throw new Error("Expected exactly one Takosumi prerender outlet in the built HTML template");
}
if (template.split(hydrationOutlet).length !== 2) {
  throw new Error("Expected exactly one Takosumi hydration bootstrap outlet in the built HTML template");
}

const { renderApp, renderHydrationBootstrap } = await import(fileURLToPath(new URL(".output/server/entry-server.js", root)));
const html = template
  .replace(appOutlet, renderApp())
  .replace(hydrationOutlet, renderHydrationBootstrap())
  .replace('data-prerendered="false"', 'data-prerendered="true"');

if (!html.includes('<main id="main">')) {
  throw new Error("Prerendered landing page is missing its main content");
}
if (!html.includes("<title>Takosumi</title>") || !html.includes("application/ld+json")) {
  throw new Error("Prerendered landing page is missing the public metadata contract");
}

await writeFile(outputPath, html);
assertHydrationArtifact(await readFile(outputPath, "utf8"));
