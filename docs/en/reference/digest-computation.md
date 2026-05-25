# Digest Computation {#digest-computation}

Takosumi public Installer API uses two byte-stream digest fields.

| Field                                     | Input bytes                                            | Surface                         |
| ----------------------------------------- | ------------------------------------------------------ | ------------------------------- |
| `manifestDigest`                          | Raw `.takosumi.yml` bytes                              | dry-run, apply, Deployment      |
| `source.digest` / `expected.sourceDigest` | Prepared source payload bytes fetched by the Installer | prepared source dry-run / apply |

Git source identity is the resolved commit SHA. `local` source has no portable
source byte identity and uses only `manifestDigest` as the reviewed-source
guard.

Public digests use:

```text
digest = "sha256:" + lowercase_hex(SHA-256(input_bytes))
```

Build graph digests, cache keys, container image digests, and operator
Deployment record digests are operator records.

## Public Digest Rules {#public-digest-rules}

- The hash function is SHA-256.
- The string form is `sha256:` followed by 64 lowercase hex characters.
- The `sha256:` prefix is part of the compared value.
- Comparison is byte-for-byte string equality after validation.
- Input bytes are the exact file or archive payload bytes. YAML parse result,
  comments removal, key ordering, and line-ending normalization are not applied.

`manifestDigest` is computed over the selected raw `.takosumi.yml` bytes. The
file must decode as UTF-8 and must not contain duplicate YAML mapping keys, but
the digest is still computed over raw selected bytes.

For `source.kind: "prepared"`, `source.digest` is the caller-supplied digest of
the archive payload. The Installer fetches `source.url`, computes the digest of
the received bytes, and compares it with `source.digest`.

## Expected Guard {#expected-guard}

| Source kind | Required expected fields         |
| ----------- | -------------------------------- |
| `git`       | `manifestDigest`, `commit`       |
| `prepared`  | `manifestDigest`, `sourceDigest` |
| `local`     | `manifestDigest`                 |

Deploy apply also checks `expected.currentDeploymentId` against the current
Installation pointer reviewed by dry-run.

If a well-shaped guard does not match the resolved source, apply returns 409
`failed_precondition`. If a guard carries a field that does not apply to the
source kind, apply returns 400 `invalid_argument`.

## Related Pages {#related-pages}

- [Installer API](./installer-api.md)
- [Build Service Boundary](./build-spec.md)
