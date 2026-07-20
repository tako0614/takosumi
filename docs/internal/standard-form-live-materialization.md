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

## Successor source status

The independent Takoform repository now generates the complete exact `1.0.1`
source candidate. Its EdgeWorker and DurableWorkflow fixtures pin the published
immutable `standard-form-runtime-v1.0.3` release bytes, ContainerService pins an
exact linux/amd64 OCI manifest, unsupported optional preferences were removed,
and the two retained dependencies are explicit:

- EdgeWorker uses `ObjectBucket/edge-assets` through
  `object.binding.v1` with read/write grants; and
- Schedule uses `DurableWorkflow/ingest` through `schedule_trigger` with an
  invoke grant.

The same package set owns one required, data-only portable Interface descriptor
for every outward runtime surface:

| Form | Descriptor |
| --- | --- |
| `EdgeWorker` | `http.request@1` |
| `ObjectBucket` | `object.storage@1` |
| `KVStore` | `keyvalue.store@1` |
| `SQLDatabase` | `sql.query@1` |
| `Queue` | `queue.messages@1` |
| `VectorIndex` | `vector.query@1` |
| `DurableWorkflow` | `workflow.invoke@1` |
| `ContainerService` | `http.request@1` |
| `StatefulActorNamespace` | `actor.invoke@1` |
| `Schedule` | none; it consumes a workflow and exposes no runtime surface |

These are open portable identities; none uses a `takosumi.cloud.*` name. Each
descriptor carries a closed non-secret document schema and deterministic
`output` mappings. SQLDatabase publishes and maps `engine` in addition to its
Resource id and name.

Takosumi's committed exact fixture retains all ten candidate FormRefs, package
digests, desired/negative fixture digests, and parsed descriptors. Focused host
tests prove all ten create/read/update/import/observe/drift/delete lifecycles
and prove that all nine required descriptors become `Resolved`, Resource-owned
Interfaces with `form_descriptor` provenance before Resource Ready. Schedule
creates no invented Interface. The proof uses an explicitly injected
deterministic test Adapter; it is source-level OSS host conformance, not a
hosted target or production deployment proof.

Local source gates and the all-or-nothing ten-package candidate builder do not
require CI. The GitHub workflow remains optional automation and the current
keyless OIDC signing path. Publication must stop at that exact signer boundary
if the identity is unavailable; it must not weaken signature policy.

## Historical blocker matrix and hosted remainder

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
releases remain data-only. Takosumi owns the host-conformance-only source and
candidate verifier under `conformance/standard-form-runtime/v1.0.3`; its
separate release lane keyless-signs and attests the exact local bytes. The OCI
fixture is the public Docker Hub nginx `linux/amd64` manifest pinned as
`sha256:845b5424415de5f77dd5753cbb7c1be8bd8e44cc81f20f9705783a02f8848317`
and the candidate gate verifies the registry manifest bytes against that
digest. A Form Package points at retained release identities and digests but
never embeds executable code. None of these runtime artifacts grants host,
target, capacity, billing, or admission authority.

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
