# Generalization and Product-Boundary Audit

Status: implementation audit for the pre-v1 clean cut. The product direction
remains [`final-plan.md`](./final-plan.md); this document is a verification
matrix, not a second specification.

## Decision rule

Takosumi is not required to contain zero provider-specific code. A provider,
target, billing implementation, runner substrate, or compatibility adapter may
be specific when it is:

1. selected explicitly through an open contract;
2. owned by its adapter, plugin, operator configuration, or Cloud extension;
3. replaceable without changing a Capsule or the core ledger; and
4. unable to inject credentials or schedule work through metadata or Output.

The following are forbidden in the OSS core:

- choosing behavior from a vendor name, URL, Output name, Store document, or
  repository convention;
- treating one hosted deployment, provider, forge, payment processor, runner,
  or target implementation as the implicit product default;
- letting display/catalog metadata become executable configuration;
- maintaining a second deployment, runtime-service, work, or resource ledger
  beside the final `Run` / `StateVersion` / `Output`, `Runner`, and Resource
  Shape records;
- placing official managed capacity, payment enforcement, versioned pricing catalogs, SLA, or
  support behavior in OSS; and
- retaining retired public nouns as active read/write contracts under a new
  label.

Generalization is not vocabulary erasure. `Space` remains the natural Resource
Shape namespace, a Cloudflare compatibility adapter may use Worker/D1/R2 terms,
and a concrete module may expose ordinary outputs such as `worker_name` or
`url`. Those names become a boundary violation only when generic Core,
dashboard, or operator tooling interprets them without an explicit
adapter/contribution or service-side mapping.

## Whole-product matrix

