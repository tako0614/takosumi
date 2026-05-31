import assert from "node:assert/strict";
import {
  OFFICIAL_MATERIAL_KIND_NAMES,
  PROJECTION_FAMILY_NAMES,
} from "takosumi-contract/catalog";

// Takosumi is a kind-agnostic framework. The official portable kind catalog is
// published *spec*, not framework source: each descriptor is flat JSON-LD under
// docs/kinds/v1/<name>.jsonld, served at https://takosumi.com/kinds/v1/<name>.
// The kernel / contract / installer / cli / runtime-agent import none of them.
// Backend-specific native kind descriptors + their KernelPlugin implementations
// live in the sibling ../takosumi-plugins repository.
const ROOT = new URL("../", import.meta.url);
const CATALOG_ROOT = new URL("docs/kinds/v1/", ROOT);

const PORTABLE_KINDS = [
  "gateway",
  "kv-store",
  "message-queue",
  "object-store",
  "postgres",
  "sqlite",
  "vector-store",
  "web-service",
  "worker",
] as const;

// Source areas that constitute the framework itself; none may depend on a kind
// descriptor (that is what "kind-agnostic" means, RFC 0001).
const FRAMEWORK_SOURCE_DIRS = [
  "src/contract/",
  "src/kernel/",
  "src/installer/",
  "src/cli/",
  "src/runtime-agent/",
] as const;

interface DenoManifest {
  readonly name?: string;
  readonly exports?: Record<string, string>;
  readonly workspace?: readonly string[];
  readonly imports?: Record<string, string>;
}

interface KindDescriptor {
  readonly name?: string;
  readonly "@id"?: string;
  readonly referenceAliases?: readonly string[];
  readonly family?: string;
  readonly portableBase?: string;
  readonly spec?: {
    readonly properties?: Record<string, unknown>;
  };
  readonly capabilityTerms?: readonly string[];
  readonly listens?: Record<
    string,
    {
      readonly accepts?: readonly string[];
      readonly projectionFamilies?: readonly string[];
      readonly projectionMatrix?: Record<string, readonly string[]>;
      readonly requiredWhenReferencedBy?: string;
    }
  >;
}

function descriptorUrl(name: string): URL {
  return new URL(`${name}.jsonld`, CATALOG_ROOT);
}

Deno.test("takosumi framework ships no kind source packages", async () => {
  // No src/kinds tree: kinds are not framework source.
  await assert.rejects(
    () => Deno.stat(new URL("src/kinds", ROOT)),
    "src/kinds must not exist — the official catalog is published JSON-LD in docs/kinds/v1",
  );

  const manifest = await readJson<DenoManifest>(new URL("deno.json", ROOT));

  const kindExports = Object.keys(manifest.exports ?? {})
    .filter((subpath) =>
      subpath === "./kinds" || subpath.startsWith("./kind/")
    );
  assert.deepEqual(
    kindExports,
    [],
    "the framework package must not expose ./kind/* or ./kinds subpath exports",
  );

  const kindImports = Object.keys(manifest.imports ?? {})
    .filter((specifier) => specifier.startsWith("@takos/takosumi-kind-"));
  assert.deepEqual(
    kindImports,
    [],
    "the framework import map must not self-map any @takos/takosumi-kind-* alias",
  );
});

Deno.test("framework source imports no kind descriptor (kind-agnostic guard)", async () => {
  for (const dir of FRAMEWORK_SOURCE_DIRS) {
    const files = await listTsFiles(new URL(dir, ROOT));
    for (const file of files) {
      const source = await Deno.readTextFile(file);
      for (const specifier of importSpecifiers(source)) {
        assert.equal(
          specifier.includes("takosumi-kind-") ||
            /(?:^|\/)kinds\//.test(specifier),
          false,
          `${
            relativeToRoot(file)
          }: framework source must not import a kind descriptor (${specifier})`,
        );
      }
    }
  }
});

