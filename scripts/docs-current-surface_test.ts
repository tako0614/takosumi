import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";

const ROOT = new URL("../", import.meta.url);

const REQUIRED_DOCS = [
  "docs/index.md",
  "docs/getting-started/quickstart.md",
  "docs/reference/model.md",
  "docs/reference/deploy-control-api.md",
  "docs/reference/runner-profiles.md",
  "docs/reference/operator.md",
  "docs/reference/cli.md",
  "docs/en/index.md",
  "docs/en/getting-started/quickstart.md",
  "docs/en/reference/model.md",
  "docs/en/reference/deploy-control-api.md",
  "docs/en/reference/runner-profiles.md",
  "docs/en/reference/operator.md",
  "docs/en/reference/cli.md",
] as const;

const RETIRED_DOC_PATHS = [
  docPath("accounts"),
  docPath("ki" + "nds"),
  docPath("operator"),
  docPath("reference", "cata" + "log.md"),
  docPath("reference", "ki" + "nd-bindings.md"),
  docPath("reference", "ki" + "nd-packages.md"),
  docPath("reference", "build-spec.md"),
  docPath("reference", "platform-services.md"),
  docPath("reference", "takosumi-v1.md"),
  docPath("reference", "spec-boundaries.md"),
  docPath("reference", "public-spec-source-" + "map.md"),
] as const;

const RETIRED_DOC_TERMS: readonly (string | RegExp)[] = [
  "App" + "Spec",
  // The retired `.takosumi/` in-repo metadata convention (trailing slash keeps
  // legitimate hostnames like app.takosumi.com out of this check).
  "." + "takosumi/",
  "takosumi-" + "cloud",
  // Word-bounded: the retired product name must not match "Takosumi Cloudflare"
  // (= service-owned Cloudflare wording in the core spec).
  new RegExp("\\bTakosumi " + "Cloud\\b"),
  "takosumi-" + "plugins",
  "official " + "catalog",
  "kind " + "descriptor",
  "backend " + "plugin",
  "Deno" + "-first",
  "dn" + "t",
];

test("Takosumi docs are rebuilt around current OpenTofu-native surface", async () => {
  for (const path of REQUIRED_DOCS) {
    const entry = await stat(new URL(path, ROOT));
    assert.equal(entry.isFile(), true, `missing ${path}`);
  }

  for (const path of RETIRED_DOC_PATHS) {
    await assert.rejects(
      () => stat(new URL(path, ROOT)),
      `retired docs path must not exist: ${path}`,
    );
  }

  const docs = await readDocs();
  for (const term of RETIRED_DOC_TERMS) {
    const hit = typeof term === "string" ? docs.includes(term) : term.test(docs);
    assert.equal(hit, false, `retired docs term: ${term}`);
  }

  // The 2026-06-07 core-spec surface: Space-direct OpenTofu Capsule DAG model.
  assert.match(
    docs,
    /OpenTofu Capsule DAG (?:を管理する OSS control plane|directly under a Space)/,
  );
  assert.match(docs, /CapsuleCompatibilityReport/);
  assert.match(docs, /OutputSnapshot/);
  assert.match(docs, /CapabilityBinding/);
  assert.match(docs, /DependencySnapshot/);
});

test("website build no longer publishes docs kind overlays", async () => {
  const buildScript = await readText(new URL("website/build.sh", ROOT));
  assert.equal(buildScript.includes("/ki" + "nds/v1"), false);
  assert.equal(buildScript.includes("docs/ki" + "nds"), false);

  const worker = await readText(new URL("website/public/_worker.js", ROOT));
  assert.match(worker, /status: 404/);
  assert.ok(worker.includes("/ki" + "nds/"));
});

async function readDocs(): Promise<string> {
  const chunks: string[] = [];
  for await (const file of walk(new URL("docs/", ROOT))) {
    if (!file.pathname.endsWith(".md")) continue;
    chunks.push(await readText(file));
  }
  return chunks.join("\n");
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.name === "node_modules" || entry.name === ".vitepress") continue;
    if (entry.isDirectory()) {
      yield* walk(child);
    } else if (entry.isFile()) {
      yield child;
    }
  }
}

async function readText(path: URL): Promise<string> {
  return await readFile(path, "utf8");
}

function docPath(...segments: readonly string[]): string {
  return ["docs", ...segments].join("/");
}
