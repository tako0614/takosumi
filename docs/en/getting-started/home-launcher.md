# Show your app on the home screen

If your software has a screen people open (a web app), you can put a tile that opens it on the
dashboard home (**Your apps**). **Open service** at the end of adding then opens that screen in a
new tab too. You declare it in the repository's `.well-known/takosumi.json`
([Repository manifest](../reference/repository-manifest.md)).

An app without this declaration also gets a tile on the home screen, but its tile opens the app's
page instead of a screen.

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
screen (`ui.open`). The home tile opens the screen only for people who have this permission. The
tile of an app whose install has not finished, or that is scheduled for uninstall or stopped, is
drawn muted with a small mark (**Installing**, **Needs attention**, and so on), and opens the
app's page.

## Declare your phone app

If the same product has a native phone app (distributed on the App Store or Google Play), you can
name it in `clients`, next to `display` in the `document`. Takosumi reads it so that, on a phone,
the screen can be handed to that app. Opening the screen on the web always remains possible,
with or without this declaration.

Today Takosumi checks the declaration and returns it in the app's screen API
(`screens[].clients` of `GET /api/v1/capsules/{id}/app`). Handing the screen to the native app
from the dashboard and Takosumi Mobile comes later.

```json
"document": {
  "launcher": true,
  "display": { "title": "Yurucommu", "icon": "/icon.svg" },
  "clients": {
    "preferred": "native",
    "ios": {
      "bundleId": "com.yurucommu",
      "open": "yurucommu://connect?host_url={origin}&product=yurucommu"
    },
    "android": {
      "package": "com.yurucommu",
      "open": "yurucommu://connect?host_url={origin}&product=yurucommu"
    }
  }
}
```

| Field | What to write |
| --- | --- |
| `preferred` | The default on a phone: `"native"` (the native app) or `"web"`. Without it, `"native"`. The API returns `"native"` only when at least one OS has a verified native app (below), and `"web"` otherwise. It applies only on an OS with a verified native app |
| `ios.bundleId` | The bundle id, in reverse-DNS form such as `com.example.notes`. Required for verification |
| `android.package` | Required. The applicationId, in reverse-DNS form. On Android the link goes only to the app with this package |
| `open` | A template for the app's custom-scheme link |
| `ios.universalLink`, `android.appLink` | Optional. A template for an https link on the publisher's domain (universal link, App Link) |
| `ios.name`, `android.name` | Optional. The name shown for an unverified app where people choose how to open (up to 64 characters: ASCII once accents are removed with NFKD, or Japanese without Latin letters). A verified app uses the name the operator registered |
| `ios.appStoreId` | Optional. The App Store id (1 to 12 digits). A verified app uses the registered id |
| `ios.storeUrl`, `android.storeUrl` | Optional. An install link; only one tied to the declared id is used (below) |

### Verified and unverified

Any app can write any declaration, so a declaration alone does not show that it names that
product's real app. Takosumi therefore compares it with the native apps the operator registered
as trusted (`TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS`, below).

- **Verified** (`verified: true`): the declared `bundleId` (`package` on Android) matches a
  registered app and each link template matches one of that app's registered templates. The name
  and App Store id come from the registration, not from the declaration. Links that do not match
  are dropped. A declaration that claims a registered `bundleId` or `package` with no matching
  link loses that OS entirely.
