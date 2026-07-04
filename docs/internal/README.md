# Internal Takosumi Notes

This directory contains Takosumi development authority documents, architecture
notes, and conformance notes. They are intentionally excluded from the
published VitePress docs.

Decision: keep Takosumi-specific development notes in this product-local
`docs/internal/` directory, not in the ecosystem root. The root repository
should only carry cross-product governance, quality gates, and integration
references.

Keep Takosumi-specific development notes here instead of moving them to the
ecosystem root. The root `docs/` directory is for cross-product indexes,
quality gates, and ecosystem reference material, not Takosumi's product-local
planning backlog.

Public docs, internal notes, and operator runbooks have different jobs:

```text
docs/
  Public product docs and API references for users/operators.

docs/internal/
  Product direction, implementation specs, architecture decisions, conformance
  notes, and temporary planning material.

docs/operations/
  Operator runbooks and operational procedures.
```

The public docs build excludes `internal/**/*.md` and `operations/**/*.md`.
When an internal design becomes a stable user/operator contract, rewrite the
contract into `docs/reference/` or `docs/cloud/` instead of linking readers to
the internal note.

Do not copy operator-private paths, secret file paths, private evidence refs,
Stripe sync routes, price-book env, or closed handler wiring into public docs.
Public docs may describe the external contract and fail-closed behavior; the
implementation procedure belongs in `docs/operations/` or private operator
evidence.

Use public docs for external product and API contracts:

```text
../index.md
../reference/api.md
../reference/model.md
../cloud/index.md
```

Use this directory for implementation planning, architecture decisions, and
agent-facing truth sources:

```text
final-plan.md
core-spec.md
core-conformance.md
ai-gateway.md
provider-compat-opentofu-architecture.md
```
