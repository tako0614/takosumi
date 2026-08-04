# Repository manifest and repository-owned install UX report

Status: implemented and selected for Yurucommu's managed Store path.
`contract/repository-manifest.ts` is the current wire contract. The general
repository envelope is captured with the immutable `SourceSnapshot`; its
current `install` section is compiled against the exact compatibility report
and persisted as a DB-owned per-install `InstallConfig`. Present invalid
declarations fail closed with a diagnostic; they never silently fall back to a
raw-variable form.

Date: 2026-07-29

Scope: Takosumi OSS Store-to-Capsule install UX, optional Git repository
metadata, `InstallConfig` compilation, and the Yurucommu install as the concrete
acceptance case.

## Implementation status

- Yurucommu owns `.well-known/takosumi.json`.
- The transitional direct module `.` remains declared and installable.
- The Store supplies only the Yurucommu repository URL. The synced repository's
  `takosumi.com/v2.1` manifest selects `deploy/takoform` through
  `install.defaultModule`; the matching host policy cannot override it.
- Takosumi compiles the exact module declaration into an immutable,
  Workspace-scoped `InstallConfig` before Capsule creation.
- App vocabulary and labels come from the repository declaration. Managed
  hostname policy, database migration authority, installer binding authority,
  provider selection, credentials, and runtime materialization remain
  service/host owned.
- The managed module declares an IaC-owned launcher Interface. Takosumi adds
  only an explicit `ui.open` Binding for the authenticated installing
  principal; it does not recreate the Interface from an Output blueprint.
- Invalid, stale, mismatched, or unsupported declarations are visible as
  actionable compatibility failures.

The findings below preserve the original audit rationale. Statements labelled
as current state describe the pre-implementation baseline unless a resolution
is noted above.

## Outcome

Takosumi supports an optional, repository-owned general manifest at:

```text
.well-known/takosumi.json
```

The current closed envelope is:

```text
apiVersion: takosumi.com/v1alpha1
kind: Repository
```

The current version defines only `install.modules`; it does not add empty
reserved sections for future application, link, or Interface discovery.
`$schema` and the retired install-only `schemaVersion` are not wire fields.
Future sections require a new closed `apiVersion`.

This manifest is an optional enhancement for a plain Git/OpenTofu repository.
It is not required to install a module and does not replace the Git Source,
immutable `SourceSnapshot`, selected module path, compatibility report,
service-side `InstallConfig`, reviewed Plan, provider bindings, or Run
authority.

The ownership split is:

- the app repository owns what the application calls a user choice, the labels
  and help shown for that choice, and the mapping from app concepts to its own
  OpenTofu variable names;
- Takosumi owns whether a requested projection is supported, how Workspace,
  hostname, OIDC, credential, generated-secret, provider, policy, and runtime
  values are resolved, and the exact `InstallConfig` persisted for a Plan;
- the selected module owns variable types, defaults, validation, resources, and
  Outputs;
- a TCS Store node owns discovery and browse presentation only;
- an operator or Takosumi Cloud owns which targets, domains, providers, and
  managed integrations are actually available.

The ordinary Yurucommu install should require zero values when Takosumi-managed
hostname allocation and Takosumi Accounts OIDC are available. A user may
optionally change the public URL or select a password-based bootstrap mode.
Cloud provider identifiers, resource names, bindings, release artifact
coordinates, OIDC client identifiers, encryption material, route patterns, and
raw environment-variable names must not appear as ordinary setup questions.

## Why this report exists

Takosumi currently combines three different concerns in one install surface:

1. a human decision, such as the desired public URL or authentication mode;
2. a value Takosumi can derive, such as a Capsule-scoped name, Workspace id,
   managed hostname, OIDC issuer, or OIDC client id;
3. an operator or module implementation detail, such as a Cloudflare account
   id, provider enable flag, release digest, route pattern, or binding name.

When these are presented as a list of OpenTofu inputs or environment variables,
the user must understand the deployment implementation before they can install
an application. The form is technically expressive but does not represent the
actual product decision.

