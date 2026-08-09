# Internal Takosumi notes

`docs/internal/` contains product-local authority notes and migration evidence.
It is excluded from the published VitePress surface. The current OSS contract
is [Core Spec](./core-spec.md); historical plans and decision records must link
back to it and must not redefine supported routes or ownership.

Use these locations for the corresponding kind of material:

```text
docs/                 published product/API docs
docs/internal/        current contract, conformance, and historical decisions
docs/operations/       operator procedures and migration runbooks
app-docs/              hosted Takosumi Cloud service documentation
```

The public build excludes `internal/**/*.md` and `operations/**/*.md`. When a
contract becomes user-facing, copy only the stable external behavior into
`docs/reference/` or `app-docs/`; do not expose private paths, credentials,
evidence files, or closed Cloud implementation details.

Current authority order for this product is:

1. repository source and the nearest `AGENTS.md`;
2. this repo's [Core Spec](./core-spec.md);
3. public reference docs and operator runbooks for their respective surfaces.

`final-plan.md`, `service-form-host-offering-separation.md`, and other older
notes are retained as explicitly superseded records. They cannot override Core
Spec or reintroduce a Takosumi OSS Form Host.
