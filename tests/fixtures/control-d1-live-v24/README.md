# Control D1 live v24 schema fixtures

These files are schema-only exports captured read-only on 2026-07-16. They
contain no table rows, database identifiers, account identifiers, or secret
values. They preserve the physical SQLite definitions needed to prove that the
candidate schema converges even when two databases have the same v1..v24
ledger but different historical DDL shapes.

| Environment class | File                    | Source SHA-256                                                   |
| ----------------- | ----------------------- | ---------------------------------------------------------------- |
| staging           | `staging-schema.sql`    | `1fa2455c3d880f99f727be07404190439a5588e492116df8c4dff6fd64e5c86e` |
| production        | `production-schema.sql` | `76b930c0fde893d49ef9b9bf2738f9882103d5de0da18f134593e52f2f349848` |

The test seeds synthetic rows only after loading the export, applies the
reviewed candidate plan under the durable fence, and proves physical schema,
index, constraint, row, and fence convergence. The production-only retired
Cloud tables remain in this historical fixture so the Cloud candidate cleanup
can attest their row counts and digests before dropping them. The legacy
database itself is never released or modified beyond its permanent fence.
