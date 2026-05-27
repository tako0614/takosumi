import assert from "node:assert/strict";
import {
  OFFICIAL_MATERIAL_KIND_NAMES,
  PROJECTION_FAMILY_NAMES,
} from "takosumi-contract/catalog";

const ROOT = new URL("../", import.meta.url);
const PACKAGE_ROOT = new URL("packages/", ROOT);

const PORTABLE_KIND_PACKAGES = [
  "kind-gateway",
  "kind-kv-store",
  "kind-message-queue",
  "kind-object-store",
  "kind-postgres",
  "kind-sqlite",
  "kind-vector-store",
  "kind-web-service",
  "kind-worker",
] as const;

const GENERATED_FILE_BY_PACKAGE: Readonly<Record<string, string>> = {
  "kind-gateway": "gateway.generated.ts",
  "kind-kv-store": "kv-store.generated.ts",
  "kind-message-queue": "message-queue.generated.ts",
  "kind-object-store": "object-store.generated.ts",
  "kind-postgres": "database-postgres.generated.ts",
  "kind-sqlite": "sqlite.generated.ts",
  "kind-vector-store": "vector-store.generated.ts",
  "kind-web-service": "web-service.generated.ts",
  "kind-worker": "worker.generated.ts",
};

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

interface KindModule {
  readonly KIND_ALIASES?: Readonly<Record<string, string>>;
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

Deno.test("portable kind package aliases and READMEs mirror descriptors", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const manifest = await readJson<DenoManifest>(
      new URL(`${dir}/deno.json`, PACKAGE_ROOT),
    );
    const descriptor = await readJson<KindDescriptor>(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    const mod = await import(
      new URL(`../packages/${dir}/mod.ts`, import.meta.url).href
    ) as KindModule;
    const kindUri = descriptor["@id"] ?? "";
    const expectedAliases = Object.fromEntries(
      (descriptor.referenceAliases ?? []).map((alias) => [alias, kindUri]),
    );

    assert.equal(manifest.exports?.["."], "./mod.ts", `${dir}: root export`);
    assert.equal(
      manifest.exports?.["./spec/kind.jsonld"],
      undefined,
      `${dir}: raw JSON-LD descriptors are catalog assets, not JSR module exports`,
    );

    assert.deepEqual(
      mod.KIND_ALIASES,
      expectedAliases,
      `${dir}: KIND_ALIASES must match descriptor.referenceAliases`,
    );

    const readme = await Deno.readTextFile(
      new URL(`${dir}/README.md`, PACKAGE_ROOT),
    );
    assert.ok(readme.includes(`# ${manifest.name}`), `${dir}: README title`);
    assert.ok(
      readme.includes(`Kind URI: \`${kindUri}\``),
      `${dir}: README kind URI`,
    );
    assert.ok(readme.includes("## Spec Fields"), `${dir}: README spec`);
    assert.ok(
      readme.includes("## Output Slot Contract"),
      `${dir}: README output slot`,
    );
    assert.ok(readme.includes("## Outputs"), `${dir}: README outputs`);
    assert.ok(
      readme.includes("does not choose a backend or provision resources"),
      `${dir}: README boundary`,
    );
  }
});

Deno.test("runtime-agent package uses narrow contract subpaths", async () => {
  const files = await listTsFiles(new URL("runtime-agent/src/", PACKAGE_ROOT));
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
  const files = await listTsFiles(new URL("kernel/src/plugins/", PACKAGE_ROOT));
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
    new URL("packages/contract/src/reference-compat.ts", ROOT),
  );
  assert.equal(
    compat.includes("./provider-plugin.ts"),
    false,
    "reference/compat must not re-export the legacy ProviderPlugin bridge",
  );

  const manifest = await readJson<DenoManifest>(
    new URL("packages/contract/deno.json", ROOT),
  );
  assert.equal(
    manifest.exports?.["./reference/provider-plugin"],
    undefined,
    "ProviderPlugin must stay off the public reference subpath surface",
  );
  assert.equal(
    manifest.exports?.["./reference/kernel-plugin-adapter"],
    undefined,
    "kernelPluginFromProviderPlugin must stay off the public reference subpath surface",
  );
  assert.equal(
    manifest.exports?.["./internal/provider-plugin"],
    "./src/provider-plugin.ts",
    "legacy provider bridge should be available only as an internal compatibility subpath",
  );
});

Deno.test("portable kind descriptors use implementation-neutral material wording", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptorSource = await Deno.readTextFile(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    assertNoProviderLocalWording(
      descriptorSource,
      `packages/${dir}/spec/kind.jsonld`,
    );
    const generated = await Deno.readTextFile(
      new URL(
        `${dir}/src/${GENERATED_FILE_BY_PACKAGE[dir]}`,
        PACKAGE_ROOT,
      ),
    );
    assertNoProviderLocalWording(
      generated,
      `packages/${dir}/src/${GENERATED_FILE_BY_PACKAGE[dir]}`,
    );
  }
});

