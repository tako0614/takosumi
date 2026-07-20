# Standard Form live materialization audit

Status: GA blocker audit, 2026-07-20. This document describes evidence work;
it does not admit a Form, activate Stable, publish an artifact, or authorize a
production deployment.

## Decision

The immutable Takoform `1.0.0` package set remains retained and non-admitted.
Its illustrative artifact digests must not be treated as real bytes or replaced
behind the same fixture name. The coordinated successor is a complete
`1.0.1` Form Package set with real canonical desired fixtures and a Takoform
provider `0.1.1` candidate, because provider `0.1.0` pins the exact `1.0.0`
FormRefs and package digests.

Takosumi host reports must embed a non-secret execution summary, bind its
recomputed RFC 8785 digest, and bind the exact retained package fixture-file
digest plus effective canonical input digest. The signed public report contains
only lifecycle checks, identities, fixture names, and digests. It does not echo
a runner-local path, artifact URL, desired value, connection document,
credential, target, quote, or backend identity.

## Ten-kind materializability matrix

| Kind | `1.0.0` live result | Minimum `1.0.1` / host work | Import authority | Honest drift evidence |
| --- | --- | --- | --- | --- |
| `EdgeWorker` | Blocked: reserved `.test` URL and illustrative `a…a` digest cannot resolve to real bytes. | Separately release a minimal immutable Worker module and pin its real HTTPS URL and SHA-256. Keep any connection only if the selected target materializes it. | Existing external native-id import is sufficient. | Observe the deployed script/config or an independently mutated supported setting. |
| `ObjectBucket` | Desired fixture is materializable; the staging attempt stopped earlier at `deployment_quote_invalid`. The scratch R2 import bucket was deleted and 404 readback confirmed cleanup. | No artifact. Fix and seal the hosted catalog/quote candidate, then rerun. | Existing external R2 native-id import is sufficient. | Mutate storage class through the real backend and require `drifted`. |
| `KVStore` | Blocked on the audited hosted target: fixture requests `strong`, while that target implements `eventual`. | Use a real materializable canonical preference or add a target that truthfully provides strong consistency; never silently downgrade. | Deterministic external native creation/import is sufficient. | Backend observation must compare a real observable property; an unconditional match is not evidence. |
| `SQLDatabase` | Blocked on the audited hosted target: `migrationsPath` is rejected. | Either materialize the retained migration source for real or omit the optional path in a new canonical fixture. | Deterministic external native creation/import is sufficient. | Observe a real supported database property; an unconditional match is not evidence. |
| `Queue` | Blocked on the audited hosted target: non-empty delivery settings are rejected. | Materialize delivery settings or omit them in a new canonical fixture. | Deterministic external native creation/import is sufficient. | Observe real delivery configuration; an unconditional match is not evidence. |
| `VectorIndex` | Blocked on the audited hosted target: the SQL connection is rejected. | Implement the connection projection or remove the optional connection in a new canonical fixture. | Deterministic external native creation/import is sufficient. | Observe dimensions/metric or another real backend property. |
| `DurableWorkflow` | Blocked: illustrative `artifact:workflow:ingest`, `b…b` digest, and unsupported Queue connection. | Separately release a minimal workflow module, pin its real digest, and provide a real fetch/seed path; implement or remove the optional connection. | Needs an operator-only real native seeding/adoption path that preserves the manager's workspace/resource identity. No public fake seam. | Mutate/read the real workflow revision or configuration. |
| `ContainerService` | Blocked: nonexistent example OCI image with illustrative `c…c` digest and unsupported SQL connection. | Publish a long-running minimal OCI image, retain registry readback, pin its manifest digest, and implement or remove the optional connection. | Needs an operator-only real native seeding/adoption path. | Mutate/read the real container revision/configuration. |
| `StatefulActorNamespace` | Blocked on the audited hosted target: the SQL connection is rejected. | Implement the connection projection or remove the optional connection in a new canonical fixture. | Needs an operator-only real native seeding/adoption path. | Mutate/read the real namespace revision/configuration. |
| `Schedule` | The schedule connection is supported, but its required `DurableWorkflow/ingest` dependency is not yet materializable. | Run only after the real workflow fixture exists; retain the required invoke/schedule-trigger connection. | Needs an operator-only real native seeding/adoption path. | Mutate/read the real cron or target revision. |

The minimum external artifact set is therefore one immutable edge module, one
immutable workflow module, and one immutable long-running OCI image. Package
releases remain data-only. Runtime artifacts use a separate immutable release
and readback lane; a Form Package points at their retained identities and
digests but never embeds executable code.

## Hosted evidence prerequisites

Before any of the ten reports is retained as passed, the hosted candidate must
have a final sealed catalog fingerprint that includes the exact Form Package,
implementation, manager, SKU, and quote inputs. The current staging failure
`backend_unavailable` / `deployment_quote_invalid` is a real blocker, not a
runner exception. A provisional catalog fingerprint cannot become the final
subject, and this audit must not activate Stable.

Every live run also needs a dedicated scratch Workspace, exact package
readback, real backend mutation, import cleanup, Resource cleanup, and a
post-cleanup backend readback. Internal runtime managers may expose narrowly
scoped operator seeding/adoption only where the real backend cannot otherwise
create the exact native identity. Such authority is not portable API surface
and must never synthesize success.
