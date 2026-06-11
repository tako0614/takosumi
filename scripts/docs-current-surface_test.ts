import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { test } from "bun:test";
import { deployControlD1TableNames } from "../core/adapters/storage/drizzle/schema/logical.ts";

const ROOT = new URL("../", import.meta.url);

const REQUIRED_DOCS = [
  "docs/index.md",
  "docs/getting-started/quickstart.md",
  "docs/reference/model.md",
  "docs/reference/deploy-control-api.md",
  "docs/reference/operator-execution-boundaries.md",
  "docs/reference/operator.md",
  "docs/reference/cli.md",
  "docs/en/index.md",
  "docs/en/getting-started/quickstart.md",
  "docs/en/reference/model.md",
  "docs/en/reference/deploy-control-api.md",
  "docs/en/reference/operator-execution-boundaries.md",
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

const SOURCE_DOCS_WITH_PUBLIC_SURFACE_WORDING = [
  "README.md",
  "CONVENTIONS.md",
  "ROADMAP.md",
  "contract/README.md",
  "core/README.md",
  "src/runtime-agent/README.md",
  "website/src/components/EndCTA.tsx",
  "website/src/components/Showcase.tsx",
  "website/src/components/Footer.tsx",
  "website/src/content/why.ts",
  "website/src/content/ecosystem.ts",
  "scripts/prove-opentofu-output-snapshot.ts",
  "package.json",
] as const;

const RETIRED_SOURCE_DOC_TERMS: readonly (string | RegExp)[] = [
  "npm install @takosjp/takosumi",
  "@takosjp/takosumi/contract",
  "@takosjp/takosumi/deploy-control",
  "@takosjp/takosumi/cli",
  "@takosjp/takosumi/server",
  "https://www.npmjs.com/package/@takosjp/takosumi",
  "takosumi install",
  "opentofu:deployment-output-proof",
  "opentofu-deployment-output-proof",
  "takosumi.opentofu-deployment-output-proof",
  "/v1/installations/{installationId}/deployment-outputs",
  "public package surface",
  "deploy-control plane has no public routes",
  /\bCapsule path\b/,
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
    const hit =
      typeof term === "string" ? docs.includes(term) : term.test(docs);
    assert.equal(hit, false, `retired docs term: ${term}`);
  }

  // The 2026-06-07 core-spec surface: Space-direct OpenTofu Capsule DAG model.
  assert.match(
    docs,
    /OpenTofu Capsule DAG (?:を管理する OSS control plane|directly under a Space)/,
  );
  assert.match(docs, /CapsuleCompatibilityReport/);
  assert.match(docs, /OutputSnapshot/);
  assert.match(docs, /ProviderBinding/);
  assert.match(docs, /DependencySnapshot/);
});

test("source docs keep current source-module and modulePath vocabulary", async () => {
  const docs = (
    await Promise.all(
      SOURCE_DOCS_WITH_PUBLIC_SURFACE_WORDING.map((path) =>
        readText(new URL(path, ROOT)),
      ),
    )
  ).join("\n");

  for (const term of RETIRED_SOURCE_DOC_TERMS) {
    const hit =
      typeof term === "string" ? docs.includes(term) : term.test(docs);
    assert.equal(hit, false, `retired source-doc term: ${term}`);
  }

  assert.match(docs, /takosumi-contract/);
  assert.match(docs, /module path/);
});

test("workspace packages stay private source modules", async () => {
  for (const path of [
    "package.json",
    "accounts/contract/package.json",
    "accounts/service/package.json",
    "accounts/cli/package.json",
    "accounts/platform-services/package.json",
    "deploy/node-postgres/package.json",
  ]) {
    const manifest = JSON.parse(await readText(new URL(path, ROOT))) as {
      readonly private?: boolean;
    };
    assert.equal(manifest.private, true, `${path} must be private`);
  }
});