Deno.test("portable kind descriptors use closed official spec schemas", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptorSource = await Deno.readTextFile(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    assertNoOpenAdditionalProperties(
      descriptorSource,
      `packages/${dir}/spec/kind.jsonld`,
    );
  }
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

Deno.test("portable kind descriptors do not advertise backend-specific capabilities", async () => {
  const forbiddenCapabilities: Readonly<Record<string, readonly string[]>> = {
    "kind-gateway": ["sni", "alpn-acme", "http3", "redirects"],
    "kind-kv-store": [],
    "kind-message-queue": [],
    "kind-object-store": [
      "versioning",
      "presigned-urls",
      "server-side-encryption",
      "public-access",
      "event-notifications",
      "lifecycle-rules",
      "multipart-upload",
    ],
    "kind-postgres": ["read-replicas", "ssl-required", "ipv6", "extensions"],
    "kind-sqlite": [],
    "kind-vector-store": [],
    "kind-web-service": [
      "scale-to-zero",
      "long-request",
      "sticky-session",
      "geo-routing",
      "crons",
      "private-networking",
    ],
    "kind-worker": ["scale-to-zero", "long-request", "geo-routing"],
  };

  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptor = await readJson<KindDescriptor>(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    const capabilityTerms = new Set(descriptor.capabilityTerms ?? []);
    for (const term of forbiddenCapabilities[dir]) {
      assert.equal(
        capabilityTerms.has(term),
        false,
        `${dir}: ${term} belongs in a native kind descriptor`,
      );
    }
  }
});

Deno.test("portable object-store descriptor keeps backend controls out of spec", async () => {
  const descriptor = await readJson<KindDescriptor>(
    new URL("kind-object-store/spec/kind.jsonld", PACKAGE_ROOT),
  );
  assert.deepEqual(
    Object.keys(descriptor.spec?.properties ?? {}).sort(),
    ["name"],
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
    "packages/contract/README.md",
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

Deno.test("portable generated kind helpers expose typed output field names", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const generated = await Deno.readTextFile(
      new URL(
        `${dir}/src/${GENERATED_FILE_BY_PACKAGE[dir]}`,
        PACKAGE_ROOT,
      ),
    );
    const prefix = generatedPrefix(dir.slice("kind-".length));
    assert.match(
      generated,
      new RegExp(`export type ${prefix}OutputFieldName =\\n  \\| "`),
      `${dir}: missing output field name union`,
    );
    assert.match(
      generated,
      new RegExp(
        `export const ${
          constantPrefix(prefix)
        }_OUTPUT_FIELDS:\\s+readonly ${prefix}OutputFieldName\\[\\]\\s*=\\s*\\[`,
      ),
      `${dir}: output fields const must use the output field union`,
    );
  }
});

Deno.test("portable generated kind helpers expose typed output slot descriptors", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptor = await readJson<{ readonly outputSlots?: unknown }>(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    const generated = await Deno.readTextFile(
      new URL(
        `${dir}/src/${GENERATED_FILE_BY_PACKAGE[dir]}`,
        PACKAGE_ROOT,
      ),
    );
    const prefix = generatedPrefix(dir.slice("kind-".length));
    const upper = constantPrefix(prefix);

    assert.match(
      generated,
      new RegExp(`export type ${prefix}OutputSlotName =`),
      `${dir}: missing output slot name union`,
    );
    assert.match(
      generated,
      new RegExp(`export type ${prefix}OutputSlotContract =`),
      `${dir}: missing output slot contract union`,
    );
    assert.match(
      generated,
      new RegExp(`export interface ${prefix}OutputSlotDescriptor`),
      `${dir}: missing output slot descriptor interface`,
    );
    assert.match(
      generated,
      new RegExp(
        `export const ${upper}_OUTPUT_SLOT_DESCRIPTORS:\\s+readonly ${prefix}OutputSlotDescriptor\\[\\]\\s*=\\s*\\[`,
      ),
      `${dir}: missing typed output slot descriptors const`,
    );
    for (const outputSlot of Object.keys(descriptor.outputSlots ?? {})) {
      assert.match(
        generated,
        new RegExp(`name: ${JSON.stringify(outputSlot)}`),
        `${dir}: missing generated output slot ${outputSlot}`,
      );
    }
  }
});

Deno.test("portable generated kind helpers expose listen slot descriptors", async () => {
  for (const dir of PORTABLE_KIND_PACKAGES) {
    const descriptor = await readJson<KindDescriptor>(
      new URL(`${dir}/spec/kind.jsonld`, PACKAGE_ROOT),
    );
    const generated = await Deno.readTextFile(
      new URL(
        `${dir}/src/${GENERATED_FILE_BY_PACKAGE[dir]}`,
        PACKAGE_ROOT,
      ),
    );
    const prefix = generatedPrefix(dir.slice("kind-".length));
    assert.match(
      generated,
      new RegExp(`export interface ${prefix}ListenSlotDescriptor`),
      `${dir}: missing listen slot descriptor interface`,
    );
    assert.match(
      generated,
      new RegExp(
        `export const ${
          constantPrefix(prefix)
        }_LISTEN_SLOTS:\\s+readonly ${prefix}ListenSlotDescriptor\\[\\]\\s*=\\s*\\[`,
      ),
      `${dir}: missing generated listen slots const`,
    );
    for (const slot of Object.keys(descriptor.listens ?? {})) {
      assert.match(
        generated,
        new RegExp(`name: ${JSON.stringify(slot)}`),
        `${dir}: missing generated listen slot ${slot}`,
      );
    }
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

function normalizeWorkspace(workspace: readonly string[]): string[] {
  return workspace.map((entry) => entry.replace(/^\.\//, "").replace(/\/$/, ""))
    .sort();
}

function generatedPrefix(kind: string): string {
  switch (kind) {
    case "gateway":
      return "Gateway";
    case "kv-store":
      return "KvStore";
    case "message-queue":
      return "MessageQueue";
    case "object-store":
      return "ObjectStore";
    case "postgres":
      return "DatabasePostgres";
    case "sqlite":
      return "Sqlite";
    case "vector-store":
      return "VectorStore";
    case "web-service":
      return "WebService";
    case "worker":
      return "Worker";
    default:
      assert.fail(`unknown kind ${kind}`);
  }
}

function constantPrefix(prefix: string): string {
  return prefix.replace(
    /[A-Z]/g,
    (match, index) => index === 0 ? match : `_${match}`,
  ).toUpperCase();
}