| Surface                        | Generic authority                                                                                                 | Allowed specialization                                                                                                                       | Rejected coupling / required check                                                                                                                                                                                                                     |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace ownership            | Workspace -> Project -> Capsule DB records and one WorkspaceMember ledger                                         | Operator membership/auth adapter                                                                                                             | No source-and-run `Space` alias, self-bootstrapped duplicate membership store, or no-op outbox worker; Project/member data must be durable and Workspace-scoped                                                                                        |
| Git source                     | `GitAddress` and immutable `SourceSnapshot`; omitted ref means Git `HEAD`                                         | Forge authentication helper                                                                                                                  | No GitHub identifier in core, guessed `main`/`master`, or upload/artifact authoring path for a Capsule                                                                                                                                                 |
| Store / TCS / install links    | Service-side Git pointer plus display metadata                                                                    | Optional repo presentation evidence and Store-specific search/ranking UI                                                                     | Repo metadata, Store switch, and external link must not select the module path or carry inputs, OIDC, policy, projections, ref resolution, or execution                                                                                                |
| Install configuration          | Service-side `InstallConfig` with explicit literal/value-source defaults                                          | UI presentation chosen by operator/Workspace                                                                                                 | No repository manifest authority, `InstallType`, trust-string admission, closed Store taxonomy, magic default string, built-in template binding, or implicit first-party template                                                                      |
| Generated root                 | One child-module wrapper over the selected Git module                                                             | Provider blocks derived from explicit bindings                                                                                               | No root/module/app type switch; no vendor inference or credential values in HCL                                                                                                                                                                        |
| Provider credentials           | Provider Connection + Credential Recipe + Provider Binding                                                        | Provider-owned recipe/helper and OAuth token-response mapper                                                                                 | Env/file injection only; no vendor token/credential transformation in Core, generated-root secret variable, ownership kind, or implicit fallback                                                                                                       |
| Runner                         | `Runner` + typed RunnerProfile lifecycle/availability + open `executorId` selected explicitly                     | Any operator substrate/image/network policy and injected executor adapter                                                                    | No metadata/label scheduling, implicit executor fallback, Cloudflare Container-shaped core profile, or hidden runtime-agent work ledger                                                                                                                |
| Run ledger                     | `Run` operation + successful `StateVersion` and `Output`                                                          | Runner-specific execution evidence                                                                                                           | No active `Deployment`, `StateSnapshot`, `OutputSnapshot`, or separate apply/destroy ledger                                                                                                                                                            |
| OpenTofu Output                | Ordinary root module return values                                                                                | Explicit Interface/Dependency mapping to a named Output                                                                                      | No reserved schema/name, credentials, MCP declaration, lifecycle command, or Workspace-wide reconcile                                                                                                                                                  |
| Interface                      | Service-side Interface + Binding + explicit delivery-handler registry                                             | Protocol handler by type/version; OAuth2 is one registered delivery; explicit Resource Space-to-Workspace scope resolver                     | No Output-discovered service graph, projection grant, runtime material token, fixed delivery switch, fallback transform, or Resource Space = Stack Workspace id inference                                                                              |
| Dependency                     | Explicit Output-to-input edge pinned to producer state                                                            | Cross-Workspace authorization policy                                                                                                         | No output-name inference, expression/template language, or hidden runtime-service dependency                                                                                                                                                           |
| Lifecycle                      | Service-side Capsule actions                                                                                      | Operator-approved runner command policy                                                                                                      | No Output-carried release command or Store/repository metadata execution                                                                                                                                                                               |
| Resource Shape                 | Bundled typed schema or explicitly registered operator schema + exact TargetPool implementation descriptor + lock | Open shape/implementation/manager/engine/connection-permission/projection token, schema registry, plugin/adapter, and target-specific module | No unregistered catch-all shape, global six-kind enum, closed capability taxonomy, vendor/provider-name inference, compiled target matrix, or mutable resolution without lock evidence                                                                 |
| Compatibility API              | Capability/version contract                                                                                       | Adapter-provided subset                                                                                                                      | No claim of full vendor compatibility and no official resource pool in OSS                                                                                                                                                                             |
| Billing                        | Disabled/showback measurement ledger plus injected ShowbackRater / enforcement / quota ports                      | Operator rating policy; Cloud PriceCatalog and payment extension                                                                             | No fixed price, plan-action weight, Stripe route/schema/env/client, official PriceCatalog, or payment gate in OSS; zero/unrated must remain distinct from rated zero                                                                                   |
| Takosumi Cloud                 | Closed extension composed one-way onto OSS                                                                        | Official targets, payment, quota, support                                                                                                    | OSS must not import Cloud or know official deployment details                                                                                                                                                                                          |
| Accounts / OIDC                | Account, membership, generic OIDC and Interface Principal                                                         | IdP/OAuth provider adapters                                                                                                                  | No app runtime projection/material resolver or vendor-specific default issuer                                                                                                                                                                          |
| Dashboard / CLI                | Capability-driven clients over public contracts                                                                   | Extension-contributed views/commands and recipe-provided setup presentation                                                                  | No hostname, edition, provider catalog, Stripe, WfP, or Store-behavior heuristics                                                                                                                                                                      |
| Backup / audit / observability | Generic ledgers, opaque artifact refs, and injected append-only sink/producer ports                               | Storage/export adapters such as S3 Object Lock; confirmed migration adoption may read an already-recorded historical ref opaquely            | No R2 field names in portable contracts, retired Space/Installation object-key construction in current writers, provider-derived command env, provider lifecycle artifact registry, domain-owned S3 selection, or fake readiness work item as evidence |
| Production durability          | Durable control-plane storage and observability adapters                                                          | Operator-selected D1/Postgres/export backend                                                                                                 | No isolate-local audit chain, replay ledger, Project store, or other authoritative in-memory fallback in staging/production                                                                                                                            |
| API discovery                  | Mounted capabilities, open contract versions, and versioned extension tokens                                      | Host-injected extension inventory and contributed endpoints                                                                                  | No route/path substring inference, edition flag, fixed `commercial` capability branch, or Cloud-only route in OSS discovery                                                                                                                            |

## Verification gates

The implementation is conformant only when all of the following are true:

1. source scans reject active retired ledgers, the compatibility runtime-agent,
   Cloud/Stripe/WfP implementation terms in OSS core, runtime-cell topology,
   storage-substrate fields in portable contracts, retired artifact-key layouts
   outside immutable migration history, dashboard-owned provider
   catalogs, fixed OSS showback prices/action weights, magic InstallConfig
   defaults, and executable Store metadata outside explicit migration/history
   allowlists;
2. contract and OpenAPI tests prove that Output is opaque, Resource Shape kinds
   are open but schema-bound and fail closed when unregistered,
   Target/implementation/runner-substrate tokens are open,
   UsageEvent distinguishes rated zero from zero/unrated, and public records
   contain no internal template or provider implementation fields;
3. focused domain tests prove explicit selection and fail-closed behavior for
   credentials, target implementations, Interface mappings, Store metadata,
   unrated showback defaults, host rating, and extension absence;
4. D1 and Postgres tests use the same canonical Workspace/Project/Capsule,
   StateVersion, and Output records, and production composition persists its
   audit chain rather than falling back to isolate memory; and
5. TypeScript, Go provider, dashboard, CLI, accounts, Cloud dependency-direction,
   and root product-boundary gates pass together.
