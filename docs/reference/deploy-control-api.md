# Deploy-Control API

Last updated: 2026-07-13

This API controls OpenTofu/Terraform execution in Takosumi OSS. It runs existing
providers as-is. Public compatibility profiles are separate capability-versioned
surfaces that map into the Resource Shape model, not hidden deploy-control
gateway routes.

## Public Surface

The OSS deploy-control surface is centered on:

```text
Workspace
Project
Capsule
Source
ProviderConnection
ProviderBinding
Secret
Run
StateVersion
Output
AuditEvent
```

A Capsule-driven plan Run is the caller contract: clients create or select a
Capsule, bind providers through ProviderBindings, create a `plan` Run, review the
saved plan result, then approve an `apply` or `destroy` Run against that saved
plan/state context.

## Minimal API Shape

```text
POST   /projects
GET    /projects/:id

POST   /capsules
GET    /capsules/:id
PATCH  /capsules/:id

POST   /connections
GET    /connections
GET    /connections/:id
DELETE /connections/:id

POST   /runs
GET    /runs/:id
GET    /runs/:id/logs
POST   /runs/:id/approve
POST   /runs/:id/cancel

GET    /state/:capsule_id/versions
GET    /outputs/:capsule_id

POST   /secrets
GET    /audit
```

## Output Sync

Output Sync は OpenTofu の標準機能ではなく、Takosumi 固有の任意機能です。
実装されたホストは `takosumi.output-sync.v1` capability を公開します。Workspace
ごとに既定で有効ですが、通常の Output capture や明示的な Dependency を止めずに
無効化できます。

公開APIは次の4つです。

```text
GET   /api/v1/workspaces/{workspaceId}/output-sync
PATCH /api/v1/workspaces/{workspaceId}/output-sync
GET   /api/v1/workspaces/{workspaceId}/output-sync/snapshot
POST  /api/v1/workspaces/{workspaceId}/output-sync/reconcile
```

設定APIはWorkspaceの有効状態を読み書きします。snapshotは現在の非機密Outputを
Workspace単位で返します。reconcileは通常のRun policyとapprovalに従って、
Workspace内の対象Capsuleを再評価します。公開event feedは定義しません。
active memberは設定とsnapshotを参照でき、設定変更とreconcileはowner/adminだけが
実行できます。

reconcileは現在apply済みのSourceSnapshotを固定したまま、`active` / `stale`
CapsuleをDependency DAGのlayer順にplanします。同じlayerは並列実行でき、前layerが
no-opまたはapply成功した後だけ次layerを開始します。clean planは自動applyし、
destructive planは通常のapprovalで停止します。Outputがさらに変化した場合は最大5回
まで追従し、収束しない場合は明示的な失敗として止まります。Git refの更新はこの処理に
混ぜません。

`service_exports`と`service_bindings`は、通常のOpenTofu Output上で接続契約を
表現する任意のTakosumi Output Conventionです。endpoint、capability、認証方式、
scope、grant参照は含められますが、token、password、live dataは含めません。
credentialらしいmetadata keyや、userinfo/credential queryを含むURLはapply時に
拒否されます。
実データはMCP、HTTP、S3など宣言されたinterfaceから取得します。

別WorkspaceのOutputをsnapshotまたはreconcileで利用するには、明示的な
`OutputShare`が必要です。Output Syncが無効またはcapabilityが存在しない場合も、
`tofu output -json`のcapture、Capsule Output API、明示的なDependency、
`terraform_remote_state`は独立して利用できます。

## Provider Connections

ProviderConnection creation stores credential metadata and encrypted secret
references. A Run resolves ProviderBindings to ProviderConnections, evaluates the
CredentialRecipe, and injects only temporary env/file material into the runner.

Provider resolution statuses in OSS are:

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

The response must not include raw secrets, secret references, internal resolver
IDs, temporary credentials, or generated credential files.

## Runs

A Run records:

```text
source snapshot
tool version
provider lock digest
provider bindings
injected env metadata, not values
plan result
apply result
logs
outputs
state version
actor
timestamps
audit evidence
```

Secrets are redacted before logs or diagnostics are persisted.

## Release Activation Seam

