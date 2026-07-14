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

The realized deploy config and vault location are operator-owned. Verify file
permissions and list only remote secret names:

```bash
test -f "$TAKOSUMI_WRANGLER_CONFIG"
test -d "$TAKOSUMI_SECRETS"
find "$TAKOSUMI_SECRETS" -maxdepth 1 -type f \
  -exec sh -c 'test "$(stat -c %a "$1")" = 600' sh {} \;
bunx wrangler@latest secret list --config "$TAKOSUMI_WRANGLER_CONFIG"
```

Push one approved value through standard input. Do not echo it, infer missing
values, overwrite unrelated classes, or automatically delete remote-only
secrets.

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
