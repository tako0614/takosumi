# Tenant Lifecycle Design

This document records the design rationale for the v1 tenant lifecycle: how a Space is provisioned, how a trial Space differs from a paid Space, how a customer's data is exported, and how a Space is deleted. Wire-level shapes (request bodies, status fields, audit event payloads) live in the reference layer; this document explains the invariants the kernel keeps and the surfaces it intentionally leaves to operators.

## Tenant unit invariant

The v1 tenant unit is `Space`. A customer is one Space inside one Organization. The reasoning is:

- **`Space` is already the kernel's isolation primitive.** Namespace, secrets, journal, observation, approvals, and activation are all Space-scoped ([Space Model](./space-model.md)). Adding a parallel "tenant" concept on top of `Space` would create two boundaries that the kernel must keep aligned.
- **A larger "tenant" is allowed but operator-defined.** A customer that runs `prod`, `staging`, and `dev` as separate Spaces under one Organization is fully expressible. The kernel only enforces the per-Space invariants; the customer-shaped grouping is a property of the Organization and of operator policy, not of kernel state.
- **`1 Space = N tenants` is rejected.** Two contractual boundaries inside one Space would force the kernel to split per-Space state at apply time. The kernel never sees that split; the invariant stops at "one Space, one tenant."

A "tenant lifecycle" therefore means a `Space` lifecycle.

## Why provisioning is a closed seven-stage sequence

Tenant provisioning is decomposed into seven ordered stages, each idempotent and journaled:

```text
1. namespace-partition-allocate
2. secret-partition-init
3. quota-tier-apply
4. catalog-release-adopt
5. default-operator-account
6. audit-chain-genesis
7. observation-set-init
```

Design rationale:

- **Each stage targets one already-existing kernel substrate.** Step 1 belongs to the storage schema, step 2 to the secret partition, step 3 to the quota dimension table, step 4 to catalog adoption, and so on. Provisioning is the fan-in point that walks every Space-scoped substrate exactly once. This avoids inventing a new "tenant table" that lives parallel to the existing Space-scoped state.
- **Idempotent + journaled means recovery is free.** A retry resumes from the first uncompleted stage. A power loss between stages does not produce a half-Space; the next call reads the journaled completion record and continues.
- **Partial failure is not auto-cleaned.** If a stage fails permanently, the kernel rolls back completed stages in reverse order. If rollback itself fails, the Space is held in `operator-action-required` instead of being silently destroyed. The kernel does not assume that abandoning a half-built Space is safer than holding it for operator inspection: a partial provisioning may still hold customer data (audit chain genesis, secret partition).
- **`Idempotency-Key` is required.** This stops a retry on the client side from minting a second Space with a different id under the same intent.

The decomposition is closed in v1. A new stage requires a `CONVENTIONS.md` §6 RFC, because adding a stage changes the failure surface every operator already accounts for.

## Why trial Spaces are a separate lifecycle

A trial Space is not just "a Space with a low quota tier." It uses a separate lifecycle state machine: `active-trial`, `expiring-soon`, `frozen`, `cleaned-up`, `converted`. The reasoning is:

- **A commercial PaaS treats trials differently for incident scoping.** When operators triage an outage, they need to slice impact by paid customers vs. trial customers. Treating both through one lifecycle would either dilute paid-customer signals with trial noise or hold trial Spaces under paid-tier escalation paths.
- **Trials have an end date by construction.** `trialExpiresAt` is required for a trial Space. The state machine encodes the four observable outcomes — still active, approaching expiry, expired into a read-only grace, cleaned up — without operators having to invent a side-table.
- **Conversion preserves audit continuity.** A trial-to-paid conversion does not mint a new Space id. The audit chain, journal, observation set, and namespace registry stay attached to the same `space:<id>`. A customer that converts during a trial loses no data and produces no migration boundary.
- **Frozen grace is a kernel-side property.** The 24-hour read-only window after `trialExpiresAt` is not something operators implement on top of the kernel; it is part of the Space's own state machine. This stops two operators from disagreeing on what "expired" means.

`active-trial` and `converted` are the only customer-visible long-running states; `frozen` and `cleaned-up` are operator-visible terminals. The operator-driven extension path is explicit (`POST /api/internal/v1/spaces/:id/trial/extend`) so that "extend a trial" is a first-class action, not an ad-hoc field write.

## Data export and deletion: design constraints

Customers can export their Space data and delete their Space. The kernel exposes the primitives that make these compliant with right-to-erasure regimes (GDPR, regional equivalents). The constraints:

- **Two-phase delete (soft → hard).** Soft-delete is reversible inside a bounded window; hard-delete is terminal. Customer accidents and operator accidents both have a recovery path in the soft phase. Once hard-delete completes, the Space cannot be recovered, and the audit retention window starts.
- **Audit chain hash is preserved through redaction.** A hard-delete does not destroy the audit chain. Field-level redaction zeroes out PII while keeping the hash chain intact, so that downstream verifiers (compliance tools, legal review) still see an unbroken chain. A break in the chain would itself be a compliance signal that needs investigation; redaction must not produce that signal.
- **Retention regimes are kernel-aware.** `complianceRegime` on the Organization decides how long the redacted audit chain stays. The kernel does not pick the regime; the operator picks it at Organization create. The kernel guarantees only that whichever regime is set is enforced.
- **Export is a logical format, not a database dump.** A `data-portability` export produces a schema-versioned bundle that another Takosumi instance could import. This is the v1 data-portability contract. Future schema-breaking changes will land through versioned export; today's export will still be readable then.
- **Customer self-service deletion is in scope; admin escalation is not.** The kernel exposes the export and delete endpoints. The customer-facing UI, the legal-hold escalation, and the support-side cancel-deletion workflow live outside Takosumi.

## Tenant data portability rationale

A logical export format exists so that:

- a customer can leave one Takosumi installation and rejoin another without losing audit history;
- an operator can move a Space across kernels for capacity or compliance reasons;
- a future major migration has a stable input format that does not require database-level translation.

The export is **not** a backup substitute. Backups are for kernel-side recovery and follow [Backup and Restore](../reference/backup-restore.md). Exports are the customer-facing portability surface and are independent of operator backup policy.

## Boundary

The kernel ships:

- the seven-stage provisioning state machine and its idempotency / rollback rules;
- the trial Space attribute set and the five-state lifecycle, including frozen grace and operator-driven extension;
- the soft-delete / hard-delete two-phase deletion API and the field-level redaction that keeps audit hashes intact;
- the four export modes (`full`, `manifest-only`, `audit-only`, `data-portability`) and their schema-versioned format.

The kernel does not ship:

- the customer-facing signup form, the payment flow, the TOS acceptance UI;
- the customer-facing delete-my-account UI or the cancel-deletion workflow;
- admin escalation paths, legal-hold orchestration, or the regime-selection wizard;
- email templates, in-app banners, or the trial-conversion marketing surface.

These compose on top of the kernel primitives but are operator concerns.

## Related reference docs

- [Tenant Provisioning](../reference/tenant-provisioning.md)
- [Trial Spaces](../reference/trial-spaces.md)
- [Tenant Export and Deletion](../reference/tenant-export-deletion.md)
- [Compliance Retention](../reference/compliance-retention.md)
- [Storage Schema](../reference/storage-schema.md)
- [Backup and Restore](../reference/backup-restore.md)

## Cross-references

- [Space Model](./space-model.md)
- [Operator Boundaries](./operator-boundaries.md)
- [PaaS Provider Design](./paas-provider-design.md)
- [Identity and Access Design](./identity-and-access-design.md)
- [PaaS Operations Design](./paas-operations-design.md)
