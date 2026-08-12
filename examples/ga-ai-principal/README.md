# GA AI Principal fixture

This is a providerless OpenTofu Capsule used by the Cloud GA AI Principal
workflow. It has no provider blocks or resources. Takosumi supplies the
endpoint and public OIDC client metadata through the repository manifest; the
Cloud operator creates the AI Interface after the Capsule is applied.

For this fixture, allowlist these non-secret outputs when creating the Capsule:

- `public_url`
- `takosumi_accounts_issuer_url`
- `takosumi_accounts_client_id`
- `takosumi_accounts_redirect_uri`

The last three values identify the public PKCE client and let the operator
start the normal authorization-code flow after apply. They are not bearer
credentials. Access tokens, authorization codes, PKCE verifiers, session
credentials, and Interface tokens must never be added to an OpenTofu output or
state handoff.
