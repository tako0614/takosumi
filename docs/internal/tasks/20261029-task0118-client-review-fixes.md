# TASK-0118 Phase 7 client review fixes

Scope: takosumi PR #662 and its stacked install-review PR #664, takosumi-mobile
PR #2, and takosumi-dev-server PR #1. Merge current main into each owned branch;
propagate #662 normally into #664. Push reviewed heads and require their CI gates.
Do not merge pull requests, deploy, or access live databases, providers, identity
systems, billing, or credentials.

The per-app API selects ownership and personal resources. Retained workspace
selection is used only when a route is demonstrably missing. Keep the legacy
selector and first-account bootstrap only on that compatibility branch. A business
`not_found` is an error, never permission to retry under another scope. Retain the
two-step store install and use workspace-less version resolution.

Home, app roles, connection selection, OAuth and store status share the current
account's app-list read. Scope caches to the session, invalidate ownership changes,
and bound per-app reads with visible incomplete results. Personal usage must not
fall back to workspace-wide usage. Preserve the optional commercial billing panel
with its retained owned personal billing reference.

Writer B owns the server contracts for pending outgoing/incoming transfers,
label-only owner connection choices, personal OAuth start, and workspace-less
source-ref resolution. Transfer reads use the public `transfers` envelope with
`transferId`, `capsuleId`, `fromAccountId`, `toAccountId`, and `state`; unavailable
routes hide/disable the corresponding new operation. The UI discovers incoming
transfers without requiring app membership or a manually supplied transfer ID.

Verification is focused local tests, affected static portable-gate phases,
dashboard build and selected deterministic browser journeys. The shared SSD has
limited capacity: no full local gate, dependency copies, or live checks. CI is the
full gate and all PR heads must pass before handoff.