Yurucommu makes the mismatch visible because most of its deployment values are
deterministic:

| Value | Expected source |
| --- | --- |
| Capsule/resource name | Capsule name, normalized by Takosumi |
| Worker, database, bucket, KV, and queue names | Module/Takoform graph |
| Cloud account and provider credentials | selected `ProviderConnection` / Target |
| DB, media, KV, queue, and schedule bindings | module/Takoform graph and host |
| encryption key | module or host-generated secret |
| OIDC issuer, client id, and redirect URI | Takosumi Accounts registration |
| release tag, artifact URL, and digest | pinned Yurucommu release/module |
| public URL | managed allocation, with an optional user override |
| bootstrap password | only when the user selects password authentication |
| push gateway configuration | optional integration, not baseline setup |

An ordinary user should not be asked to transcribe the first seven rows.

## Current repository evidence

### Takosumi treats setup presentation as DB-owned

The current `docs/internal/core-spec.md` says:

- Store is discovery/presentation only;
- `variablePresentation` and `installExperience` are DB-owned
  `InstallConfig` fields;
- `.well-known/tcs.json` may carry display text, icon URL, and `modulePath`;
- repository metadata must not carry variable presentation/defaults,
  `installExperience`, output policy, OIDC wiring, lifecycle actions, or
  Interface blueprints.

The current contract encodes the same decision:

- `contract/install-configs.ts` defines `variablePresentation` and
  `installExperience` on `InstallConfig`;
- the comments explicitly say repository metadata cannot add, replace, or
  default variable presentation;
- `accounts/service/src/control/repo-owned-install-config.ts` adopts only name,
  description, badge, and icon from the captured repository document;
- `dashboard/src/lib/tcs-client.ts` strips `inputs`, `installExperience`, and
  `outputAllowlist` from Store responses.

`SourceSnapshot.repositoryInstallMetadata` already proves an important part of
the desired design: repository-root metadata is observed with bounded size from
the same immutable Git commit as the executable snapshot. The current capture
is limited to `.well-known/tcs.json` and is typed as display presentation only.

### Takosumi Store describes a different owner

The adjacent `takosumi-store` repository says:

- install setup metadata and OpenTofu UX belong to the repository and installer,
  not the Store read API;
- Store listing publication rejects `inputs`, `installExperience`, and
  `outputAllowlist`;
- its official-listing loader says setup inputs and `installExperience` live in
  the app repository's `.well-known/tcs.json` and are read by installers from
  Git.

Takosumi then ignores those repository fields. The Store and installer
therefore agree that the Store is not the owner, but disagree about whether the
app repository is allowed to describe install UX. This is a current
cross-repository conformance gap, not merely missing UI polish.

### Yurucommu uses a transitional install path

The former `deploy/reference-app-install-configs.ts` made Yurucommu selectable
with:

```text
modulePath: "."
```

That root module is the direct Cloudflare deployment path. Its variables cover
provider enablement, Cloudflare account and routing, artifact selection,
secrets, OIDC, notification push, and an arbitrary non-secret `env` map. These
are valid operator controls for a direct module, but they are not all end-user
choices.

Takosumi duplicates part of the app knowledge in its reference
`InstallConfig`:

- three Cloudflare enable flags are literal `variableMapping` values;
- common Cloudflare variable presentation is injected centrally;
- Yurucommu push variables are named centrally;
- the Yurucommu callback path and OIDC variable names are copied centrally.

The app repository and Takosumi can drift whenever Yurucommu renames a variable,
changes its authentication bootstrap, or changes an optional integration.

The Yurucommu root module also requires an OIDC-only install to provide either
`oidc_owner_sub` or `allow_unpinned_owner_claim`. The current reference
`InstallConfig` declares issuer/client-id projection but neither owner input.
That is a concrete example of centralized setup metadata failing to preserve an
app-owned invariant.

### The canonical managed Yurucommu graph has the right shape

