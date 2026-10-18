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
- Declare each provider in `required_providers` with a `source`. A provider outside
  `hashicorp/` without a `source` is treated as a different provider.
- Keep credentials out of provider blocks. Attributes named `token`, `api_token`, `api_key`,
  `access_key`, `secret_key`, `client_secret`, or `password` are stopped even when set from a
  variable. Credentials reach the run from a connection (Connection), as environment variables
  or files ([Credentials](../concepts/credentials.md)).
- Working examples are
  [`examples/opentofu-basic`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-basic)
  (no provider) and
  [`examples/opentofu-null-provider`](https://github.com/tako0614/takosumi/tree/main/examples/opentofu-null-provider)
  (the smallest example with one provider).

## What stops a module from being added

| What you wrote | How to fix it |
| --- | --- |
| A remote module source, such as a registry address or `git::` | Copy the module into the repository and refer to it with a path starting with `./`. Remote sources are rejected even when the version is pinned |
| A `../` module source that leaves the selected module's directory | Put the module inside the selected module's directory |
| A `.tf.json` configuration file | Write the same thing in HCL (`.tf`) |
| A provisioner (`local-exec`, `remote-exec`, `file`) | Remove it. It works only if the people who run Takosumi allow it |
| The `external` data source | Remove it. It works only if the people who run Takosumi allow it |
| `path.root`, `abspath()`, `pathexpand()`, or reading a file whose path starts with `/` or `~` or contains `..` | Use a file inside the module, or pass it in a variable |
| An `ephemeral` root output, or `sensitive` set to anything other than `true`/`false` | Write `sensitive` and `ephemeral` as the literal `true` or `false` |
| A tracked symbolic link or Git submodule | Commit the actual files instead |

If the part of the repository Takosumi reads contains even one `.tf` file with such a problem,
no module in that part can be added. By default Takosumi reads the whole repository. When test
or example modules live in the same repository, narrow what it reads to your module's directory
with `sourcePath` in the add link (the Source's `defaultPath`;
[Sources and Capsules](../concepts/sources.md)).

## Variables and outputs

- A variable without a `default` must be filled in when adding. `default = null` makes it
  optional.
- `string`, `number`, and `bool` are entered as they are; `list`, `map`, `object`, and the like
  are entered as JSON values.
- `sensitive = true` on a variable does not make the input secret. Mark secret inputs with
  `inputs[].secret` in the [Repository manifest](../reference/repository-manifest.md).
- Outputs that are not `sensitive` are recorded in the Workspace. An output is not published if
  its name contains a part such as `token`, `secret`, `password`, `key`, `auth`, or `session`,
  separated by `_` or `-` (for example `public_key` or `auth_url`), or if its value looks
  secret ([State and outputs](../concepts/state-and-outputs.md)).

## What you can leave out

- `.well-known/takosumi.json` ([Repository manifest](../reference/repository-manifest.md)) is
  optional. Add it only when you want input descriptions, secret inputs, Interfaces, and so on.
- `.terraform.lock.hcl` is optional. Without one, it is created during the check and pinned by
  the review (plan). If you commit one, commit the file OpenTofu (`tofu init`) created.

## Size limits

| What | Limit |
| --- | --- |
| Configuration files | 256 files, 1 MiB each, 4 MiB in total |
| Root modules found | 32 |
| Directory depth | 64 levels |
| The part of the repository fetched (archive) | 50 MiB by default (the people who run Takosumi can change it) |

## OpenTofu version

The standard runner uses OpenTofu 1.12.5. If `required_version` does not include it, the check
fails and the add screen says "The pre-add check couldn't finish." Trying again gives the same
result, so check `required_version`.