Takosumi OSS treats a successful `apply` as an OpenTofu/Terraform ledger commit:
state versions, outputs, run history, and AuditEvent evidence are persisted.

Application publication is a separate operator/Cloud extension step. A host may
inject a post-apply release activator to publish a product artifact after the
apply ledger commit succeeds.

The seam is intentionally generic:

```text
OpenTofu apply
  -> StateVersion / Output ledger commit
  -> optional host-injected release activation
  -> AuditEvent: release_activation.pending|succeeded|failed
```

Operator webhook activators receive no provider credentials, no runner env, and
no sensitive OpenTofu outputs. Runner activators receive only dispatch-scoped
ProviderConnection / CredentialRecipe material minted from the same reviewed
ProviderBinding set as apply/destroy. Secret-shaped output names or values are
filtered before either hook. A release activation failure records AuditEvent
evidence but does not roll back the OpenTofu apply ledger; callers must surface
it as "infrastructure applied, application activation failed/pending" rather
than as a generic apply failure.

Capsules may mark individual post-apply commands with `executor = "runner"` or
`executor = "operator"`. Runner commands are restored into the source snapshot
and receive non-secret metadata such as `TAKOSUMI_OUTPUTS_JSON` plus
dispatch-only provider credentials when the reviewed run had ProviderBindings.
Operator commands are not attempted by the built-in runner activator; they
remain pending unless the host configures an operator/Cloud release activator
that owns the credential boundary for work outside the runner sandbox.
Commands may also declare `timeout_seconds` / `timeoutSeconds` as an execution
constraint. This is still part of the Git/OpenTofu-declared release descriptor:
Takosumi does not interpret the command semantics, but the runner enforces the
declared timeout for long app-owned activation bridges such as container
artifact upload or provider-gap setup.

The platform Worker can enable the generic webhook bridge with:

```text
TAKOSUMI_RELEASE_ACTIVATOR_URL
TAKOSUMI_RELEASE_ACTIVATOR_TOKEN
```

The URL is non-secret operator config. The token is a Worker secret. Production
URLs must be `https`; `http` is accepted only in explicit local substrate/dev
mode. The webhook receives a `takosumi.operator.release-activation@v1` JSON
payload with deploy-control ledger ids, the current runtime Capsule /
StateVersion / Output context, deployment summary, and already-filtered
non-sensitive outputs. Public readiness evidence is expressed as Workspace /
Project / Capsule / StateVersion / Output claims. This payload is an
operator-controlled bridge contract, not a customer API surface. It must return
one of:

```json
{ "status": "skipped" }
{ "status": "pending", "message": "queued" }
{ "status": "succeeded", "launchUrl": "https://example.com" }
{ "status": "failed", "message": "publication failed" }
```

The webhook materializer is where product-specific publication lives. Takosumi
Core only forwards the SourceSnapshot reference, non-sensitive outputs, and
declared opaque argv commands. It does not inspect whether those commands migrate
a database, publish an artifact, update an index, or perform another app-owned
activation task.

## Out-of-Scope For Deploy-Control

Deploy-Control は OpenTofu execution の Run / state / output API です。
compatibility profile、managed Cloud resource、official billing の endpoint
family は Deploy-Control の責務ではありません。これらは別の capability として
document され、discovery で広告されます。

OSS Deploy-Control API は、公式 hosted Cloud endpoint family を直接公開しません。

```text
/compat/cloudflare/client/v4
/gateway/ai/v1
provider-compatible endpoint families
official managed resource backend controls
managed edge/storage/container resource APIs
official billing/quota/usage endpoints
```

Compatibility API framework 自体は Takosumi の一部です。
`compat.cloudflare.workers.v1`、`compat.s3.v1`、OpenAI-compatible AI endpoint
などの profile は scoped / versioned capability であり、Deploy-Control の hidden
route ではありません。

公式 hosted service で現在 document している Cloud endpoint family は
`compat.cloudflare.workers.v1`、`compat.s3.v1`、OpenAI-compatible AI Gateway です。
追加 endpoint family は、それぞれ compatibility matrix、auth model、usage
contract、fail-closed behavior を持つ別仕様として定義します。
