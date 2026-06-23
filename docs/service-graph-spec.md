# Capsule Runtime Service Projection

> This document describes an output-projected runtime contract/profile for services exposed by OpenTofu Capsules.
> It is not Takosumi's final public model, a Takosumi-specific manifest, an OSS resource driver, or a managed-resource
> backend. The filename is retained for migration compatibility, but the customer-facing Takosumi model remains
> Workspace / Project / Capsule / Source / ProviderConnection / CredentialRecipe / ProviderBinding / Run /
> StateVersion / Output / Runner / AuditEvent / Operator. Takos is a first-party consumer/provider profile of this
> projection; generic capability tokens describe service classes, while service ids and names may identify the producer.

## 1. Purpose

Takosumi manages OpenTofu Capsules, Run ledgers, StateVersions, Outputs, ProviderConnections, policy, and
audit. Many Capsules also expose runtime services: HTTP APIs, MCP servers, Git endpoints, object stores, SQL endpoints,
agent runtimes, OIDC clients, event webhooks, and billing/reporting ports.

The Capsule runtime service projection is the internal/runtime projection shape for those services:

- a producer Capsule exposes a **ServiceExport**;
- a consumer Capsule requests a **ServiceBinding**;
- the accounts/vault boundary materializes a **ServiceGrant** only when the binding is authorized;
- Takosumi records enough audit evidence to explain which Capsule exposed a service, which consumer bound to it,
  which Output generation supplied it, which Run made it current, and which grant was issued.

Where a runtime service profile is needed, new docs should describe it as Output-to-runtime service projection under the
final Capsule / Output / Run model. ServiceExport / ServiceBinding / ServiceGrant are internal wire records and
migration vocabulary, not new top-level public Takosumi product nouns.

## 2. Ownership

The projection is built from Takosumi-owned records:

| Concern              | Owner                                                                         |
| -------------------- | ----------------------------------------------------------------------------- |
| Producer identity    | `Capsule` + successful `Run` + `StateVersion` + `Output`                      |
| Producer data source | `tofu output -json` projected through Capsule output allowlist policy         |
| Consumer dependency  | output-to-input wiring pinned at plan time                                    |
| Credential source    | `ServiceGrant` secret refs issued by Vault / Takosumi Accounts token rotation |
| Runtime authority    | `ServiceGrant`                                                                |
| Audit                | `Run` / `AuditEvent`                                                          |

Takos consumes these projections to build its app launcher, MCP registry, file handling, storage, Git, and agent
experiences. Takos may also expose first-party services through the projection, but it does not define a separate
Takosumi public standard.

## 3. Non-Goals

Service Graph v1 is not:

- a replacement for OpenTofu provider schemas, resource graphs, or state;
- a required in-repository manifest or DSL;
- an OSS resource driver, compatibility gateway, or managed-resource system;
- a service mesh or traffic proxy;
- a secret transport through OpenTofu outputs;
- a provider credential model. Provider credentials stay outside Service Graph and are resolved through Provider Connections,
  Credential Recipes, Provider Bindings, Vault backing material, policy, and runner phase boundaries.

## 4. Core Records

### 4.1 ServiceExport

A ServiceExport is a non-secret, allowlist-projected description of a service exposed by one producer Capsule.
It is derived from an Output record or from an operator/distribution service that is explicitly recorded as a
Capsule-scoped export.

Canonical fields:

| field               | meaning                                                                             |
| ------------------- | ----------------------------------------------------------------------------------- |
| `id`                | Takosumi-generated stable export id                                                 |
| `workspaceId`       | owning Workspace                                                                    |
| `producerCapsuleId` | Capsule that owns the service, or the distribution Capsule for same-origin services |
| `applyRunId`        | successful apply Run that made this export current                                  |
| `stateVersionId`    | StateVersion current when this export was projected                                 |
| `outputId`          | Output generation the export came from                                              |
| `name`              | producer-local stable name, unique within the Capsule                               |
| `capabilities`      | capability tokens such as `protocol.mcp.server` or `storage.object`                 |
| `endpoints`         | non-secret endpoint descriptors                                                     |
| `auth`              | accepted auth schemes, without secret values                                        |
| `metadata`          | display and protocol metadata, never authority                                      |
| `visibility`        | `private`, `space`, `public`, or `shared`                                           |
| `status`            | `ready`, `unavailable`, `revoked`, or `stale`                                       |

The current wire value `space` means Workspace-visible in the Final Plan model.
It is not a reintroduction of the retired Takosumi Space public concept.

