# Takosumi Mobile Kit

Takosumi Mobile Kit is the product-agnostic mobile foundation for clients backed by a Takosumi-managed host.

It consumes the generic Takosumi App Handoff Protocol; it does not define a mobile-only install protocol. Host discovery, connection URLs, Host Center links, and OIDC PKCE helpers live in Takosumi-owned code so product mobile shells can stay thin and mostly identical. The kit does not know product names; a product is a validated key supplied by the app adapter.

In this package, "shared" means reusable mobile foundation owned by Takosumi
Mobile Kit. It does not mean product shells share product code directly.
Mobile clients should depend on the same typed foundation seams, then keep
app-specific API clients and native plugin choices inside their own product
shell.

The package intentionally does not own native push, calls, or product UI. Those belong in the product mobile shell or native plugin layer and should call this package for host and identity setup.

## Host-First Product Surface Rule

Product mobile shells should not rebuild every host screen as native UI. The
default path is:

- use the shared shell for connection, auth, session, recent hosts, push,
  deep-link, secure storage, biometric unlock, QR, and host shortcuts
- open mature host screens through route handoff / in-app browser, especially
  list, settings, admin, detail, and management views that already exist on the
  host
- add product-local native UI only for high-frequency mobile actions, compact
  previews, short capture flows, device-backed flows, or foreground push/deep
  link handling
- when a behavior is product-agnostic, implement the shared seam here and wire
  it from each product shell that needs it instead of adding one-off product
  code
- when a behavior is product-specific, keep only the typed host API client in
  that product shell and fall back to host handoff for the full workflow

This keeps product mobile code structurally similar without forcing Takosumi
Mobile Kit to know product nouns or duplicating complete web screens in native
UI.

## Current Surface

- Normalize host URLs and app handoff payloads. Remote HTTP hosts are rejected;
  HTTP is limited to loopback development while normal hosts require HTTPS.
- Parse product mobile route payloads such as `notesapp://open?path=/notes` and
  `chatapp://open?url=https://host.example/rooms` so native deep
  links and push taps can open same-origin host routes through the current
  mobile session.
- Build Takosumi App Handoff / Host Center links from product-local source
  coordinates plus a return URI. A product key alone is never an install target.
- Preserve App Handoff setup payloads through discovery state.
- Discover host capabilities through `.well-known` and capabilities endpoints.
- Build OIDC authorization URLs and token exchanges with PKCE material. The
  issuer must be advertised explicitly; discovery validates issuer equality,
  required endpoints, and HTTPS endpoint transport.
- Store pending sign-in requests and mobile sessions through the native bridge
  store. Pending sign-in requests expire after ten minutes.
- Keep a product-local recent host list in normal persistent storage so
  mobile clients can reconnect to known product hosts
  without retyping URLs, and let users remove one remembered host or clear the
  list from the shared shell.
- Let signed-in users copy the connected host URL through the shared shell when
  the native bridge exposes clipboard text writes.
- Refresh expired OIDC mobile sessions with rotated refresh tokens before
  product home APIs are called.
- Optionally gate restored mobile sessions behind biometric authentication when
  the native bridge reports biometric support. The session stays stored if the
  user cancels unlock, so the app can retry without forcing a new sign-in.
- Let product shells opt into remote push token registration by combining the
  native bridge's typed `registerPushNotifications` adapter with a
  product-owned host registration callback. Sign-in and session restore remain
  usable when the device or product host cannot register push.
- Keep remote push token refresh and foreground/tap notification events typed
  in the shared bridge. Token refresh is re-posted through the product
  registration callback, while tapped notifications with same-origin `path`,
  `route`, `url`, or `href` payloads are opened through the connected host.
- Keep route deep links pending across sign-in when the payload includes
  `host_url`, then open the requested host route after the mobile session is
  established.
- Provide a small host API helper for registering product-neutral HTTP pushers
  through the current mobile session bearer token. It uses the host-advertised
  `notificationPushers` endpoint, falling back to
  `POST /api/notifications/pushers`, and sends `app_id`, opaque `pushkey`, and
  validated gateway data instead of inventing a mobile-only token endpoint.