`yurucommu/deploy/takoform` is the canonical managed desired-resource
definition. Its four variables all have module defaults:

- `project_name`;
- `worker_release_tag`;
- `worker_bundle_url`;
- `worker_bundle_sha256`.

The graph declares database, bucket, KV, delivery queues, schedule, HTTP
service, connections, and launcher Interface rather than asking the user to
name each runtime binding.

It is not ready for Store cutover yet. Its README correctly blocks selection
until the Takosumi host can materialize encryption/authentication,
notification-push configuration, public hostname, queue consumers, scheduled
handler, migrations, exact provider/Form Package identity, and rollback
evidence. Repository-owned install UX does not waive those lifecycle gates.

## Blocking findings

### F-01 — Store and installer disagree about repository setup metadata

Severity: blocking contract inconsistency.

Owner: Takosumi install contract, with an aligned TCS Store boundary.

Current state:

- Store rejects setup fields because it says they belong to the app repository;
- Takosumi ignores the same repository fields because it says they belong to a
  DB-owned `InstallConfig`.

Required resolution:

1. Give the Takosumi-specific install UX document one explicit owner and schema.
2. Keep TCS Store listing responses free of setup/execution fields.
3. Remove claims that `.well-known/tcs.json` owns installer setup after the new
   Takosumi document is adopted.
4. Keep Store-to-install handoff limited to Git coordinate and display data.

### F-02 — App input meaning is duplicated in Takosumi

Severity: high UX and conformance risk.

Owner: the app repository for app vocabulary; Takosumi for resolution and
execution policy.

Current state:

The former `deploy/reference-app-install-configs.ts` hard-coded first-party app
variable names, callback paths, labels, and optional integration fields. The
production composition has removed that catalog; equivalent records remain
test fixtures only, while pinned repository manifests drive new install UX.

Required resolution:

- read and validate an app-owned proposal from the pinned source snapshot;
- compile the accepted proposal into an exact DB-owned `InstallConfig`;
- retain operator patch/override ability without making a Store listing
  authoritative;
- remove first-party variable-presentation duplication only after shadow
  comparison proves parity.

### F-03 — Transitional direct-provider variables leak into normal install UX

Severity: high UX risk.

Owner: Takosumi dashboard and install compiler.

Current state:

Yurucommu Store selection points to the root Cloudflare module. The dashboard
also renders generic OpenTofu input and plain environment editors under the
advanced disclosure for selected Store apps.

Required resolution:

- normal Store install renders semantic user questions only;
- deterministic, module-default, connection-derived, and host-derived values
  are not rendered as questions;
- raw variable and environment editors remain available only for explicit
  manual Git/expert import, not as the ordinary Store-app fallback;
- compatibility findings identify missing compiler bindings instead of
  instructing a user to guess internal variable names.

### F-04 — Yurucommu OIDC owner bootstrap is not compiled

Severity: high identity/install correctness risk.

Owner: Yurucommu declares its bootstrap semantics; Takosumi Accounts/install
compiler binds the authenticated installer safely.

Current state:

The root module rejects OIDC installs without `oidc_owner_sub` or an explicit
un-pinned-owner acknowledgement. The reference `InstallConfig` maps only issuer
and client id.

Required resolution:

- prefer binding the authenticated installing principal to the app's owner slot
  when the application supports an exact subject mapping;
- otherwise present a specific, auditable first-login ownership acknowledgement;
- never expose `oidc_owner_sub` or `allow_unpinned_owner_claim` as unexplained
  raw variables in the ordinary form;
- cover the selected path with Accounts, Capsule creation, plan, and first-login
  tests.

## Architecture decision

### Use a general Takosumi repository manifest

Adopt `.well-known/takosumi.json`, not new install fields in
`.well-known/tcs.json`.

Reasons:

1. TCS Store owns decentralized discovery and browse presentation. It should
   not acquire install or execution authority.
2. Takosumi owns the repository-manifest parser and installer, while
   `InstallConfig`, compatibility check, Plan, and Run retain execution
   authority.
