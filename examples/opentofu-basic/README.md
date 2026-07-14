# OpenTofu Capsule Sample

This directory is a plain OpenTofu Capsule example. It intentionally has no
provider block and no remote resources, so Takosumi can prove generic
plan/apply/destroy, state capture, and output projection without any cloud API
keys. `example_label` and `example_endpoint` are ordinary module outputs; the
smoke command maps those exact names explicitly and they are not reserved by
Takosumi.

Install it through the standard Takosumi dashboard flow by linking a Git URL
into `/install?git=...`. The dashboard pre-fills `/new`; the Capsule source is
the Git URL / ref / module path, not a local upload.

Example operator entry (replace the origin and Git URL with the values selected
by that operator/user):

```text
https://takosumi.example.com/install?git=https://git.example.com/example/opentofu-basic.git&ref=v1.0.0&path=.
```

The dashboard pre-fills `/new`, runs compatibility review, asks for Provider
Connection choices, and creates the plan/apply Runs through `/api/v1/*`.

Local OpenTofu check:

```bash
tofu init -input=false
tofu plan -input=false -out=tfplan
tofu apply -input=false tfplan
tofu output -json
tofu plan -destroy -input=false -out=tfdestroy
tofu apply -input=false tfdestroy
```
