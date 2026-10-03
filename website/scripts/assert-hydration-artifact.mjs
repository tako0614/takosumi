import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

export function assertHydrationArtifact(html) {
  const appStart = html.indexOf('<div id="app"');
  const headEnd = html.indexOf("</head>");
  const clientModule = html.search(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=/i);
  assert.notEqual(appStart, -1, "generated HTML contains the hydrated app root");
  assert.notEqual(headEnd, -1, "generated HTML has a document head");
  assert.notEqual(clientModule, -1, "generated HTML has the client module runtime");

  const inlineScripts = [];
  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  for (const match of html.matchAll(scriptPattern)) {
    const openingIndex = match.index ?? -1;
    if (openingIndex >= clientModule) break;
    const attributes = match[1] ?? "";
    if (/\bsrc\s*=/.test(attributes)) continue;
    const type = attributes.match(/\btype\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase();
    if (type && type !== "text/javascript" && type !== "application/javascript") continue;
    inlineScripts.push({ openingIndex, closingIndex: openingIndex + match[0].length, code: match[2] ?? "" });
  }

  assert.equal(inlineScripts.length, 1, "generated HTML contains exactly one executable inline bootstrap before the client runtime");
  const [bootstrap] = inlineScripts;
  assert.ok(bootstrap.openingIndex < headEnd, "hydration bootstrap is in the document head");
  assert.ok(bootstrap.closingIndex < appStart, "hydration bootstrap is outside the hydrated app subtree");
  assert.ok(bootstrap.closingIndex < clientModule, "hydration bootstrap precedes the client runtime");

  const listeners = [];
  const browserGlobal = {};
  const document = { addEventListener: (name) => listeners.push(name) };
  Object.assign(browserGlobal, { window: browserGlobal, document });
  vm.runInNewContext(bootstrap.code, browserGlobal, { timeout: 1000 });

  const hydration = browserGlobal._$HY;
  assert.ok(hydration && typeof hydration === "object", "emitted bootstrap initializes the Solid hydration runtime");
  assert.ok(Array.isArray(hydration.events), "hydration runtime has an event queue");
  assert.equal(Object.prototype.toString.call(hydration.completed), "[object WeakSet]", "hydration runtime tracks completed nodes");
  assert.deepEqual(listeners, ["click", "input"], "hydration runtime captures the default delegated events before client code");
  return { bootstrapScripts: inlineScripts.length, clientRuntimeAfterBootstrap: true, appOutsideBootstrap: true, initializedEvents: listeners };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const artifactPath = process.argv[2] ?? new URL("../.output/public/index.html", import.meta.url);
  const html = await readFile(artifactPath, "utf8");
  console.log(JSON.stringify({ artifact: String(artifactPath), result: assertHydrationArtifact(html) }, null, 2));
}
