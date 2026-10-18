# Prepare a repository

Takosumi adds an OpenTofu root module kept in Git. No Takosumi-specific configuration file is
needed. This page lists what to follow so that your software can be added from Takosumi.

While adding, Takosumi checks the repository. If it finds a problem, the add screen shows
**Needs manual changes** or **Cannot be added right now** and does not go further. In both
cases, fix the repository and add the new commit again.

## The smallest shape

```text
deploy/opentofu/
  main.tf        # resources and provider declarations
  variables.tf   # values the user enters (optional)
  outputs.tf     # at least one output
```

```hcl
# Excerpt from examples/opentofu-null-provider/main.tf (one file is fine too)
terraform {
  required_providers {
    null = {
      source  = "hashicorp/null"
      version = "~> 3.2"
    }
  }
}

variable "name" {
  type    = string
  default = "takosumi-null-provider"
}

resource "null_resource" "marker" {
  triggers = {
    name = var.name
  }
}

output "example_label" {
  value = null_resource.marker.triggers.name
}
```

- Write configuration in `.tf` or `.tofu` files. `.tf.json` cannot be added yet.
- Only files tracked by Git are read.
- Declare at least one `output`. Without any, the module cannot be added.
- Declare providers in `required_providers`. Without a `source`, a provider is taken to be
  `hashicorp/<name>`, so always set `source` for a provider outside `hashicorp/`, for example
  `cloudflare/cloudflare`.
- Keep credentials out of provider blocks. Attributes named `token`, `api_token`, `api_key`,
  `access_key`, `secret_key`, `client_secret`, or `password` are stopped even when set from a
  variable. Other names are not checked, but keep them out too. Credentials reach the run from a
  connection (Connection), as environment variables or files
  ([Credentials](../concepts/credentials.md)).
- Working examples are
  [`examples/opentofu-basic`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-basic)
  (no provider) and
  [`examples/opentofu-null-provider`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-null-provider)
  (the smallest example with one provider).

## What stops a module from being added

By default Takosumi reads the whole repository. In the add link, `path` is the directory of the
module to add, and `sourcePath` (the Source's `defaultPath`) is the part of the repository that is
read ([Sources and Capsules](../concepts/sources.md)).

### Problems that stop every module in the part that is read

If any of these appears anywhere in the part that is read, no module in it can be added. When
test or example modules live in the same repository, narrow what is read to your module's
directory with `sourcePath`.

| What you wrote | How to fix it |
| --- | --- |
| A remote module source, such as a registry address or `git::` | Copy the module into the repository and refer to it with a path starting with `./`. Remote sources are rejected even when the version is pinned |
| A `../` module source that leaves the selected module's directory | Put the module inside the selected module's directory |
| A module source that is not a plain string, or one that points to a missing directory | Write `source` as a string such as `"./modules/app"` and commit that directory |
| Conflicting exact versions of the same provider | Use the same version in every module |
| An unreadable JSON configuration file, or files over the count or size limits | Fix it, or narrow what is read (see "Size limits" below) |

### Problems that stop only that module

| What you wrote | How to fix it |
| --- | --- |
| A `.tf.json` configuration file | Write the same thing in HCL (`.tf`) |
| Resources but no `required_providers` | Declare the providers in `required_providers` |
| A provisioner (`local-exec`, `remote-exec`, `file`) | Remove it. It works only if the people who run Takosumi allow it |
| The `external` data source | Remove it. It works only if the people who run Takosumi allow it |
| A provider, resource, or data source the people who run Takosumi do not allow | Use an allowed one, or ask them |
| `path.root`, `abspath()`, or `pathexpand()` | Use a file inside the module or a variable instead. Even a mention in a comment stops it |
| A string path passed to `file()`, `templatefile()`, and the like that starts with `/` or `~` or contains `..` | Read files inside the module with a relative path, or pass them in a variable |
| An `ephemeral` root output, or `sensitive` set to anything other than `true`/`false` | Write `sensitive` and `ephemeral` as the literal `true` or `false` |
| A root variable declared twice, or a variable that only an override file declares | Declare each variable once, and change only declared variables in override files |
| A committed `.terraform.lock.hcl` whose providers do not match the module's | Delete the lock, or recreate it with `tofu init` and commit it |

A tracked symbolic link or Git submodule makes fetching the repository fail, before the add
screen. Commit the actual files instead.

## Variables and outputs

- A variable without a `default` must be filled in when adding. `default = null` makes it
  optional.
- `string`, `number`, and `bool` are entered as they are. Everything else, including `list`,
  `map`, `object`, and variables without a `type`, is entered as a JSON value.
- `sensitive = true` on a variable does not make the input secret. Mark secret inputs with
  `inputs[].secret` in the [Repository manifest](../reference/repository-manifest.md).
- Outputs that are not `sensitive` are recorded in the Workspace whatever their names (up to 128
  outputs, 64 KiB each, 256 KiB in total; anything beyond is not recorded).
- Only outputs you map explicitly are published outside the Workspace. Even when mapped, an output
  is not published if its name contains a part such as `token`, `secret`, `password`, `key`,
  `auth`, or `session`, separated by `_` or `-` (for example `public_key` or `auth_url`), or if
  its value looks secret ([State and outputs](../concepts/state-and-outputs.md)).

## What you can leave out

- `.well-known/takosumi.json` ([Repository manifest](../reference/repository-manifest.md)) is
  optional. Add it only when you want input descriptions, secret inputs, Interfaces, and so on.
- `.terraform.lock.hcl` is optional. Without one, it is created during the check and pinned by
  the review (plan). If you commit one, commit a file that OpenTofu (`tofu init`) created and
  that matches the module's providers.

## Size limits

| What | Limit |
| --- | --- |
| Configuration files | 256 files, 1 MiB each, 4 MiB in total |
| Root modules found | 32 |
| Path depth | 64 parts, including the file name |
| The part of the repository fetched (archive) | 50 MiB by default (the people who run Takosumi can change it) |

## OpenTofu version

The standard runner uses OpenTofu 1.12.5. If `required_version` does not include it, the check
fails and the add screen says "The pre-add check couldn't finish." The screen suggests trying
again, but for this cause every retry gives the same result, so check `required_version`.
