import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { isRetiredV1Path } from "../../contract/api-surface.ts";

const REPO_ROOT = resolve(import.meta.dir, "../..");

/**
 * These names are the durable tables owned by the retired embedded Host.
 * This is a lexical custody guard, not a SQL parser: it catches a new
 * production reader/writer before a stop-write or detach change.
 */
const LEGACY_TABLE_TOKEN_PATTERN =
  /(?<![A-Za-z0-9_])(?:takosumi_)?(?:resource_shapes|resolution_locks|target_pools|space_policies|service_form_(?:packages|definitions|activations)(?:__takoform_v1alpha1)?|offering_catalogs|resource_identity_fences|portable_host_idempotency)(?![A-Za-z0-9_])/u;

const IMPLEMENTATION_ROOTS = [
  "accounts",
  "cli",
  "contract",
  "core",
  "dashboard/src",
  "deploy",
  ".github",
  "lib",
  "opentofu-modules",
  "recipes",
  "runner",
  "scripts",
  "worker",
] as const;

const IMPLEMENTATION_FILES = ["Dockerfile"] as const;

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cfg",
  ".conf",
  ".hcl",
  ".ini",
  ".js",
  ".json",
  ".jsonc",
  ".mjs",
  ".py",
  ".properties",
  ".sh",
  ".sql",
  ".tf",
  ".toml",
  ".ts",
  ".tsx",
  ".yml",
  ".yaml",
]);

const SOURCE_BASENAMES = new Set(["Dockerfile", "Containerfile"]);

const EXPECTED_LEGACY_CUSTODY_PATHS = new Set([
  "core/adapters/storage/migrations.ts",
  "scripts/check-generalization-boundaries.ts",
  "worker/src/d1_opentofu_store.ts",
  "worker/src/d1_portable_host_idempotency_schema.ts",
]);

type LegacyTokenHit = Readonly<{
  readonly offset: number;
  readonly token: string;
}>;

const LEGACY_CUSTODY_RANGES = [
  {
    path: "core/adapters/storage/migrations.ts",
    start: "export const postgresStorageMigrationStatements",
  },
  {
    path: "scripts/check-generalization-boundaries.ts",
    start: "const RETIRED_PATHS = [",
    end: "] as const;",
  },
  {
    path: "worker/src/d1_opentofu_store.ts",
    start: "const D1_SERVICE_FORM_REGISTRY_STATEMENTS = [",
  },
  {
    path: "worker/src/d1_portable_host_idempotency_schema.ts",
    start: "export const D1_PORTABLE_HOST_IDEMPOTENCY_SCHEMA_STATEMENTS = [",
    end: "] as const;",
  },
] as const;

const D1_RETIRED_TABLES = [
  "offering_catalogs",
  "portable_host_idempotency",
  "resource_identity_fences",
  "resource_shapes",
  "resolution_locks",
  "service_form_activations",
  "service_form_activations__takoform_v1alpha1",
  "service_form_definitions",
  "service_form_definitions__takoform_v1alpha1",
  "service_form_packages",
  "service_form_packages__takoform_v1alpha1",
  "space_policies",
  "target_pools",
] as const;

const POSTGRES_RETIRED_TABLES = [
  "takosumi_offering_catalogs",
  "takosumi_resource_identity_fences",
  "takosumi_resource_shapes",
  "takosumi_resolution_locks",
  "takosumi_service_form_activations",
  "takosumi_service_form_activations__takoform_v1alpha1",
  "takosumi_service_form_definitions",
  "takosumi_service_form_definitions__takoform_v1alpha1",
  "takosumi_service_form_packages",
  "takosumi_service_form_packages__takoform_v1alpha1",
  "takosumi_space_policies",
  "takosumi_target_pools",
] as const;

function walkSourceFiles(root: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules") continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkSourceFiles(path));
    } else if (
      entry.isFile() &&
      (SOURCE_BASENAMES.has(entry.name) ||
        SOURCE_EXTENSIONS.has(path.slice(path.lastIndexOf("."))))
    ) {
      files.push(path);
    }
  }
  return files;
}

