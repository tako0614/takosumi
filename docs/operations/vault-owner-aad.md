# Owner-bound Vault envelopes

New secret envelopes use AAD version 3 with exactly `ownerAccountId`, `connectionId`, and `provider`. The owner comes from trusted account or legacy namespace authority. Operator connections use a fixed operator owner label. Reading first tries the owner-bound envelope and retains the historical v2 reader during the expand period.

The operator can invoke `rewrapVaultSecrets(vault, reviewedConnectionIds, { dryRun: true })` from `core/adapters/vault/rewrap.ts` with an already composed Vault. Dry-run decrypts only inside the Vault to verify the envelope and returns value-free status. It never writes. After reviewing statuses, invoke the same job with `{ dryRun: false }` to persist v3 using compare-and-swap against the original connection and secret envelope. Concurrent renewal, owner changes, and revocation produce a conflict; do not retry with refreshed authority automatically.

Results contain only connection IDs, envelope versions and statuses. Do not log the Vault, crypto input, decrypted material or provider responses. This repository change does not run the job against any environment. Keep the historical reader until the operator has verified rewrap completion and Phase 9 authorizes its removal.
