# Internal Takosumi notes

Status: internal memo. This material is not customer-facing product docs; it
guides product-local implementation, conformance, and historical review.

`docs/internal/` contains product-local authority notes and migration evidence.
It is excluded from the published VitePress surface. The active product
destination and definition of done is [Product Goal](./product-goal.md); the
current OSS contract is [Core Spec](./core-spec.md), and adoption evidence is
[Core Conformance](./core-conformance.md). Historical plans and decision
records must link back to Core Spec and must not redefine supported routes or
ownership.

Use these locations for the corresponding kind of material:

```text
docs/                 published product/API docs
docs/internal/        current contract, conformance, and historical decisions
docs/operations/       operator procedures and migration runbooks
app-docs/              hosted Takosumi hosted service service documentation
```

Internal navigation:

- [Product Goal](./product-goal.md) — active destination and measurable
  definition of done; not a contract or roadmap/backlog.
- [Core Spec](./core-spec.md) — current OSS contract and ownership authority.
- [Core Conformance](./core-conformance.md) — evidence against Core Spec.
- [Generalization audit](./generalization-audit.md) — allowed specialization
  and boundary checks.
- [AI Gateway boundary](./ai-gateway.md) — generic OSS extension seam; hosted
  behavior belongs to Takosumi hosted service.

The public build excludes `internal/**/*.md` and `operations/**/*.md`. When a
contract becomes user-facing, copy only the stable external behavior into
`docs/reference/` or `app-docs/`; do not expose private paths, credentials,
evidence files, or closed Cloud implementation details.

Promotion checklist: keep only stable external behavior, remove private paths,
credentials, evidence references, and closed implementation details, update any
English counterpart, and run the docs-boundary and docs-build checks before
moving material into a published surface.

Current authority order for this product is:

1. repository source and the nearest `AGENTS.md`;
2. this repo's [Core Spec](./core-spec.md);
3. public reference docs and operator runbooks for their respective surfaces.

The [Product Goal](./product-goal.md) describes the destination and evidence
layers but does not override that order. [Core Conformance](./core-conformance.md)
records what is proven and what remains partial; it is not a roadmap or a
permission to promote a historical surface.

`final-plan.md`, `service-form-host-offering-separation.md`, and other older
notes are retained as explicitly superseded records. They cannot override Core
Spec or reintroduce a Takosumi OSS Form Host.