Deno.test("published portable catalog has all 9 base descriptors with portable URIs", async () => {
  const names: string[] = [];
  for await (const entry of Deno.readDir(CATALOG_ROOT)) {
    if (entry.isFile && entry.name.endsWith(".jsonld")) {
      names.push(entry.name.replace(/\.jsonld$/, ""));
    }
  }
  assert.deepEqual(names.sort(), [...PORTABLE_KINDS]);

  for (const name of PORTABLE_KINDS) {
    const descriptor = await readJson<KindDescriptor>(descriptorUrl(name));
    assert.equal(
      descriptor["@id"],
      `https://takosumi.com/kinds/v1/${name}`,
      `${name}: descriptor @id must be the portable kind URI`,
    );
    assert.equal(
      descriptor.portableBase,
      undefined,
      `${name}: a portable base descriptor must not declare portableBase`,
    );
  }
});

Deno.test("portable kind descriptors use implementation-neutral material wording", async () => {
  for (const name of PORTABLE_KINDS) {
    const descriptorSource = await Deno.readTextFile(descriptorUrl(name));
    assertNoProviderLocalWording(
      descriptorSource,
      `docs/kinds/v1/${name}.jsonld`,
    );
  }
});

Deno.test("portable kind descriptors use closed official spec schemas", async () => {
  for (const name of PORTABLE_KINDS) {
    const descriptorSource = await Deno.readTextFile(descriptorUrl(name));
    assertNoOpenAdditionalProperties(
      descriptorSource,
      `docs/kinds/v1/${name}.jsonld`,
    );
  }
});

Deno.test("portable kind descriptors match family listen contracts", async () => {
  for (const name of PORTABLE_KINDS) {
    const descriptor = await readJson<KindDescriptor>(descriptorUrl(name));
    assert.deepEqual(
      normalizeListenContract(descriptor.listens),
      expectedListenContract(name),
      `${name}: listens`,
    );
  }
});

Deno.test("portable kind descriptors do not advertise backend-specific capabilities", async () => {
  const forbiddenCapabilities: Readonly<Record<string, readonly string[]>> = {
    "gateway": ["sni", "alpn-acme", "http3", "redirects"],
    "kv-store": [],
    "message-queue": [],
    "object-store": [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "event-notifications",
      "lifecycle-rules",
      "multipart-upload",
    ],
    "postgres": ["read-replicas", "ssl-required", "ipv6", "extensions"],
    "sqlite": [],
    "vector-store": [],
    "web-service": [
      "scale-to-zero",
      "long-request",
      "sticky-session",
      "geo-routing",
      "crons",
      "private-networking",
    ],
    "worker": ["scale-to-zero", "long-request", "geo-routing"],
  };

  for (const name of PORTABLE_KINDS) {
    const descriptor = await readJson<KindDescriptor>(descriptorUrl(name));
    const capabilityTerms = new Set(descriptor.capabilityTerms ?? []);
    for (const term of forbiddenCapabilities[name]) {
      assert.equal(
        capabilityTerms.has(term),
        false,
        `${name}: ${term} belongs in a native kind descriptor`,
      );
    }
  }
});

Deno.test("portable object-store descriptor keeps backend controls out of spec", async () => {
  const descriptor = await readJson<KindDescriptor>(
    descriptorUrl("object-store"),
  );
  assert.deepEqual(
    Object.keys(descriptor.spec?.properties ?? {}).sort(),
    ["name"],
  );
});

Deno.test("runtime-agent package uses narrow contract subpaths", async () => {
  const files = await listTsFiles(new URL("src/runtime-agent/", ROOT));
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    assert.equal(
      source.includes("takosumi-contract/reference/compat"),
      false,
      `${
        relativeToRoot(file)
      }: import the specific contract subpath instead of the broad compat umbrella`,
    );
  }
});

Deno.test("takosumi scripts use narrow contract subpaths", async () => {
  const broadCompatSubpath = "takosumi-contract/reference/" + "compat";
  const files = await listTsFiles(new URL("scripts/", ROOT));
  for (const file of files) {
    if (relativeToRoot(file) === "scripts/kind-package-ownership_test.ts") {
      continue;
    }
    const source = await Deno.readTextFile(file);
    assert.equal(
      source.includes(broadCompatSubpath),
      false,
      `${
        relativeToRoot(file)
      }: import the specific contract subpath instead of the broad compat umbrella`,
    );
  }
});