- **Unverified** (`verified: false`): every other declaration. It is returned with its real
  destination (the Android package, the custom scheme, the link host) in `target`. It cannot use
  a scheme or host that a registered app owns, or a host below one (such as
  `evil.open.example.com`). A name that imitates Takosumi or a registered app (including case,
  full-width forms and lookalikes such as `0` for `o`) is dropped. Japanese names are compared
  after reading katakana as hiragana and small kana as full-size and removing spaces, middle dots
  and long-vowel marks; a name equal to a registered name, containing it, or part of it (two
  characters or more) is dropped (with `ゆるこみゅ` registered, `ユルコミュ` and `ゆるこみゅ公式`
  are dropped too), and `たこすみ` / `タコスミ` count as Takosumi. A name is also dropped unless it
  is ASCII once accents are removed (NFKD) or Japanese without Latin letters (so other scripts
  such as Cyrillic, Greek or Cherokee, letters without a decomposition such as `ß`, `Ø`, `Ł` and
  `Æ`, symbols such as `©`, small capitals, emoji, and Latin mixed with kana or kanji are
  dropped), and when it keeps combining marks that do not compose into one letter (overlaid
  strokes, stacked accents; kana voicing marks compose and pass).

The dashboard and Takosumi Mobile open only a verified native app without asking, and honour
`preferred: "native"` only for one. They never open an unverified native app automatically; they
show `target` and ask first. An unverified app without `name` is shown with a neutral label such
as "Unverified app" and its `target`, never with the screen's `display.title`: the title is not
checked against the registered names.

Templates are compared literally, except that the case of the scheme and host and a default port
(`:443`) are normalised. Every registered template contains `{origin}`.

By default Takosumi trusts the three native apps in the TASK-0119 design:

| id | Name | Bundle id and package | Templates (iOS and Android) |
| --- | --- | --- | --- |
| `yurucommu-mobile` | Yurucommu | `com.yurucommu` | `yurucommu://connect?host_url={origin}`, `yurucommu://connect?host_url={origin}&product=yurucommu` |
| `yurumeet-mobile` | Yurumeet | `com.yurumeet` | `yurume://connect?host_url={origin}`, `yurume://connect?host_url={origin}&product=yurumeet` |
| `takos-mobile` | Takos | `jp.takos.mobile` | `takos://connect?host_url={origin}`, `takos://connect?host_url={origin}&product=takos` |

Operators replace this list by setting `TAKOSUMI_ACCOUNTS_TRUSTED_NATIVE_CLIENTS` to a JSON
array (`[]` trusts none); see [Configuration](../reference/configuration.md).

### Templates and links

- Each OS needs `open` or `universalLink` (`appLink` on Android), or both. Android also needs
  `package`.
- A template can contain only `{origin}` (the origin of the screen's URL) and `{url}` (the whole
  screen URL), at most four in all. Both are inserted URL-encoded. That public URL is the only
  thing handed to the app: never a token, a session, or an account id. Today's yurucommu-mobile
  and similar apps read `connect?host_url=`, so `open` works in the form shown above.
- Each instance has its own domain, so a native app cannot claim instance domains as universal
  links. To use universal links or App Links, put a page on the publisher's domain that sends
  people to the store or back to the web when the app is missing. With the instance URL after
  `#`, it is not sent to that page's server.
- `storeUrl` can only be the App Store page of `appStoreId` (`id<appStoreId>` on
  `apps.apple.com`) on iOS, and the Google Play page (`details?id=<package>`) or F-Droid page
  (`/packages/<package>/`) of `package` on Android. A TestFlight `join` link works only for a
  verified app registered with `testFlight: true`. Without a usable `storeUrl`, the link is built
  from `appStoreId` or `package`.
- `clients` is an optional field inside `document`, so neither the Interface version (`"1"`) nor
  the manifest version changes. A Takosumi that does not know the field ignores it.

### Refused values

A value that fails a check is not an error: that field is treated as absent, and an OS left with
no way to open the app is treated as absent too. Unknown fields and operating systems (such as
`windows`) are ignored and never returned by the API. A declaration that writes `verified` or
`trustedClientId` itself is ignored there too.