### 4.2 ServiceBinding

A ServiceBinding is a consumer Capsule's request to use a service. It is service-side configuration, not a
required repo manifest. A binding can be created by UI, API, dashboard Capsule flow, first-party distribution seed, or
operator policy.

Canonical fields:

| field               | meaning                                                                   |
| ------------------- | ------------------------------------------------------------------------- |
| `id`                | Takosumi-generated binding id                                             |
| `workspaceId`       | consumer Workspace                                                        |
| `consumerCapsuleId` | Capsule or runtime projection that will receive the binding               |
| `target`            | consumer runtime or generated-root input target that receives the binding |
| `selector`          | capability / producer / name / visibility constraints                     |
| `grantRequest`      | requested scopes, audiences, env names, and token ttl hints               |
| `dependencyMode`    | `variable_injection`, `remote_state`, or `published_output`               |
| `status`            | `pending`, `bound`, `blocked`, `revoked`, or `stale`                      |

When a host wires ServiceBinding resolution into the plan lifecycle, the selected ServiceExport must be pinned into the
consumer's plan-time output-to-input snapshot. The current reference service exposes fail-closed binding resolution and
grant issuance as explicit Service Graph operations, and deploy-control automatically projects producer
`service_exports` after apply. It does not silently issue grants from an apply Run.

### 4.3 ServiceGrant

A ServiceGrant is runtime authority created for one binding. It is never stored in OpenTofu output values.

Canonical fields:

| field               | meaning                                                           |
| ------------------- | ----------------------------------------------------------------- |
| `id`                | grant id                                                          |
| `bindingId`         | bound ServiceBinding                                              |
| `serviceExportId`   | selected ServiceExport                                            |
| `consumerCapsuleId` | consumer receiving the grant                                      |
| `scopes`            | explicit permission tokens                                        |
| `audience`          | service audience                                                  |
| `material`          | non-secret injection metadata such as env names and endpoint keys |
| `secretRef`         | internal vault/accounts reference for the token or credential     |
| `expiresAt`         | expiration if the grant is token-backed                           |
| `rotatedAt`         | rotation timestamp                                                |
| `status`            | `active`, `expired`, `revoked`, or `superseded`                   |

The value behind `secretRef` is issued by Takosumi Accounts or Vault and delivered through the runtime secret injection
path. The internal ledger stores only the reference and audit evidence; public API responses and projections expose
expiry and non-secret metadata, not the `secretRef` / vault handle. Non-secret runtime env material may contain env
variable names such as `MCP_TOKEN`, public resource names, endpoint URLs, bucket names, or model aliases; it must not
contain bearer token values, API keys, password-bearing URLs such as `DATABASE_URL=...`, or other secret literals. Those
secret values must move through `secretRef` / runtime secret delivery.

`RuntimeGrant` is product wording for this runtime authority. In the v1 contract it is a projection of ServiceGrant
evidence, not a parallel grant model and not an OpenTofu provider credential. Runtime grants authorize a deployed
workload to use a scoped service capability after deployment; provider credentials authorize OpenTofu plan/apply/destroy
only during a Run.

Service ids and producer-local names are not capability tokens. They may identify the producer when that is the honest
service identity, for example `takosumi.control.api` for the Takosumi-issued same-Workspace support projection. The
capability remains generic (`control.api`) so consumers bind to the service class, while audit and UI can still show
which producer provides it. This is scoped runtime material for an installed service, not the product control surface;
Workspaces, Capsules, and Runs still use `/api/v1`.

## 5. Capability Catalog

Capability tokens are product-neutral dotted strings. Versioning belongs to the Service Graph contract and individual
protocol metadata, not to product names. A token names the class of service being exported or requested; product policy,
grant scopes, endpoints, and metadata describe what a specific Capsule can actually do.

The standard namespaces are:

| namespace         | use                                                                 |
| ----------------- | ------------------------------------------------------------------- |
| `protocol.*`      | wire protocols and API endpoint classes                             |
| `interface.*`     | user-facing integration points that are not themselves protocols    |
| `storage.*`       | data stores and file/object abstractions                            |
| `source.*`        | source-code, package, and repository services                       |
| `compute.*`       | execution, sandbox, job, and container services                     |
| `automation.*`    | tool, workflow, and task automation services                        |
| `ai.*`            | model, embedding, vector, retrieval, and AI-runtime services        |
| `identity.*`      | identity providers, clients, and subject projections                |
| `auth.*`          | token exchange, signing, bootstrap, and runtime authorization ports |
| `messaging.*`     | queues, pub/sub, streams, and async delivery services               |
| `events.*`        | event ingress, subscriptions, and webhook-style event services      |
| `observability.*` | logs, metrics, traces, and audit/telemetry export services          |
| `billing.*`       | showback, usage reporting, and billing integration ports            |
| `deployment.*`    | deployment result, output, and activation read services             |
| `control.*`       | scoped control-plane APIs for resources owned by the same operator  |
| `governance.*`    | policy, compliance evidence, and approval services                  |

