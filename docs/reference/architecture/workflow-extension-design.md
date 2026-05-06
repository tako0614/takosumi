# Workflow Placement Rationale

This document records why **Takosumi has no workflow vocabulary in the kernel**
and where workflow / cron / hook concerns live instead. Workflow-style
automation — scheduled jobs, build pipelines, deployment hooks,
external-event-driven runs — is owned by **`takosumi-git`**, a sibling product
of `takosumi` that sits above the kernel and submits manifests to it. The kernel
itself is a pure manifest deploy engine: it accepts a closed `Manifest` envelope
at `POST /v1/deployments`, resolves the resource DAG, and applies it. Upstream
clients may attach opaque deploy provenance for audit, but that provenance is
not a workflow execution contract.

> **Policy change note.** Earlier drafts of this document reserved four kernel
> primitives (trigger, `execute-step` operation kind, declarable hook extension
> point, trigger ↔ resource binding) for future workflow integration. That
> reservation has been **withdrawn**. The kernel ships no workflow primitive at
> all; everything workflow-shaped lives above the `POST /v1/deployments`
> boundary in `takosumi-git`. The reference docs written for the reserved
> primitives (`triggers.md`, `execute-step-operation.md`, `declarable-hooks.md`)
> have been removed along with the `compute.<name>.build.fromWorkflow` validator
> and the `resource.workflow@v1` kernel-known shape.

The doc is design-layer only.

## 1. Why kernel-side workflow primitive is not built-in

Takosumi has always positioned the kernel as a thin curation layer. The 5
curated shapes (`object-store`, `web-service`, `database-postgres`,
`custom-domain`, `worker`) are kernel-owned because they correspond to PaaS
primitives that any `Space` operator must reason about. Workflow / cron / hook
surfaces do not belong in this set. The reasoning:

- **Kernel thinness.** Embedding a GitHub Actions / GitLab CI style execution
  graph inside the kernel forces the kernel to model job DAG, matrix, retry, and
  concurrency semantics on top of the existing apply DAG. That is a second
  scheduler living inside the same `WriteAheadOperationJournal`. Two DAGs
  sharing one journal is a structural overload of the WAL stage enum and an
  obstacle to evolving either side.
- **Curation neutrality.** The catalog is intentionally small and middle-of-
  the-road. A built-in `workflow` shape would either be too opinionated for the
  long tail of CI / cron / lifecycle use cases or too generic to ship without
  becoming yet another DAG language.
- **Plugin freedom.** A plugin can model "cron job", "single-step build",
  "multi-step pipeline", "post-activate notification", and so on at exactly the
  level of detail its users need. Forcing all of them through one kernel-owned
  abstraction is more restrictive than the v1 plugin model already accepts.
- **Cyclical dependency risk.** Workflow features tend to be expressed as
  "deploy + run hook + observe + redeploy". Encoding that loop into a kernel
  primitive would deploy-bind the lifecycle and make `OperationPlan` ordering
  impossible to reason about in isolation.

## 2. Workflow lives in `takosumi-git`

Workflow concerns are entirely outside the kernel. They are implemented by
**`takosumi-git`**, a sibling product that:

1. Watches git (push / PR / tag) or receives webhook events.
2. Runs the build pipeline (image build, artifact upload).
3. Generates a `Manifest` with resolved artifact URIs.
4. Submits the manifest to the kernel via `POST /v1/deployments`.
5. Manages manifest version history — the git history of the manifest file is
   the authoritative version history. The kernel does not store a parallel
   "manifest version" concept.

Project-local files used by `takosumi-git` (workflow definitions, the
`.takosumi/` directory layout, `manifest.yml`, and similar inputs) live in the
project repository and are parsed by `takosumi-git`, never by the kernel. The
kernel CLI does not auto-discover any of these paths either; `takosumi deploy`
takes an explicit manifest path and posts the body to `POST /v1/deployments`.
The kernel's only repository-level input is the `Manifest` body submitted over
HTTP, plus optional opaque provenance supplied by the caller for audit.

