# Secret rotation runbook

This runbook covers Takosumi OSS and Takosumi for Operator secret classes.
Closed Takosumi Cloud payment, managed-capacity, and AI-upstream secrets are
owned by `takosumi-cloud/docs/operations/secret-rotation.md`.

Cadence, audit requirements, and responsibility follow
[Secret Rotation Policy](secret-rotation-policy.md).

## Scope and invariants

Secret values, private keys, provider credential JSON, token bodies, and raw
rotation evidence live in an approved vault outside every repository. Takosumi
stores only encrypted/ref material appropriate to the owning domain and never
returns raw values from normal GET APIs.

- Workspace provider credentials are ProviderConnection/Secret material.
- A CredentialRecipe injects env/files only into the intended Run phase.
- Git source credentials do not become provider credentials.
- OIDC signing keys and upstream client secrets are platform identity secrets.
- InterfaceBinding credentials are invocation-time material and never Outputs.
- A hosting extension's commercial or managed-service secrets do not become OSS
  environment variables.

## Preparation

1. Identify environment, secret class, owner, affected Workspace/Capsule or
   ProviderConnection, and every consumer.
2. Confirm the vault retains the previous version for the approved rollback
   window.
3. Confirm provider/operator audit trails and maintenance-window approval.
4. Record only secret references/IDs and expected verification paths.
5. Check whether the class supports overlapping old/new credentials.

## Rotation

1. Issue the replacement at the provider or vault.
2. Update the owning reference: ProviderConnection/Secret, signing-key config,
   or the explicitly named runtime secret.
3. Keep both versions only for a bounded supported overlap.
4. Verify the exact Connection test, runner phase, OIDC flow, Interface
   invocation, or internal control route.
5. Revoke the previous value after verification and cache/overlap expiry.
6. Record actor, timestamps, old/new references, revocation reference, and
   verification result in the operator audit ledger.

## Platform identity secrets

Upstream OAuth/OIDC providers use the generic descriptor array
`TAKOSUMI_ACCOUNTS_UPSTREAM_PROVIDERS`. Non-secret endpoints, client id,
redirect URI, and scopes live in the descriptor. `clientSecretEnv` names the
operator-vault secret made available at runtime. Do not introduce a fixed
provider-specific env family or place a client secret in the descriptor.

OIDC signing-key rotation uses an active private key plus, when needed, a
public-only previous JWKS during a bounded overlap. Signing always uses the
active key. After token and JWKS cache windows expire, remove the previous
public key and verify discovery/JWKS again.

Evidence must prove the new key id is published, the previous key remains only
for the declared overlap, old credentials were revoked, and no private key or
client secret appears in evidence.

Capture the public JWKS once during overlap and again after removing the old
public key. Keep the captures and the following exact-schema run log in the
operator-private evidence directory. IDs are vault/audit references, never
secret bodies. `owner` and `reviewer` must be different people, and the measured
OAuth overlap must exactly match `overlapWindowSeconds`.

```json
{
  "kind": "takosumi.identity-security-rotation-log@v1",
  "rotationRunId": "rotation-run-id",
  "environment": "production",
  "issuer": "https://app.takosumi.com",
  "owner": "operator-subject",
  "reviewer": "reviewer-subject",
  "startedAt": "2026-01-01T00:00:00.000Z",
  "completedAt": "2026-01-01T00:30:00.000Z",
  "result": "passed",
  "keyRotation": {
    "keyId": "new-public-kid",
    "previousKeyId": "previous-public-kid",
    "overlapCapturedAt": "2026-01-01T00:05:00.000Z",
    "previousKeyRemovedAt": "2026-01-01T00:20:00.000Z",
    "postRevocationCapturedAt": "2026-01-01T00:21:00.000Z"
  },
  "clientSecretRotation": {
    "clientId": "upstream-client-id",
    "oldSecretId": "vault-secret-version-old",
    "newSecretId": "vault-secret-version-new",
    "overlapStartedAt": "2026-01-01T00:05:00.000Z",
    "oldSecretRevokedAt": "2026-01-01T00:20:00.000Z",
    "overlapWindowSeconds": 900,
    "revocationEventId": "provider-revocation-event-id"
  },
  "auditEvent": {
    "id": "takosumi-audit-event-id",
    "subject": "operator-subject",
    "at": "2026-01-01T00:22:00.000Z"
  }
}
```

Merge the evidence only after both public snapshots and the run log exist:

```bash
bun run cli -- launch-readiness oidc-account-security evidence \
  --file "$READINESS_FILE" --out "$READINESS_FILE" \
  --issuer "$TAKOSUMI_ISSUER" \
  --overlap-jwks-file "$OVERLAP_JWKS_FILE" \
  --post-revocation-jwks-file "$POST_REVOCATION_JWKS_FILE" \
  --rotation-log-file "$ROTATION_LOG_FILE" \
  --ref-prefix "$PRIVATE_ROTATION_EVIDENCE_REF" --json
```

The helper rejects private JWK material, a missing old/new overlap, an old key
that remains published after revocation, extra run-log fields, self-review, or
inconsistent timestamps. It does not perform or claim the live rotation.

## ProviderConnection secrets

Create a replacement Connection or secret version, test it, update explicit
ProviderBindings/default selection, then revoke the old Connection. Never use
an implicit fallback from an invalid or missing binding.

```bash
takosumi connections test <new-connection-id>
takosumi connections revoke <old-connection-id>
```

Any helper input file stays outside the repo and is deleted after import.
Shell history, logs, PR comments, and terminal transcripts must not contain the
credential.

## Worker secret delivery

The realized deploy config, vault, and delivery adapter are operator-owned.
Takosumi OSS intentionally does not own a bulk platform-secret registry,
generate missing operator secrets, or prescribe one cloud CLI. A self-hosting
operator must use its reviewed deployment adapter, validate the exact selected
secret names, pass values without logging them, perform a fixed readback, and
keep only public IDs/digests in evidence.

Takosumi Cloud is stricter: runtime-secret mutation is part of the fixed
controller release and raw Wrangler secret/deploy commands are not an operator
path. The closed adapter accepts an exact value-free
`takosumi.cloud-runtime-secret-files@v1` manifest whose paths point to
owner-matched `0600` files under `0700` directories outside every source
checkout. The sealed release policy allowlists names, the OIDC key triple is
atomic, and the adapter proves health plus exact public JWKS key IDs before it
records success. See the closed Cloud rotation and immutable Worker-release
runbooks for staging, replica, authorization, and production execution.

## Verification

- health, readiness, OIDC discovery, and JWKS are valid;
- unauthenticated APIs remain rejected;
- the affected Connection/Run/Interface path works with the new material;
- old material stops working after revocation;
- state, Outputs, audit events, failure diagnostics, and logs contain no secret;
- saved plan, source snapshot, dependency snapshot, and state generation guards
  remain intact for the next affected Run.

## Rollback

Before revocation, point the explicit reference back to the previous vault
version. After revocation, issue an emergency replacement and repeat the same
procedure. Always record the failure cause, recovery time, and remaining work.

## Related documents

- [Secret Rotation Policy](secret-rotation-policy.md)
- [Troubleshooting Playbook](troubleshooting.md)
- [Incident Response](incident-response.md)