Initial standard capabilities:

| capability                 | meaning                                                                   |
| -------------------------- | ------------------------------------------------------------------------- |
| `protocol.mcp.server`      | MCP server endpoint                                                       |
| `protocol.http.api`        | generic HTTP API endpoint                                                 |
| `protocol.grpc.api`        | gRPC API endpoint                                                         |
| `protocol.websocket.api`   | WebSocket API endpoint                                                    |
| `interface.ui.surface`     | embeddable or launchable UI surface                                       |
| `interface.file.handler`   | file open/edit handler metadata                                           |
| `storage.object`           | object/blob storage API                                                   |
| `storage.filesystem`       | file-tree storage API                                                     |
| `storage.key_value`        | key-value storage API                                                     |
| `storage.sql`              | SQL/database API                                                          |
| `storage.vector`           | vector index or vector-search API                                         |
| `storage.search_index`     | text/search index API                                                     |
| `source.repository`        | repository metadata, refs, and object access                              |
| `source.git.smart_http`    | Git Smart HTTP endpoint                                                   |
| `compute.job_runner`       | asynchronous job execution endpoint                                       |
| `compute.sandbox`          | sandboxed execution environment                                           |
| `automation.agent_runtime` | agent/task runtime endpoint                                               |
| `automation.tool_provider` | tool provider usable by a runtime or agent                                |
| `ai.model`                 | model inference endpoint                                                  |
| `ai.embedding_model`       | embedding model endpoint                                                  |
| `identity.oidc`            | OIDC issuer/client projection                                             |
| `identity.oauth.client`    | OAuth client projection                                                   |
| `auth.bootstrap_token`     | one-time or short-lived bootstrap token delivery                          |
| `auth.token_exchange`      | token exchange endpoint                                                   |
| `auth.webhook_signing`     | webhook/event signing secret authority                                    |
| `messaging.queue`          | queue service                                                             |
| `messaging.pubsub`         | publish/subscribe service                                                 |
| `events.webhook`           | event ingest webhook                                                      |
| `events.subscription`      | event subscription stream                                                 |
| `observability.logs`       | log read/export endpoint                                                  |
| `observability.metrics`    | metric read/export endpoint                                               |
| `observability.traces`     | trace read/export endpoint                                                |
| `billing.usage`            | usage reporting, showback, or billing integration port                    |
| `deployment.outputs`       | non-secret deployment output read API                                     |
| `control.api`              | scoped same-Workspace support callbacks for a producer-owned resource set |
| `governance.policy`        | policy decision or policy evidence service                                |
| `governance.approval`      | approval request/decision service                                         |

Compatibility aliases are not part of v1. Records that use older product-local names are invalid; any historical data
cleanup must rewrite them before they are served or persisted as Service Graph records. `billing.*` capabilities do not
make official billing an OSS feature; official billing, payment enforcement, and usage metering sold as a service are
Takosumi Cloud-only. Products can define profiles that require subsets of these capabilities. For example, Takos uses
`protocol.mcp.server` for MCP tool loading, `source.repository` / `source.git.smart_http` for Git UX,
`storage.filesystem` / `storage.object` for files, and `automation.agent_runtime` for agent task execution.

### 5.1 Cloud-only Takosumi AI Gateway Profile

Takosumi Cloud may provide an operator-backed AI Gateway as a Service Graph
service with service id `takosumi.ai.gateway`, capability `ai.model`, and
endpoint `/gateway/ai/v1`. It is an OpenAI-compatible HTTP API facade for model
and embedding calls. This is a Cloud/closed operator extension, not part of the
Takosumi OSS public control-plane contract. OSS Takosumi remains focused on
OpenTofu/Terraform runs, ProviderConnections, CredentialRecipes,
ProviderBindings, StateVersions, Outputs, Runners, and AuditEvents. The gateway
is not a provider credential and not an OpenTofu output secret.

The runtime projection material for this service is:

| field                 | value / meaning                                                 |
| --------------------- | --------------------------------------------------------------- |
| `baseUrl`             | issuer-relative `/gateway/ai/v1` endpoint                       |
| `apiKeyEnv`           | recommended runtime env name for the rotated service token      |
| `baseUrlEnv`          | recommended runtime env name for the OpenAI-compatible base URL |
| `modelEnv`            | recommended runtime env name for the default model alias        |
| `defaultModel`        | `takosumi/default`                                              |
| `capabilities`        | `ai.model`, `ai.embedding_model`, `protocol.http.api`           |
| `compatibleProtocol`  | `openai.chat_completions`                                       |
| `compatibleProtocols` | `openai.chat_completions`, `openai.embeddings`                  |

The service token scope is `ai.model` plus one or more endpoint scopes:

| endpoint                               | required endpoint scope |
| -------------------------------------- | ----------------------- |
| `GET /gateway/ai/v1/models`            | `ai.models.read`        |
| `POST /gateway/ai/v1/chat/completions` | `ai.chat`               |
| `POST /gateway/ai/v1/embeddings`       | `ai.embeddings`         |

Operator upstream provider keys stay in operator secrets/env vars referenced by
the closed Takosumi Cloud AI Gateway service's
`TAKOSUMI_AI_GATEWAY_PROFILES` config. A profile declares public model aliases
and the env var name that contains the upstream key (`apiKeyEnv`); it must not
contain the key value itself, including through static upstream `headers`.
Model alias `metadata` is returned by `GET /gateway/ai/v1/models`, so it is public display/protocol metadata only:
secret-shaped keys, bearer-token strings, API keys, credential URLs, and password-bearing values are invalid profile
config.
At request time the gateway maps the public model alias to the provider-native model id, injects the upstream key,
forwards the call, and returns only safe response headers. The rotated Service Graph service token is the only key
projected to an installed service.

### 5.2 Takos Runtime Profile

Takos may project first-party runtime surfaces through Service Graph when the
host worker is the Takos distribution worker. These are product runtime
surfaces, not Takosumi managed cloud resources and not provider-compatible
Gateway endpoints.

Initial service ids:

| service id                | capability                 | endpoint shape                      |
| ------------------------- | -------------------------- | ----------------------------------- |
| `takos.mcp.registry`      | `protocol.mcp.server`      | `/api/mcp/servers`                  |
| `takos.storage.workspace` | `storage.filesystem`       | `/api/spaces/{spaceId}/storage`     |
| `takos.git.smart_http`    | `source.git.smart_http`    | `/git/`                             |
| `takos.agent.runtime`     | `automation.agent_runtime` | `/api/spaces/{spaceId}/agent-tasks` |

The hosted Takosumi platform worker leaves these projections
`not_configured`. The Takos distribution worker marks them ready by passing a
host runtime profile into the shared Accounts plane. They do not issue Service
Graph service tokens until their receiving APIs actually enforce such tokens;
otherwise the projection would look usable while the token has no authority.

## 6. OpenTofu Projection

Takosumi does not require a manifest. A Capsule may optionally expose service records through a well-known OpenTofu
output named `service_exports`, or an operator may map arbitrary outputs into ServiceExport records through service-side
Capsule configuration or operator policy.

Example:

```hcl
output "service_exports" {
  value = [
    {
      name         = "research-tools"
      capabilities = ["protocol.mcp.server"]
      endpoints = [
        {
          name     = "default"
          protocol = "https"
          url      = "https://example.test/mcp"
        }
      ]
      auth = [
        {
          scheme   = "bearer"
          audience = "research-tools"
          scopes   = ["mcp.invoke"]
        }
      ]
      metadata = {
        title = "Research tools"
      }
      visibility = "space"
    }
  ]
}
```

Rules:

- `service_exports` is optional. A repo without it is still a valid OpenTofu Capsule.
- Secret values, API keys, bearer tokens, private keys, and provider credentials must not appear in `service_exports`.
- The output must pass the same sensitive-flag and output allowlist checks as other Output projections.
- If an endpoint is sensitive, the endpoint is not published as a ServiceExport; use a ServiceGrant that resolves the
  endpoint through vault/accounts material instead.
- Unknown capability tokens may be recorded only when policy allows extension capabilities for that Workspace/operator.

## 7. Binding Resolution

Binding resolution is fail-closed. In the current reference implementation these steps are available through the
Service Graph service/API; hosts that need automatic runtime handoff must invoke them from their own plan/apply
workflow:

