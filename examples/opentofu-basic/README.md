# OpenTofu Capsule Sample

This directory is a plain OpenTofu Capsule example. It intentionally has no
provider block and no remote resources, so Takosumi can prove generic
plan/apply/destroy, state capture, and output projection without any cloud API
keys.

Install it through the standard Takosumi dashboard flow by linking a Git URL
into `/install?git=...`, or use `takosumi deploy <dir>` only as a local-upload
helper before pushing the Capsule to Git.

Standard product entry:

```text
https://app.takosumi.com/install?git=https://git.example.com/example/opentofu-basic.git&ref=main&path=.
```

The dashboard pre-fills `/new`, runs compatibility review, asks for Provider Connection choices, and creates the plan/apply
Runs through `/api/v1/*`.

Advanced local upload:

```bash
takosumi deploy . --space @me --name opentofu-basic
```

Local OpenTofu check:

```bash
tofu init -input=false
tofu plan -input=false -out=tfplan
tofu apply -input=false tfplan
tofu output -json
tofu plan -destroy -input=false -out=tfdestroy
tofu apply -input=false tfdestroy
```