3. The current `tcs.repo/v1` meaning is already contradictory across sibling
   repositories. Extending it would preserve the ambiguity.
4. The app repository can own its Takosumi metadata without pretending that
   the schema is a generic OpenTofu or Takoform standard.
5. The document remains optional, so plain Git/OpenTofu installability does not
   depend on a Takosumi manifest.

`.well-known/tcs.json` remains optional Store indexing presentation. It may
contain display text and a repository-relative icon. The Takosumi manifest's
`install` section owns installer-facing declarations.

### Treat repository declarations as a proposal

The repository document does not directly mutate a Capsule or Run.

Takosumi must:

1. capture the document from the same exact Git commit as the
   `SourceSnapshot`;
2. parse it using a strict, versioned, bounded schema;
3. select the declaration for the exact module path being installed;
4. compare every referenced variable with the compatibility report/module;
5. resolve only known Takosumi projection kinds;
6. apply operator policy and capability checks;
7. persist the accepted result into the per-install DB-owned `InstallConfig`;
8. pin that exact `InstallConfig` and source snapshot into the reviewed Plan.

The persisted `InstallConfig`, not a later read of the repository document, is
the execution input. A source update may propose a different install UX, but it
cannot silently rewrite an existing Capsule's configuration.

### Keep lifecycle and authority out of the document

The `takosumi.com/v1alpha1` `install` section may declare:

- localized label, helper, placeholder, and grouping information;
- an exact module variable name;
- input type/format and whether a question is normal or advanced;
- whether an input comes from the user, Capsule name, module default, or a
  supported Takosumi semantic projection;
- current semantic projections such as service name, public endpoint, initial
  secret, OIDC client, and pinned artifact variable names;
- feature grouping for optional integrations.

It must not contain:

- Git URL, ref, tag, commit, or alternate source selection;
- `InstallConfig` id or an instruction to select another service-side config;
- provider credentials, connection ids, secret values, or generated secret
  bytes;
- arbitrary commands, lifecycle actions, scripts, hooks, or executable code;
- output allowlist/exposure policy;
- runner id, target selection, adapter selection, billing, quota, price, or
  Cloud capacity;
- Interface authorization/binding grants;
- arbitrary environment-variable injection;
- a bypass for compatibility, policy, Plan review, or Run approval.

## Draft wire shape

The exact schema should be finalized in `contract/` before implementation. The
following shape is deliberately close to existing
`InstallConfigVariablePresentation` and `InstallConfigInstallExperience` so the
first implementation can compile into existing records rather than creating a
second install model.

```json
{
  "apiVersion": "takosumi.com/v1alpha1",
  "kind": "Repository",
  "install": {
    "modules": {
    ".": {
      "inputs": [
        {
          "name": "project_name",
          "source": { "kind": "capsule_name" },
          "type": "string",
          "format": "subdomain",
          "label": {
            "ja": "サービス名",
            "en": "Service name"
          },
          "advanced": true
        },
        {
          "name": "app_url",
          "source": { "kind": "user" },
          "type": "string",
          "format": "url",
          "required": false,
          "label": {
            "ja": "公開 URL",
            "en": "Public URL"
          },
          "helper": {
            "ja": "空欄の場合は Takosumi が URL を割り当てます。",
            "en": "Takosumi allocates a URL when omitted."
          }
        }
      ],
      "installExperience": {
        "projections": [
          {
            "kind": "service_name",
            "variable": "project_name"
          },
          {
            "kind": "public_endpoint",
            "variables": {
              "url": "app_url",
              "subdomain": "project_name"
            }
          },
          {
            "kind": "initial_secret",
            "variable": "auth_password_hash",
            "secretKind": "password_or_hash",
            "optional": true
          },
          {
            "kind": "oidc_client",
            "variables": {
              "issuerUrl": "takosumi_accounts_issuer_url",
              "clientId": "takosumi_accounts_client_id"
            },
            "callbackPath": "/api/auth/callback/takos",
            "scopes": ["openid", "profile", "email"]
          }
        ]
      },
      "features": [
        {
          "id": "notification-push",
          "optional": true,
          "label": {
            "ja": "通知を有効にする",
            "en": "Enable notifications"
          },
          "inputs": [
            "notification_push_gateway_url",
            "notification_push_gateway_token",
            "notification_push_web_push_public_key"
          ]
        }
      ]
    }
    }
  }
}
```