1. Select candidate ServiceExports by `workspaceId`, visibility, capability, producer constraints, and policy.
2. Reject ambiguous matches unless the binding selector is explicit enough.
3. Check the producer Output generation, successful apply Run, export status, and dependency policy.
4. Pin the selected export into the consumer's plan-time output-to-input snapshot when the host integrates Service Graph with plan creation.
5. Materialize non-secret endpoint values into generated-root variables or consumer runtime env only as requested by the binding.
   Secret values fail closed and must be represented by `secretRef` / runtime secret delivery; public metadata may name
   the env var that will receive the secret.
6. Create or rotate ServiceGrants only after policy confirms the requested scopes and audience.

Endpoint discovery and runtime authority are separate ledger facts but one binding flow. A consumer should not learn a
secret just because it can discover an endpoint.

## 8. Auth And Grants

Supported auth schemes in v1:

| scheme           | authority source                                           |
| ---------------- | ---------------------------------------------------------- |
| `none`           | public or workspace-visible endpoint with no runtime token |
| `bearer`         | Takosumi Accounts / Vault ServiceGrant                     |
| `oidc`           | Takosumi Accounts OIDC issuer/client projection            |
| `signed_webhook` | webhook signing secret held behind a ServiceGrant          |

Provider credentials are not ServiceGrants. A ServiceGrant authorizes runtime service use after a Capsule has been
deployed. Provider credentials authorize OpenTofu plan/apply/destroy and remain in the ProviderConnection /
CredentialRecipe / ProviderBinding / vault-runner boundary.

## 9. Takos Profile

Takos is allowed to provide a first-party profile over Service Graph. This profile is a consumer/provider profile, not
the standard itself:

- app launcher: `interface.ui.surface`;
- file handlers: `interface.file.handler`;
- MCP registry: `protocol.mcp.server`;
- storage UX and APIs: `storage.filesystem`, `storage.object`, `storage.sql`, `storage.key_value`;
- Git UX and APIs: `source.repository`, `source.git.smart_http`;
- agent execution: `automation.agent_runtime`, `automation.tool_provider`;
- same-workspace deploy/control access: `deployment.outputs`, `auth.bootstrap_token`, and `control.api`.

Takos-specific UI decisions, app launcher ranking, bundled app seeding, chat/agent UX, and memory behavior stay in
Takos. Service identity, binding, grant, output generation, dependency pinning, and audit stay in Takosumi.
MCP is represented by the `protocol.mcp.server` runtime capability in this Takos profile; it is not a Takosumi-specific
repo manifest or OSS resource-driver interface.

## 10. Adoption Rule

New code, docs, generated examples, API payloads, and public schemas must use Service Graph v1 concepts directly:

- `ServiceExport` for published services;
- `ServiceBinding` for consumer requests;
- `ServiceGrant` for runtime authority;
- capability tokens from the catalog in this document.

Do not introduce product-prefixed capability tokens for generic service capabilities. Producer-qualified service ids
and names are allowed when they identify the actual producer. Do not document secondary product-local registries as part
of the standard. Do not require Capsule repositories to adopt a Takosumi-specific manifest, and do not describe
ServiceExport as an OSS resource class or managed-resource driver.

Current implementation anchors:

- TypeScript contract: `contract/service-graph.ts`
- Core service and stores: `core/domains/service-graph`
- Internal API seam: `core/api/deploy_control_service_graph_routes.ts`
- Deploy-control apply projection: successful apply validates `service_exports` before commit and projects allowlisted
  ServiceExport rows after the Output is recorded. Current route paths, table columns, and a few method names still
  contain `Installation` / `OutputSnapshot`; those are migration seams. The Service Graph DTO fields themselves use
  `workspaceId`, `producerCapsuleId`, `consumerCapsuleId`, `applyRunId`, and `outputId`.
- App context / storage transaction wiring: `core/app_context*.ts` and `core/adapters/storage/*`
- Worker D1 persistence: `worker/src/d1_storage.ts` materializes `takosumi_service_graph_exports`,
  `takosumi_service_graph_bindings`, and `takosumi_service_graph_grants`
- Postgres generic storage migrations: `core/adapters/storage/migrations.ts`

The accounts-plane request/response vocabulary uses Service Graph names (`serviceBindings`, `serviceGrants`,
`serviceBinding`) for Capsule projections. Those projection routes deliver runtime material to installed services;
they are not the `/api/v1` control API for creating or reading Capsules. Internal compatibility helpers may still
validate account-plane records, but they must not persist or expose runtime service authority as the public contract.
