const managedOfferingReadinessKind =
  "takosumi.managed-offering-readiness@v1";
const managedOfferingProductionTopologyKind =
  "takosumi.production-topology@v1";

export function helpText(): string {
  return [
    "takosumi",
    "",
    "Commands:",
    "  accounts seed            Print a Takosumi Accounts seed plan",
    "  accounts serve           Run the dev/test Takosumi Accounts OIDC service",
    "  accounts migrate         Apply Takosumi Accounts Postgres migrations",
    "  accounts migrate-d1      Apply Takosumi Accounts D1 (Cloudflare) migrations",
    "  accounts launch-tokens cleanup  Prune expired or used launch token DB records",
    "  accounts tokens          Manage Takosumi Accounts personal access tokens",
    "  installations list       List AppInstallation ledger records",
    "  installations inspect    Inspect one AppInstallation ledger record",
    "  installations uninstall  Uninstall an AppInstallation and revoke active permission scopes",
    "  installations status     Update an AppInstallation status",
    "  installations materialize  Request shared-cell to dedicated materialization",
    "  installations export      Request a pending export bundle operation",
    "  launch-readiness template  Print a managed offering launch evidence template",
    "  launch-readiness validate  Validate managed offering launch evidence",
    "  launch-readiness public-summary  Emit a public-safe launch evidence summary",
    "  launch-readiness public-summary validate  Validate a public summary JSON artifact",
    "  launch-readiness production-topology template  Print a topology evidence template",
    "  launch-readiness production-topology preflight  Validate topology evidence shape",
    "  launch-readiness production-topology merge  Merge staging and production topology evidence",
  ].join("\n");
}

export function accountsSeedHelpText(): string {
  return [
    "takosumi accounts seed",
    "",
    "Options:",
    "  --issuer <url>",
    "  --subject <tsub_...>",
    "  --client-id <id>",
    "  --redirect-uri <uri>[,<uri>...]",
  ].join("\n");
}

export function accountsMigrateHelpText(): string {
  return [
    "takosumi accounts migrate",
    "",
    "Options:",
    "  --database-url <postgres-url>",
    "  --dry-run",
    "",
    "Environment:",
    "  TAKOSUMI_ACCOUNTS_DATABASE_URL",
  ].join("\n");
}

export function accountsMigrateD1HelpText(): string {
  return [
    "takosumi accounts migrate-d1",
    "",
    "Apply Takosumi Accounts D1 (Cloudflare Workers) migrations via wrangler.",
    "Calls `npx wrangler d1 execute <database-id> --command ...` once per",
    "pending migration and records each applied version in",
    "takosumi_accounts_schema_migrations.",
    "",
    "Options:",
    "  --database-id <uuid>   D1 database UUID (from `wrangler d1 create`)",
    "  --account-id <id>      Cloudflare account ID (optional; required when",
    "                         the operator's default account differs from",
    "                         the deploy target)",
    "  --remote               Target the remote/managed D1 database (default)",
    "  --local                Target the local miniflare D1 database, for",
    "                         smoke-testing the runner before a first deploy",
    "  --env <profile>        Pass `--env <profile>` to wrangler (e.g. staging)",
    "  --dry-run              Print the migrate plan without calling wrangler",
    "  --json                 Print the JSON migrate report instead of a summary",
    "",
    "Limitations:",
    "  - Forward-only. There is no down-migration; rollback requires",
    "    operator-level `wrangler d1` intervention.",
    "  - Each migration SQL must be safe under partial replay because the",
    "    runner cannot wrap a batch in a transaction.",
    "  - Do NOT run concurrently against the same database. There is no",
    "    advisory lock (D1's stateless HTTP execute cannot hold one); a racing",
    "    second runner fails loud on the version PRIMARY KEY. Run it from a",
    "    single deploy job.",
  ].join("\n");
}

export function accountsLaunchTokensCleanupHelpText(): string {
  return [
    "takosumi accounts launch-tokens cleanup",
    "",
    "Options:",
    "  --database-url <postgres-url>",
    "  --expired-retention-hours <hours>  default 24",
    "  --used-retention-hours <hours>     default 24",
    "  --now <iso-timestamp>              test/audit override",
    "  --dry-run",
    "  --json",
    "",
    "Environment:",
    "  TAKOSUMI_ACCOUNTS_DATABASE_URL",
  ].join("\n");
}

export function launchReadinessValidateHelpText(): string {
  return [
    "takosumi launch-readiness validate",
    "",
    "Options:",
    "  --file <path>  JSON evidence document",
    "  --json",
    "",
    `Document kind: ${managedOfferingReadinessKind}`,
  ].join("\n");
}

