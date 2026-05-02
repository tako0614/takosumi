# takosumi-contract

Domain contract for callers of the Takosumi internal tenant API and Takosumi
service-to-service RPC.

This package is the only PaaS package that user-facing services such as
`takosumi-app` may import for tenant operations. It intentionally contains
request/response DTOs, actor context types, route constants, and
service-signature helpers only. PaaS implementation code, database models, and
route handlers stay outside this package. The package is not a generic `common`;
PaaS owns service endpoint discovery and internal RPC identity.

It also carries the architecture-aligned M0/M1/M2 shared DTO surface used at the
PaaS boundary: actor context, source snapshots, domain events, conditions,
space/group requests and summaries, deploy-kernel records, service endpoint
trust/grants, and basic runtime network policy types.

New service-to-service callers should use `internal-rpc.ts`, which emits the
`takosumi-internal` envelope. The canonical payload binds method, path/query,
body digest, actor context, caller, audience, capabilities, request id, nonce,
and timestamp.

Git hosting contracts belong to `takosumi-git-contract`, not this package.
