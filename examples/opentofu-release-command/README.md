# OpenTofu Release Command Sample

This Capsule has no provider and no remote resources. It exists to prove the
generic post-apply activation boundary:

```text
OpenTofu output takosumi_release.post_apply
  -> Takosumi release activator
  -> restored source snapshot command
```

Takosumi must treat the command as an opaque argv array. Database migrations,
artifact uploads, and app initialization remain app/operator code.

Set `release_executor = "operator"` when proving the hosted/operator release
activator webhook. The OpenTofu shape stays the same; only the executor that
runs the opaque post-apply argv changes.

Local check:

```bash
tofu init -input=false
tofu apply -auto-approve -input=false
tofu output -json
```