export function launchReadinessPublicSummaryHelpText(): string {
  return [
    "takosumi launch-readiness public-summary",
    "",
    "Options:",
    "  --file <path>  JSON evidence document",
    "  --evidence-ref <ref>  Private evidence store ref; required when ready",
    "  --public-summary <text>  Sanitized operator-reviewed public summary",
    "  --markdown-row  Print one row for docs/quality/managed-offering-evidence-summary.md",
    "",
    "Prints a public-safe JSON summary with validator status, canonical",
    "evidenceDigest, opaque rehearsal id, and evidence ref class only.",
  ].join("\n");
}

export function launchReadinessPublicSummaryValidateHelpText(): string {
  return [
    "takosumi launch-readiness public-summary validate",
    "",
    "Options:",
    "  --file <path>  Public summary JSON from public-summary",
    "  --readiness-file <path>  Private readiness JSON used to generate it",
    "  --json",
    "",
    "Checks digest, ready state, rehearsal id, environment, date, and",
    "redaction-sensitive strings before publishing a public summary row.",
  ].join("\n");
}

export function launchReadinessTemplateHelpText(): string {
  return [
    "takosumi launch-readiness template",
    "",
    "Print a fail-closed JSON skeleton for managed offering evidence.",
    "Each required evidence type is expanded with its structured field shape,",
    "private=true, and a required publicSummary placeholder.",
    "Fill every row, change status to passed only after live evidence exists,",
    "and use structured evidence refs with type, ref, and summary fields;",
    "collection guidance: docs/managed-offering-evidence-collection-matrix.md",
    "then validate it with launch-readiness validate --file <path>.",
  ].join("\n");
}

export function launchReadinessProductionTopologyTemplateHelpText(): string {
  return [
    "takosumi launch-readiness production-topology template",
    "",
    "Options:",
    "  --environment <staging|production>",
    "",
    `Document kind: ${managedOfferingProductionTopologyKind}`,
    "",
    "Prints the input shape expected by production-topology preflight.",
  ].join("\n");
}

export function launchReadinessProductionTopologyPreflightHelpText(): string {
  return [
    "takosumi launch-readiness production-topology preflight",
    "",
    "Options:",
    "  --file <path>  JSON topology document",
    "  --json",
    "",
    `Document kind: ${managedOfferingProductionTopologyKind}`,
  ].join("\n");
}

export function launchReadinessProductionTopologyMergeHelpText(): string {
  return [
    "takosumi launch-readiness production-topology merge",
    "",
    "Options:",
    "  --staging-report <path>  JSON report from production-topology preflight --json",
    "  --production-report <path>  JSON report from production-topology preflight --json",
    "  --json",
    "",
    "Merges staging and production preflight reports into the",
    'environment: "staging+production" domain entry required by',
    "launch-readiness validate.",
  ].join("\n");
}

