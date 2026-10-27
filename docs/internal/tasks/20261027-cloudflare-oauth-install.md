# Cloudflare OAuth connection and declared install inputs

Owner: current DeckIDE writer; Takosumi only. Base 11f1a1b9. Isolated worktree; preserve other dirty checkouts and active checks.

User intent: replace manual Cloudflare token setup with OAuth, retaining app-declared domain and other settings as editable user inputs. No fixed application domain.

- Reuse provider-owned descriptors, session-authenticated OAuth start/callback, encrypted connection vault and existing verification/binding authority.
- Expose only installed and configured OAuth helpers. Keep API token fallback. Client secrets, refresh tokens and credentials never reach frontend storage, logs or public projections.
- Keep install inputs mounted during OAuth (popup with a safe same-origin callback and bounded polling). No install draft secrets or input values in URLs/storage.
- Preserve manifest/compiler input declarations, required/optional/default behavior, and actual Plan variable submission. Domains are editable when declared; no global fixed domain field.
- Add regression coverage for OAuth state/exchange/lifecycle, input retention, declared domains, expiry and failure/retry. Run focused checks followed by the required full repository gate.
- Credential/authentication behavior changes require independent review before publication. Production client registration/configuration is separate from source implementation; record actual readiness without claiming a disabled button works.

Implemented: configured helper discovery; PKCE and browser-bound OAuth; a popup that retains the install form; exact callback correlation and final verified-state reads; manual-token fallback and account selection; current host-owned client configuration; sealed refresh sessions with durable single-flight CAS; dynamic Run lifetime checks; explicit transient-vs-ambiguous refresh failures; required/optional/derived declared input editing. Memory/Postgres/D1 retain the same SQL schema. New private blob JSON fields are additive and never public.

Validation in progress: independent Claude reviews v1/v2 findings preserved and addressed; v3 closure review and final gate pending. Browser OAuth v2 all10PASS; expanded input cases required selector fixes preserved as RED evidence. External activation is not claimed: existing operator credential gets403 on OAuth-client management; client config is absent on the current service. Registration and real consent remain separate required steps.

Rollback: restore the prior reviewed Worker/config using the existing owner release. Existing token connections retain behavior. New OAuth sessions require this refresh driver and are not usable on the old artifact; do not delete/rewrite their sealed blobs to force compatibility. Forward-repair by restoring this reviewed driver or reconnecting through a supported credential mode. No blind retry of unknown refresh grants.

Final gate/evidence is stored outside product source at /root/dev/operator-runs/takosumi-cloudflare-oauth-20261027/evidence/.