The kernel therefore never interprets git, never schedules anything, never runs
workflow steps, and never holds workflow state. It can persist the caller's
opaque provenance JSON in WAL entries so operators can trace an artifact back to
the upstream workflow run without making the kernel own that workflow.

## 3. Git decoupling invariants

The kernel keeps git-agnostic invariants regardless of how `takosumi-git` (or
any other client) drives it.

- The kernel data model has no first-class `commit`, `branch`, `ref`, or `repo`
  field. Such values may appear only inside opaque deploy provenance supplied by
  an upstream client.
- `external-event` payloads, when surfaced on the kernel API, are opaque to the
  kernel. The kernel verifies the HMAC-SHA256 signature, attaches the payload as
  audit data, and refuses to parse it.
- HMAC-SHA256 verification is kernel-enforced, not optional. An unsigned
  external event is rejected before any `OperationPlan` is constructed.
- The `source-archive` DataAsset kind continues to be git-agnostic. Its optional
  `metadata.gitCommit` field is audit annotation only and does not flow into any
  kernel decision.

## 4. No kernel-known "workflow" shape

A kernel-aware workflow shape (e.g. `resource-workflow-v1`) is **not** provided.
Operators who want to provision a vendor workflow service (Cloudflare Workflows,
Temporal, Argo, etc.) do so through provider-local shapes whose IDs are owned by
the plugin, not by the kernel catalog. This preserves:

- Curation neutrality — the curated 5-shape catalog stays focused on PaaS
  primitives.
- Image-first consistency — no `build` / `pipeline` vocabulary leaks into
  kernel-known shapes.
- Plugin freedom — each provider chooses its own surface for any
  workflow-as-resource modelling.

## 5. Structural alternatives considered and rejected

- **Embed workflow as a built-in shape.** Rejected on curation neutrality and to
  preserve kernel thinness (§1).
- **Reserve kernel primitives for future workflow integration** (trigger /
  `execute-step` / declarable hook / trigger ↔ resource binding). Initially
  recorded as the "reserved contract" in earlier revisions of this doc;
  subsequently rejected. Any such primitive forces the kernel to model a second
  scheduler. `takosumi-git` owns that concern at the product layer instead.
- **Introduce a separate manifest kind for workflows.** Rejected: `takosumi-git`
  generates regular `kind: Manifest` documents; no envelope split is needed.
- **Allow `compute.<name>.build.fromWorkflow` references inside manifest spec.**
  Rejected as it forces the kernel to know about workflow file paths and build
  artifacts. This concept is removed from the manifest spec; `takosumi-git`
  resolves artifact URIs before submitting the manifest.

## 6. Boundary

```text
inside Takosumi kernel       Manifest envelope (apiVersion / kind / metadata / template / resources)
                             Opaque deploy provenance persistence
                             Resource DAG resolution and apply
                             WAL idempotency, rollback, observation
                             Curated 5-shape catalog
                             Provider plugin host
                             HMAC-SHA256 enforcement on external events (if any)

inside takosumi-git          Git push / PR / tag watching
                             Webhook receivers
                             Workflow / build / pipeline execution
                             Artifact build and URI resolution
                             Manifest generation from workflow output
                             POST /v1/deployments client
                             Manifest version history (git-backed)
                             Project-local files under .takosumi/

outside both                 UI for workflow authoring (downstream tools)
                             Operator dashboards / audit consumers
                             Cross-product orchestration
```

## Related reference docs

- [Manifest Model](./manifest-model.md)
- [Operation Plan / Write-Ahead Journal Model](./operation-plan-write-ahead-journal-model.md)
- [PaaS Provider Architecture](./paas-provider-architecture.md)
- [Data Asset Model](./data-asset-model.md)
- [Templates](/reference/templates)