- Prefer `NativeBridge.secureStore` for OIDC request/session material when a
  product shell provides one. Tauri's normal store plugin remains the
  device-persistent migration source; secure storage can be backed by a product-local
  Stronghold or platform keychain adapter.
- Provide first-run action metadata shared by product mobile shells.
- Define the native bridge contract for launch payloads, in-app browser handoff, persistent storage, QR scanning, local notifications, biometric auth, remote push, call intents, and plain-text clipboard writes.
- Provide a typed adapter helper that lets product shells pass Tauri plugin functions without making Takosumi Mobile Kit depend on Tauri packages directly.
- Provide a typed Tauri Stronghold secure-store helper that product shells can
  wire to `@tauri-apps/plugin-stronghold` without adding Tauri packages as kit
  dependencies.
- Provide typed Tauri Stronghold password-source helpers. Product shells can
  use a mobile keystore-backed source for Android Keystore / iOS Keychain and
  recognize a legacy Tauri Store-backed seed only as a migration source,
  without requiring a checked-in development password.
- Provide typed Tauri helper adapters for optional remote push registration
  sources, provider unregistration, and opener-backed call intents. These
  helpers normalize product-local plugin output into the shared native bridge
  contract; they do not make remote push or incoming-call support part of the
  Takosumi Mobile Kit runtime.
- Provide a product-agnostic `shareMobileUrl` helper that prefers Web Share,
  falls back to the native bridge's plain-text clipboard write seam, then to the
  browser clipboard when available.
- Provide a product-agnostic `copyMobileText` helper for shared shell actions
  that need native clipboard text writes without direct product code.
- Accept a typed Tauri OS platform adapter so product shells can keep
  mobile-only plugin capabilities such as QR scanning and biometric auth scoped
  to iOS / Android even when desktop Tauri scripts exist.
- Provide a typed adapter shape for product-local mobile-push plugins
  (`requestPermission()`, `getToken()`, optional `unregister()`, notification
  events, and registration-refresh events) without making a native package a
  Takosumi Mobile Kit dependency. The generic `token` field is an opaque
  cross-provider value; it can hold an APNs device token or an FCM Firebase
  Installation ID (FID).
- Provide a typed Tauri mobile product bridge factory that wires the common
  deep-link, opener, store, Stronghold, notification, clipboard, and QR scanner
  plugin shape while keeping product shells responsible for importing the
  actual Tauri plugin modules.
- Provide a default typed Tauri product bridge factory that also derives
  product-scoped storage names, builds the Stronghold password source from a
  product-local keystore service, verifies and removes the Store migration source, normalizes
  the optional mobile-push plugin shape, and supplies the opener-backed call
  fallback.
- Provide standard Tauri product storage / Stronghold naming derived from the
  product key so product shells do not hand-code per-app session and vault
  names.
- Provide a shared Solid mobile shell and shell CSS so product clients can keep
  connection, sign-in, home summary, and host shortcut UX nearly identical while
  passing product-specific copy and home render slots.
- Provide shared Solid preview section/list/card primitives so product clients
  can add compact native previews with the same shell class contract while
  keeping product-specific API calls and content rendering local.
- Provide shared Solid compose section/form/field/footer and segmented-control
  primitives so compact native capture flows share the same structure while
  product shells keep their API calls, validation choices, and copy local.
- Provide `defineMobileHostActions` so product shells declare host shortcuts
  through the same typed helper, with static paths validated as same-origin
  host routes instead of product-local ad hoc URL lists.
- Provide a shared Solid app bootstrap (`renderMobileClientApp`) so product
  entries stay mostly typed configuration while native bridge creation remains
  product-local.
- Provide small product-agnostic preview helpers for repeated mobile shell
  presentation behavior, such as timestamp formatting and appending/prepending
  paged preview items without duplicate ids or custom keys.
- Provide small product-agnostic text helpers for remaining-count display and
  submit eligibility so product shells do not hand-code raw trim/length guards.