export function accountsServeHelpText(): string {
  return [
    "takosumi accounts serve",
    "",
    "Options:",
    "  --issuer <url>",
    "  --subject <tsub_...>",
    "  --client-id <id>",
    "  --redirect-uri <uri>[,<uri>...]",
    "  --hostname <host>",
    "  --port <port>",
    "  --stripe-secret-key <sk_...>",
    "  --stripe-webhook-secret <whsec_...>",
    "  --stripe-api-base <url>",
    "  --stripe-webhook-tolerance-seconds <seconds>",
    "  --subject-secret <secret>",
    "  --github-client-id <id>",
    "  --github-client-secret <secret>",
    "  --github-redirect-uri <uri>",
    "  --google-client-id <id>",
    "  --google-client-secret <secret>",
    "  --google-redirect-uri <uri>",
    "  --oidc-provider-id <id>",
    "  --oidc-issuer <url>",
    "  --oidc-authorization-endpoint <url>",
    "  --oidc-token-endpoint <url>",
    "  --oidc-userinfo-endpoint <url>",
    "  --oidc-client-id <id>",
    "  --oidc-client-secret <secret>",
    "  --oidc-redirect-uri <uri>",
    "  --oidc-scopes <scope[,scope...]>",
    "  --oidc-subject-claim <claim>",
    "  --upstream-session-ttl-ms <milliseconds>",
    "  --passkey-rp-id <domain>",
    "  --passkey-rp-name <name>",
    "  --passkey-origin <origin>",
    "  --passkey-session-ttl-ms <milliseconds>",
    "  --installer-url <url>",
    "  --installer-token <token>",
    "  --use-edge-materials-file <path>",
    "  --shared-cell-slots <cell-id:capacity[,cell-id:capacity...]>",
    "  --shared-cell-scale-out-policy <json>",
    "  --materialize-worker-url <url>",
    "  --materialize-worker-token <token>",
    "  --workload-platform-service-resolver-token <token>",
    "  --billing-portal-url <url>",
    "  --export-output-dir <path>",
    "  --export-download-base-url <url>",
    "  --export-data-dir <path>",
    "  --export-download-ttl-ms <milliseconds>",
    "  --import-data-restore-dir <path>",
    "  --managed-offering-access <closed|open>",
    "  --managed-offering-readiness-file <path>",
    "  --managed-offering-readiness-digest <sha256:digest>",
    "  --managed-offering-evidence-ref <ref>",
    "  --managed-offering-approval-ref <ref>",
    "  --managed-offering-public-summary <text>",
    "  --database-url <postgres-url>",
    "  --dev-session-id <sess_...>  seed one in-memory dev Accounts session",
    "  --dry-run",
    "",
    "Environment:",
    "  TAKOSUMI_ACCOUNTS_DATABASE_URL",
    "  TAKOSUMI_ACCOUNTS_INSTALLER_URL",
    "  TAKOSUMI_ACCOUNTS_INSTALLER_TOKEN",
    "  TAKOSUMI_ACCOUNTS_USE_EDGE_MATERIALS",
    "  TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
    "  TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY",
    "  TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
    "  TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_TOKEN",
    "  TAKOSUMI_ACCOUNTS_WORKLOAD_PLATFORM_SERVICE_RESOLVER_TOKEN",
    "  TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL",
    "  TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR",
    "  TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL",
    "  TAKOSUMI_ACCOUNTS_EXPORT_DATA_DIR",
    "  TAKOSUMI_ACCOUNTS_IMPORT_DATA_RESTORE_DIR",
  ].join("\n");
}

export function accountsTokensHelpText(): string {
  return [
    "takosumi accounts tokens <command>",
    "",
    "Commands:",
    "  list",
    "  create",
    "  revoke <token-id>",
    "",
    "Use --token with an Accounts session bearer (sess_...) for these routes.",
  ].join("\n");
}

export function accountsTokensListHelpText(): string {
  return [
    "takosumi accounts tokens list",
    "",
    "Options:",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function accountsTokensCreateHelpText(): string {
  return [
    "takosumi accounts tokens create",
    "",
    "Options:",
    "  --name <label>",
    "  --scope <read,write,admin>",
    "  --expires-at <iso8601>",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function accountsTokensRevokeHelpText(): string {
  return [
    "takosumi accounts tokens revoke <token-id>",
    "",
    "Options:",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsListHelpText(): string {
  return [
    "takosumi installations list",
    "",
    "Options:",
    "  --space <id>",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsInspectHelpText(): string {
  return [
    "takosumi installations inspect <installation-id>",
    "",
    "Options:",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsUninstallHelpText(): string {
  return [
    "takosumi installations uninstall <installation-id>",
    "",
    "Options:",
    "  --reason <text>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsStatusHelpText(): string {
  return [
    "takosumi installations status <installation-id>",
    "",
    "Options:",
    "  --status <installing|ready|suspended|exported|failed>",
    "  --reason <text>",
    "  --mode <shared-cell|dedicated|self-hosted>",
    "  --operation <materialize|export>",
    "  --operation-id <op_...>",
    "  --runtime-target-record-id <id>",
    "  --runtime-target-type <shared-cell|dedicated|self-hosted>",
    "  --runtime-target-id <id>",
    "  --download-url <url>",
    "  --download-expires-at <iso8601>",
    "  --error <message>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsMaterializeHelpText(): string {
  return [
    "takosumi installations materialize <installation-id>",
    "",
    "Options:",
    "  --mode dedicated",
    "  --region <name>",
    "  --compute <plan>",
    "  --database <plan>",
    "  --object-store <plan>",
    "  --cutover-strategy <blue-green|cutover-now>",
    "  --drain-seconds <seconds>",
    "  --cost-ack",
    "  --permission-digest <sha256:...>",
    "  --idempotency-key <key>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsExportHelpText(): string {
  return [
    "takosumi installations export <installation-id>",
    "",
    "Options:",
    "  --include-data",
    "  --format <bundle>",
    "  --encryption-method <none|age>",
    "  --recipient <age1...[,age1...]>",
    "  --data <postgres,blobs,memory,profiles>",
    "  --secrets <templates-only|with-references>",
    "  --idempotency-key <key>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --json",
  ].join("\n");
}