| Field | Refused |
| --- | --- |
| `open` | A scheme that is not 2 to 32 characters starting with a lowercase letter (lowercase letters, digits, `+`, `.`, `-`), a blocked scheme (below), a user name or password, a query parameter whose name looks like a credential (such as `token`), a `#` fragment (on Android, Takosumi builds an `intent:` link and appends to it) |
| `universalLink`, `appLink` | Anything but `https://` (including `http://`), a user name or password, a port other than 443, an IP address or a host without a dot, a credential-like name in the query or after `#`, a Takosumi domain (`takosumi.com` and below, and this Takosumi's dashboard and issuer hosts), and for an unverified app a registered app's host or one below it |
| Any template | A `{...}` other than `{origin}` and `{url}` (including `{ORIGIN}` and an unmatched `{`), five or more placeholders, `{origin}` or `{url}` in the host, spaces or characters not allowed in URLs, more than 2,048 characters before or after filling in |
| `bundleId`, `android.package` | Not in reverse-DNS form (up to 155 characters), or Takosumi Mobile's own `com.takosumi` and anything below it (which drops the whole OS) |
| `appStoreId` | Not 1 to 12 digits |
| `storeUrl` | The page of another app than the declared id, or a host other than those above |
| `name` | 65 characters or more, control or format characters (direction overrides, zero-width characters and so on), line or paragraph separators, a name imitating Takosumi or a registered app (also in kana), or a name that is neither ASCII after NFKD nor Japanese without Latin letters, or that keeps uncomposed combining marks (above) |

Schemes `open` cannot use: `http`, `https` (write those in `universalLink` or `appLink`),
`javascript`, `vbscript`, `data`, `file`, `filesystem`, `blob`, `about`, `content`, `intent`,
`android-app` (Takosumi builds Android links), `takosumi` (Takosumi Mobile itself), `tel`, `callto`,
`sms`, `smsto`, `mms`, `mmsto`, `mailto`, `facetime`, `facetime-audio`, `facetime-prompt`,
`facetime-audio-prompt`, `itms`, `itmss`, `itms-apps`, `itms-appss`, `itms-services`, `itms-beta`,
`market`, `app-settings`, `app-prefs`, `prefs`, `shortcuts`, `x-web-search`, `ws`, `wss`, `ftp`, and
browser apps that open any web page (`x-safari-http`, `x-safari-https`, `googlechrome`,
`googlechromes`, `googlechrome-x-callback`, `firefox`, `firefox-focus`, `focus`, `microsoft-edge`,
`microsoft-edge-http`, `microsoft-edge-https`, `opera`, `opera-http`, `opera-https`, `touch-http`,
`touch-https`, `brave`, `duckduckgo`, `ddgquicklink`, `samsunginternet`, `yandexbrowser-open-url`,
`firefox-klar`, `onionhttp`, `onionhttps`).
This list only removes the worst schemes; trust comes from the registration above.

Takosumi's own identities (Takosumi Mobile's bundle id, package and scheme, Takosumi's domains,
reserved names) are in the public package `@takosjp/takosumi-contract/native-client-identity`,
which Takosumi Mobile uses too.

## What the person adding sees

1. At the end of adding, **Preparing the service** appears while Takosumi waits for the screen's
   URL.
2. On **Service added**, **Open service** opens the screen in a new tab.
3. **Your apps** on the home screen shows a tile with the icon and `display.title` (or the
   service name if there is no title). Clicking it opens the screen in a new tab. Without an icon,
   the tile shows the name's initials. **Manage** under the tile opens the app's page.

If the URL cannot be confirmed within about 30 seconds, the screen says "The service was
applied, but its launch link is not ready yet. Retry the check or open the service details."
The deployment has finished, so wait a little and check again.

## When it does not work

| What happens | Cause |
| --- | --- |
| The tile opens the app's page instead of the screen | `.well-known/takosumi.json` is not valid JSON, breaks the shape rules, or its `install.modules` key does not match the module folder. None of these is an error: the service is added as if there were no declaration |
| A tile that used to open the screen is muted and opens the app's page | The app is updating, scheduled for uninstall, or stopped. The tile's mark says which |
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
