# Takosumi Mobile Kit

Takosumi Mobile Kit is the shared connection layer for first-party mobile clients such as Takos and Yurucommu.

It keeps host discovery, connection handoff URLs, Host Center links, and OIDC PKCE helpers in Takosumi-owned code so product mobile shells can stay thin and mostly identical.

The package intentionally does not own native push, calls, or product UI. Those belong in the product mobile shell or native plugin layer and should call this package for host and identity setup.

## Current Surface

- Normalize host URLs and app handoff payloads.
- Parse product mobile route payloads such as `takos://open?path=/chat` and
  `yurucommu://open?url=https://host.example/notifications` so native deep
  links and push taps can open same-origin host routes through the current
  mobile session.
- Build Takosumi Host Center links with product and return URI.
- Preserve Host Center setup handoff payloads through discovery state.
- Discover host capabilities through `.well-known` and capabilities endpoints.
- Build OIDC authorization URLs and token exchanges with PKCE material.
- Store pending sign-in requests and mobile sessions through the native bridge store.
- Keep a product-local recent host list in normal persistent storage so
  mobile clients can reconnect to known Takos hosts / Yurucommu instances
  without retyping URLs.
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
- Provide a small host API helper for posting typed native push registrations
  through the current mobile session bearer token.
- Prefer `NativeBridge.secureStore` for OIDC request/session material when a
  product shell provides one. Tauri's normal store plugin remains the
  device-persistent fallback; secure storage can be backed by a product-local
  Stronghold or platform keychain adapter.
- Provide first-run action metadata shared by product mobile shells.
- Define the native bridge contract for launch payloads, in-app browser handoff, persistent storage, QR scanning, local notifications, biometric auth, remote push, and call intents.
- Provide a typed adapter helper that lets product shells pass Tauri plugin functions without making Takosumi Mobile Kit depend on Tauri packages directly.
- Provide a typed Tauri Stronghold secure-store helper that product shells can
  wire to `@tauri-apps/plugin-stronghold` without adding Tauri packages as kit
  dependencies.
- Provide typed Tauri Stronghold password-source helpers. Product shells can
  use a mobile keystore-backed source for Android Keystore / iOS Keychain and
  keep a Tauri Store-backed seed as desktop/dev fallback and migration source,
  without requiring a checked-in development password.
- Provide typed Tauri helper adapters for optional remote push token sources
  and opener-backed call intents. These helpers normalize product-local plugin
  output into the shared native bridge contract; they do not make remote push or
  incoming-call support part of the Takosumi Mobile Kit runtime.
- Accept a typed Tauri OS platform adapter so product shells can keep
  mobile-only plugin capabilities such as QR scanning and biometric auth scoped
  to iOS / Android even when desktop Tauri scripts exist.
- Provide a typed adapter for the community `tauri-plugin-mobile-push-api`
  shape (`requestPermission()`, `getToken()`, notification events, and token
  refresh events) without making that package a Takosumi Mobile Kit dependency.
  First-party product shells can wire this adapter by default while keeping
  APNs / Firebase project configuration product-local.
- Provide a typed Tauri mobile product bridge factory that wires the common
  deep-link, opener, store, Stronghold, notification, and QR scanner plugin
  shape while keeping product shells responsible for importing the actual
  Tauri plugin modules.
- Provide a shared Solid mobile shell and shell CSS so first-party product
  clients can keep connection, sign-in, home summary, and host shortcut UX
  nearly identical while passing product-specific copy and home render slots.
- Provide a shared Solid app bootstrap (`renderMobileClientApp`) so product
  entries stay mostly typed configuration while native bridge creation remains
  product-local.
- Provide a headless mobile client controller for URL/QR connect, host discovery, OIDC sign-in, session restore, home refresh, and sign-out.
- Provide a shared Tauri mobile doctor script used by product shells to validate config, capability permissions, app icons, plugin wiring, and native toolchain readiness.

Native implementations are intentionally product-local. Takos and Yurucommu replace the browser bridge with a Tauri/plugin-backed bridge without changing Takosumi host discovery or OIDC helpers. As of the current Tauri v2 official plugin surface we rely on `@tauri-apps/plugin-notification` for local notifications, not APNs/FCM remote push; remote push token registration is therefore an optional typed adapter that a product shell can back with a platform-specific or community plugin. Call intents are also optional: the shared helper can use Tauri opener as a standard in-app-browser fallback, while true incoming-call UI remains product/native plugin work. The controller can register a native push token with a product-owned host callback when both sides opt in, but Takosumi Mobile Kit does not invent a host endpoint. Secure token storage is also an optional typed adapter: products can use the kit's Tauri mobile product bridge / Stronghold helper or provide another platform keychain implementation as `NativeBridge.secureStore` without making this package depend on native plugin packages. The included Stronghold password helpers remove the checked-in static development password. First-party product shells use a mobile keystore-backed source for the Stronghold password seed and keep the product-scoped Tauri Store seed as a fallback for desktop/dev and migration. Biometric auth is treated as an unlock gate, not as secret derivation, because the Tauri biometric plugin authenticates the user but does not return password material.

Community remote push plugin wiring stays product-local:

```ts
import {
  createTauriMobilePushPluginAdapter,
  createTauriMobileProductBridge,
} from "@takosjp/takosumi-mobile-kit";
import {
  getToken,
  onNotificationReceived,
  onNotificationTapped,
  onTokenRefresh,
  requestPermission,
} from "tauri-plugin-mobile-push-api";

const pushNotifications = createTauriMobilePushPluginAdapter({
  mobilePush: {
    requestPermission,
    getToken,
    onNotificationReceived,
    onNotificationTapped,
    onTokenRefresh,
  },
});

createTauriMobileProductBridge({
  // normal product bridge options...
  pushNotifications,
});
```

`tauri-plugin-mobile-push@0.1.4` reports working Android event listeners and a
known iOS limitation where listener registration succeeds but notification /
token-refresh events are not delivered yet. The shared controller treats these
listeners as best-effort lifecycle hooks; registration and normal sign-in remain
usable when an event surface is unavailable.

## Checks

```sh
bun run check
bun run test
```

Product shells call the shared doctor from their own mobile package directory:

```sh
bun ../../takosumi/mobile-kit/scripts/check-tauri-mobile.mjs \
  --product takos \
  --scheme takos \
  --product-name Takos \
  --dev-port 1420
```

When a product opts into `tauri-plugin-mobile-push-api`, add:

```sh
  --remote-push-plugin mobile-push
```

The doctor treats the plugin dependency, `mobile-push:default` capability, and
Rust plugin registration as checked-in requirements. iOS Push Notifications
capability / `aps-environment` entitlement and Android Firebase / FCM project
wiring are native project files that are reported as native-readiness warnings
until the product has run `tauri ios init` / `tauri android init` and added
store/team-specific push configuration outside the shared kit.
