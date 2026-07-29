# Standard Form materialization status

Status: current ownership and evidence boundary, 2026-07-29.

## Decision

Takosumi does not publish a Standard Form package set, typed provider, signed
host-report bundle, or a separate Standard Form runtime release. Those
publication and admission artifacts are independently owned by Takoform.
Historical exact package sets are not a current Takosumi default merely because
their bytes or reports once existed.

The obsolete Takosumi candidate machinery has been retired:

- the Standard Form runtime release workflow and its release/SBOM/readback
  builders;
- the signed reference-host report workflow and candidate generator; and
- tests that required either deleted workflow or generated artifact closure.

Do not recreate those workflows, synthesize replacement reports, or restore
removed public docs to satisfy old tests.

## Retained Takosumi contracts

Takosumi still owns the portable host behavior and can test that behavior
directly:

```bash
bun run service-form:host-conformance -- \
  --endpoint https://takosumi.example.com \
  --space workspace_1 \
  --name example \
  --identity ./identity.json \
  --desired ./desired.json
```

The runner exercises discovery, exact Form availability, config-fixture
rejection, preview/apply and idempotent replay, read, exact-digest substitution
rejection, refresh/sync, optional import, delete, and parity with the canonical
Takosumi Resource/audit projection. It emits a portable conformance report; it
does not turn that local report into Takoform admission evidence.

Takosumi also retains fixed executable fixtures used by host conformance. Their
manifest and bytes are checked locally:

```bash
bun run service-form:runtime-artifacts:check
```

An optional `service-form:runtime-artifacts:oci-readback` verifies the one
pinned external OCI manifest. Neither command builds or publishes a release.

## Admission and hosted evidence

A Form is standard only when its current, exact schema/package identity has the
independently reviewed portable semantic evidence and host/provider proof
required by `evaluateStandardFormAdmission`. A historical ten-package
compatibility set alone does not qualify it.

Production or hosted availability remains separate evidence: exact installed
package readback, a real backend lifecycle, provider-neutral import and
refresh/sync behavior, security review, cleanup, and operator-owned commercial
binding where applicable. Source conformance must not be represented as hosted
capacity, production deployment, billing, or GA evidence.
