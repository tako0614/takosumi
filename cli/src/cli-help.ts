import process from "node:process";

const platformReadinessKind = "takosumi.platform-readiness@v2";
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
      "Git URL install が標準です:",
      "  dashboard /install?git=... から Capsule を追加",
      "  status <run-id>         Run の状態を表示",
      "  logs   <run-id>         Run のログを表示",
      "",
      "Resource Shape:",
      "  resources               Resource の preview / apply / import / drift 操作",
      "",
      "Operator:",
      "  connections             operator connection と internal resolver を管理",
      "  form-activations        exact FormRef の公開ポリシーを管理",
      "  target-pools            TargetPool 宣言を管理",
      "  space-policies          SpacePolicy 宣言を管理",
      "",
      "Install link の例:",
      "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com",
      "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
      "  open 'https://takosumi.example.com/install?git=https://git.example.com/example/app.git&path=deploy/opentofu'",
      "",
      "内部/開発用コマンドは help には表示しません。",
      "日本語表示は TAKOSUMI_LANG=ja または LANG=ja_* で有効になります。",
    ].join("\n");
  }
  return [
    "takosumi",
    "",
    "Git URL install is the standard flow:",
    "  dashboard /install?git=...  add a Capsule from Git URL",
    "  status <run-id>         show a Run's status",
    "  logs   <run-id>         show a Run's logs",
    "",
    "Resource Shape:",
    "  resources               Preview and reconcile typed Resources",
    "",
    "Operator:",
    "  connections             Manage operator connections and internal resolvers",
    "  form-activations        Manage exact FormRef audience policy",
    "  target-pools            Manage TargetPool declarations",
    "  space-policies          Manage SpacePolicy declarations",
    "",
    "Install link example:",
    "  export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com",
    "  export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>",
    "  open 'https://takosumi.example.com/install?git=https://git.example.com/example/app.git&path=deploy/opentofu'",
    "",
    "Internal/development commands are intentionally hidden from this help.",
  ].join("\n");
}

export function formActivationsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi form-activations <command>",
      "",
      "コマンド:",
      "  list [--limit <n> --cursor <opaque>]",
      "  get <id>",
      "  create --file <activation.json>",
      "  update <id> --file <activation-update.json>",
      "",
      "operator bearer のみが利用できます。価格、SKU、請求、容量、SLA は FormActivation に含めません。",
      "共通オプション: --url、--token、--json",
    ].join("\n");
  }
  return [
    "takosumi form-activations <command>",
    "",
    "Commands:",
    "  list [--limit <n> --cursor <opaque>]",
    "  get <id>",
    "  create --file <activation.json>",
    "  update <id> --file <activation-update.json>",
    "",
    "Only the operator bearer may use this API. FormActivation contains no price, SKU, billing, capacity, or SLA.",
    "Common options: --url, --token, --json",
  ].join("\n");
}

export function resourcesHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi resources <command>",
      "",
      "コマンド:",
      "  list --space <id> [--limit <n> --cursor <opaque>]",
      "  get <kind> <name> --space <id>",
      "  events <kind> <name> --space <id> [--limit <n> --cursor <opaque>]",
      "  preview --file <resource.json>",
      "  apply <kind> <name> --file <resource.json> [--yes]",
      "  import <kind> <name> --file <resource-with-native-id.json>",
      "  observe <kind> <name> --space <id>",
      "  refresh <kind> <name> --space <id>",
      "  delete <kind> <name> --space <id> [--managed-by <manager>] [--force]",
      "",
      "共通オプション:",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
      "  --yes  preview した plan と価格を承認して apply",
      "",
      "write request は non-secret JSON object として file から読みます。",
      "--force は operator の break-glass 認可がある endpoint だけで成功します。",
      "--managed-by を省略した delete は opentofu 所有 Resource だけを対象にします。",
    ].join("\n");
  }
  return [
    "takosumi resources <command>",
    "",
    "Commands:",
    "  list --space <id> [--limit <n> --cursor <opaque>]",
    "  get <kind> <name> --space <id>",
    "  events <kind> <name> --space <id> [--limit <n> --cursor <opaque>]",
    "  preview --file <resource.json>",
    "  apply <kind> <name> --file <resource.json> [--yes]",
    "  import <kind> <name> --file <resource-with-native-id.json>",
    "  observe <kind> <name> --space <id>",
    "  refresh <kind> <name> --space <id>",
    "  delete <kind> <name> --space <id> [--managed-by <manager>] [--force]",
    "",
    "Common options:",
    "  --url <deploy-control-url>",
    "  --token <deploy-control-bearer>",
    "  --json",
    "  --yes  approve the previewed plan and price, then apply",
    "",
    "Write requests are read from non-secret JSON object files.",
    "--force succeeds only when the endpoint grants operator break-glass access.",
    "Without --managed-by, delete targets only Resources owned by opentofu.",
  ].join("\n");
}

export function targetPoolsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi target-pools <command>",
      "",
      "コマンド:",
      "  list --space <id> [--limit <n> --cursor <opaque>]",
      "  get <name> --space <id>",
      "  put <name> --file <target-pool.json>",
      "  delete <name> --space <id>",
      "",
      "put file は top-level の space と spec.targets を持つ non-secret JSON object です。",
      "共通オプション: --url、--token、--json",
    ].join("\n");
  }
  return [
    "takosumi target-pools <command>",
    "",
    "Commands:",
    "  list --space <id> [--limit <n> --cursor <opaque>]",
    "  get <name> --space <id>",
    "  put <name> --file <target-pool.json>",
    "  delete <name> --space <id>",
    "",
    "The put file is a non-secret JSON object with top-level space and spec.targets.",
    "Common options: --url, --token, --json",
  ].join("\n");
}

