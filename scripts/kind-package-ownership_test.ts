import assert from "node:assert/strict";

const ROOT = new URL("../", import.meta.url);
const PACKAGE_ROOT = new URL("packages/", ROOT);

const PORTABLE_KIND_PACKAGES = [
  "kind-gateway",
  "kind-object-store",
  "kind-postgres",
  "kind-web-service",
  "kind-worker",
] as const;

const NATIVE_KIND_NAME_FRAGMENTS = [
  "aws",
  "azure",
  "cloudflare",
  "coredns",
  "deno-deploy",
  "docker",
  "filesystem",
  "gcp",
  "kubernetes",
  "minio",
  "systemd",
] as const;

interface DenoManifest {
  readonly workspace?: readonly string[];
  readonly imports?: Record<string, string>;
}

Deno.test("takosumi repository owns only portable kind packages", async () => {
  const kindPackageDirs = await listKindPackageDirs();
  assert.deepEqual(kindPackageDirs, PORTABLE_KIND_PACKAGES);

  for (const dir of kindPackageDirs) {
    for (const fragment of NATIVE_KIND_NAME_FRAGMENTS) {
      assert.equal(
        dir.includes(fragment),
        false,
        `${dir}: native kind packages belong in ../takosumi-plugins`,
      );
    }
  }
});

Deno.test("takosumi workspace and import map expose only portable kind packages", async () => {
  const manifest = await readJson<DenoManifest>(new URL("deno.json", ROOT));
  const expectedWorkspaceEntries = PORTABLE_KIND_PACKAGES.map((dir) =>
    `packages/${dir}`
  );
  const workspaceEntries = normalizeWorkspace(manifest.workspace ?? [])
    .filter((entry) => entry.startsWith("packages/kind-"));

  assert.deepEqual(workspaceEntries, expectedWorkspaceEntries);

  const kindImports = Object.entries(manifest.imports ?? {})
    .filter(([specifier]) => specifier.startsWith("@takos/takosumi-kind-"))
    .sort(([left], [right]) => left.localeCompare(right));

  assert.deepEqual(
    kindImports,
    PORTABLE_KIND_PACKAGES.map((dir) => [
      `@takos/takosumi-${dir}`,
      `./packages/${dir}/mod.ts`,
    ]),
  );
});

async function listKindPackageDirs(): Promise<readonly string[]> {
  const dirs: string[] = [];
  for await (const entry of Deno.readDir(PACKAGE_ROOT)) {
    if (entry.isDirectory && entry.name.startsWith("kind-")) {
      dirs.push(entry.name);
    }
  }
  return dirs.sort();
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

function normalizeWorkspace(workspace: readonly string[]): string[] {
  return workspace.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .sort();
}
