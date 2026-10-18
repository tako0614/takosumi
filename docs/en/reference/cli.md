# CLI

The Takosumi CLI lets you script things you can also do in the dashboard. You
normally add services in the dashboard (from the Store or a Git URL), and use
the CLI afterwards to check on them (`takosumi status`, `takosumi logs`) and to
manage API keys and connections.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

takosumi status <run-id>
takosumi logs   <run-id>
```

Set `TAKOSUMI_DEPLOY_CONTROL_URL` to the origin where you sign in to the dashboard;
for the Takosumi hosted service it is `https://app.takosumi.com`. Create the API
key for `TAKOSUMI_DEPLOY_CONTROL_TOKEN` as described in
[Creating a token](#creating-a-token) below.

The CLI does not run OpenTofu itself. A runner does the plan and apply, and cloud
credentials reach it only while a Run executes (see
[Credentials](../concepts/credentials.md)). The link format that opens the add
screen from a Git URL is in
[Sources and Capsules](../concepts/sources.md#the-screen-and-links-from-outside).
Sending local files with `takosumi deploy` / `takosumi plan` is retired.

## Setting up the CLI

The CLI lives in this repository's `cli/` and runs directly on Bun. It is not yet
distributed through a package manager, so install the dependencies in a checkout and
make `takosumi` callable from there.

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
alias takosumi="bun $PWD/cli/src/main.ts"
takosumi --help
```

The `takosumi ...` commands on this page and the others assume that alias.
`bun run cli -- <command>` also works, but bun prints the command line it runs, which
leaves any bearer passed to `--token` in your terminal.

## Creating a token

The CLI and the API examples on other pages read their bearer from the
`TAKOSUMI_DEPLOY_CONTROL_TOKEN` environment variable. Normally you put an API
key created in the dashboard in it.

1. In the dashboard, open **Settings**, then **Account**.
2. Under **Takosumi API keys**, choose a name and an expiry (the key stops
   working after it), select both **Read** and **Write** under **Permissions**,
   and press **Create API key**. The examples on other pages both read and
   change things, and `read` and `write` do not include each other, so with
   **Write** alone the reading examples return `403`. **Restrict this key to the
   current Workspace** starts ticked, and such a key works only inside that
   Workspace; untick it for examples that list Workspaces or touch other ones.
3. The secret is shown once, when the key is created. Copy it into
   `TAKOSUMI_DEPLOY_CONTROL_TOKEN`.

The server's setting of the same name is the operator's secret, for work that
calls the operator-only API; `takosumi connections` on this page is such work
and needs that secret.

### Creating one from the CLI

If you have an Accounts session bearer (`sess_...`), the CLI can create a key
with the same scopes. It has no Workspace restriction, and it expires only if
you pass `--expires-at`.

```bash
takosumi accounts tokens create \
  --name my-cli \
  --scope read,write \
  --accounts-url "$TAKOSUMI_ACCOUNTS_URL" \
  --token "$TAKOSUMI_ACCOUNTS_SESSION_BEARER"
```

| Option | Meaning |
| --- | --- |
| `--name` | A name for recognizing the token |
| `--scope` | `read` / `write` / `admin` |
| `--expires-at` | Expiration time (ISO 8601) |
| `--accounts-url` | The Accounts URL; the environment variable is `TAKOSUMI_ACCOUNTS_URL` |
| `--token` | **The Accounts session bearer** (`sess_...`). If omitted, `TAKOSUMI_ACCOUNTS_TOKEN` is read, then the legacy `TAKOS_TOKEN`. With none of them, the request is sent without a bearer and Accounts rejects it |
| `--json` | Print JSON |

The `--token` passed to `accounts` commands is an Accounts session bearer, not the
token being issued. This is the one place where the value passed differs from the other
commands.

**The issued token string is returned only once, when it is created.** The list command
shows only metadata such as the name, prefix, scope, and creation time. If you lose the
string, it cannot be recovered; create a new token and revoke the old one.

```bash
takosumi accounts tokens list   --accounts-url "$TAKOSUMI_ACCOUNTS_URL" --token "$SESSION"
takosumi accounts tokens revoke pat_example --accounts-url "$TAKOSUMI_ACCOUNTS_URL" --token "$SESSION"
```

You cannot assign yourself the `admin` scope. Only a token issued by an operator can have it.

## Setting up a self-hosted Accounts plane

These commands are for running Accounts in your own environment. They are unnecessary when
you only need to use an endpoint that is already running. Run a public Accounts plane from
the Cloudflare template or the Bun and PostgreSQL one (see
[Running it yourself](../concepts/self-host.md)).

### Apply the schema

For PostgreSQL:

```bash
takosumi accounts migrate --database-url "$TAKOSUMI_ACCOUNTS_DATABASE_URL"
```

Add `--dry-run` to show what would run without applying it. The database URL can also be
read from `TAKOSUMI_ACCOUNTS_DATABASE_URL`.

Cloudflare D1 schema migration is not a user-facing command: the operator runs it in
the same change window as the release. For your own installation, the procedure is in
[Running it yourself](../self-host/cloudflare.md).

### Seed the initial data

```bash
takosumi accounts seed \
  --issuer https://accounts.example.com \
  --subject tsub_example \
  --client-id example-client \
  --redirect-uri https://app.example.com/callback
```

### Start Accounts for a local check

`takosumi accounts serve` is for checking things locally. It creates a throwaway signing
key every time the process starts, so it cannot serve a public Accounts plane. By default
it listens on `127.0.0.1:8787` and keeps data in memory only.

```bash
takosumi accounts serve --issuer http://localhost:8787
```

With `--database-url`, accounts and sessions are stored in that database; the signing key
still changes on every start.

When using an upstream identity provider or passkeys, also provide options such as
`--upstream-providers` (a JSON array), `--passkey-rp-id`, `--passkey-rp-name`, and
`--passkey-origin`. For a local check that needs only one session, use
`--dev-session-id sess_...`; it works only without `--database-url`. **Do not use this
in production.**

## Platform Readiness Contributions

This is for operators preparing launch-readiness evidence. It adds the extra evidence a hosted
service or another edition requires on top of the OSS baseline. If you only add and use services,
you do not need this section.

::: details Show how contributions are built and validated

`takosumi launch-readiness template` generates the baseline shared by OSS and
Operator. When a hosted service or another edition requires additional
operational evidence, the owner maintains a versioned
`PlatformReadinessContribution` JSON and selects it at template-generation time
with `--contribution-file <path>`.

```bash
takosumi launch-readiness template \
  --contribution-file <owner-controlled-contribution.json> \
  > readiness.private.json

takosumi launch-readiness validate \
  --file readiness.private.json \
  --contribution-file <owner-controlled-contribution.json>
```

The generated `takosumi.platform-readiness@v2` document embeds the
contribution's `id`, `version`, and `capability` plus its additional
requirement/evidence schema. That embedded copy is not authority. `validate`,
`public-summary`, and `public-summary validate` require the owner-controlled
`--contribution-file` again whenever a document selects contributions. The
validator composes the trusted input and fails closed unless the entire embedded
content matches it exactly, without provider-specific code or an external
registry lookup. A different contribution version is never implicitly
treated as the same readiness profile. `validate` never double-interprets a
legacy baseline ID; an explicit `launch-readiness migrate-final-model` updates
it exactly once.

Evidence that can be reused only for a limited time declares its field as
`utc-timestamp` in the evidence schema's `formats` and lists the same field in
`notExpired`. The validator never guesses an expiry from a field name; it compares a
canonical UTC timestamp with the current time only when this schema data is present. An
expired reference is incomplete, and the report's `ready` is false. When several evidence
types across domains and rehearsals must share an identity field, declare the field and
type pairs in `consistentFields` at the top level of the contribution. Each type must
belong to exactly one requirement group in the whole profile, and validation fails if the
values differ. `ready` only means the selected profile's evidence was consistent at
validation time; it grants no GA or open-access decision, deploy or release approval, or
mutation authority.

There is no ad hoc collector DSL. When a contribution assists collection
planning, it may only assign its own evidence types to the existing fixed
classes (`browser-user-e2e`, `external-provider`, `operator-review`,
`live-probe-sync`, `operation-drill`, `release-provenance`) through
`collectionClassHints`. Extension evidence that omits a hint remains valid for
validation but is uncategorized for collection planning.
The `takosumi.platform-readiness-report@v2` validation result also returns the
composed definition's `requiredDomainIds` and `requiredRehearsalStepIds`.
Progress consumers use those arrays instead of OSS-only fixed IDs, so totals and
completed counts remain exact when Operator or hosted-service contributions are present.

:::

## Connections

Provider credential values are read from files and are never printed.

```bash
takosumi connections create \
  --workspace ws_example \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file <path-to-credential-env-json>

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

Without `--workspace`, a ProviderConnection is operator-scoped, and by default it cannot back
a Capsule's provider assignment. A ProviderConnection created from the CLI names its target
provider explicitly with
`--provider`, as a fully-qualified source such as `registry.opentofu.org/example/example`;
the CLI never infers one.

## Deployment secrets

The selected runtime adapter and operator vault own deployment-secret storage
and application. The Takosumi CLI does not treat Wrangler, one Worker runtime,
or a fixed secret-name manifest as canonical. Register provider credentials as
Provider Connections through `connections`; generate and store platform-service
signing keys and internal bearers outside the repository, then apply them with
the chosen deployment adapter's native secret command.
