# Internal Runtime-Agent Compatibility Code

`core/runtime-agent/` is retained for private operator compatibility tests and
older reference distribution code. It is not exported as a public
`@takosjp/takosumi` v1 subpath and is not part of the OpenTofu-native OSS
control-plane or runner API.

Takosumi v1 public execution is modeled with Workspace / Project / Capsule /
Source / ProviderConnection / CredentialRecipe / ProviderBinding / Secret /
Run / StateVersion / Output / Runner / AuditEvent / Operator records. A `Run`
captures init/validate/plan/apply/destroy activity, and a successful apply
advances `StateVersion` and records `Output`. OpenTofu providers own resource
graph and provider API behavior. Operators may keep private adapter hosts,
runner profiles, compatibility ledgers, or workflow engines, but those hosts are
implementation details subordinate to ProviderConnection, CredentialRecipe,
ProviderBinding, policy, and the runner boundary. They must not introduce public
Takosumi source metadata, manifests, DataAsset/kind, provider-adapter, or
runtime-handler requirements.

The public service surface is the host worker's `/api` contract on the
Takosumi platform worker, the in-process typed operations seam when composed
inside the Takos distribution worker, and the focused `takosumi-contract/*`
source-module aliases inside this repository. Root `@takosjp/takosumi` package
subpaths are not a published runtime-agent API.

New code should use the `/api` deploy-control surface and the OpenTofu runner
boundary instead of importing this directory.