This is a proposal, not permission to write a password hash into public
metadata. `initial_secret` declares an expected secret slot. Takosumi must
collect or generate material through its secret boundary and keep the value out
of the repository document, public `InstallConfig` projection, Output, log, and
audit event.

The v1alpha1 parser rejects unknown top-level and section keys, `$schema`, and
unknown `source.kind`/projection kinds. Forward compatibility comes from a new
`apiVersion`, not silent interpretation.

## Compilation rules

### Module selection

- Select only the entry whose normalized key equals the exact selected module
  path.
- Repository metadata cannot change the selected path.
- Missing module entry means no enhanced UX for that path.
- `..`, absolute paths, NUL, symlink traversal, and path aliases that escape the
  snapshot are invalid.

### Input sources

Support a deliberately small source vocabulary:

| Source | Meaning |
| --- | --- |
| `user` | Render a typed question and copy the reviewed answer |
| `capsule_name` | Derive from the normalized Capsule name |
| `workspace_scoped_capsule_name` | Derive from Workspace handle + Capsule name |
| `module_default` | Omit the variable and let OpenTofu apply its declared default |

Public endpoint, OIDC client, initial secret, artifact, authenticated context,
provider connection, and target capability remain typed semantic projections
or service-owned resolvers. Do not encode them as arbitrary string templates.

### Compatibility validation

Before rendering or compiling:

- every named module variable must exist in the exact compatibility report;
- the declared basic type must be compatible with the module type when known;
- a required repository question must not contradict an optional/defaulted
  module variable without an explicit Takosumi reason;
- a secret presentation must never target the plain `env` map;
- reserved Takosumi/OpenTofu/runner environment names remain forbidden;
- duplicate input names and duplicate semantic projections fail validation;
- the callback path must be root-relative and must not contain an origin;
- scopes must pass the Accounts allowlist;
- a public endpoint must resolve to a URL/subdomain variable declared by the
  selected module;
- unsupported declarations produce a diagnosable compatibility finding and are
  never silently treated as user input.

Current compatibility analysis records root variable names. The implementation
should extend the exact report with bounded type/default metadata or add a
separate parser result; it must not infer variable semantics from descriptions
or source comments.

### Missing and invalid documents

Absence is valid:

- manual Git install continues with the generic flow;
- an operator-installed DB `InstallConfig` continues to work;
- Store discovery continues;
- no source sync or plan is blocked solely because the optional file is absent.

Invalid or contradictory metadata must not be adopted. For a Store-backed app
that advertises enhanced setup, Takosumi should show one actionable
compatibility error rather than falling back to a raw list that asks the user
to repair app metadata.

### Update behavior

- Capture the document text/status/digest on `SourceSnapshot`.
- Compile once for the selected snapshot and persist the result.
- Existing Capsules retain their current `InstallConfig`.
- An update Plan may show that install UX metadata changed, but metadata changes
  alone do not mutate runtime configuration.
- Any re-compilation that changes effective variables or semantic projections
  requires a new reviewed Plan.

## Expected Yurucommu UX

### Default Takosumi-managed install

```text
Yurucommu

公開 URL
  https://<workspace>-yurucommu.<managed-domain>
  [変更]

認証
  Takosumi アカウントでログイン

[インストール]
```

No password is needed when Takosumi Accounts OIDC is available. The installer
registers the OIDC client and binds the installing principal/owner bootstrap
through an explicit reviewed authority path.

### Password alternative

```text
認証
  パスワード

初期パスワード
  [••••••••••••]
```

