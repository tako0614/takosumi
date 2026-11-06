# Share an install link

Put an install link in a README or on a website, and readers can open the app install screen with
the source already filled in. The link only fills in the form. **Opening it creates nothing.**
Pressing **Install** reads the Git version. The person checks the app name, connections, and settings,
then reviews the planned changes under **What this install does**. They choose **Allow and install** to apply them.

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
[Install with Takosumi](https://takosumi.example.com/install?git=https://github.com/acme/notes.git&ref=v1.2.0&path=deploy/opentofu)
```

Replace the origin, repository, version, and folder with your own.

URL-encode a value that contains `&`, `+`, `#`, `%`, or a space. For example, write `+` as
`%2B`. A bare `+` is read as a space.

## Parameters

| Parameter | Meaning |
| --- | --- |
| `git` | URL of the Git repository that holds the module (the folder with your OpenTofu configuration). It starts with `https://` and has no user name, password, `?` query, or `#` fragment |
| `ref` | The version to install: a branch, tag, or commit. Without it, the default branch |
| `path` | The folder of the module to install. Without it, Takosumi checks the repository and decides |
| `sourcePath` | The folder inside the repository that Takosumi fetches and checks. Without it, the whole repository (`.`) |
| `name` | App name. Without it, Takosumi proposes a lowercase name from the Git URL |
| `source` | `git`, `ref`, and `path` packed into one value (see "Packed form" below) |
| `product`, `return_uri` | Used as a pair to return to your own app after installation ([App Handoff](../reference/app-handoff.md)) |

Every link needs exactly one of `git` or `source`. The rest are optional. Module variable values
cannot travel in the link. The person enters them in **Settings** on the install screen.

`name` is optional. Supplied text is normalized as an app name. If it is omitted, Takosumi proposes a
name from the Git URL. The person can edit the app name on the install screen.

### Choosing the version

When the app is installed, Takosumi pins `ref` to the commit it points to at that moment. What
happens after that depends on the kind of `ref`:

- **A branch** (such as `main`): the app tracks that branch. When a new commit arrives, it
  shows **Update available**.
- **A tag or commit** (such as `v1.2.0`): the app stays on that version. The person who installed
  it moves to a newer one with **Change version**
  ([Update to a new version](./after-adding.md#update-to-a-new-version)). If you move the tag to
  another commit, though, the app shows **Update available**, as it would for a branch.

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

After the person presses **Install**, Takosumi checks the repository and compares `path` with
what it found:

- The scan confirms `path`: Takosumi uses that module without a selection screen, even if other modules exist.
- If the scan cannot confirm `path` but finds installable modules, **Choose a module** opens so
  the person can choose one of the scanned modules.
- No installable module can be identified: the screen says "No installable module could be
  identified in this version."

### Packed form

`source` takes the same shape as an OpenTofu module address:

```text
https://takosumi.example.com/install?source=git::https://github.com/acme/notes.git//deploy/opentofu?ref=v1.2.0
```

What follows `//` is the module folder, and what follows `?` is the version. Both are optional.
Only `ref` can follow `?`. `source` cannot be used together with `git`. Give `ref` and `path`
either inside `source` or outside it, not both. `sourcePath` can be used with `source`.

## A link that opens the visitor's own Takosumi

If you know which Takosumi people will add to, use the link with an origin above. If you want one
link for people on any Takosumi, leave the origin out so it opens in whichever Takosumi the person
uses. Use `web+takosumi:install` instead of `https://<Takosumi origin>/install`. The parameters
and rules are the same; only the screen for a link that cannot be read differs (see "When a link
is not used" below).

```text
web+takosumi:install?git=https://github.com/acme/notes.git&ref=v1.2.0&path=deploy/opentofu
```

This link opens the Takosumi that the person registered in their browser. They register it in
that Takosumi's dashboard: under **Account**, in **Where store installs land**, press **Register
this device** and accept the browser's prompt.

- In a browser that has not registered, this link does not open.
- In a browser that cannot register, **Account** says "This browser doesn’t support this."
- Places that remove links other than a few fixed kinds such as `https:`, like a GitHub README,
  may not keep it working as a link.

In a README, put it next to the link with an origin, so everyone can open one of them.

## When a link is not used

If an install link with `git` or `source` matches any of the following and returns to the
store list, none of its values are used and a message explains that the link is invalid.
Check the link with its publisher, or install the app using its Git URL.

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

For a `web+takosumi:install` link, only the following cases show the invalid-link message
on the store list, as `/install` does. Every other failure of a `web+takosumi:install` link
(an unknown parameter, an empty value, a broken `path`, and so on) opens the store list
without carrying the link values or showing that message. A link longer than 4,096 characters
once decoded behaves the same way.

- The `git` URL breaks its conditions (`https://`, no user name or password, no query or
  fragment)
- The contents of `source` break its rules
- `ref` or `path` is given both inside and outside `source`
- `name` is longer than 96 characters, or `ref` is longer than 512 characters

## Check before you share

Open the link yourself. On the first install screen, **Source and version** should show the intended repository.
If the link specifies `ref`, check that version too. Choose **Install** to check the required connections,
settings, and planned changes.
Check the link's `path` against the `sourcePath` rules above.
If the store list opens with an invalid-link message, check the rules above.
The first screen is the same one shown in the
[Quickstart](./quickstart.md#_6-add-the-example).

## What the person opening it sees

1. Someone who is not signed in sees the sign-in screen with context for the app they are installing.
   After signing in, they return to the install screen.
2. The install screen shows the app name, **Source and version**, and the steps that follow.
3. Pressing **Install** pins `ref` to a commit and checks the repository. The person sets the app
   name, connections, and settings, reviews the planned changes, and then chooses
   **Allow and install** to apply them. From the Store, manually entered Git URLs use
   **Install from a Git repository** and **Continue** before the install screen. An existing app
   also offers **Open** and **Install another**.

Link values end up in browser history and logs. Keep secrets out of the link.

## Related

- [Prepare a repository](./prepare-repository.md)
- [Show your app on the home screen](./home-launcher.md)
- [Update, restore, or delete an app](./after-adding.md)
- [Sources and Capsules](../concepts/sources.md)
- [App Handoff](../reference/app-handoff.md) — return to your own app after installation, and the
  detailed `web+takosumi:` rules
