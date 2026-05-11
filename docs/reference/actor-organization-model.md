# Actor / Organization Model

This page is retained as a link-compatible migration stub.

Actor, organization, membership, account ownership, and billing ownership are
not owned by the takosumi kernel. The normative owner is Takosumi Accounts in
`takosumi-cloud/`.

Current model:

- takosumi kernel accepts compiled Shape manifests and records deploy evidence.
- Takosumi Accounts owns account, billing, AppInstallation ledger, OIDC issuer,
  pairwise subject, AppBinding, AppGrant, and audit lifecycle.
- Kernel deploys created directly through `POST /v1/deployments` are unmanaged
  deployments and do not create AppInstallation ownership.

References:

- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `docs/platform/app-installation.md`
