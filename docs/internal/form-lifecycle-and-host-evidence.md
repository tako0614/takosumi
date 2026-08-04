# Form lifecycle and host evidence

Status: current ownership and evidence boundary, 2026-08-04.

## Decision

Takosumi does not publish, approve, or classify a Standard Form set. Takoform
owns exact FormRef/package identity, package publication, conformance material,
and the Proposal/Experimental/Stable/Legacy lifecycle. Takosumi owns one host
lifecycle and reports support through its Form Registry, executable
Target/Adapter evidence, exact FormActivation, and principal audience.

Historical package/checkpoint artifacts are not a current Takosumi default or
authority merely because their bytes or reports still exist. The obsolete
Takosumi central-admission contract, evaluator, and tests are removed and must
not be recreated.

## Retained Takosumi contracts

Takosumi tests portable host behavior directly:

```bash
bun run service-form:host-conformance -- \
  --endpoint https://takosumi.example.com \
  --space workspace_1 \
  --name example \
  --identity ./identity.json \
  --desired ./desired.json
```

The runner exercises discovery, exact Form availability, negative-fixture
rejection, preview/apply and idempotent replay, read, exact-digest substitution
rejection, refresh/sync, optional import, delete, and parity with the canonical
Takosumi Resource/audit projection. It emits host conformance evidence; that
evidence does not promote Takoform lifecycle maturity or activate a Form.

Takosumi also retains fixed executable fixtures used by host conformance:

```bash
bun run service-form:runtime-artifacts:check
```

An optional `service-form:runtime-artifacts:oci-readback` verifies the pinned
external OCI manifest. Neither command builds or publishes a release.

## Historical publication proof

`service-form:published-package-host-proof` pins the last actually published
Legacy checkpoint, `forms/admissions/v1.0.7`. It reads nine reviewed kinds from
the immutable 34-entry package publication ledger and verifies exact retained
bytes, signatures, transparency evidence, install, replay, and service
reconstruction. It deliberately does not consume the historical Standard
admission set.

Production or hosted availability remains separate evidence: exact installed
package readback, an executable implementation and Adapter, active exact
FormActivation, principal audience, real backend lifecycle, retained
reverification, backup/restore, and—where applicable—an independent Offering
and commercial binding. Repository conformance must not be represented as
hosted capacity, production deployment, billing, maturity, or GA evidence.
