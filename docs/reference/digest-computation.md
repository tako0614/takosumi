# Digest Computation {#digest-computation}

Takosumi public Installer API uses two byte-stream digest fields:

| Field                                     | Input bytes                                   | Surface                         |
| ----------------------------------------- | --------------------------------------------- | ------------------------------- |
| `manifestDigest`                          | raw `.takosumi.yml` file bytes                | dry-run / apply / Deployment    |
| `source.digest` / `expected.sourceDigest` | fetched prepared source archive payload bytes | prepared source dry-run / apply |

Git source identity is the resolved commit SHA. It is a source identity, not a
Takosumi digest field. `local` source has no portable source byte identity; it
uses only `manifestDigest` as the reviewed-source guard.

Build graph digests, build cache keys, container image digests, DataAsset blob
digests, and retained implementation/operator evidence digests are separate
operator or implementation records.

## Public Byte Digests {#public-byte-digests}

Takosumi v1 public byte digests use SHA-256:

```text
digest = "sha256:" + lowercase_hex(SHA-256(input_bytes))
```

Rules:

- The hash function is SHA-256.
- The string form is `sha256:` followed by 64 lowercase hex characters.
- The `sha256:` prefix is part of the compared value.
- Comparison is byte-for-byte string equality after validation. Implementations
  do not normalize case at comparison time.
- The input bytes are the exact file or archive payload bytes. YAML parse
  result, JSON canonical form, comments removal, key ordering, and line-ending
  normalization are not applied.

### `manifestDigest` {#manifestdigest}

`manifestDigest` is the SHA-256 digest of the `.takosumi.yml` bytes selected
from the resolved source root. Line endings, comments, whitespace, and YAML key
order participate in the digest.

The selected `.takosumi.yml` bytes must decode as UTF-8 before YAML parsing.
Invalid UTF-8 is rejected before AppSpec validation. Duplicate YAML mapping keys
are invalid. These parse rules do not change `manifestDigest`: the digest is
still computed over the raw selected bytes, not over decoded text or parsed
YAML.

`manifestDigest` guards the AppSpec bytes reviewed by dry-run. It does not guard
the entire source tree for `local` source.

### Prepared Source Digest {#sourcedigest}

For `source.kind: "prepared"`, `source.digest` is the caller-supplied digest of
the archive payload bytes. The Installer API fetches `source.url`, computes the
digest of the bytes it actually received, and compares that value with
`source.digest`.

Dry-run and apply responses use `expected.sourceDigest` as the reviewed-source
guard for the same resolved prepared source identity. `expected.sourceDigest`
does not replace `source.digest`; apply checks both when both are present.

### Expected Guard {#expected-guard}

`expected` binds apply to the source reviewed by dry-run:

| Source kind | Required expected fields         |
| ----------- | -------------------------------- |
| `git`       | `manifestDigest`, `commit`       |
| `prepared`  | `manifestDigest`, `sourceDigest` |
| `local`     | `manifestDigest`                 |

If a well-shaped guard does not match the resolved source, apply returns 409
`failed_precondition`. If a guard carries a field that does not apply to the
source kind, apply returns 400 `invalid_argument`.

## Reference Evidence Digests {#reference-evidence-digests}

Reference implementations can persist additional structured digests for replay,
approval, audit, rollout, and provider-operation recovery. Those names,
canonicalization rules, and input fields belong to the implementation or
operator ledger that defines the retained evidence records. They are not public
Installer API fields.

## DataAsset Digest {#dataasset-digest}

DataAsset is an optional operator extension for content-addressed blobs. The
current reference DataAsset extension uses a byte-stream digest of the blob
bytes and stores metadata such as `kind`, `contentTypeHint`, and retention
policy separately. This digest is extension evidence, not an Installer API
source identity.

## Algorithm Migration {#algorithm-migration}

Takosumi v1 uses only `sha256:` digests for the public Installer API. If a
future spec adopts another algorithm, the prefix, verifier, docs, tests, and
public wire validation must change in the same compatibility update.

## Related Pages {#related-pages}

- [Installer API](./installer-api.md)
- [Build service handoff](./build-spec.md)
- [DataAsset Policy](./data-asset-policy.md)
- [Resource IDs](./resource-ids.md)
