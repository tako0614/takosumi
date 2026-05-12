# Auth Providers

This page is retained as a link-compatible migration stub.

Auth providers, upstream IdP brokering, passkeys, OIDC discovery, and pairwise
subject derivation are responsibilities of the operator's account plane
(reference implementation: Takosumi Accounts in `takosumi-cloud/`). The takosumi
kernel does not own OAuth/OIDC provider behavior and does not broker user
identity.

References:

- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/apps/launch-token.md`