The UI accepts a password, not an unexplained `AUTH_PASSWORD_HASH` or
`auth_password_hash` field. Takosumi performs the supported derivation and
stores/materializes only what the selected secret contract allows.

### Optional notification integration

Notification push appears as one feature choice. Raw gateway URL, token, and
public key are shown only after the feature is enabled and only if Takosumi
cannot satisfy the integration from a selected Interface/Connection.

### Expert/manual import

Direct Git import may retain:

- explicit module input overrides;
- a non-secret environment map;
- provider binding selection;
- source credential selection;
- module/ref/path inspection.

These controls must be labeled as expert/operator configuration and must not be
the default Store-install experience.

## Implementation plan

This work changes install authority and crosses repositories once app metadata
and Store documentation are updated. The implementation phase therefore needs a
cross-repository task ledger. This report itself is Takosumi-local and does not
grant that mutation authority.

### Phase 1 — Contract and parser, no adoption

Primary repository: `takosumi`.

1. Add strict contract types and parser for
   `apiVersion=takosumi.com/v1alpha1`, `kind=Repository`.
2. Add JSON fixtures for valid, absent, oversized, symlink, unknown-key,
   unknown-version, traversal, duplicate, secret-leak, and unsupported
   projection cases.
3. Add an optional `SourceSnapshot` observation for
   `.well-known/takosumi.json`. The retired pre-GA install-only wire is not a
   supported manifest version.
4. Record status and digest; do not expose raw text through public APIs.
5. Keep runtime behavior unchanged.

Likely implementation areas:

- `contract/sources.ts`;
- `contract/repository-manifest.ts`;
- `runner/lib/source_sync.ts`;
- SourceSnapshot D1/Postgres/in-memory persistence;
- source-sync and archive tests.

### Phase 2 — Compatibility compiler and shadow comparison

Primary repository: `takosumi`.

1. Resolve the exact module entry.
2. Validate declared variables against the exact compatibility analysis.
3. Compile into existing `variablePresentation`, `installExperience`, and
   allowed initial `variableMapping` shapes.
4. Compare compiled first-party results with current reference
   `InstallConfig`s without changing the install result.
5. Emit bounded non-secret diagnostics for mismatch.

Likely implementation areas:

- `core/domains/sources/capsule_compatibility.ts`;
- a new install-UX compiler in the Capsule/install-config domain;
- `accounts/service/src/control/repo-owned-install-config.ts`;
- reference-config and dashboard install tests.

### Phase 3 — Dashboard adoption

Primary repository: `takosumi`.

1. Use the compiled DB-owned result, never the raw repository JSON.
2. Render only user questions in ordinary Store setup.
3. Render semantic public URL/authentication controls.
4. Keep derived/module-default values out of the form.
5. Keep raw input/environment editors only for manual/expert import.
6. Show an actionable invalid-metadata finding without exposing raw secret-like
   values.

Likely implementation areas:

- `dashboard/src/views/new/NewAppView.tsx`;
- `dashboard/src/views/new/install-helpers.ts`;
- Accounts/control API public-safe projections;
- focused dashboard new-flow tests.

### Phase 4 — First-party app declarations

Primary repositories: each app repository.

1. Add `.well-known/takosumi.json` to Yurucommu first.
2. Cover root transitional module behavior and the future
   `deploy/takoform` module as separate exact module entries when necessary.
3. Add an app-local test that every declared variable and callback path still
   exists.
4. Repeat for other first-party apps only after the Yurucommu flow proves the
   schema.

Do not mechanically copy current centralized `variablePresentation`. Reclassify
every value as user, derived, module default, semantic integration, operator
connection, or unsupported.

### Phase 5 — Align Store and authoritative docs

Repositories: `takosumi` and `takosumi-store`.

1. Keep TCS listings URL-only for install authority; names, descriptions,
   icons, and generic search metadata remain presentation-only.
