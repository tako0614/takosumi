# Identity and Access Architecture

This page is retained as a link-compatible migration stub.

Identity and access for users, accounts, organizations, memberships, billing,
OIDC, launch tokens, AppInstallations, AppBindings, and AppGrants live in an
operator account plane (reference implementation: Takosumi Accounts in
`takosumi-cloud/`). The takosumi kernel stays a generic manifest deploy engine
that can deploy any application and does not own account-plane identity.

Kernel-side trust is limited to:

- public deploy/artifact route authentication configured by the operator
- ProviderPlugin / runtime-agent contracts
- deploy evidence, WAL, audit, and observation records for unmanaged deployments

References:

- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `takosumi-cloud/docs/accounts-service.md`
- `docs/reference/design-principles.md`