Deno.test("kernel plugin registry uses the plugin contract subpath", async () => {
  const broadCompatSubpath = "takosumi-contract/reference/" + "compat";
  const files = await listTsFiles(new URL("src/kernel/plugins/", ROOT));
  for (const file of files) {
    const source = await Deno.readTextFile(file);
    assert.equal(
      source.includes(broadCompatSubpath),
      false,
      `${
        relativeToRoot(file)
      }: plugin registry code must import reference/plugin directly`,
    );
  }
});

Deno.test("reference compat does not expose legacy provider bridge", async () => {
  const compat = await Deno.readTextFile(
    new URL("src/contract/reference-compat.ts", ROOT),
  );
  assert.equal(
    compat.includes("./provider-plugin.ts"),
    false,
    "reference/compat must not re-export the legacy ProviderPlugin bridge",
  );

  const manifest = await readJson<DenoManifest>(new URL("deno.json", ROOT));
  assert.equal(
    manifest.imports?.["@takos/takosumi-contract/internal/provider-plugin"],
    "./src/contract/provider-plugin.ts",
    "legacy provider bridge stays reachable only via the internal contract alias",
  );
});

Deno.test("kind alias docs state that the resolved URI owns the schema", async () => {
  const docs = [
    "docs/reference/kind-bindings.md",
    "docs/reference/kind-packages.md",
    "docs/en/reference/kind-packages.md",
    "docs/reference/plugin-loading.md",
    "docs/operator/bootstrap.md",
  ] as const;
  const forbiddenPhrases = [
    "operator が `worker` を `cloudflare-worker` に map",
    "portable alias を特定の native kind に map",
    "map a portable alias to a native kind",
    "kindAliases: { worker: WORKER_KIND }",
    "worker: WORKER_KIND",
    "postgres: DB_KIND",
  ] as const;

  for (const doc of docs) {
    const source = await Deno.readTextFile(new URL(doc, ROOT));
    for (const phrase of forbiddenPhrases) {
      assert.equal(
        source.includes(phrase),
        false,
        `${doc}: do not imply that a portable alias keeps portable schema after resolving to a native kind URI`,
      );
    }
  }

  assert.match(
    await Deno.readTextFile(new URL("docs/reference/kind-bindings.md", ROOT)),
    /解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します/,
  );
  assert.match(
    await Deno.readTextFile(
      new URL("docs/en/reference/kind-packages.md", ROOT),
    ),
    /The resolved kind URI owns the `spec` schema, output slots, and connection compatibility/,
  );
  assert.match(
    await Deno.readTextFile(new URL("docs/operator/bootstrap.md", ROOT)),
    /native kind alias を有効にする例です/,
  );
});

Deno.test("reference plugin docs show explicit operator lifecycle clients", async () => {
  const docs = [
    "AGENTS.md",
    "src/contract/README.md",
    "docs/rfc/0001-kernel-kind-agnostic.md",
    "docs/reference/plugin-loading.md",
    "docs/reference/catalog.md",
    "docs/reference/kind-bindings.md",
    "docs/reference/kind-packages.md",
    "docs/operator/bootstrap.md",
    "docs/en/reference/plugin-loading.md",
    "docs/en/reference/kind-bindings.md",
    "docs/en/reference/kind-packages.md",
  ] as const;
  const forbiddenPhrases = [
    "cloudflareWorkerPlugin()",
    "cloudflareR2ObjectStorePlugin()",
    "cloudflareWorkerPlugin(...)",
    "cloudflareR2ObjectStorePlugin(...)",
    "cloudflareWorkerPlugin({ accountId })",
    'awsS3ObjectStorePlugin({ region: "us-east-1" })',
    'awsRdsPostgresPlugin({ region: "us-east-1" })',
    'dockerComposeWebServicePlugin({ hostBinding: "127.0.0.1" })',
    "dockerPostgresPlugin()",
    "filesystemObjectStorePlugin()",
  ] as const;

  for (const doc of docs) {
    const source = await Deno.readTextFile(new URL(doc, ROOT));
    for (const phrase of forbiddenPhrases) {
      assert.equal(
        source.includes(phrase),
        false,
        `${doc}: reference plugin examples must pass operator-owned lifecycle clients explicitly`,
      );
    }
  }

  assert.match(
    await Deno.readTextFile(new URL("docs/reference/plugin-loading.md", ROOT)),
    /cloudflareWorkerPlugin\(\{ accountId, lifecycle \}\)/,
  );
  assert.match(
    await Deno.readTextFile(new URL("docs/operator/bootstrap.md", ROOT)),
    /dockerPostgresPlugin\(\{ lifecycle: databaseLifecycle \}\)/,
  );
});

