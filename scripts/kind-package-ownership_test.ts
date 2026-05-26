import assert from "node:assert/strict";
import {
  OFFICIAL_OUTPUT_TYPE_NAMES,
  PROJECTION_FAMILY_NAMES,
} from "takosumi-contract/type-catalog";

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

interface KindDescriptor {
  readonly family?: string;
  readonly listens?: Record<
    string,
    {
      readonly accepts?: readonly string[];
      readonly projectionFamilies?: readonly string[];
      readonly requiredWhenReferencedBy?: string;
    }
  >;
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

Deno.test("portable kind descriptors match family listen contracts", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptor = await readJson<KindDescriptor>(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    assert.deepEqual(
      normalizeListenContract(descriptor.listens),
      expectedListenContract(dir.slice("kind-".length)),
      `${dir}: listens`,
    );
  }
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

function expectedListenContract(family: string): unknown {
  switch (family) {
    case "worker":
    case "web-service":
      return {
        "*": {
          accepts: [...OFFICIAL_OUTPUT_TYPE_NAMES],
          projectionFamilies: [...PROJECTION_FAMILY_NAMES].sort(),
        },
      };
    case "gateway":
      return {
        "*": {
          accepts: ["http-endpoint"],
          projectionFamilies: ["upstream"],
          requiredWhenReferencedBy: "spec.routes[].to",
        },
      };
    case "postgres":
    case "object-store":
      return undefined;
    default:
      assert.fail(`unknown kind family ${family}`);
  }
}

function normalizeListenContract(
  listens: KindDescriptor["listens"],
): unknown {
  if (listens === undefined) return undefined;
  const normalized: Record<string, unknown> = {};
  for (const [name, entry] of Object.entries(listens)) {
    normalized[name] = {
      accepts: [...(entry.accepts ?? [])],
      projectionFamilies: [...(entry.projectionFamilies ?? [])].sort(),
      ...(entry.requiredWhenReferencedBy
        ? { requiredWhenReferencedBy: entry.requiredWhenReferencedBy }
        : {}),
    };
  }
  return normalized;
}

function normalizeWorkspace(workspace: readonly string[]): string[] {
  return workspace.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .sort();
}
