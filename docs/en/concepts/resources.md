# Resources

A Resource is a typed service you can create without writing an OpenTofu module. You
declare what you want, and Takosumi resolves where to create it and on which
implementation.

The entrance differs from the Stack flow, where you run a module of your own, but the
Run ledger, the state management, and the audit record are the same.

## The available types depend on the endpoint

Takosumi core accepts no Resource kinds by default. Whoever operates an endpoint
explicitly introduces the types it can handle, then chooses which of those may be created
and changed.

That means **different endpoints offer different types**. There are two ways to check.

```bash
curl -s https://takosumi.example.com/.well-known/takosumi

takosumi form-availability list --space prod
```

If a type that has already been introduced is later closed to writes, existing Resources
of that type can still be read, diffed, and deleted.

## What a declaration looks like

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "ObjectBucket",
  "metadata": {
    "name": "assets",
    "space": "prod"
  },
  "spec": {
    "name": "assets",
    "storageClass": "standard"
  }
}
```

`spec` is the state you want; `status` is the state Takosumi observed. You do not write
`status` yourself. The name in the path, `metadata.name`, and `spec.name` have to agree,
and a mismatch comes back as a `400` that says where the disagreement is.

## Applying takes two steps

```bash
takosumi resources preview --file bucket.json
takosumi resources apply ObjectBucket assets --file bucket.json --yes
```

`apply` always runs `preview` internally first, so what was displayed and what gets
applied are the same thing. Run it without `--yes` and it prints the contents and **stops
with exit code 2**. The two steps — look, then add the flag — are deliberate.

## Preview selects the target and implementation

```text
the Resource declaration
  → is the type usable (introduced, writable)
  → select one target and implementation
  → record that selection
  → create the real thing
  → publish state and Outputs
```

Once selected, the target and implementation are recorded. Later diffs and refreshes
**use that same target and implementation**, so behavior does not change under you unless
you explicitly request a change. The [API reference](../reference/api.md) documents the
record names used on the wire.

## Reading state

```bash
takosumi resources get ObjectBucket assets --space prod
takosumi resources list --space prod
takosumi resources events ObjectBucket assets --space prod
```

Events come back newest first, and stay readable as audit history after the Resource is
deleted. An event never contains credentials, raw errors, the spec, the state, or Output
values.

The dashboard does not list arbitrary Output values either. It makes a value clickable
only when the exact Resource kind and Output name are explicitly allowlisted as a public
navigation surface, and the value validates as an HTTPS URL without credentials, a query,
or a fragment. The same Output name on another kind, an arbitrary `public_url`, or a
secret-looking Output does not become a link.

Listing is keyset-based on `createdAt` and id. Every page but the last returns a
`nextCursor`; pass it straight to the next `--cursor` without interpreting it. The default
page size is 100, and so is the maximum.

## Observing and refreshing

```bash
takosumi resources observe ObjectBucket assets --space prod
takosumi resources refresh ObjectBucket assets --space prod
```

`observe` is a read-only diff. A difference it finds is not applied automatically.
`refresh` changes nothing outside; it updates the state and Outputs on the Takosumi side
and, when it succeeds, re-resolves the versions of related Interfaces.

An endpoint with active types observes its Ready Resources periodically, oldest first.
That too is read-only, and if an apply or a delete moved things on while an observation
was in flight, the stale result does not overwrite the state. The frequency and the
concurrency are set by whoever operates the endpoint.

## Taking over something that already exists

```bash
takosumi resources import ObjectBucket assets --file import.json
```

The file holds the usual declaration plus a top-level `nativeId`. `nativeId` is the
identifier the provider assigned; it **is not a credential**. Do not put a secret there.

An import is applied only when the plan contains exactly one import and no creations,
updates, or deletions.

## How the Takoform host API relates

When enabled, Takosumi's Takoform host API is the portable entrance to this machinery.
It translates Takoform Forms and Resource requests onto the canonical Resource lifecycle
and uses the same ledger. There is no Takosumi-specific Terraform provider and no second
state store.

## Related

- [Interfaces](./interfaces.md)
- [Run model](./run-model.md)