function importSpecifiers(source: string): readonly string[] {
  const specifiers: string[] = [];
  const re = /(?:import|export)[^;]*?\sfrom\s*["']([^"']+)["']/g;
  for (let match = re.exec(source); match !== null; match = re.exec(source)) {
    specifiers.push(match[1]);
  }
  const dynamic = /import\(\s*["']([^"']+)["']\s*\)/g;
  for (
    let match = dynamic.exec(source);
    match !== null;
    match = dynamic.exec(source)
  ) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

async function listTsFiles(root: URL): Promise<readonly URL[]> {
  const files: URL[] = [];
  for await (const entry of Deno.readDir(root)) {
    const url = new URL(`${entry.name}${entry.isDirectory ? "/" : ""}`, root);
    if (entry.isDirectory) {
      files.push(...await listTsFiles(url));
    } else if (entry.isFile && entry.name.endsWith(".ts")) {
      files.push(url);
    }
  }
  return files.sort((left, right) =>
    left.pathname.localeCompare(right.pathname)
  );
}

async function readJson<T>(url: URL): Promise<T> {
  return JSON.parse(await Deno.readTextFile(url)) as T;
}

function assertNoProviderLocalWording(source: string, label: string): void {
  for (
    const phrase of [
      `provider${"-"}local`,
      `Provider${"-"}local`,
      `provider${"-"}scope`,
      `Provider${"-"}scope`,
    ]
  ) {
    assert.equal(
      source.includes(phrase),
      false,
      `${label}: use implementation-local wording instead of ${phrase}`,
    );
  }
}

function assertNoOpenAdditionalProperties(source: string, label: string): void {
  assert.equal(
    source.includes(`"additionalProperties": true`),
    false,
    `${label}: official descriptor schemas must spell supported fields instead of using additionalProperties: true`,
  );
}

function relativeToRoot(url: URL): string {
  return decodeURIComponent(url.pathname.replace(ROOT.pathname, ""));
}

function expectedListenContract(family: string): unknown {
  switch (family) {
    case "worker":
    case "web-service":
      return {
        "*": {
          accepts: [...OFFICIAL_MATERIAL_KIND_NAMES],
          projectionFamilies: [...PROJECTION_FAMILY_NAMES].sort(),
          projectionMatrix: {
            "billing.port@v1": ["config-mount", "secret-env"],
            "event-channel": ["config-mount", "secret-env"],
            "http-endpoint": ["config-mount", "env", "upstream"],
            "identity.oidc@v1": ["config-mount", "secret-env"],
            "mcp-server@v1": ["config-mount", "secret-env"],
            "object-store": ["config-mount", "secret-env"],
            "service-binding": ["config-mount", "secret-env"],
          },
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
    case "kv-store":
    case "message-queue":
    case "postgres":
    case "object-store":
    case "sqlite":
    case "vector-store":
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
      ...(entry.projectionMatrix
        ? {
          projectionMatrix: normalizeProjectionMatrix(entry.projectionMatrix),
        }
        : {}),
      ...(entry.requiredWhenReferencedBy
        ? { requiredWhenReferencedBy: entry.requiredWhenReferencedBy }
        : {}),
    };
  }
  return normalized;
}

function normalizeProjectionMatrix(
  matrix: Record<string, readonly string[]>,
): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(matrix)
      .map(([contract, projections]): [string, string[]] => [
        contract,
        [...projections].sort(),
      ])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}
