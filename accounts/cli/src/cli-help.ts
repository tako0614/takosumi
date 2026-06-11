import process from "node:process";

const managedOfferingReadinessKind =
  "takosumi.managed-offering-readiness@v1";
const managedOfferingProductionTopologyKind =
  "takosumi.production-topology@v1";

export function isJapaneseCli(): boolean {
  const explicit = process.env.TAKOSUMI_LANG ?? process.env.TAKOSUMI_LOCALE;
  if (explicit) return explicit.toLowerCase().startsWith("ja");
  const locale = process.env.LC_ALL ?? process.env.LC_MESSAGES ??
    process.env.LANG ?? "";
  return locale.toLowerCase().startsWith("ja");
}

export function helpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi",
      "",
      "Deploy (ローカル Capsule を自分の Space へ):",
      "  deploy [dir]            ローカル OpenTofu Capsule を upload→plan→apply",
      "  plan   [dir]            upload→plan のみ (apply しない)",
      "  status <run-id>         Run の状態を表示",
      "  logs   <run-id>         Run のログを表示",
      "",
      "Operator:",
      "  run connections         Takosumi 提供 provider default を管理",
      "  run secrets             Worker secret の確認と適用",
      "",
      "deploy の例:",
      "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com",
      "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
      "  takosumi deploy ./my-capsule --space @me --name my-app --var region=apac",
      "",
      "内部/開発用コマンドは help には表示しません。",
      "日本語表示は TAKOSUMI_LANG=ja または LANG=ja_* で有効になります。",
    ].join("\n");
  }
  return [
    "takosumi",
    "",
    "Deploy (a local Capsule into your Space):",
    "  deploy [dir]            upload a local OpenTofu Capsule, then plan/apply",
    "  plan   [dir]            upload + plan only (no apply)",
    "  status <run-id>         show a Run's status",
    "  logs   <run-id>         show a Run's logs",
    "",
    "Operator:",
    "  run connections         Manage Takosumi-provided provider defaults",
    "  run secrets             Check and apply Worker secrets",
    "",
    "Deploy example:",
    "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com",
    "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
    "  takosumi deploy ./my-capsule --space @me --name my-app --var region=apac",
    "",
    "Internal/development commands are intentionally hidden from this help.",
  ].join("\n");
}

export function platformSecretsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi secrets <command>",
      "",
      "コマンド:",
      "  status",
      "  apply",
      "",
      "operator vault の状態を確認し、生成可能 secret を作成して Worker に push します。",
      "表示するのは secret 名と件数だけで、値は表示しません。",
      "provider credential は Takosumi 提供 default なら `takosumi run connections ...`、",
      "user-owned credential は dashboard/API flow で扱います。",
    ].join("\n");
  }
  return [
    "takosumi secrets <command>",
    "",
    "Commands:",
    "  status",
    "  apply",
    "",
    "Checks the operator vault, creates generatable secrets, and pushes Worker",
    "secrets. It only prints secret names and counts, never values. Operator",
    "provider credentials use `takosumi run connections ...`; user-owned",
    "credentials are dashboard/API flows, not CLI flows.",
  ].join("\n");
}

export function platformSecretsStatusHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi secrets status",
      "",
      "オプション:",
      "  --config <wrangler.toml>",
      "  --secrets-dir <path>",
      "  --json",
      "",
      "環境変数:",
      "  TAKOSUMI_WRANGLER_CONFIG",
      "  TAKOSUMI_SECRETS",
    ].join("\n");
  }
  return [
    "takosumi secrets status",
    "",
    "Options:",
    "  --config <wrangler.toml>",
    "  --secrets-dir <path>",
    "  --json",
    "",
    "Environment:",
    "  TAKOSUMI_WRANGLER_CONFIG",
    "  TAKOSUMI_SECRETS",
  ].join("\n");
}

export function platformSecretsApplyHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi secrets apply",
      "",
      "local vault を正本として Worker secret に push します。",
      "生成可能 secret は不足時に作成します。既存 protected key は上書きしません。",
      "",
      "オプション:",
      "  --config <wrangler.toml>",
      "  --secrets-dir <path>",
      "  --regenerate <secret-name|rotate-safe>",
      "  --dry-run",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi secrets apply",
    "",
    "Pushes Worker secrets from the local operator vault. Missing generatable",
    "secrets are created. Existing protected keys are never overwritten.",
    "",
    "Options:",
    "  --config <wrangler.toml>",
    "  --secrets-dir <path>",
    "  --regenerate <secret-name|rotate-safe>",
    "  --dry-run",
    "  --json",
  ].join("\n");
}

