# Form lifecycle and host evidence (superseded)

Status: superseded historical evidence note, retained for migration and
reproducibility. The current ownership boundary is [Core Spec](./core-spec.md)
and its evidence map is [Core Conformance](./core-conformance.md). This note
does not define a current OSS Form Host, Registry, activation surface, or GA
requirement.

## Historical decision and retained evidence

Takosumi does not publish, approve, or classify a Standard Form set. Takoform
owns exact FormRef/package identity, package publication, conformance material,
and the Proposal/Experimental/Stable/Legacy lifecycle. A hosted Form
implementation, exact availability, activation, target/adapter evidence,
principal audience, backend lifecycle, and provider credentials belong to
Takoserver or another external Host. Takosumi Hosted may present retail/client
composition but does not own managed supply. Takosumi OSS retains only generic contracts and migration
evidence; it does not own a Form Registry or hosted Form lifecycle.

Historical package/checkpoint artifacts are not a current Takosumi default or
authority merely because their bytes or reports still exist. The obsolete
Takosumi central-admission contract, evaluator, and tests are removed and must
not be recreated.

## Retained compatibility commands (historical)

The commands below remain useful for retained portable-host and package
evidence. They are historical compatibility checks, not a supported OSS
authoring flow, hosted availability claim, or release/GA gate:

```bash
bun run service-form:host-conformance -- \
  --endpoint https://takosumi.example.com \
  --space workspace_1 \
  --name example \
  --identity ./identity.json \
  --desired ./desired.json
```

The runner exercises the retained discovery, exact Form availability,
negative-fixture rejection, preview/apply and idempotent replay, read,
exact-digest substitution rejection, refresh/sync, optional import, delete,
and parity fixtures. It emits compatibility evidence; that evidence does not
promote Takoform lifecycle maturity, activate a Form, or create a current OSS
Form Host.

Takosumi also retains fixed executable fixtures used by that historical
conformance lane:

```bash
bun run service-form:runtime-artifacts:check
```

An optional `service-form:runtime-artifacts:oci-readback` verifies the pinned
external OCI manifest. Neither command builds or publishes a release, and
neither command proves hosted Cloud readiness.

## Historical publication proof

`service-form:published-package-host-proof` pins the last actually published
Legacy checkpoint, `forms/admissions/v1.0.7`. It reads nine reviewed kinds from
the immutable 34-entry package publication ledger and verifies exact retained
bytes, signatures, transparency evidence, install, replay, and service
reconstruction. It deliberately does not consume the historical Standard
admission set.

For this retained historical lane, production or hosted availability was
separate evidence: exact installed package readback, an executable
implementation and Adapter, active exact FormActivation, principal audience,
real backend lifecycle, retained reverification, backup/restore, and—where
applicable—an independent Offering and commercial binding. Current hosted
capacity, production deployment, billing, maturity, and GA evidence belong to
the owning external Host; repository conformance must not be represented as
any of them.