- Provide a headless mobile client controller for URL/QR connect, host discovery, OIDC sign-in, session restore, home refresh, and sign-out.
- Provide a shared Tauri mobile doctor script used by product shells to validate config, capability permissions, app icons, plugin wiring, and native toolchain readiness.
- Provide a shared native-init wrapper that runs Tauri Android/iOS generation and
  immediately applies the selected product project's non-secret push wiring.
  Provider files, signing, and device evidence remain product/operator-owned.
- Validate one release-evidence contract from both the strict evidence gate and
  the non-failing status reporter, so a status cannot report ready while signing,
  store upload, screenshots, or physical-device smoke evidence is absent.

Native implementations are intentionally product-local. Product apps replace the browser bridge with a Tauri/plugin-backed bridge without changing Takosumi host discovery or OIDC helpers. As of the current Tauri v2 official plugin surface we rely on `@tauri-apps/plugin-notification` for local notifications, not APNs/FCM remote push; remote push registration is therefore an optional typed adapter that a product shell backs with a platform-specific implementation. Call intents are also optional: the shared helper can use Tauri opener as a standard in-app-browser fallback, while true incoming-call UI remains product/native plugin work. The controller can pass a native provider registration identifier to a product-owned callback, unregister it on session teardown, and register the opaque value through the portable Notification Pusher contract; the host implementation remains product-owned. Secure token storage is also an optional typed adapter: products can use the kit's Tauri mobile product bridge / Stronghold helper or provide another platform keychain implementation as `NativeBridge.secureStore` without making this package depend on native plugin packages. The included Stronghold password helpers remove the checked-in static development password. Product shells can migrate a legacy product-scoped Tauri Store seed into native secure storage; the plaintext migration value is retained only until a later app start reads the same seed back from native storage, then it is deleted. Native store failure never silently falls back to plaintext. Biometric auth is treated as an unlock gate, not as secret derivation, because the Tauri biometric plugin authenticates the user but does not return password material.

The community `tauri-plugin-mobile-push@0.1.4` adapter remains available for
experimentation, but it is not a GA implementation: its locked Rust command
surface does not provide a verified Android token path, listener registration
is incomplete, and its platform event lifecycle is not sufficient for a
shipping claim. Product shells must keep remote push feature-off until they
provide a product-owned native adapter, delivery backend, token lifecycle, and
physical-device evidence. The shared typed adapter is an integration seam, not
readiness evidence.

## Checks

```sh
bun run check
bun run test
```

Product shells call the shared doctor from their own mobile package directory:

```sh
bun ../../takosumi/mobile-kit/scripts/check-tauri-mobile.mjs \
  --product notes-app \
  --scheme notesapp \
  --product-name Notes \
  --dev-port 1420
```

For legacy/community adapter experiments only, add:

```sh
  --remote-push-plugin mobile-push
```

The doctor then checks the community dependency, capability, and Rust plugin
registration, but passing those static checks is not a GA claim. A shipping
product should instead use its release-status and evidence gates to require a
product-owned native plugin, delivery backend, provider-error cleanup, token
replacement, and device evidence.

At the ecosystem root, `bun run check:mobile-apps` remains the normal shared
foundation and product web-surface gate. `bun run check:mobile-apps:native` is
the stricter native release-readiness gate: it runs each product's
`mobile:native-release-check` and turns native toolchain/generated-project
warnings into failures. `bun run check:mobile-apps:release` adds product release
evidence checks for signed artifacts, store upload references, store
screenshots, device smoke, native security, mobile OIDC integration, and remote
push. `bun run
status:mobile-apps:release` reports implementation, environment, operator, and
evidence blocker categories without failing, which is useful while the apps
are not yet store-ready. Keep these gates separate so day-to-day mobile shell
work can stay green before store/team-specific native projects, SDKs, and
release evidence are available.

Each product can additionally expose a repository-only release gate by running
the status reporter with `--skip-toolchain-probe --fail-on-repo-blockers`. That
gate fails source/configuration defects while continuing to list generated
project, SDK, provider, signing, store, and physical-device blockers under their
actual owners.