test("core spec SQL appendix names every deploy-control D1 table", async () => {
  const coreSpec = await readText(new URL("docs/core-spec.md", ROOT));
  const sqlAppendix = coreSpecSqlAppendix(coreSpec);
  assert.ok(sqlAppendix, "missing core-spec D1 schema SQL appendix");

  const documentedTables = new Set(
    [...sqlAppendix.matchAll(/CREATE TABLE ([a-z_]+) \(/g)].map(
      (match) => match[1],
    ),
  );
  for (const tableName of Object.values(deployControlD1TableNames)) {
    assert.equal(
      documentedTables.has(tableName),
      true,
      `core-spec D1 SQL appendix is missing ${tableName}`,
    );
  }
});

test("core spec SQL appendix preserves logical row columns and key constraints", async () => {
  const coreSpec = await readText(new URL("docs/core-spec.md", ROOT));
  const tables = parseCreateTables(coreSpecSqlAppendix(coreSpec));

  for (const [tableName, columns] of Object.entries(REQUIRED_LOGICAL_COLUMNS)) {
    const table = tables.get(tableName);
    assert.ok(table, `core-spec D1 SQL appendix is missing ${tableName}`);
    for (const column of columns) {
      assert.equal(
        table.columns.has(column),
        true,
        `core-spec D1 SQL appendix table ${tableName} is missing column ${column}`,
      );
    }
  }

  for (const [tableName, constraints] of Object.entries(
    REQUIRED_TABLE_CONSTRAINTS,
  )) {
    const table = tables.get(tableName);
    assert.ok(table, `core-spec D1 SQL appendix is missing ${tableName}`);
    const body = table.body.replace(/\s+/g, " ").toLowerCase();
    for (const constraint of constraints) {
      assert.equal(
        body.includes(constraint.toLowerCase()),
        true,
        `core-spec D1 SQL appendix table ${tableName} is missing constraint ${constraint}`,
      );
    }
  }
});

test("core spec SQL appendix preserves logical lookup indexes", async () => {
  const coreSpec = await readText(new URL("docs/core-spec.md", ROOT));
  const indexes = parseCreateIndexes(coreSpecSqlAppendix(coreSpec));

  for (const [indexName, expected] of Object.entries(
    REQUIRED_LOGICAL_INDEXES,
  )) {
    const index = indexes.get(indexName);
    assert.ok(index, `core-spec D1 SQL appendix is missing index ${indexName}`);
    assert.equal(
      index.table,
      expected.table,
      `core-spec D1 SQL appendix index ${indexName} points at ${index.table}, expected ${expected.table}`,
    );
    assert.deepEqual(
      index.columns,
      expected.columns,
      `core-spec D1 SQL appendix index ${indexName} columns drifted`,
    );
    assert.equal(
      index.unique,
      expected.unique ?? false,
      `core-spec D1 SQL appendix index ${indexName} uniqueness drifted`,
    );
  }
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

function coreSpecSqlAppendix(coreSpec: string): string {
  const sqlAppendix = coreSpec.match(
    /## 35\. D1 schema[\s\S]*?```sql\n(?<sql>[\s\S]*?)\n```/,
  )?.groups?.sql;
  assert.ok(sqlAppendix, "missing core-spec D1 schema SQL appendix");
  return sqlAppendix;
}

function parseCreateTables(
  sql: string,
): Map<string, { columns: Set<string>; body: string }> {
  const tables = new Map<string, { columns: Set<string>; body: string }>();
  for (const match of sql.matchAll(
    /CREATE TABLE (?<name>[a-z_]+) \(\n(?<body>[\s\S]*?)\n\);/g,
  )) {
    const name = match.groups?.name;
    const body = match.groups?.body;
    assert.ok(name && body, "malformed CREATE TABLE block");
    const columns = new Set<string>();
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim().replace(/,$/, "");
      if (!line) continue;
      if (
        line.startsWith("PRIMARY KEY") ||
        line.startsWith("UNIQUE") ||
        line.startsWith("FOREIGN KEY") ||
        line.startsWith("CHECK")
      ) {
        continue;
      }
      const column = line.match(/^([a-z_]+)/)?.[1];
      if (column) columns.add(column);
    }
    tables.set(name, { columns, body });
  }
  return tables;
}

function parseCreateIndexes(
  sql: string,
): Map<string, { table: string; columns: readonly string[]; unique: boolean }> {
  const indexes = new Map<
    string,
    { table: string; columns: readonly string[]; unique: boolean }
  >();
  for (const match of sql.matchAll(
    /CREATE (?<unique>UNIQUE )?INDEX (?<name>[a-z_]+)\s+ON (?<table>[a-z_]+)\((?<columns>[a-z_,\s]+)\);/g,
  )) {
    const unique = match.groups?.unique;
    const name = match.groups?.name;
    const table = match.groups?.table;
    const columns = match.groups?.columns;
    assert.ok(name && table && columns, "malformed CREATE INDEX block");
    indexes.set(name, {
      table,
      columns: columns.split(",").map((column) => column.trim()),
      unique: unique !== undefined,
    });
  }
  return indexes;
}

const REQUIRED_LOGICAL_COLUMNS = {
  runner_profiles: [
    "id",
    "display_name",
    "mode",
    "default_env_json",
    "created_at",
    "updated_at",
  ],
  spaces: [
    "id",
    "handle",
    "display_name",
    "type",
    "owner_user_id",
    "billing_account_id",
    "billing_settings_json",
    "policy_json",
    "created_at",
    "updated_at",
  ],
  space_members: ["space_id", "user_id", "role", "created_at"],
  sources: [
    "id",
    "space_id",
    "name",
    "url",
    "default_ref",
    "default_path",
    "auth_connection_id",
    "status",
    "created_at",
    "updated_at",
  ],
  source_snapshots: [
    "id",
    "source_id",
    "url",
    "ref",
    "resolved_commit",
    "path",
    "archive_object_key",
    "archive_digest",
    "archive_size_bytes",
    "fetched_by_run_id",
    "fetched_at",
  ],
  connections: [
    "id",
    "scope",
    "space_id",
    "provider",
    "status",
    "connection_json",
    "created_at",
    "updated_at",
  ],
  secret_blobs: [
    "id",
    "space_id",
    "kind",
    "ciphertext",
    "encrypted_dek",
    "nonce",
    "aad",
    "key_version",
    "created_at",
    "rotated_at",
  ],
  operator_connection_defaults: [
    "id",
    "provider",
    "connection_id",
    "created_at",
    "updated_at",
  ],
  install_configs: [
    "id",
    "space_id",
    "name",
    "trust_level",
    "module_path",
    "normalization_json",
    "build_json",
    "variable_mapping_json",
    "output_allowlist_json",
    "policy_json",
    "backup_json",
    "created_at",
    "updated_at",
  ],
  capsule_compatibility_reports: [
    "id",
    "source_snapshot_id",
    "level",
    "findings_json",
    "providers_json",
    "resources_json",
    "data_sources_json",
    "provisioners_json",
    "normalized_object_key",
    "normalized_digest",
    "created_at",
  ],
  installations: [
    "id",
    "space_id",
    "name",
    "slug",
    "source_id",
    "install_config_id",
    "environment",
    "current_deployment_id",
    "current_state_generation",
    "current_output_snapshot_id",
    "compatibility_report_id",
    "status",
    "created_at",
    "updated_at",
  ],
  deployment_profiles: [
    "id",
    "space_id",
    "installation_id",
    "environment",
    "bindings_json",
    "created_at",
    "updated_at",
  ],
  installation_dependencies: [
    "id",
    "space_id",
    "producer_installation_id",
    "consumer_installation_id",
    "mode",
    "outputs_json",
    "visibility",
    "created_at",
  ],
  output_snapshots: [
    "id",
    "space_id",
    "installation_id",
    "state_generation",
    "raw_output_artifact_key",
    "public_outputs_json",
    "space_outputs_json",
    "output_digest",
    "created_at",
  ],
  dependency_snapshots: [
    "id",
    "run_id",
    "dependencies_json",
    "mode",
    "created_at",
  ],
  output_shares: [
    "id",
    "from_space_id",
    "to_space_id",
    "producer_installation_id",
    "outputs_json",
    "status",
    "created_at",
    "revoked_at",
  ],
  run_groups: [
    "id",
    "space_id",
    "type",
    "status",
    "graph_json",
    "created_at",
    "finished_at",
  ],
  runs: [
    "id",
    "run_group_id",
    "space_id",
    "source_id",
    "installation_id",
    "environment",
    "type",
    "status",
    "source_snapshot_id",
    "dependency_snapshot_id",
    "compatibility_report_id",
    "base_state_generation",
    "plan_digest",
    "plan_artifact_key",
    "policy_status",
    "error_code",
    "created_by",
    "created_at",
    "started_at",
    "finished_at",
  ],
  runs_inputs: ["plan_run_id", "inputs_json"],
  state_snapshots: [
    "id",
    "space_id",
    "installation_id",
    "environment",
    "generation",
    "object_key",
    "digest",
    "created_by_run_id",
    "created_at",
  ],
  deployments: [
    "id",
    "space_id",
    "installation_id",
    "environment",
    "apply_run_id",
    "source_snapshot_id",
    "dependency_snapshot_id",
    "state_generation",
    "output_snapshot_id",
    "outputs_public_json",
    "status",
    "created_at",
  ],
  artifacts: [
    "id",
    "run_id",
    "kind",
    "object_key",
    "digest",
    "size_bytes",
    "created_at",
  ],
  credential_mint_events: [
    "id",
    "run_id",
    "space_id",
    "installation_id",
    "source_id",
    "connection_id",
    "phase",
    "capabilities_json",
    "actor_id",
    "created_at",
  ],
  security_findings: [
    "id",
    "space_id",
    "installation_id",
    "run_id",
    "severity",
    "type",
    "message",
    "metadata_json",
    "created_at",
  ],
  billing_accounts: [
    "id",
    "owner_type",
    "owner_id",
    "provider",
    "stripe_customer_id",
    "status",
    "created_at",
    "updated_at",
  ],
  plans: [
    "id",
    "name",
    "monthly_base_price",
    "included_credits",
    "limits_json",
    "created_at",
    "updated_at",
  ],
  space_subscriptions: [
    "id",
    "space_id",
    "billing_account_id",
    "plan_id",
    "status",
    "current_period_start",
    "current_period_end",
    "created_at",
    "updated_at",
  ],
  credit_balances: [
    "space_id",
    "available_credits",
    "reserved_credits",
    "monthly_included_credits",
    "purchased_credits",
    "updated_at",
  ],
  usage_events: [
    "id",
    "space_id",
    "installation_id",
    "run_id",
    "kind",
    "quantity",
    "credits",
    "source",
    "idempotency_key",
    "created_at",
  ],
  credit_reservations: [
    "id",
    "space_id",
    "run_id",
    "estimated_credits",
    "mode",
    "status",
    "created_at",
    "expires_at",
  ],
  audit_events: [
    "id",
    "space_id",
    "actor_id",
    "action",
    "target_type",
    "target_id",
    "run_id",
    "metadata_json",
    "created_at",
  ],
  backups: [
    "id",
    "space_id",
    "installation_id",
    "environment",
    "created_by_run_id",
    "backup_json",
    "created_at",
  ],
} as const satisfies Record<string, readonly string[]>;

const REQUIRED_TABLE_CONSTRAINTS = {
  installations: ["UNIQUE(space_id, name, environment)"],
  state_snapshots: ["UNIQUE(installation_id, environment, generation)"],
  usage_events: ["idempotency_key TEXT NOT NULL UNIQUE"],
  space_members: ["PRIMARY KEY (space_id, user_id)"],
} as const satisfies Record<string, readonly string[]>;

const REQUIRED_LOGICAL_INDEXES = {
  spaces_handle_unique: {
    table: "spaces",
    columns: ["handle"],
    unique: true,
  },
  sources_space_idx: { table: "sources", columns: ["space_id"] },
  source_snapshots_source_idx: {
    table: "source_snapshots",
    columns: ["source_id"],
  },
  connections_space_idx: { table: "connections", columns: ["space_id"] },
  connections_status_idx: { table: "connections", columns: ["status"] },
  operator_connection_defaults_provider_idx: {
    table: "operator_connection_defaults",
    columns: ["provider"],
    unique: true,
  },
  install_configs_space_idx: {
    table: "install_configs",
    columns: ["space_id"],
  },
  capsule_compatibility_reports_source_snapshot_idx: {
    table: "capsule_compatibility_reports",
    columns: ["source_snapshot_id"],
  },
  installations_space_idx: {
    table: "installations",
    columns: ["space_id"],
  },
  installations_current_deployment_idx: {
    table: "installations",
    columns: ["current_deployment_id"],
  },
  deployment_profiles_installation_environment_unique: {
    table: "deployment_profiles",
    columns: ["installation_id", "environment"],
    unique: true,
  },
  deployment_profiles_installation_idx: {
    table: "deployment_profiles",
    columns: ["installation_id"],
  },
  installation_dependencies_space_idx: {
    table: "installation_dependencies",
    columns: ["space_id"],
  },
  installation_dependencies_producer_idx: {
    table: "installation_dependencies",
    columns: ["producer_installation_id"],
  },
  installation_dependencies_consumer_idx: {
    table: "installation_dependencies",
    columns: ["consumer_installation_id"],
  },
  output_snapshots_installation_idx: {
    table: "output_snapshots",
    columns: ["installation_id"],
  },
  dependency_snapshots_run_idx: {
    table: "dependency_snapshots",
    columns: ["run_id"],
  },
  output_shares_from_space_idx: {
    table: "output_shares",
    columns: ["from_space_id"],
  },
  output_shares_to_space_idx: {
    table: "output_shares",
    columns: ["to_space_id"],
  },
  output_shares_producer_idx: {
    table: "output_shares",
    columns: ["producer_installation_id"],
  },
  run_groups_space_idx: { table: "run_groups", columns: ["space_id"] },
  runs_space_idx: { table: "runs", columns: ["space_id"] },
  runs_source_idx: { table: "runs", columns: ["source_id"] },
  runs_installation_idx: { table: "runs", columns: ["installation_id"] },
  runs_type_idx: { table: "runs", columns: ["type"] },
  runs_created_at_idx: { table: "runs", columns: ["created_at"] },
  state_snapshots_installation_idx: {
    table: "state_snapshots",
    columns: ["installation_id"],
  },
  deployments_space_idx: { table: "deployments", columns: ["space_id"] },
  deployments_installation_idx: {
    table: "deployments",
    columns: ["installation_id"],
  },
  deployments_apply_idx: { table: "deployments", columns: ["apply_run_id"] },
  artifacts_run_idx: { table: "artifacts", columns: ["run_id"] },
  billing_accounts_owner_idx: {
    table: "billing_accounts",
    columns: ["owner_type", "owner_id"],
  },
  billing_accounts_status_idx: {
    table: "billing_accounts",
    columns: ["status"],
  },
  space_subscriptions_space_idx: {
    table: "space_subscriptions",
    columns: ["space_id"],
  },
  space_subscriptions_billing_account_idx: {
    table: "space_subscriptions",
    columns: ["billing_account_id"],
  },
  usage_events_space_idx: { table: "usage_events", columns: ["space_id"] },
  usage_events_run_idx: { table: "usage_events", columns: ["run_id"] },
  credit_reservations_space_idx: {
    table: "credit_reservations",
    columns: ["space_id"],
  },
  credit_reservations_run_idx: {
    table: "credit_reservations",
    columns: ["run_id"],
  },
  credit_reservations_status_idx: {
    table: "credit_reservations",
    columns: ["status"],
  },
  credential_mint_events_run_idx: {
    table: "credential_mint_events",
    columns: ["run_id"],
  },
  credential_mint_events_space_idx: {
    table: "credential_mint_events",
    columns: ["space_id"],
  },
  credential_mint_events_source_idx: {
    table: "credential_mint_events",
    columns: ["source_id"],
  },
  security_findings_space_idx: {
    table: "security_findings",
    columns: ["space_id"],
  },
  security_findings_run_idx: {
    table: "security_findings",
    columns: ["run_id"],
  },
  security_findings_severity_idx: {
    table: "security_findings",
    columns: ["severity"],
  },
  audit_events_space_idx: { table: "audit_events", columns: ["space_id"] },
  backups_space_idx: { table: "backups", columns: ["space_id"] },
} as const satisfies Record<
  string,
  {
    readonly table: string;
    readonly columns: readonly string[];
    readonly unique?: boolean;
  }
>;