2. Limit `.well-known/tcs.json` to TCS indexing presentation.
3. Document `.well-known/takosumi.json` in Takosumi public/reference docs.
4. Update `core-spec.md` and `core-conformance.md` in the same Takosumi change
   that enables adoption.
5. Remove Store comments/tests that claim installer setup belongs in
   `.well-known/tcs.json`.
6. Add a source-coordinate handoff test proving Store cannot supply or override
   Takosumi install UX.

### Phase 6 — Yurucommu managed cutover

Repositories: `yurucommu`, `takosumi`, the owning provider/Takoform release
repositories, and operator/Cloud composition where applicable.

This phase is separate from metadata adoption. Change the selectable path from
the transitional root module to `deploy/takoform` only after:

- exact provider and Form Package release/admission;
- host materialization for encryption and OIDC/password bootstrap;
- managed hostname allocation;
- queue consumer and schedule execution;
- D1/schema migration activation;
- launcher/public URL readiness;
- plan/apply/destroy and rollback/forward-repair evidence.

No metadata document can substitute for these lifecycle and operator proofs.

## Acceptance criteria

### Contract

- `.well-known/takosumi.json` is optional and versioned.
- The selected file is captured from the same commit as `SourceSnapshot`.
- Unknown API versions, kinds, sections, and keys are rejected without
  executing anything.
- Repository metadata cannot select Git source/ref, provider credentials,
  runner, target, lifecycle action, output exposure, or policy bypass.
- The accepted compilation is persisted as an exact DB-owned `InstallConfig`.
- Existing Capsules do not change when repository metadata changes.

### UX

- A default Yurucommu Store install on a capable Takosumi host requires no raw
  module input or environment-variable entry.
- The ordinary form shows the resulting managed URL and authentication mode.
- Password is asked only when password mode is selected.
- Push fields are absent until the optional feature is enabled.
- Cloudflare account id, route pattern, release URL/digest, OIDC client id,
  encryption key, bindings, and enable flags are not ordinary user questions.
- Manual Git import retains an explicit expert override path.

### Security and authority

- No secret value enters repository metadata, SourceSnapshot public projection,
  Store listing, Output, log, compatibility finding, or audit event.
- OIDC callback, scope, owner bootstrap, and client registration are validated
  by Takosumi Accounts.
- Provider credentials remain in `ProviderConnection`/credential materialization.
- The reviewed Plan pins effective configuration and projection digests.
- Store node switching cannot alter effective install configuration.

### Verification

At minimum:

```bash
cd takosumi
bun run test:dashboard-new-flow
bun run test:accounts
bun run test:service
bun run check

cd ../yurucommu
bun run check

cd ../takosumi-store
bun run check

cd ../takos-control
bun run check:workspace -- --task TASK-xxxx
```

Live/provider evidence remains separate from these portable gates.

## Non-goals

- making a Takosumi metadata file mandatory for plain Git/OpenTofu modules;
- turning TCS Store into an installer or execution authority;
- defining a generic cross-platform OpenTofu UX standard;
- reading variable semantics from HCL comments;
- allowing repository metadata to carry secret values or arbitrary commands;
- replacing the reviewed Plan/Run flow with one-click mutation;
- declaring the Yurucommu Takoform candidate production-ready;
- automatically migrating existing Capsules when metadata changes.

## Handoff summary

The main implementation should begin with F-01 and F-02, not with dashboard
field hiding. The UI currently reflects an ownership problem: app input meaning
is centralized in Takosumi while the Store says it belongs in the app
repository.

The chosen target is:

```text
app repo .well-known/takosumi.json
  -> immutable SourceSnapshot observation
  -> strict Takosumi install-UX parser
  -> compatibility/policy compiler
  -> exact DB-owned InstallConfig
  -> semantic user form
  -> reviewed Plan and Run
```

Yurucommu is the first acceptance case. Its default managed install should be
zero-input; custom URL, password mode, and optional notification integration
are explicit user choices. Everything else must come from the module, selected
connections/targets, or Takosumi-owned resolvers.
