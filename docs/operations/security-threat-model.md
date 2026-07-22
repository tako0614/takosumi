# Takosumi Security Threat Model

This document is the public-safe threat-model baseline for Takosumi OSS and
Takosumi for Operator. It describes assets, trust boundaries, threats, and
required controls. It is not a production acceptance record: an accountable
operator/security reviewer must still review the exact deployed composition and
record a separate private acceptance reference.

## Scope and trust boundaries

The model covers one operator-selected Takosumi origin containing Accounts,
OIDC, dashboard, control plane, and runner dispatch. It also covers the
operator-selected database/object/queue substrates and runner executors.
Takosumi Cloud adds a closed commercial/managed-capacity layer through public
OSS seams; OSS does not trust or depend on that layer.

Trust crosses these boundaries:

1. Browser/native client to the public origin.
2. Upstream OAuth/OIDC provider to Accounts callback and token exchange.
3. Accounts identity to Workspace-scoped control APIs.
4. Control plane to an explicitly selected RunnerProfile/executor.
5. Runner to Git sources, provider registries, and provider APIs.
6. Runner to encrypted state, Output, logs, and audit stores.
7. Interface consumer to InterfaceBinding-authorized runtime credentials.
8. Operator vault/configuration to the deployed platform.

Git repositories, OpenTofu modules, provider binaries, provider responses,
browser input, callback parameters, and tenant-supplied configuration are
untrusted. Operator credentials and deployment evidence remain outside the
public repository.

## Protected assets

- account sessions, refresh/access tokens, OIDC signing private keys, upstream
  client secrets, and pairwise-subject material;
- Workspace membership and authorization;
- ProviderConnection and Secret values;
- source snapshots, reviewed plan digests, StateVersions, Outputs, and locks;
- InterfaceBinding authorization and invocation-time credentials;
- immutable audit chain and release/provenance evidence;
- tenant isolation, availability, quota, and billing attribution.

## Threats and required controls

| Threat                                                        | Required control and verification                                                                                                                                                   |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Issuer/redirect confusion or callback interception            | Bare-origin issuer is exact, redirect URIs are pre-registered and exact, PKCE/state/nonce/session tests pass, discovery and JWKS are same-origin.                                   |
| OIDC signing-key disclosure                                   | Private JWK is a Worker/operator secret; JWKS accepts public-only keys and rejects `d`; evidence/log output contains identifiers and digests only.                                  |
| Stale OIDC signing key remains trusted                        | Rotation publishes bounded old/new JWKS overlap, signs only with the active key, then captures post-revocation JWKS proving the old `kid` is absent.                                |
| Upstream OAuth client-secret leakage or incomplete revocation | Descriptor stores only `clientSecretEnv`; vault versions overlap for a measured window; old version is revoked and a revocation event plus audit event is recorded.                 |
| Session/token replay or cross-client correlation              | Pairwise subjects, audience/scope checks, refresh/session rotation, revocation, and exact client registration are enforced.                                                         |
| Unauthenticated or cross-Workspace API access                 | Session/OIDC middleware, Workspace membership checks, explicit roles/bindings, and unauthenticated/cross-tenant negative tests fail closed.                                         |
| Malicious Git source/module build                             | Source is pinned to immutable identity; argv-only `sourceBuild` runs credential-free; generated-root and relative-path rules reject traversal and undeclared artifacts.             |
| Malicious provider binary/module execution                    | Provider admission/lock/mirror policy, reviewed plan digest, resource/action policy, non-root runner process, bounded resource limits, and substrate isolation apply.               |
| SSRF or metadata/control-plane access                         | URL/parser checks reject private/link-local/metadata targets; DNS answers are revalidated; selected runner substrate must enforce egress policy and prove allowed/denied endpoints. |
| Credential exfiltration from Run phases                       | Source phase receives only source credentials; provider env/files are phase-scoped, written outside the source tree with restrictive modes, redacted, and shredded on cleanup.      |
| State/plan substitution or stale apply                        | Source, provider binding, dependency/state generation, plan digest, and lock identity are pinned and rechecked before apply.                                                        |
| Secret leakage through Output/Interface/log/audit             | Sensitive Outputs are excluded; Interface accepts non-secret declared inputs only; logs/diagnostics/audit use redaction and secret-boundary tests.                                  |
| Audit deletion/suppression                                    | Chained immutable events, external append-only replication where configured, backup/restore chain verification, and operator rotation/run logs are required.                        |
| Tenant DoS, quota bypass, or billing abuse                    | Bounded inputs, queue/lease controls, quotas/rate limits, kill switch, noisy-tenant tests, and audited operator override are required.                                              |
| Closed-host boundary leak                                     | Dependency direction stays Cloud to OSS; closed billing/capacity internals do not enter public contracts or become required by self-hosted Takosumi.                                |

## Review and change triggers

Review this model before GA and whenever one of these changes:

- OIDC issuer/client/token behavior or secret classes;
- runner substrate, privilege, network, filesystem, or credential delivery;
- source-build/provider execution authority;
- state encryption, audit retention/replication, backup, or restore;
- public compatibility API or Interface credential delivery;
- commercial/closed seam ownership.

The private review record must identify the reviewed commit and deployment,
open risks, accepted compensating controls, reviewer, and date. Readiness
`threat-model.acceptedBy` is a human/operator acceptance field; repository
tests or this document alone must never populate it.

## Technical verification baseline

```bash
cd takosumi
bun run check
bun run test:accounts
bun test tests/runner tests/worker/src/runner_credentials_test.ts \
  tests/worker/src/runner_plan_apply_redaction_test.ts
cd ..
bun run check:secrets-leakage
```

The deployed substrate must additionally satisfy its versioned platform
hardening contribution, especially runner execution, egress enforcement,
credential boundary, and secret-boundary checks.
