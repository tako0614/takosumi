# Actor / Organization Model

This page is retained as a link-compatible migration stub.

Actor, organization, membership, account ownership, and billing ownership are
not owned by the takosumi kernel. They belong to an operator account plane;
`takosumi-cloud/` is the reference (currently exercised) implementation of that
plane, but the kernel contract does not privilege it.

Current model:

- takosumi kernel accepts compiled Shape manifests and records deploy evidence.
- An operator account plane (reference impl: Takosumi Accounts in
  `takosumi-cloud/`) owns account, billing, AppInstallation ledger, OIDC issuer,
  pairwise subject, AppBinding, AppGrant, and audit lifecycle.
- Kernel deploys created directly through `POST /v1/deployments` are unmanaged
  deployments and do not create AppInstallation ownership.

References:

- `takosumi-cloud/docs/accounts-service.md`
- `takosumi-cloud/docs/architecture/takosumi-accounts.md`
- `docs/platform/app-installation.md`
