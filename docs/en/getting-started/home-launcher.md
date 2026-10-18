# Show your app on the home screen

If your software has a screen people open (a web app), you can put a tile that opens it on the
dashboard home (**Your apps**). **Open service** at the end of adding then opens that screen in a
new tab too. You declare it in the repository's `.well-known/takosumi.json`
([Repository manifest](../reference/repository-manifest.md)).

A service without this declaration does not appear on the home screen. It is listed only under
**Workloads**.

## What you need

1. An OpenTofu `output` that returns the screen's URL
2. A `.well-known/takosumi.json` that points at that `output`

### 1. An output with the screen's URL

```hcl
variable "hostname" {
  type    = string
  default = "notes.example.com"
}

output "launch_url" {
  description = "URL of the screen people open"
  value       = "https://${var.hostname}"
}
```

This example builds the URL from a variable's default. In practice, build it from the address of
a resource the module creates (a published Worker, a server, and so on). If you use a variable
without a default, declare it under `inputs` in `.well-known/takosumi.json` so the person adding
can enter it ([Repository manifest](../reference/repository-manifest.md#inputs)).

- The value is a URL starting with `https://` or `http://`. A URL with a user name or password, a
  `#` fragment, or a query parameter whose name looks like a credential (such as `token`) does not
  become a tile.
- Do not make it `sensitive` or `ephemeral`.

### 2. `.well-known/takosumi.json`

Put it at the top of the repository. This example is for a module in `deploy/opentofu`:

```json
{
  "apiVersion": "takosumi.com/v2.4",
  "kind": "Repository",
  "install": {
    "modules": {
      "deploy/opentofu": {
        "inputs": [],
        "interfaces": [
          {
            "key": "launcher",
            "name": "notes.launcher",
            "spec": {
              "type": "interface.ui.surface",
              "version": "1",
              "document": {
                "launcher": true,
                "display": { "title": "Notes", "icon": "/icon.svg" }
              },
              "inputs": {
                "url": {
                  "source": "output",
                  "outputName": "launch_url",
                  "outputType": "url"
                }
              },
              "access": { "visibility": "workspace" }
            },
            "bindingRequests": [
              {
                "key": "installer",
                "subject": { "source": "installing_principal" },
                "permissions": ["ui.open"],
                "delivery": { "type": "none" }
              }
            ]
          }
        ]
      }
    }
  }
}
```

Change these values and keep the rest as shown:

| Where | What to write |
| --- | --- |
| The key under `install.modules` | The module folder, written **from the top of the repository** (`.` for the top). If your install link uses `sourcePath=infra&path=deploy/opentofu`, the key is `infra/deploy/opentofu` |
| `name` | A name for this declaration. It starts with a letter and uses only letters, numbers, `_`, `.`, and `-` (up to 128 characters) |
| `display.title` | The name on the tile (up to 256 characters) |
| `display.icon` | The tile's icon (see the table below). Without it, the tile shows the name's initials |
| `outputName` | The name of the output from step 1 |

`display` can also have `sortOrder` (a number; smaller comes first), `category` (up to 64
characters), and `description` (up to 1,024 characters). Today the dashboard uses `category` only
to color tiles that have no icon (`site`, `storage`, `worker`), and does not show `description`.

| Form of `display.icon` | Example | Meaning |
| --- | --- | --- |
| A path starting with `/` | `/icon.svg` | An image on the same origin as the screen's URL. Your app must serve that image |
| An `https://` URL | `https://cdn.example.com/notes.svg` | That image |
| Short text of up to 16 characters | `📝` | A text icon (without `/`, `.`, or `:`) |

`bindingRequests` asks Takosumi to give the person who adds the service permission to open the
screen (`ui.open`). The home tile is shown only to people who have this permission, and only
while the service is **Deployed** or **Update available**.

## What the person adding sees

1. At the end of adding, **Preparing the service** appears while Takosumi waits for the screen's
   URL.
2. On **Service added**, **Open service** opens the screen in a new tab.
3. **Your apps** on the home screen shows a tile with the icon and `display.title` (or the
   service name if there is no title). Clicking it opens the screen in a new tab. Without an icon,
   the tile shows the name's initials.

If the URL cannot be confirmed within about 30 seconds, the screen says "The service was
applied, but its launch link is not ready yet. Retry the check or open the service details."
The deployment has finished, so wait a little and check again.

## When it does not work

| What happens | Cause |
| --- | --- |
| The service is added, but no tile appears | `.well-known/takosumi.json` is not valid JSON, breaks the shape rules, or its `install.modules` key does not match the module folder. None of these is an error: the service is added as if there were no declaration |
| A tile that was there disappeared | The service is neither **Deployed** nor **Update available** (for example **Error**, **Disabled**, or **Scheduled for deletion**) |
| The pre-add check says "This app version's setup declaration needs to be fixed by its publisher." and shows **Cannot be added right now** | The shape is valid but does not fit the module (the `outputName` output is missing, or it is `sensitive`), or it asks for a permission the Takosumi you add to does not allow |
| "The service was applied, but its launch link is not ready yet." keeps appearing | The output value does not meet the URL conditions above |

If the people who run the Takosumi require a manifest version, an unreadable or missing manifest
stops the pre-add check instead.

You can check the shape against the public JSON Schema
([v2.4](/schemas/repository-manifest-v2.4.schema.json)). Takosumi checks more than the schema
does, so a file that passes the schema can still be rejected.

With the standard settings, the only permissions a repository can ask for are `ui.open` to open
a screen (with `delivery` `none`) and `mcp.invoke` to call an MCP server (with `delivery`
`oauth2`). If the people who run the Takosumi changed those settings, their settings apply.

## Related

- [Share an install link](./install-link.md)
- [Repository manifest](../reference/repository-manifest.md)
- [Interfaces](../concepts/interfaces.md)
