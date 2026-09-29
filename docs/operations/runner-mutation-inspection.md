# Runner mutation authority inspection

An operator may inspect the durable Runner mutation claim for one exact
ApplyRun without dispatching or resuming it:

```http
GET /internal/platform/runner-mutation?runId=apply_<exact-id>
Authorization: Bearer <deploy-control-token>
```

This private platform route uses the existing deploy-control bearer. It reads
the exact Core ApplyRun through the existing D1 store in forced `predeployed`
mode (schema verification and SELECT only, never request-time bootstrap DDL),
accepts only create/update/destroy ApplyRuns with a Workspace, and addresses
`RUNNER.idFromName(applyRun.id)`. Other Run types, malformed or duplicate IDs,
and unauthenticated callers never reach the Runner Durable Object. Missing
schema fails closed. It is not a public Host API or Form contract.

The response reports only finite facts from the fixed
`runner-mutation-authority` slot and the corresponding
`runner-mutation-dispatch@v2:<semanticDigest>` slot. `authority.status` is
`absent`, `unknown`, `malformed`, or `valid`. `unknown` denotes an unrecognized
versioned record kind; `malformed` denotes an invalid recognized/missing kind.
A valid record exposes only `action`, `phase`,
`version`, `fence`, and `redispatchBlocked`; the semantic digest and raw storage
object are not returned. `dispatch.status` is `not_checked` when the authority
slot cannot identify a digest; otherwise it is `absent`, `malformed`,
`conflicting`, `unknown`, or `matching`. `matching` means the two parsed records agree on
their finite identity and phase fields, **not** that provider execution
succeeded, state was persisted, or adoption is safe.
An authority action that disagrees with the exact Core Run type returns 409
with the same allowlisted observation. It is a conflict, not a recoverable
request error.

The route reads no container endpoint, state body, Output, credential, or
request payload. It does not start/stop a container, write storage, alter an
alarm, mint credentials, retry, replay, cancel, or recover a Run. A failed Core
Run is not evidence that the provider mutation did not occur. The Worker uses
an exact Runner DO RPC: an older DO without the inspection method fails
unavailable, with no fallback to the DO's container-forwarding `fetch` route.
The two storage keys are read in one read-only transaction so a concurrent
phase update cannot be reported as a false conflict. In particular,
`preparing` is pre-dispatch claim evidence only; `dispatched` and
`indeterminate` remain blocked from redispatch. Missing, malformed, or
conflicting records are uncertainty to investigate, not permission to repair
them or to adopt an R2 target. Recovery still requires the separate exact-Run
and immutable-target evidence checks described in the [core spec](../internal/core-spec.md).

This endpoint requires a platform Worker deployment before it can inspect a
live Durable Object. Building or testing this code does not publish it, and
deploying it does not authorize a production mutation.