function legacyTableTokenInventory(): Map<string, readonly LegacyTokenHit[]> {
  const inventory = new Map<string, readonly LegacyTokenHit[]>();
  const tokenPattern = new RegExp(LEGACY_TABLE_TOKEN_PATTERN.source, "gu");
  for (const implementationRoot of IMPLEMENTATION_ROOTS) {
    for (const path of walkSourceFiles(join(REPO_ROOT, implementationRoot))) {
      const source = readFileSync(path, "utf8");
      const hits = [...source.matchAll(tokenPattern)].map((match) => ({
        offset: match.index ?? -1,
        token: match[0],
      }));
      if (hits.length > 0) inventory.set(relative(REPO_ROOT, path), hits);
    }
  }
  for (const implementationFile of IMPLEMENTATION_FILES) {
    const path = join(REPO_ROOT, implementationFile);
    const fileSource = readFileSync(path, "utf8");
    const hits = [...fileSource.matchAll(tokenPattern)].map((match) => ({
      offset: match.index ?? -1,
      token: match[0],
    }));
    if (hits.length > 0) inventory.set(implementationFile, hits);
  }
  return inventory;
}

function source(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

test("lexical Host table-token custody stays outside runtime code", () => {
  const inventory = legacyTableTokenInventory();
  assert.deepEqual(
    [...inventory.keys()].sort(),
    [...EXPECTED_LEGACY_CUSTODY_PATHS].sort(),
    "legacy table names must remain in migration/guard custody only",
  );
  for (const [path, hits] of inventory) {
    const range = LEGACY_CUSTODY_RANGES.find((candidate) =>
      candidate.path === path
    );
    assert.ok(range, `legacy custody range missing for ${path}`);
    const fileSource = source(path);
    const start = fileSource.indexOf(range.start);
    const end = "end" in range
      ? fileSource.indexOf(range.end, start + range.start.length)
      : fileSource.length;
    assert.ok(start >= 0, `legacy custody start moved for ${path}`);
    assert.ok(end > start, `legacy custody end moved for ${path}`);
    for (const hit of hits) {
      assert.ok(
        hit.offset >= start && hit.offset < end,
        `${path} legacy token ${hit.token} escaped its custody range`,
      );
    }
  }

  const d1Store = source("worker/src/d1_opentofu_store.ts");
  const runtimeStart = d1Store.indexOf(
    "export class CloudflareD1OpenTofuControlStore",
  );
  const migrationStart = d1Store.indexOf(
    "const D1_SERVICE_FORM_REGISTRY_STATEMENTS",
  );
  assert.ok(runtimeStart >= 0, "D1 runtime store boundary moved");
  assert.ok(migrationStart > runtimeStart, "D1 migration boundary moved");
  assert.equal(
    new RegExp(LEGACY_TABLE_TOKEN_PATTERN.source, "u").test(
      d1Store.slice(runtimeStart, migrationStart),
    ),
    false,
    "D1 runtime store must not read or write retired Host tables",
  );

  for (const retiredPath of [
    "contract/resource-shape.ts",
    "contract/resolution.ts",
    "contract/target.ts",
    "contract/service-forms.ts",
    "contract/offerings.ts",
    "core/api/form_host_routes.ts",
    "core/api/resource_routes.ts",
    "core/api/offering_catalog_routes.ts",
    "core/domains/resource-shape",
    "core/domains/service-forms",
    "core/domains/offerings",
    "core/domains/workspace-views",
    "worker/src/resource_shape_composition.ts",
    "worker/src/d1_portable_host_idempotency.ts",
    "worker/src/scheduled/resource_observation.ts",
  ]) {
    assert.equal(
      existsSync(join(REPO_ROOT, retiredPath)),
      false,
      `retired Host implementation path unexpectedly exists: ${retiredPath}`,
    );
  }
});

test("D1 and PostgreSQL retirement inventories preserve mixed-state guards", () => {
  const d1Store = source("worker/src/d1_opentofu_store.ts");
  const d1TableExport = d1Store.match(
    /export const D1_RETIRED_HOST_TABLES = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(d1TableExport, "D1 retired table export moved");
  const d1Tables = [
    ...d1TableExport[1].matchAll(/"([^"]+)"/gu),
  ].map(([_, table]) => table);
  assert.deepEqual(d1Tables, [...D1_RETIRED_TABLES]);

  const d1RetirementStart = d1Store.indexOf(
    "export const D1_RETIRED_HOST_SCHEMA_RETIREMENT_STATEMENTS",
  );
  const d1RetirementEnd = d1Store.indexOf("\n] as const;", d1RetirementStart);
  assert.ok(d1RetirementStart >= 0, "D1 retirement statements moved");
  assert.ok(d1RetirementEnd > d1RetirementStart, "D1 retirement boundary moved");
  const d1RetirementSql = d1Store.slice(
    d1RetirementStart,
    d1RetirementEnd,
  );
  for (const table of D1_RETIRED_TABLES) {
    assert.match(d1RetirementSql, new RegExp(`select 1 from ${table}\\b`));
    assert.match(d1RetirementSql, new RegExp(`drop table ${table}\\b`));
  }
  assert.match(
    d1Store,
    /const D1_RETIRED_HOST_DISPOSITION_GUARD =\s*"retired_host_rows_require_operator_disposition"/u,
  );
  assert.match(
    d1Store,
    /const D1_RETAINED_INTERFACE_HOST_EVIDENCE_GUARD =\s*"retained_interface_host_evidence_requires_operator_disposition"/u,
  );
  assert.match(d1RetirementSql, /owner_kind = 'Resource'/u);
  assert.match(d1RetirementSql, /subject_kind = 'Resource'/u);

  const postgresSource = source("core/adapters/storage/migrations.ts");
  const postgresRetirementStart = postgresSource.indexOf(
    'id: "retired.host_schema.drop_empty"',
  );
  assert.ok(postgresRetirementStart >= 0, "PostgreSQL retirement migration moved");
  const postgresRetirement = postgresSource.slice(postgresRetirementStart);
  assert.match(postgresRetirement, /version: 110/u);
  for (const table of POSTGRES_RETIRED_TABLES) {
    assert.match(
      postgresRetirement,
      new RegExp(`select 1 from ${table}\\b`),
    );
    assert.match(postgresRetirement, new RegExp(`drop table ${table}\\b`));
  }
  assert.equal(
    postgresRetirement.includes("portable_host_idempotency"),
    false,
    "portable_host_idempotency is a D1-only historical exception",
  );
  assert.match(
    postgresRetirement,
    /RETIRED_HOST_ROWS_REQUIRE_OPERATOR_DISPOSITION/u,
  );
  assert.match(
    postgresRetirement,
    /RETAINED_INTERFACE_HOST_EVIDENCE_REQUIRES_OPERATOR_DISPOSITION/u,
  );

  assert.match(d1Store, /version: 59,\s*name: "d1_portable_host_idempotency"/u);
  assert.match(
    d1Store,
    /version: 66,\s*name: "d1_retired_host_schema_drop_empty"/u,
  );
  assert.equal(
    existsSync(join(REPO_ROOT, "worker/src/d1_portable_host_idempotency_schema.ts")),
    true,
  );
  const idempotencySchema = source(
    "worker/src/d1_portable_host_idempotency_schema.ts",
  );
  assert.match(
    idempotencySchema,
    /create table if not exists portable_host_idempotency/u,
  );
  for (const column of [
    "workspace_id",
    "actor_account_id",
    "space",
    "idempotency_key",
    "reservation_id",
    "fingerprint_json",
    "response_json",
  ]) {
    assert.match(idempotencySchema, new RegExp(`\\b${column}\\b`));
  }

  const interfaceContract = source("contract/interfaces.ts");
  assert.match(
    interfaceContract,
    /export type InterfaceOwnerKind = "Workspace" \| "Capsule";/u,
  );
  assert.match(
    interfaceContract,
    /export type InterfaceSubjectKind = "Principal" \| "ServiceAccount" \| "Capsule";/u,
  );
  assert.doesNotMatch(interfaceContract, /\| "Resource"/u);
  for (const schemaPath of [
    "core/adapters/storage/drizzle/schema/d1.ts",
    "core/adapters/storage/drizzle/schema/postgres.ts",
  ]) {
    const interfaceSchema = source(schemaPath);
    for (const retiredColumn of [
      "form_ref_key",
      "form_schema_digest",
      "descriptor_name",
      "descriptor_version",
    ]) {
      assert.doesNotMatch(
        interfaceSchema,
        new RegExp(`\\b${retiredColumn}\\b`),
        `${schemaPath} still declares retired Interface column ${retiredColumn}`,
      );
    }
  }
});

test("legacy Host routes are tombstoned while the narrow recovery exception stays fenced", () => {
  const routeFamilies = source("core/api/route_families.ts");
  assert.doesNotMatch(
    routeFamilies,
    /id: "(?:resource-shape|offering-catalogs|form-activations)"/u,
  );

  const apiSurface = source("contract/api-surface.ts");
  assert.match(apiSurface, /export function isRetiredV1Path\(/u);
  assert.match(apiSurface, /return matchesPrefix\(pathname, RETIRED_V1_PREFIX\)/u);
  for (const path of [
    "/v1/resources",
    "/v1/target-pools/default",
    "/v1/space-policies/default",
    "/v1/form-activations",
    "/v1/form-availability",
    "/v1/interfaces",
  ]) {
    assert.equal(isRetiredV1Path(path), true, path);
  }
  assert.equal(isRetiredV1Path("/api/v1/interfaces"), false);

  const edgePaths = source("core/api/edge_public_paths.ts");
  assert.match(edgePaths, /interfaces: "session"/u);
  assert.match(
    edgePaths,
    /const EDGE_EXPOSURE_OVERRIDES[\s\S]*No legacy Takoform discovery override/u,
  );
  assert.doesNotMatch(
    edgePaths,
    /\/v1\/(?:resources|target-pools|space-policies|form-activations|form-availability)/u,
  );

  const platformExtensionRoutes = source(
    "contract/platform-extension-routes.ts",
  );
  assert.match(platformExtensionRoutes, /"\/v1"/u);
  assert.match(platformExtensionRoutes, /"\/apis\/forms\.takoform\.com"/u);
  assert.match(platformExtensionRoutes, /"\/\.well-known\/takoform"/u);

  const platformWorker = source("deploy/platform/worker.ts");
  assert.match(platformWorker, /url\.pathname === "\/v1\/capabilities"/u);
  assert.match(platformWorker, /isPlatformLegacyInterfaceApiPath\(url\.pathname\)/u);
  assert.match(
    platformWorker,
    /const RETIRED_TAKOFORM_HOST_API_PREFIX = "\/apis\/forms\.takoform\.com"/u,
  );
  assert.match(platformWorker, /if \(isRetiredV1Path\(url\.pathname\)\)/u);
  assert.match(
    platformWorker,
    /if \(isPlatformTakoformHostPath\(url\.pathname\)\)/u,
  );

  const runEngine = source(
    "core/domains/deploy-control/run-engine/run_engine.ts",
  );
  assert.match(
    runEngine,
    /function isEligibleLegacySourcelessPlan\(planRun: PlanRun\)/u,
  );
  assert.match(
    runEngine,
    /if \(!appliedPlan \|\| !isEligibleLegacySourcelessPlan\(appliedPlan\)\)/u,
  );
  assert.match(runEngine, /record\.path\.startsWith\("\/resource-shape\/"\)/u);
  assert.match(
    runEngine,
    /record\.url\.startsWith\("https:\/\/uploads\.takosumi\.com\/"\)/u,
  );
  assert.match(runEngine, /\/\^\[0-9a-f\]\{64\}\$\/i\.test/u);
  assert.match(runEngine, /planRun\.sourceSnapshotId/u);
  assert.match(runEngine, /planRun\.appliedApplyRunId/u);
});
