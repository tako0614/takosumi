# Internal Runtime-Agent Compatibility Code

`core/runtime-agent/` is retained for private operator compatibility tests and
older reference distribution code. It is not exported as a public
`@takosjp/takosumi` v1 subpath and is not part of the OpenTofu-native Deploy
Control API.

Takosumi v1 public execution is modeled as Space-scoped `Run` and `RunGroup`
records over `Installation`s, with successful applies captured as
`Deployment`, `StateSnapshot`, and `OutputSnapshot` records. OpenTofu providers
own resource graph and provider API behavior. Operators may keep private adapter
hosts, runner profiles, PlanRun/ApplyRun compatibility ledgers, or workflow
engines, but those hosts are implementation details subordinate to Connection,
InstallationProviderEnvBinding, and policy. They must not introduce public Takosumi source metadata, DataAsset, kind,
provider-adapter, or runtime-handler requirements.

The public service surface is the hosted Worker `/api` contract and the focused
`takosumi-contract/*` source-module aliases inside this repository. Root
`@takosjp/takosumi` package subpaths are not a published runtime-agent API.

New code should use the `/api` deploy-control surface and the OpenTofu runner
boundary instead of importing this directory.
