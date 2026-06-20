# OpenTofu Capsule Sample

This directory is a plain OpenTofu Capsule example. Install it through the standard Takosumi dashboard flow by linking a
Git URL into `/install?git=...`, or use `takosumi deploy <dir>` only as a local-upload helper before pushing the Capsule
to Git.

Standard product entry:

```text
https://app.takosumi.com/install?git=https://git.example.com/example/opentofu-basic.git&ref=main&path=.
```

The dashboard pre-fills `/new`, runs compatibility review, asks for Provider Connection choices, and creates the plan/apply
Runs through `/api/v1/*`.

Advanced local upload:

```bash
takosumi deploy . --space @me --name opentofu-basic --provider cloudflare=conn_cf
```
