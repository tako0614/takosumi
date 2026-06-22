# Takosumi

Takosumi is an OpenTofu/Terraform control plane. In Takosumi Cloud, you add a
service from the browser, connect the cloud account it needs, review the planned
changes, and deploy to your own cloud. The OSS edition uses the same model for
self-hosting.

## What You Do First

```text
1. Choose a service or paste a Git URL
2. Connect the required cloud account
3. Review the resources that will be created or updated
4. Approve the deploy
5. Inspect the URL, history, state, outputs, and activity
```

Start with the [Quickstart](./getting-started/quickstart.md).

## Cloud and OSS

```text
Takosumi OSS:
  Run existing Terraform/OpenTofu providers as-is.

Takosumi Cloud:
  closed official hosted Takosumi for Operators
  + Cloud-only compatibility gateways
  + Cloud-only managed resources.
```

The most important boundary:

```text
OSS runs existing providers.
Only Cloud has compatibility gateways and managed resources.
```

## Product Words

The normal Takosumi Cloud UI does not lead with internal control-plane nouns.

| UI word | Meaning |
| --- | --- |
| Service | The app, worker, API, site, or storage you host |
| Connection | The Cloudflare / AWS / GCP account Takosumi can use |
| Changes | The plan / resource summary you review before deploy |
| History | Who changed what and when |
| Restore point | A state version you can recover from |

Technical details are still available in the [Model reference](./reference/model.md).

## What Takosumi Manages

```text
add a service or Git repo
check required connections
inject env/files only for the Run
run OpenTofu/Terraform against existing providers
review and approve apply
store state, outputs, run history, and audit
```

The core value is:

```text
Same manifest, different connection.
```

## What OSS Does Not Do

```text
Cloudflare compatibility API
AWS/GCP compatibility API
S3 gateway
managed edge
managed container
managed storage
official billing/quota/usage
official cloud backend
```

## Next Documents

- [Quickstart](./getting-started/quickstart.md)
- [Model reference](./reference/model.md)
- [CLI reference](./reference/cli.md)