export function spacePoliciesHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi space-policies <command>",
      "",
      "コマンド:",
      "  list --space <id> [--limit <n> --cursor <opaque>]",
      "  get <name> --space <id>",
      "  put <name> --file <space-policy.json>",
      "  delete <name> --space <id>",
      "",
      "put file は top-level の space と spec を持つ non-secret JSON object です。",
      "共通オプション: --url、--token、--json",
    ].join("\n");
  }
  return [
    "takosumi space-policies <command>",
    "",
    "Commands:",
    "  list --space <id> [--limit <n> --cursor <opaque>]",
    "  get <name> --space <id>",
    "  put <name> --file <space-policy.json>",
    "  delete <name> --space <id>",
    "",
    "The put file is a non-secret JSON object with top-level space and spec.",
    "Common options: --url, --token, --json",
  ].join("\n");
}

export function connectionsHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections <command>",
      "",
      "コマンド:",
      "  list",
      "  create",
      "  test <connection-id>",
      "  revoke <connection-id>",
      "",
      "`--url` に Takosumi platform origin、`--token` に deploy-control bearer を渡します。",
      "credential 値は file からだけ読み、CLI には表示しません。",
      "create は provider source と Credential Recipe を明示して Provider Connection を作成します。",
    ].join("\n");
  }
  return [
    "takosumi connections <command>",
    "",
    "Commands:",
    "  list",
    "  create",
    "  test <connection-id>",
    "  revoke <connection-id>",
    "",
    "Use --url with the Takosumi platform origin and --token with the",
    "deploy-control bearer. Credential values are accepted only through files",
    "and are never printed by the CLI. create requires an explicit provider source,",
    "Credential Recipe id/auth mode, and secret partition.",
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

export function connectionsCreateHelpText(): string {
  if (isJapaneseCli()) {
    return [
      "takosumi connections create",
      "",
      "provider source と Credential Recipe を明示して Provider Connection を作成します。",
      "credential値はfileからだけ読み、CLIには表示しません。",
      "",
      "オプション:",
      "  --provider <source>     必須。完全修飾 provider source",
      "  --recipe <id>           必須。Credential Recipe id",
      "  --auth-mode <mode>      必須。recipe auth mode",
      "  --secret-partition <id> 必須。暗号境界の任意 token",
      "  --scope <workspace|operator> 省略時は --workspace の有無から決定",
      "  --workspace <workspace-id> Workspace scope の所有 Workspace",
      "  --values-file <path>    credential env の JSON object",
      "  --files-file <path>     credential file の JSON array",
      "  --scope-hints-file <path>  任意の非secret JSON object",
      "  --display-name <name>",
      "  --expires-at <iso8601>",
      "  --url <deploy-control-url>",
      "  --token <deploy-control-bearer>",
      "  --json",
    ].join("\n");
  }
  return [
    "takosumi connections create",
    "",
    "Creates a Provider Connection from explicit provider and Credential Recipe data.",
    "Credential values are read only from files and are never printed by the CLI.",
    "",
    "Options:",
    "  --provider <source>     required fully-qualified provider source",
    "  --recipe <id>           required Credential Recipe id",
    "  --auth-mode <mode>      required recipe auth mode",
    "  --secret-partition <id> required opaque encryption partition token",
    "  --scope <workspace|operator> inferred from --workspace when omitted",
    "  --workspace <workspace-id> owning Workspace for workspace scope",
    "  --values-file <path>    JSON object containing credential env",
    "  --files-file <path>     JSON array containing credential files",
    "  --scope-hints-file <path>  optional non-secret JSON object",
    "  --display-name <name>",
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
    "Calls `bunx wrangler d1 execute <database-name-or-binding> --command ...` once per",
    "pending migration and records each applied version in",
    "takosumi_accounts_schema_migrations.",
    "",
    "Options:",
    "  --database-id <name>   D1 database name or binding (Wrangler d1 execute positional)",
    "  --wrangler-config <path>",
    "                         Target Worker wrangler config when running from a sibling checkout",
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
    "Options:",
    "  --contribution-file <path>  Optional versioned contribution JSON object or array",
    "",
    "Print a fail-closed JSON skeleton for platform readiness evidence.",
    "The full selected contribution definition is embedded in the @v2 document,",
    "so later validation needs no provider-specific validator or registry lookup.",
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
    "  --contribution-file <path>  Fix the v2 profile to versioned contribution JSON",
    "  --dry-run      Report changes without writing output",
    "  --check        Exit 1 when legacy names are still present",
    "  --json         Print migration report JSON",
    "",
    "Migrates pre-final-plan readiness event and owner keys to the final",
    "Workspace/Capsule/Run/StateVersion evidence schema, upgrades a readiness",
    "document to @v2, maps retired baseline readiness IDs explicitly, and fixes",
    "the selected contribution definition. For an operation-drill evidence",
    "envelope, its kind and metadata stay unchanged while readinessPatch is",
    "migrated. Raw evidence is",
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
    "  --subject-secret <secret>",
    "  --upstream-providers <json-array>",
    "  --upstream-session-ttl-ms <milliseconds>",
    "  --passkey-rp-id <domain>",
    "  --passkey-rp-name <name>",
    "  --passkey-origin <origin>",
    "  --passkey-session-ttl-ms <milliseconds>",
    "  --database-url <postgres-url>",
    "  --dev-session-id <sess_...>  seed one in-memory dev Accounts session",
    "  --dry-run",
    "",
    "Environment:",
    "  TAKOSUMI_ACCOUNTS_DATABASE_URL",
    "  <clientSecretEnv named by each upstream provider descriptor>",
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