export function connectionsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections <command>",
      "",
      "コマンド:",
      "  list",
      "  set-cloudflare-token",
      "  test <connection-id>",
      "  revoke <connection-id>",
      "  defaults list",
      "  defaults set <provider> <connection-id>",
      "",
      "`--url` に Takosumi platform origin、`--token` に deploy-control bearer を渡します。",
      "credential 値は file からだけ読み、CLI には表示しません。",
      "この CLI は operator-only です。Takosumi 提供 default と platform secret だけを扱います。",
      "Space/user-owned provider env set は dashboard/API flow で作成します。",
    ].join("\n");
  }
  return [
    "takosumi connections <command>",
    "",
    "Commands:",
    "  list",
    "  set-cloudflare-token",
    "  test <connection-id>",
    "  revoke <connection-id>",
    "  defaults list",
    "  defaults set <provider> <connection-id>",
    "",
    "Use --url with the Takosumi platform origin and --token with the",
    "deploy-control bearer. Credential values are accepted only through files",
    "and are never printed by the CLI. This CLI is operator-only: it manages",
    "Takosumi-provided defaults and platform secrets. Space/user-owned provider",
    "env sets are created through dashboard/API flows.",
  ].join("\n");
}

export function connectionsListHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections list",
      "",
      "オプション:",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
      "",
      "環境変数:",
      "  TAKOSUMI_DEPLOY_CONTROL_URL",
      "  TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    ].join("\n");
  }
  return [
    "takosumi connections list",
    "",
    "Options:",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
    "",
    "Environment:",
    "  TAKOSUMI_DEPLOY_CONTROL_URL",
    "  TAKOSUMI_DEPLOY_CONTROL_TOKEN",
  ].join("\n");
}

export function connectionsCreateCloudflareHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections set-cloudflare-token",
      "",
      "オプション:",
      "  --api-token-file <path>  Cloudflare API token を含む file",
      "  --values-file <path>     JSON object。例: {\"CLOUDFLARE_API_TOKEN\":\"...\"}",
      "  --display-name <name>",
      "  --account-id <id>",
      "  --zone-id <id>",
      "  --expires-at <iso8601>",
      "  --default <provider,...>  operator default も同時に設定。例: cloudflare",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi connections set-cloudflare-token",
    "",
    "Options:",
    "  --api-token-file <path>  file containing the Cloudflare API token",
    "  --values-file <path>     JSON object, e.g. {\"CLOUDFLARE_API_TOKEN\":\"...\"}",
    "  --display-name <name>",
    "  --account-id <id>",
    "  --zone-id <id>",
    "  --expires-at <iso8601>",
  "  --default <provider,...>  also set operator defaults, e.g. cloudflare",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
  ].join("\n");
}

export function connectionsTestHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections test <connection-id>",
      "",
      "オプション:",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi connections test <connection-id>",
    "",
    "Options:",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
  ].join("\n");
}

export function connectionsRevokeHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections revoke <connection-id>",
      "",
      "オプション:",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi connections revoke <connection-id>",
    "",
    "Options:",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
  ].join("\n");
}

export function connectionsDefaultsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections defaults <command>",
      "",
      "コマンド:",
      "  list",
      "  set <provider> <connection-id>",
    ].join("\n");
  }
  return [
    "takosumi connections defaults <command>",
    "",
    "Commands:",
    "  list",
    "  set <provider> <connection-id>",
  ].join("\n");
}

export function connectionsDefaultsSetHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections defaults set <provider> <connection-id>",
      "",
      "Provider:",
      "  cloudflare のような短縮名、または OpenTofu provider source",
      "",
      "オプション:",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi connections defaults set <provider> <connection-id>",
    "",
    "Provider:",
    "  short name such as cloudflare or an OpenTofu provider source",
    "",
    "Options:",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
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
    "collection guidance: root docs/quality/managed-offering-evidence-summary.md",
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
    "  --deploy-control-url <url>",
    "  --deploy-control-token <token>",
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
    "  TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_URL",
    "  TAKOSUMI_DEPLOY_CONTROL_TOKEN",
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
