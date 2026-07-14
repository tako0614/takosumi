# Local-substrate hardening evidence (FIXTURE)

**This is not production evidence.** It is a deterministic file used by the
local-substrate to exercise the generic production-hardening evidence checks.
The fixture covers container execution, egress enforcement, credential recipe,
and secret-boundary checks. Real evidence is operator state outside the OSS
repository and must use immutable references to independently reviewed results.

There is deliberately no Accounts-specific public-access or launch-approval
gate. Accounts is an account-plane facade; publishing a hosted service and its
commercial readiness policy belong to the operator/Cloud extension.

## How to regenerate the digest

```bash
cd takosumi/deploy/local-substrate
sha256sum docs/launch-readiness/p0-local-evidence.md
# → <hash>  docs/launch-readiness/p0-local-evidence.md
# Then update the local hardening *_EVIDENCE_DIGEST values in
# env/takosumi-service-worker.env
# with `sha256:<hash>`.
```

The substrate's `scripts/up.sh` does not auto-recompute this digest. That is
intentional: a changed fixture must not silently continue satisfying the
hardening checks. Update the env file after reviewing the fixture, or the
generic hardening evidence validation will reject the digest.
