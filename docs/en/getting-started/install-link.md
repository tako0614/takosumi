# Share an install link

Put an install link in a README or on a website, and readers can open the Takosumi add screen
with your repository already filled in. The link only fills in the form. **Opening it creates
nothing.** The person adding checks the screen and presses **Add** themselves.

Get the repository into the shape described in
[Prepare a repository](./prepare-repository.md) first.

## The link

```text
https://<Takosumi origin>/install?git=<Git URL>&ref=<branch, tag, or commit>&path=<module folder>
```

`<Takosumi origin>` is the dashboard origin (the part from `https://` to the host name) of the
Takosumi people will add to. For the official hosted service it is `https://app.takosumi.com`.
For a Takosumi you run yourself, it is your origin.

In a README, make it a Markdown link:

```markdown
[Add with Takosumi](https://takosumi.example.com/install?git=https://github.com/acme/notes.git&ref=v1.2.0&path=deploy/opentofu)
```

Replace the origin, repository, version, and folder with your own.

URL-encode a value that contains `&`, `+`, `#`, `%`, or a space. For example, write `+` as
`%2B`. A bare `+` is read as a space.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `git` | URL of the Git repository that holds the module (the folder with your OpenTofu configuration). It starts with `https://` and has no user name, password, `?` query, or `#` fragment |
| `ref` | The version to add: a branch, tag, or commit. Without it, the default branch |
| `path` | The folder of the module to add. Without it, Takosumi checks the repository and decides |
| `sourcePath` | The folder inside the repository that Takosumi fetches and checks. Without it, the whole repository (`.`) |
| `name` | The service name: lowercase letters, numbers, and hyphens only. Without it, the repository name |
| `source` | `git`, `ref`, and `path` packed into one value (see "Packed form" below) |
| `product`, `return_uri` | Used as a pair to return to your own app after adding ([App Handoff](../reference/app-handoff.md)) |

Every link needs exactly one of `git` or `source`. The rest are optional. Module variable values
cannot travel in the link. The person adding enters them on the **Set up the service** screen.

If the repository name has anything other than lowercase letters, numbers, and hyphens (capital
letters, `_`, `.`, and so on), add `name`. With the repository name as is,
pressing **Add** shows "Use lowercase letters, numbers, and hyphens for the service name." and
the person adding has to fix the name.

### Choosing the version

When the service is added, Takosumi pins `ref` to the commit it points to at that moment. What
happens after that depends on the kind of `ref`:

- **A branch** (such as `main`): the service tracks that branch. When a new commit arrives, it
  shows **Update available**.
- **A tag or commit** (such as `v1.2.0`): the service stays on that version. The person who added
  it moves to a newer one with **Change version**
  ([Update to a new version](./after-adding.md#update-to-a-new-version)). If you move the tag to
  another commit, though, the service shows **Update available**, as it would for a branch.

### `path` and `sourcePath`

`path` is **relative to `sourcePath`**, not to the top of the repository.

| Where the module is | What to write |
| --- | --- |
| `deploy/opentofu` in the repository | `path=deploy/opentofu` |
| `infra/deploy/opentofu`, checking only inside `infra` | `sourcePath=infra&path=deploy/opentofu` |
| The top of the repository | `path=.` |

Use `sourcePath` when test or example modules live in the same repository and you want to
narrow what is checked to the main module
([What stops a module from being added](./prepare-repository.md#what-stops-a-module-from-being-added)).

Write folders like `deploy/opentofu`. A folder cannot start with `/` or `./`, end with `/`,
contain an empty part (`a//b`), a `.` or `..` part, `\`, or a drive name (`C:`), or be longer than
1,024 characters.

After the person adding presses **Add**, Takosumi checks the repository and compares `path` with
what it found:

- `path` is found and it is the only module: Takosumi uses it.
- `path` is found and there are other modules: **Choose a module** opens with that module
  selected. The person adding can still choose another one.
- `path` is not found: `path` is ignored and the check decides. With one module, Takosumi uses
  it. With several, the person adding chooses. With none, the screen says "No module that can be
  added was found in this repository version." Nothing says that `path` was ignored, so a wrong
  path is easy to miss, especially a path written from the top of the repository when
  `sourcePath` is set.

### Packed form

`source` takes the same shape as an OpenTofu module address:

```text
https://takosumi.example.com/install?source=git::https://github.com/acme/notes.git//deploy/opentofu?ref=v1.2.0
```

What follows `//` is the module folder, and what follows `?` is the version. Both are optional.
Only `ref` can follow `?`. `source` cannot be used together with `git`. Give `ref` and `path`
either inside `source` or outside it, not both. `sourcePath` can be used with `source`.

## When a link is not used

If a link with `git` or `source` matches any of the following, none of its values are used, and
the add screen opens with an empty source. **No error is shown.**

- A parameter that is not in the table above. This includes tracking parameters such as
  `utm_source` and attempts to pass variable values such as `var.<name>`
- The same parameter twice
- Both `git` and `source`
- A `source` that does not start with `git::`, has something other than `ref` after `?`, or has a
  folder after `//` that breaks the rules above
- `ref` or `path` given both inside and outside `source`
- An empty value (such as `ref=`), or a value with spaces before or after it
- A `git` URL that does not start with `https://`, contains a user name or password, or has a
  `?` query or `#` fragment
- A `path` or `sourcePath` that breaks the rules above
- A `name` longer than 96 characters or a `ref` longer than 512 characters
- Only one of `product` and `return_uri`, or values that break the
  [App Handoff](../reference/app-handoff.md#product-key-and-return-uri-rules) rules

A link with neither `git` nor `source` opens the store list instead of a filled-in add
screen.

## Check before you share

Open the link yourself. On the first add screen, **Source** should show the repository, version,
and folder. The Git URL and the other values are in the collapsed **Source details**. If
**Source** is missing and the fields in **Source details** are empty, one of the cases above
applies.
The first screen is the same one shown in the
[Quickstart](./quickstart.md#_6-add-the-example).

## What the person opening it sees

1. Someone who is not signed in sees the sign-in screen with the name, version, and folder of the
   service they are adding. After signing in, they return to the add screen.
2. The first add screen shows the service name, **Source**, and the steps that follow.
3. After they press **Add**, Takosumi pins `ref` to a commit and checks the repository. On
   **Set up the service** they enter variables and connections, and on **Review before adding**
   they check everything before adding.

Link values end up in browser history and logs. Keep secrets out of the link.

## Related

- [Prepare a repository](./prepare-repository.md)
- [Show your app on the home screen](./home-launcher.md)
- [Update, restore, or delete a service](./after-adding.md)
- [Sources and Capsules](../concepts/sources.md)
- [App Handoff](../reference/app-handoff.md) — return to your own app after adding
