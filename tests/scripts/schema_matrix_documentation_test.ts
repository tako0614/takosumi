import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (path: string): string => readFileSync(join(root, path), "utf8");

function numericVersions(source: string): number[] {
  return [...source.matchAll(/^\s+version:\s*(\d+),\s*$/gmu)].map((match) =>
    Number(match[1]),
  );
}

function catalogBody(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error(`catalog markers missing: ${start} .. ${end}`);
  }
  return source.slice(startIndex, endIndex);
}

function maximum(values: readonly number[], label: string): number {
  if (values.length === 0) throw new Error(`${label} has no versions`);
  return Math.max(...values);
}

test("JP and EN schema matrices follow current source authorities", () => {
  const jp = read("docs/reference/schema-matrix.md");
  const en = read("docs/en/reference/schema-matrix.md");
  const matrices = [jp, en];

  const packageVersion = JSON.parse(read("package.json")).version as string;
  const contractVersion = JSON.parse(read("contract/package.json")).version as string;

  const capabilities = read("contract/capabilities.ts");
  const apiVersion = capabilities.match(
    /TAKOSUMI_API_VERSION\s*=\s*"([^"]+)"/u,
  )?.[1];
  expect(apiVersion).toBeDefined();

  const openapi = read("core/api/openapi.ts");
  const openapiVersion = openapi.match(
    /TAKOSUMI_OPENAPI_VERSION\s*=\s*"([^"]+)"/u,
  )?.[1];
  expect(openapiVersion).toBe(packageVersion);

  const storageVersions = numericVersions(read("core/adapters/storage/migrations.ts"));
  const storageLatest = maximum(storageVersions, "PostgreSQL storage catalog");

  const d1Source = read("worker/src/d1_opentofu_store.ts");
  const d1Catalog = catalogBody(
    d1Source,
    "const D1_OPEN_TOFU_SCHEMA_MIGRATIONS = [",
    "] as const satisfies readonly D1OpenTofuSchemaMigration[];",
  );
  const d1Versions = numericVersions(d1Catalog);
  const d1Latest = maximum(d1Versions, "control D1 catalog");

  const accountsPgVersions = readdirSync(join(root, "accounts/service/migrations"))
    .map((name) => name.match(/^(\d{3})_.*\.sql$/u)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number);
  const accountsPgLatest = maximum(accountsPgVersions, "Accounts PostgreSQL catalog");

  const accountsD1Source = read("cli/src/cli-accounts-db.ts");
  const accountsD1Catalog = catalogBody(
    accountsD1Source,
    "const D1_ACCOUNTS_MIGRATIONS: readonly D1AccountsMigration[] = [",
    "];\n// Immutable account-plane schema migration catalog ends.",
  );
  const accountsD1Latest = maximum(
    numericVersions(accountsD1Catalog),
    "Accounts D1 catalog",
  );

  const repositoryManifest = read("contract/repository-manifest.ts");
  const repositoryApiVersions = [
    ...repositoryManifest.matchAll(
      /TAKOSUMI_REPOSITORY_MANIFEST_API_VERSION(?:_V\d+(?:_\d+)*)?\s*=\s*"([^"]+)"/gu,
    ),
  ].map((match) => match[1]!);
  expect(repositoryApiVersions).toEqual([
    "takosumi.com/v1",
    "takosumi.com/v2",
    "takosumi.com/v2.1",
    "takosumi.com/v2.2",
    "takosumi.com/v2.3",
  ]);

  const publishedRepositorySchemas = readdirSync(join(root, "docs/public/schemas"))
    .map((name) => name.match(/^repository-manifest-(v\d+(?:\.\d+)*)\.schema\.json$/u)?.[1])
    .filter((value): value is string => value !== undefined)
    .sort();
  expect(publishedRepositorySchemas).toEqual(["v2.1", "v2.2", "v2.3"]);

  const requiredTokens = [
    packageVersion,
    contractVersion,
    apiVersion!,
    openapiVersion!,
    String(storageLatest),
    String(d1Latest),
    String(d1Versions.length),
    String(accountsD1Latest),
    ...repositoryApiVersions,
    ...publishedRepositorySchemas,
  ];
  for (const matrix of matrices) {
    for (const token of requiredTokens) expect(matrix).toContain(`\`${token}\``);
    expect(matrix).toContain(`\`${String(accountsPgLatest).padStart(3, "0")}\``);
  }
  expect(jp).toContain("単一の「schema version」はありません");
  expect(en).toContain('no single global "schema version"');
});

test("the public contract README does not advertise a retired manifest lane", () => {
  const contractReadme = read("contract/README.md");
  expect(contractReadme).not.toContain("takosumi.com/v1alpha1");
  for (const version of ["v1", "v2", "v2.1", "v2.2", "v2.3"]) {
    expect(contractReadme).toContain(`takosumi.com/${version}`);
  }
  expect(contractReadme).toContain("schema matrix");
});
