# RBAC Policy

This page is retained as a link-compatible migration stub.

RBAC for accounts, spaces, AppInstallations, AppBindings, and AppGrants is owned
by the operator's account plane (reference implementation: Takosumi Accounts in
`takosumi-cloud/`), not by the takosumi kernel. Kernel provider authorization is
limited to operator configuration, deploy token policy, ProviderPlugin
contracts, and runtime-agent trust.

References:

- `takosumi-cloud/docs/accounts-service.md`
- `docs/platform/app-installation.md`
- `docs/reference/binding-catalog.md`
- `docs/reference/namespace-exports.md`
