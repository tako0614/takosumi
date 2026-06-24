import process from "node:process";

const platformReadinessKind = "takosumi.platform-readiness@v1";
const platformReadinessProductionTopologyKind =
  "takosumi.production-topology@v1";

export function isJapaneseCli(): boolean {
  const explicit = process.env.TAKOSUMI_LANG ?? process.env.TAKOSUMI_LOCALE;
  if (explicit) return explicit.toLowerCase().startsWith("ja");
  const locale =
    process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? "";
  return locale.toLowerCase().startsWith("ja");
}

export function helpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi",
      "",
      "Local upload helper (Git URL install は dashboard / /install?git=... が標準):",
      "  deploy [dir]            ローカル OpenTofu Capsule を upload→plan→apply",
      "  plan   [dir]            upload→plan のみ (apply しない)",
      "  status <run-id>         Run の状態を表示",
      "  logs   <run-id>         Run のログを表示",
      "",
      "Operator:",
      "  connections             operator connection と internal resolver を管理",
      "  secrets                 Worker secret の確認と適用",
      "",
      "deploy の例:",
      "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com",
      "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
      "  takosumi deploy ./my-capsule --space @me --name my-app --provider cloudflare=conn_cf --var region=apac",
      "",
      "内部/開発用コマンドは help には表示しません。",
      "日本語表示は TAKOSUMI_LANG=ja または LANG=ja_* で有効になります。",
    ].join("\n");
  }
  return [
    "takosumi",
    "",
    "Local upload helper (Git URL install is the standard dashboard flow):",
    "  deploy [dir]            upload a local OpenTofu Capsule, then plan/apply",
    "  plan   [dir]            upload + plan only (no apply)",
    "  status <run-id>         show a Run's status",
    "  logs   <run-id>         show a Run's logs",
    "",
    "Operator:",
    "  connections             Manage operator connections and internal resolvers",
    "  secrets                 Check and apply Worker secrets",
    "",
    "Deploy example:",
    "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://app.takosumi.com",
    "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
    "  takosumi deploy ./my-capsule --space @me --name my-app --provider cloudflare=conn_cf --var region=apac",
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
      "Provider Connection は dashboard/API flow で扱います。",
      "内部 resolver record は通常 CLI surface では操作しません。",
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
    "secrets. It only prints secret names and counts, never values. Provider",
    "Connection setup is a dashboard/API flow. Internal",
    "resolver records are not part of the normal CLI surface.",
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
      "AI Gateway の `TAKOSUMI_AI_GATEWAY_PROFILES` は env または wrangler config の",
      "`[vars]` から読みます。`openai_compatible` profile は `apiKeyEnv` が指す",
      "Worker secret 名の不足も検出します。`workers_ai_binding` profile は Worker",
      "`AI` binding を使うため upstream secret を要求しません。",
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
    "Reads `TAKOSUMI_AI_GATEWAY_PROFILES` from the environment or the",
    "wrangler config `[vars]` block. `openai_compatible` profiles report",
    "missing Worker secrets named by `apiKeyEnv`. `workers_ai_binding`",
    "profiles use the Worker `AI` binding and do not require upstream secrets.",
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
      "  --init-protected",
      "  --local-only",
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
    "  --init-protected",
    "  --local-only",
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
      "",
      "`--url` に Takosumi platform origin、`--token` に deploy-control bearer を渡します。",
      "credential 値は file からだけ読み、CLI には表示しません。",
      "この CLI は operator-only です。operator-scope Provider Connection backing material を扱います。",
      "Space 用 Provider Connection helper は dashboard/API flow で作成します。",
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
    "",
    "Use --url with the Takosumi platform origin and --token with the",
    "deploy-control bearer. Credential values are accepted only through files",
    "and are never printed by the CLI. This CLI is operator-only: it manages",
    "operator-scope Provider Connection backing material. Space Provider Connection",
    "helpers are created through dashboard/API flows.",
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
      '  --values-file <path>     JSON object。例: {"CLOUDFLARE_API_TOKEN":"..."}',
      "  --display-name <name>",
      "  --account-id <id>",
      "  --zone-id <id>",
      "  --expires-at <iso8601>",
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
    '  --values-file <path>     JSON object, e.g. {"CLOUDFLARE_API_TOKEN":"..."}',
    "  --display-name <name>",
    "  --account-id <id>",
    "  --zone-id <id>",
    "  --expires-at <iso8601>",
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
    "Calls `npx wrangler d1 execute <database-name-or-binding> --command ...` once per",
    "pending migration and records each applied version in",
    "takosumi_accounts_schema_migrations.",
    "",
    "Options:",
    "  --database-id <name>   D1 database name or binding (Wrangler d1 execute positional)",
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
    `Document kind: ${platformReadinessKind}`,
    "JSON output includes gapDetails for missing or incomplete evidence.",
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
    "  --markdown-row  Print one row for docs/quality/platform-readiness-evidence-summary.md",
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

export function launchReadinessOidcAccountSecurityEvidenceHelpText(): string {
  return [
    "takosumi launch-readiness oidc-account-security evidence",
    "",
    "Options:",
    "  --file <path>                    Existing private readiness JSON",
    "  --out <path>                     Write updated readiness JSON here",
    "  --issuer <https-url>             Expected OIDC issuer",
    "  --jwks-file <path>               Use captured JWKS JSON instead of live fetch",
    "  --key-id <kid>                   New signing key id that must appear in JWKS",
    "  --previous-key-id <kid>          Previous signing key id; must also appear in JWKS",
    "  --rotation-run-id <id>           Operator key/client-secret rotation run id",
    "  --client-id <id>                 Upstream OAuth client id",
    "  --old-secret-id <id>             Operator-vault id of the old client secret",
    "  --new-secret-id <id>             Operator-vault id of the new client secret",
    "  --overlap-window-seconds <n>     Positive client-secret overlap window",
    "  --revocation-event-id <id>       Upstream/client-secret revocation event id",
    "  --audit-event-id <id>            Audit ledger event id for the rotation",
    "  --audit-subject <subject>        Operator subject recorded in audit",
    "  --owner <actor>                  Evidence owner",
    "  --reviewer <actor>               Distinct reviewer",
    "  --environment <env>              production or staging",
    "  --completed-at <iso8601>         Completion timestamp",
    "  --ref-prefix <ref>               Private evidence ref prefix",
    "  --json",
    "",
    "Merges only the OIDC account-security evidence that can be tied to a",
    "verified JWKS key id and operator-supplied rotation/audit records.",
  ].join("\n");
}

export function launchReadinessTemplateHelpText(): string {
  return [
    "takosumi launch-readiness template",
    "",
    "Print a fail-closed JSON skeleton for platform readiness evidence.",
    "Each required evidence type is expanded with its structured field shape,",
    "private=true, and a required publicSummary placeholder.",
    "Fill every row, change status to passed only after live evidence exists,",
    "and use structured evidence refs with type, ref, and summary fields;",
    "collection guidance: root docs/quality/platform-readiness-evidence-summary.md",
    "then validate it with launch-readiness validate --file <path>.",
  ].join("\n");
}

export function launchReadinessMigrateFinalModelHelpText(): string {
  return [
    "takosumi launch-readiness migrate-final-model",
    "",
    "Options:",
    "  --file <path>  Existing private readiness JSON",
    "  --out <path>   Write migrated JSON here",
    "  --dry-run      Report changes without writing output",
    "  --check        Exit 1 when legacy names are still present",
    "  --json         Print migration report JSON",
    "",
    "Migrates pre-final-plan readiness evidence names such as",
    "installation-created, installationId, and spaceId to the final",
    "Workspace/Capsule/Run/StateVersion evidence schema. Raw evidence is",
    "not printed; pass --out to write the migrated document.",
  ].join("\n");
}

export function launchReadinessProductionTopologyTemplateHelpText(): string {
  return [
    "takosumi launch-readiness production-topology template",
    "",
    "Options:",
    "  --environment <staging|production>",
    "",
    `Document kind: ${platformReadinessProductionTopologyKind}`,
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
    `Document kind: ${platformReadinessProductionTopologyKind}`,
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
    "  --service-binding-materials-file <path>",
    "  --shared-cell-slots <cell-id:capacity[,cell-id:capacity...]>",
    "  --shared-cell-scale-out-policy <json>",
    "  --materialize-worker-url <url>",
    "  --materialize-worker-token <token>",
    "  --service-graph-material-resolver-token <token>",
    "  --billing-portal-url <url>",
    "  --export-output-dir <path>",
    "  --export-download-base-url <url>",
    "  --export-data-dir <path>",
    "  --export-download-ttl-ms <milliseconds>",
    "  --platform-access <closed|open>",
    "  --platform-readiness-file <path>",
    "  --platform-readiness-digest <sha256:digest>",
    "  --platform-evidence-ref <ref>",
    "  --platform-approval-ref <ref>",
    "  --platform-public-summary <text>",
    "  --database-url <postgres-url>",
    "  --dev-session-id <sess_...>  seed one in-memory dev Accounts session",
    "  --dry-run",
    "",
    "Environment:",
    "  TAKOSUMI_ACCOUNTS_DATABASE_URL",
    "  TAKOSUMI_DEPLOY_CONTROL_URL",
    "  TAKOSUMI_DEPLOY_CONTROL_TOKEN",
    "  TAKOSUMI_ACCOUNTS_SERVICE_BINDING_MATERIALS",
    "  TAKOSUMI_ACCOUNTS_SHARED_CELL_SLOTS",
    "  TAKOSUMI_ACCOUNTS_SHARED_CELL_SCALE_OUT_POLICY",
    "  TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_URL",
    "  TAKOSUMI_ACCOUNTS_MATERIALIZE_WORKER_TOKEN",
    "  TAKOSUMI_ACCOUNTS_SERVICE_GRAPH_MATERIAL_RESOLVER_TOKEN",
    "  TAKOSUMI_ACCOUNTS_BILLING_PORTAL_URL",
    "  TAKOSUMI_ACCOUNTS_EXPORT_OUTPUT_DIR",
    "  TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_BASE_URL",
    "  TAKOSUMI_ACCOUNTS_EXPORT_DATA_DIR",
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
    "takosumi internal installations list",
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
    "takosumi internal installations inspect <installation-id>",
    "",
    "Options:",
    "  --accounts-url <url>",
    "  --token <accounts-session-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsUninstallHelpText(): string {
  return [
    "takosumi internal installations uninstall <installation-id>",
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
    "takosumi internal installations status <installation-id>",
    "",
    "Options:",
    "  --status <installing|ready|suspended|exported|failed>",
    "  --reason <text>",
    "  --mode <shared-cell|dedicated|self-hosted>",
    "  --operation <materialize|export>",
    "  --operation-id <op_...>",
    "  --preserve-digest <sha256:...>",
    "  --runtime-target-record-id <id>",
    "  --runtime-target-type <shared-cell|dedicated|self-hosted>",
    "  --runtime-target-id <id>",
    "  --download-url <url>",
    "  --download-expires-at <iso8601>",
    "  --archive-digest <sha256:...>",
    "  --error <message>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsMaterializeHelpText(): string {
  return [
    "takosumi internal installations materialize <installation-id>",
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
    "  --drill-token <operator-token>",
    "  --drill-token-file <path>",
    "  --json",
  ].join("\n");
}

export function installationsExportHelpText(): string {
  return [
    "takosumi internal installations export <installation-id>",
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

export function installationsExportOperationHelpText(): string {
  return [
    "takosumi internal installations export-operation <installation-id> <operation-id>",
    "",
    "Reads an installation export operation without downloading the archive.",
    "",
    "Options:",
    "  --accounts-url <url>",
    "  --token <accounts-read-bearer>",
    "  --json",
  ].join("\n");
}

export function installationsImportPlanHelpText(): string {
  return [
    "takosumi internal installations import-plan",
    "",
    "Reads a takos-export/bundle.json payload or a Cloudflare/R2 export JSON",
    "document and prints the target deploy-control PlanRun request plus the",
    "Accounts projection create template that import-apply can execute.",
    "This does not call the retired public import route.",
    "",
    "Options:",
    "  --bundle-file <takos-export/bundle.json>",
    "  --target-issuer <https://self-host.example>",
    "  --target-account <account-id>",
    "  --target-space <space-id>",
    "  --created-by-subject <tsub_...>",
    "  --target-installation-id <installation-id>",
    "  --mode <shared-cell|dedicated|self-hosted>",
    "  --out-file <path>",
    "  --json",
  ].join("\n");
}

export function installationsImportApplyHelpText(): string {
  return [
    "takosumi internal installations import-apply",
    "",
    "Applies an installation import through the target Accounts/deploy-control",
    "flow: create/sync the target Git Source, create the target Installation,",
    "create target PlanRun, require it to be succeeded, then create the Accounts",
    "projection using the reviewed expected guard.",
    "This does not call the retired public import route.",
    "",
    "Options:",
    "  --plan-file <import-plan.json>",
    "  --bundle-file <takos-export/bundle.json>",
    "  --target-issuer <https://self-host.example>",
    "  --target-account <account-id>",
    "  --target-space <space-id>",
    "  --created-by-subject <tsub_...>",
    "  --target-installation-id <review-only-installation-id>",
    "  --mode <shared-cell|dedicated|self-hosted>",
    "  --install-config-id <id>   default: cfg-default-opentofu-capsule",
    "  --environment <name>       default: production",
    "  --wait-timeout-seconds <n> default: 120",
    "  --wait-interval-ms <n>     default: 1000",
    "  --idempotency-key <key>",
    "  --accounts-url <url>",
    "  --token <accounts-write-bearer>",
    "  --out-file <path>",
    "  --json",
  ].join("\n");
}
