#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inspectMobileReleaseVersions } from "./mobile-release-versions.mjs";

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.appDir ?? process.cwd());
const product = requireArg(args.product, "--product");
const scheme = requireArg(args.scheme, "--scheme");
const productName = requireArg(args.productName, "--product-name");
const devPort = requireArg(args.devPort, "--dev-port");
const strictNativeEnv = Boolean(args.strictNativeEnv);
const remotePushPlugin = args.remotePushPlugin;

const results = [];

checkFile("package.json");
checkFile("src-tauri/Cargo.toml");
checkFile("src-tauri/tauri.conf.json");
checkFile("src-tauri/capabilities/default.json");
checkFile("src-tauri/capabilities/mobile.json");
checkFile("src-tauri/Info.ios.plist");
checkFile("vite.config.ts");
checkIconFiles();

const packageJson = readJson("package.json");
const tauriConfig = readJson("src-tauri/tauri.conf.json");
const defaultCapability = readJson("src-tauri/capabilities/default.json");
const mobileCapability = readJson("src-tauri/capabilities/mobile.json");
const cargoToml = readText("src-tauri/Cargo.toml");
const libRs = readText("src-tauri/src/lib.rs");
const iosPlist = readText("src-tauri/Info.ios.plist");
const viteConfig = readText("vite.config.ts");
const nativeTs = readText("src/native.ts");
const keystorePluginCargoToml = readText(
  "src-tauri/plugins/keystore/Cargo.toml",
);
const keystorePluginAndroid = readText(
  "src-tauri/plugins/keystore/android/src/main/java/KeystorePlugin.kt",
);
const keystorePluginAndroidGradle = readText(
  "src-tauri/plugins/keystore/android/build.gradle.kts",
);
const keystorePluginAndroidManifest = readText(
  "src-tauri/plugins/keystore/android/src/main/AndroidManifest.xml",
);
const keystorePluginIos = readText(
  "src-tauri/plugins/keystore/ios/Sources/KeystorePlugin.swift",
);
const mobilePushPluginCargoToml = readText(
  "src-tauri/plugins/mobile-push/Cargo.toml",
);
const mobilePushPluginAndroid = readText(
  "src-tauri/plugins/mobile-push/android/src/main/java/MobilePushPlugin.kt",
);
const mobilePushPluginAndroidGradle = readText(
  "src-tauri/plugins/mobile-push/android/build.gradle.kts",
);
const mobilePushPluginAndroidService = readText(
  "src-tauri/plugins/mobile-push/android/src/main/java/TakosFirebaseMessagingService.kt",
);
const mobilePushPluginAndroidRuntime = readText(
  "src-tauri/plugins/mobile-push/android/src/main/java/MobilePushRuntime.kt",
);
const mobilePushPluginAndroidManifest = readText(
  "src-tauri/plugins/mobile-push/android/src/main/AndroidManifest.xml",
);
const mobilePushPluginIos = readText(
  "src-tauri/plugins/mobile-push/ios/Sources/MobilePushPlugin.swift",
);
const mobileKitTauriBridgeTs = readFileSync(
  new URL("../src/tauri-bridge.ts", import.meta.url),
  "utf8",
);

checkPackage(packageJson);
checkTauriConfig(tauriConfig);
checkReleaseVersionSources(tauriConfig);
checkCapabilities(defaultCapability, mobileCapability);
checkCargoToml(cargoToml);
checkRustEntry(libRs);
checkKeystoreSecurity({
  cargoToml,
  keystorePluginCargoToml,
  keystorePluginAndroid,
  keystorePluginAndroidGradle,
  keystorePluginAndroidManifest,
  keystorePluginIos,
  mobileKitTauriBridgeTs,
});
checkIosPlist(iosPlist);
checkViteConfig(viteConfig);
checkNativeBridge(nativeTs, mobileKitTauriBridgeTs);
checkRemotePushPlugin(remotePushPlugin, {
  packageJson,
  defaultCapability,
  mobileCapability,
  cargoToml,
  libRs,
  nativeTs,
  mobilePushPluginCargoToml,
  mobilePushPluginAndroid,
  mobilePushPluginAndroidGradle,
  mobilePushPluginAndroidRuntime,
  mobilePushPluginAndroidService,
  mobilePushPluginAndroidManifest,
  mobilePushPluginIos,
});
checkCliSurface();
checkNativeEnvironment();
printResults();

const hasError = results.some((result) => result.kind === "error");
const hasNativeWarning = results.some((result) => result.native);
if (hasError || (strictNativeEnv && hasNativeWarning)) {
  process.exit(1);
}

function checkPackage(pkg) {
  if (pkg.name) ok(`package: ${pkg.name}`);
  expectDependency(pkg, "@tauri-apps/api");
  expectDependency(pkg, "@tauri-apps/plugin-barcode-scanner");
  expectDependency(pkg, "@tauri-apps/plugin-biometric");
  expectDependency(pkg, "@tauri-apps/plugin-clipboard-manager");
  expectDependency(pkg, "@tauri-apps/plugin-deep-link");
  expectDependency(pkg, "@tauri-apps/plugin-notification");
  expectDependency(pkg, "@tauri-apps/plugin-opener");
  expectDependency(pkg, "@tauri-apps/plugin-os");
  expectDependency(pkg, "@tauri-apps/plugin-store");
  expectDependency(pkg, "@tauri-apps/plugin-stronghold");
  expectDevDependency(pkg, "@tauri-apps/cli");
  expectScript(pkg, "tauri:dev");
  expectScript(pkg, "tauri:build");
  expectScript(pkg, "tauri:android:init");
  expectScript(pkg, "tauri:android:dev");
  expectScript(pkg, "tauri:android:build");
  expectScript(pkg, "tauri:ios:init");
  expectScript(pkg, "tauri:ios:dev");
  expectScript(pkg, "tauri:ios:build");
  expectScript(pkg, "release:native-check");
  expect(
    pkg.scripts?.["release:native-check"]?.includes(
      "check-tauri-mobile-release.mjs",
    ),
    "script release:native-check runs the shared native release checker",
  );
  expectScript(pkg, "release:evidence-check");
  expect(
    pkg.scripts?.["release:evidence-check"]?.includes(
      "check-mobile-release-evidence.mjs",
    ),
    "script release:evidence-check runs the shared release evidence checker",
  );
  expectScript(pkg, "release:check");
  expect(
    pkg.scripts?.["release:check"]?.includes("check-mobile-full-release.mjs"),
    "script release:check runs native and evidence release checks",
  );
  expectScript(pkg, "release:status");
  expectScript(pkg, "release:repo-check");
  expect(
    pkg.scripts?.["release:repo-check"]?.includes("--skip-toolchain-probe") &&
      pkg.scripts?.["release:repo-check"]?.includes("--fail-on-repo-blockers"),
    "script release:repo-check fails only repository-actionable release blockers",
  );
  if (remotePushPlugin) {
    expect(
      pkg.scripts?.["tauri:android:init"]?.includes(
        "init-tauri-mobile-native.mjs --platform android",
      ) &&
        pkg.scripts?.["tauri:ios:init"]?.includes(
          "init-tauri-mobile-native.mjs --platform ios",
        ),
      "native init scripts automatically apply product-owned push wiring",
    );
    expectScript(pkg, "tauri:native-push:apply");
    expectScript(pkg, "tauri:native-push:verify");
    expectScript(pkg, "tauri:native-push:apply:release");
    expectScript(pkg, "tauri:native-push:verify:release");
    expect(
      pkg.scripts?.["tauri:native-push:apply"]?.includes(
        "--apple-environment development",
      ) &&
        pkg.scripts?.["tauri:native-push:verify"]?.includes(
          "--apple-environment development",
        ) &&
        pkg.scripts?.["tauri:native-push:verify"]?.includes("--dry-run") &&
        pkg.scripts?.["tauri:native-push:verify"]?.includes("--strict"),
      "development native-push scripts explicitly use the APNs development entitlement",
    );
    expect(
      pkg.scripts?.["tauri:native-push:apply:release"]?.includes(
        "--apple-environment production",
      ) &&
        pkg.scripts?.["tauri:native-push:verify:release"]?.includes(
          "--apple-environment production",
        ) &&
        pkg.scripts?.["tauri:native-push:verify:release"]?.includes(
          "--dry-run",
        ) &&
        pkg.scripts?.["tauri:native-push:verify:release"]?.includes("--strict"),
      "release native-push scripts explicitly require the APNs production entitlement",
    );
  }
  expect(
    pkg.scripts?.["tauri:android:dev"]?.includes("--host"),
    "script tauri:android:dev exposes the dev server host to devices",
  );
  expect(
    !pkg.scripts?.["tauri:android:dev"]?.includes("--host 0.0.0.0"),
    "script tauri:android:dev does not publish 0.0.0.0 as the device host",
  );
  expect(
    !pkg.scripts?.dev?.includes("--host 0.0.0.0"),
    "script dev leaves mobile host selection to Vite config",
  );
}

function checkTauriConfig(config) {
  expect(config.productName === productName, "tauri.conf productName matches");
  expect(
    typeof config.identifier === "string" &&
      config.identifier.includes(product),
    "tauri.conf identifier is product-scoped",
  );
  expect(
    config.build?.devUrl === `http://localhost:${devPort}`,
    "tauri.conf devUrl matches mobile dev port",
  );
  expect(
    config.build?.frontendDist === "../dist",
    "tauri.conf frontendDist points at Vite dist",
  );
  expect(config.bundle?.active === true, "tauri.conf bundle is enabled");
  const bundleIcons = new Set(config.bundle?.icon ?? []);
  for (const icon of requiredBundleIcons()) {
    expect(bundleIcons.has(icon), `tauri.conf bundle.icon includes ${icon}`);
  }

  const mobileSchemes =
    config.plugins?.["deep-link"]?.mobile?.flatMap((entry) =>
      Array.isArray(entry.scheme) ? entry.scheme : [],
    ) ?? [];
  const desktopSchemes = config.plugins?.["deep-link"]?.desktop?.schemes ?? [];
  expect(
    mobileSchemes.includes(scheme),
    "mobile deep-link scheme is configured",
  );
  expect(
    desktopSchemes.includes(scheme),
    "desktop deep-link scheme is configured",
  );
}

function checkReleaseVersionSources(config) {
  const tauriVersion =
    typeof config.version === "string" && config.version.trim()
      ? config.version.trim()
      : undefined;
  const inspection = inspectMobileReleaseVersions(appDir, tauriVersion);
  for (const issue of inspection.issues) {
    error(`${issue.id}: ${issue.detail}`);
  }
  if (inspection.issues.length === 0 && tauriVersion) {
    ok(`release version sources match: ${tauriVersion}`);
  }
}

function checkIconFiles() {
  checkFile("src-tauri/app-icon.svg");
  for (const icon of requiredBundleIcons()) {
    checkFile(`src-tauri/${icon}`);
  }
  for (const icon of [
    "icons/icon.png",
    "icons/ios/AppIcon-512@2x.png",
    "icons/android/mipmap-xxxhdpi/ic_launcher.png",
  ]) {
    checkFile(`src-tauri/${icon}`);
  }
}

function requiredBundleIcons() {
  return [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico",
  ];
}

function checkCapabilities(defaultCapability, mobileCapability) {
  const defaultPermissions = new Set(defaultCapability.permissions ?? []);
  const mobilePermissions = new Set(mobileCapability.permissions ?? []);
  const desktopRequired = [
    "core:default",
    "core:event:default",
    "core:path:default",
    "clipboard-manager:allow-write-text",
    "deep-link:default",
    "notification:default",
    "opener:allow-default-urls",
    "os:default",
    "store:default",
    "stronghold:default",
  ];
  const mobileRequired = [
    "barcode-scanner:allow-cancel",
    "barcode-scanner:allow-scan",
    "biometric:default",
    "clipboard-manager:allow-write-text",
    "core:event:default",
    "core:path:default",
    "deep-link:default",
    "keystore:default",
    "notification:default",
    "opener:allow-default-urls",
    "os:default",
    "store:default",
    "stronghold:default",
  ];

  for (const permission of desktopRequired) {
    expect(
      defaultPermissions.has(permission),
      `desktop capability includes ${permission}`,
    );
  }
  expect(
    mobileCapability.platforms?.includes("iOS") &&
      mobileCapability.platforms?.includes("android"),
    "mobile capability targets iOS and Android",
  );
  for (const permission of mobileRequired) {
    expect(
      mobilePermissions.has(permission),
      `mobile capability includes ${permission}`,
    );
  }
}

function checkCargoToml(cargoToml) {
  expect(cargoToml.includes("tauri ="), "Cargo.toml depends on tauri");
  expect(
    cargoToml.includes("tauri-plugin-clipboard-manager"),
    "Cargo.toml registers clipboard-manager plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-deep-link"),
    "Cargo.toml registers deep-link plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-notification"),
    "Cargo.toml registers notification plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-opener"),
    "Cargo.toml registers opener plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-os"),
    "Cargo.toml registers OS plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-store"),
    "Cargo.toml registers store plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-stronghold"),
    "Cargo.toml registers stronghold plugin dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-barcode-scanner"),
    "Cargo.toml registers mobile barcode scanner dependency",
  );
  expect(
    cargoToml.includes("tauri-plugin-biometric"),
    "Cargo.toml registers mobile biometric dependency",
  );
  expect(
    /tauri-plugin-keystore\s*=\s*\{\s*path\s*=\s*["']plugins\/keystore["']\s*\}/.test(
      cargoToml,
    ),
    "Cargo.toml registers the product-owned mobile keystore",
  );
  expect(
    !cargoToml.includes('tauri-plugin-keystore = "2.1.0-alpha') &&
      !cargoToml.includes("tauri-plugin-keystore = '2.1.0-alpha"),
    "Cargo.toml does not use the unsafe alpha keystore package",
  );
  expect(
    cargoToml.includes('cfg(any(target_os = "android", target_os = "ios"))'),
    "mobile native dependencies are mobile-target scoped",
  );
}

function checkKeystoreSecurity({
  cargoToml,
  keystorePluginCargoToml,
  keystorePluginAndroid,
  keystorePluginAndroidGradle,
  keystorePluginAndroidManifest,
  keystorePluginIos,
  mobileKitTauriBridgeTs,
}) {
  expect(
    cargoToml.includes('path = "plugins/keystore"'),
    "mobile keystore source is owned by the product",
  );
  expect(
    keystorePluginCargoToml.includes("publish = false") &&
      keystorePluginCargoToml.includes('license = "AGPL-3.0-only"'),
    "product-owned keystore is private and uses the product license",
  );
  expect(
    keystorePluginAndroid.includes("request.service") &&
      keystorePluginAndroid.includes("request.user") &&
      keystorePluginAndroid.includes("AndroidKeyStore") &&
      keystorePluginAndroid.includes("AES/GCM/NoPadding") &&
      keystorePluginAndroid.includes(".commit()"),
    "Android keystore scopes each item and confirms encrypted persistence",
  );
  expect(
    keystorePluginAndroidGradle.includes("minSdk = 24") &&
      !keystorePluginAndroidManifest.includes("<uses-sdk"),
    "Android keystore supports the app minimum SDK without a manifest override",
  );
  expect(
    !/unime|identity-wallet/i.test(keystorePluginAndroid),
    "Android keystore has no unrelated product identifiers",
  );
  expect(
    keystorePluginIos.includes("kSecAttrService") &&
      keystorePluginIos.includes("kSecAttrAccount") &&
      keystorePluginIos.includes(
        "kSecAttrAccessibleWhenUnlockedThisDeviceOnly",
      ),
    "iOS keystore uses device-local service/account Keychain items",
  );
  expect(
    !/unime|identity-wallet/i.test(keystorePluginIos),
    "iOS keystore has no unrelated product identifiers",
  );
  expect(
    mobileKitTauriBridgeTs.includes("payload: { service, user, value }") &&
      mobileKitTauriBridgeTs.includes(
        "removeVerifiedStrongholdPasswordMigrationFallback",
      ) &&
      mobileKitTauriBridgeTs.includes("await handle.delete(key)"),
    "Stronghold seed migration deletes plaintext only after native read-back",
  );
}

function checkRustEntry(libRs) {
  expect(
    libRs.includes("tauri_plugin_stronghold"),
    "Rust entry registers stronghold plugin",
  );
  expect(
    libRs.includes("tauri_plugin_clipboard_manager::init"),
    "Rust entry registers clipboard-manager plugin",
  );
  expect(
    libRs.includes("Builder::with_argon2"),
    "Rust entry uses Stronghold's built-in argon2 password hashing",
  );
  expect(
    libRs.includes("tauri_plugin_os::init"),
    "Rust entry registers OS plugin",
  );
  expect(
    libRs.includes("tauri_plugin_biometric::init"),
    "Rust entry registers biometric plugin",
  );
  expect(
    libRs.includes("tauri_plugin_keystore::init"),
    "Rust entry registers mobile keystore plugin",
  );
  expect(
    libRs.includes("create_dir_all"),
    "Rust entry prepares Stronghold salt storage directory",
  );
}

function checkIosPlist(iosPlist) {
  expect(
    iosPlist.includes("NSCameraUsageDescription"),
    "iOS camera usage description is present",
  );
  expect(
    iosPlist.includes("NSFaceIDUsageDescription"),
    "iOS Face ID usage description is present",
  );
}

function checkViteConfig(viteConfig) {
  const usesSharedViteConfig =
    viteConfig.includes("createTauriMobileViteConfig") &&
    viteConfig.includes("importMetaUrl: import.meta.url");
  expect(
    usesSharedViteConfig || viteConfig.includes("TAURI_DEV_HOST"),
    "Vite config reads TAURI_DEV_HOST for mobile devices",
  );
  expect(
    viteConfig.includes(`const devPort = ${devPort}`),
    "Vite config declares the doctor-checked dev port",
  );
  expect(
    usesSharedViteConfig || viteConfig.includes("host: host || false"),
    "Vite config exposes the dev server through the selected mobile host",
  );
  expect(
    usesSharedViteConfig || viteConfig.includes("hmr: host"),
    "Vite config pins HMR to the selected mobile host",
  );
}

function checkNativeBridge(nativeTs, mobileKitTauriBridgeTs) {
  expect(
    nativeTs.includes("createTauriMobileDefaultProductBridge"),
    "native bridge uses the shared default Tauri product bridge",
  );
  expect(
    nativeTs.includes("keychainService:") &&
      mobileKitTauriBridgeTs.includes("createTauriKeystoreStrongholdPassword"),
    "native bridge derives Stronghold password through product-local keystore source",
  );
  expect(
    mobileKitTauriBridgeTs.includes("createTauriInvokeKeystoreAdapter"),
    "native bridge wires Tauri keystore commands through a typed adapter",
  );
  expect(
    mobileKitTauriBridgeTs.includes("createTauriMobileProductStorageNames") &&
      mobileKitTauriBridgeTs.includes("storageNames.strongholdPasswordKey"),
    "native bridge recognizes the product-scoped legacy Store migration source",
  );
  expect(
    !nativeTs.includes(`${product}-mobile-stronghold-v1`) &&
      !mobileKitTauriBridgeTs.includes(`${product}-mobile-stronghold-v1`),
    "native bridge does not use the checked-in Stronghold development password",
  );
  expect(
    nativeTs.includes("@tauri-apps/plugin-clipboard-manager") &&
      nativeTs.includes("writeText") &&
      nativeTs.includes("clipboard:"),
    "native bridge wires clipboard-manager text writes through the shared bridge",
  );
}

function checkRemotePushPlugin(
  plugin,
  {
    packageJson,
    mobileCapability,
    cargoToml,
    libRs,
    nativeTs,
    mobilePushPluginCargoToml,
    mobilePushPluginAndroid,
    mobilePushPluginAndroidGradle,
    mobilePushPluginAndroidRuntime,
    mobilePushPluginAndroidService,
    mobilePushPluginAndroidManifest,
    mobilePushPluginIos,
  },
) {
  if (!plugin) return;
  if (plugin !== "mobile-push") {
    error(`unsupported --remote-push-plugin value: ${plugin}`);
    return;
  }

  ok("remote push plugin profile: mobile-push");
  expect(
    !packageJson.dependencies?.["tauri-plugin-mobile-push-api"],
    "mobile shell does not use the community mobile-push JavaScript package",
  );
  expect(
    new Set(mobileCapability.permissions ?? []).has("mobile-push:default"),
    "mobile capability includes mobile-push:default",
  );
  expect(
    /tauri-plugin-mobile-push\s*=\s*\{\s*path\s*=\s*["']plugins\/mobile-push["']\s*\}/.test(
      cargoToml,
    ),
    "Cargo.toml registers the product-owned mobile-push plugin",
  );
  expect(
    libRs.includes("tauri_plugin_mobile_push::init"),
    "Rust entry registers mobile-push plugin",
  );
  expect(
    nativeTs.includes("takosMobilePushPlugin") &&
      nativeTs.includes("mobilePush:"),
    "native bridge wires the product-owned mobile-push module",
  );
  expect(
    mobilePushPluginCargoToml.includes("publish = false") &&
      mobilePushPluginCargoToml.includes('license = "AGPL-3.0-only"') &&
      !mobilePushPluginCargoToml.includes('tauri-plugin-mobile-push = "0.1.4"'),
    "mobile-push plugin is private, product-licensed, and not the community alpha package",
  );
  expect(
    mobilePushPluginAndroidService.includes("FirebaseMessagingService") &&
      mobilePushPluginAndroidService.includes("onRegistered") &&
      !mobilePushPluginAndroidService.includes("onNewToken") &&
      mobilePushPluginAndroidService.includes("onMessageReceived") &&
      mobilePushPluginAndroid.includes(
        "FirebaseMessaging.getInstance().register()",
      ) &&
      mobilePushPluginAndroid.includes(
        "FirebaseMessaging.getInstance().unregister()",
      ) &&
      mobilePushPluginAndroid.includes(
        "FirebaseInstallations.getInstance().id",
      ) &&
      mobilePushPluginAndroid.includes("REGISTRATION_REQUEST_TIMEOUT_MILLIS") &&
      mobilePushPluginAndroid.includes("AtomicBoolean(false)") &&
      !mobilePushPluginAndroid.includes(".deleteToken()") &&
      !mobilePushPluginAndroid.includes(".getToken()"),
    "Android plugin uses bounded FCM FID registration/unregistration and current lifecycle callbacks",
  );
  expect(
    mobilePushPluginAndroidGradle.includes("minSdk = 24") &&
      mobilePushPluginAndroidGradle.includes(
        'implementation("androidx.appcompat:appcompat:1.6.0")',
      ) &&
      !mobilePushPluginAndroidManifest.includes("<uses-sdk"),
    "Android push plugin supports the app minimum SDK and declares its lifecycle dependency",
  );
  expect(
    mobilePushPluginAndroidManifest.includes(
      "jp.takos.mobile.push.TakosFirebaseMessagingService",
    ) &&
      mobilePushPluginAndroidManifest.includes(
        "com.google.firebase.MESSAGING_EVENT",
      ) &&
      mobilePushPluginAndroidManifest.includes("POST_NOTIFICATIONS") &&
      mobilePushPluginAndroidManifest.includes(
        "firebase_messaging_installation_id_enabled",
      ) &&
      mobilePushPluginAndroidManifest.includes(
        "firebase_messaging_auto_init_enabled",
      ) &&
      mobilePushPluginAndroidManifest.includes('android:value="false"'),
    "Android plugin owns its FCM service, FID opt-in, session-bound auto-init policy, and notification permission manifest",
  );
  expect(
    mobilePushPluginAndroidRuntime.includes("event in activatedEvents") &&
      !mobilePushPluginAndroidRuntime.includes("activeListeners") &&
      mobilePushPluginIos.includes("activatedEvents.contains(event)") &&
      !mobilePushPluginIos.includes("activeListeners"),
    "native push uses an idempotent event barrier without a parallel listener count",
  );
  expect(
    mobilePushPluginIos.includes("registerForRemoteNotifications()") &&
      mobilePushPluginIos.includes(
        "didRegisterForRemoteNotificationsWithDeviceToken",
      ) &&
      mobilePushPluginIos.includes(
        "didFailToRegisterForRemoteNotificationsWithError",
      ) &&
      mobilePushPluginIos.includes("requestAuthorization") &&
      mobilePushPluginIos.includes('return "sandbox"') &&
      mobilePushPluginIos.includes('return "production"') &&
      mobilePushPluginIos.includes("Bundle.main.object(") &&
      mobilePushPluginIos.includes("TauriMobilePushAPNSEnvironment") &&
      !mobilePushPluginIos.includes("SecTask") &&
      !mobilePushPluginIos.includes("#if DEBUG") &&
      mobilePushPluginIos.includes("tokenRequestTimeoutSeconds") &&
      mobilePushPluginIos.includes("timeoutPendingTokenInvoke") &&
      mobilePushPluginIos.includes("unregisterForRemoteNotifications()") &&
      mobilePushPluginIos.includes("registrationRequested") &&
      mobilePushPluginIos.includes("UNPushNotificationTrigger.self") &&
      !mobilePushPluginIos.includes("UserDefaults"),
    "iOS plugin separates permission from bounded session registration, unregisters on logout, and reads the signed bundle APNs environment",
  );
  expect(
    mobilePushPluginIos.includes("notification-received") &&
      mobilePushPluginIos.includes("notification-tapped") &&
      mobilePushPluginIos.includes("token-refresh"),
    "iOS plugin exposes notification and token-refresh lifecycle events",
  );
  checkRemotePushNativeProjectFiles();
}

function checkRemotePushNativeProjectFiles() {
  checkIosPushEntitlement();
  checkAndroidFirebaseProjectFiles();
}

function checkIosPushEntitlement() {
  const appleDir = path.join(appDir, "src-tauri/gen/apple");
  if (!existsSync(appleDir)) {
    warn(
      "iOS Push Notifications capability and aps-environment entitlement must be enabled after tauri ios init; run tauri:native-push:apply after init",
      true,
    );
    return;
  }

  const entitlementFiles = collectFiles(appleDir).filter((filePath) =>
    filePath.endsWith(".entitlements"),
  );
  if (entitlementFiles.length === 0) {
    warn(
      "iOS aps-environment entitlement file is missing after tauri ios init; add Push Notifications in Xcode, then run tauri:native-push:apply",
      true,
    );
    return;
  }

  const environments = entitlementFiles
    .map((filePath) => readApsEnvironment(readFileSync(filePath, "utf8")))
    .filter((value) => value !== undefined);
  if (environments.length === 0) {
    warn("iOS aps-environment entitlement is missing", true);
  } else if (
    environments.every(
      (environment) =>
        environment === "development" || environment === "production",
    )
  ) {
    ok(
      `iOS aps-environment entitlement is valid: ${[...new Set(environments)].join(", ")}`,
    );
  } else {
    warn("iOS aps-environment entitlement has an invalid value", true);
  }

  const bundleEnvironments = collectFiles(appleDir)
    .filter((filePath) => path.basename(filePath) === "Info.plist")
    .map((filePath) =>
      readPlistString(
        readFileSync(filePath, "utf8"),
        "TauriMobilePushAPNSEnvironment",
      ),
    )
    .filter((value) => value !== undefined);
  const distinctEntitlements = [...new Set(environments)];
  const distinctBundleEnvironments = [...new Set(bundleEnvironments)];
  if (
    distinctEntitlements.length === 1 &&
    distinctBundleEnvironments.length === 1 &&
    distinctBundleEnvironments[0] === distinctEntitlements[0]
  ) {
    ok(
      `iOS signed bundle APNs environment matches entitlement: ${distinctBundleEnvironments[0]}`,
    );
  } else {
    warn(
      "iOS signed bundle APNs environment is missing or does not match the entitlement; run tauri:native-push:apply",
      true,
    );
  }
}

function readApsEnvironment(xml) {
  return readPlistString(xml, "aps-environment");
}

function readPlistString(xml, key) {
  return xml.match(
    new RegExp(
      `<key>\\s*${key}\\s*<\\/key>\\s*<string>\\s*([^<]+?)\\s*<\\/string>`,
      "u",
    ),
  )?.[1];
}

function checkAndroidFirebaseProjectFiles() {
  if (
    existsSync(
      path.join(appDir, "src-tauri/gen/android/app/google-services.json"),
    )
  ) {
    ok("Android google-services.json exists for Firebase Cloud Messaging");
  } else {
    warn(
      "Android FCM needs src-tauri/gen/android/app/google-services.json after tauri android init; run tauri:native-push:apply after adding it",
      true,
    );
  }

  const androidDir = path.join(appDir, "src-tauri/gen/android");
  if (!existsSync(androidDir)) {
    warn(
      "Android Firebase Gradle wiring must be added after tauri android init; run tauri:native-push:apply after init",
      true,
    );
    return;
  }

  const androidFiles = collectFiles(androidDir);
  const gradleFiles = androidFiles.filter(
    (filePath) =>
      filePath.endsWith("build.gradle") ||
      filePath.endsWith("build.gradle.kts"),
  );
  const gradleText = gradleFiles
    .map((filePath) => readFileSync(filePath, "utf8"))
    .join("\n");
  if (
    gradleText.includes("com.google.gms.google-services") &&
    gradleText.includes("firebase-messaging") &&
    gradleText.includes("firebase-installations")
  ) {
    ok("Android Firebase Messaging and Installations Gradle wiring is present");
  } else {
    warn(
      "Android Firebase Messaging or Installations Gradle wiring is missing",
      true,
    );
  }

  ok("Android FCM service is supplied by the product-owned plugin manifest");
}

function collectFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(filePath));
    else if (entry.isFile()) files.push(filePath);
  }
  return files;
}

function checkCliSurface() {
  const version = run("bunx", ["tauri", "--version"]);
  if (version.ok) ok(`Tauri CLI: ${version.output.trim()}`);
  else warn("Tauri CLI is unavailable", true);

  const androidHelp = run("bunx", ["tauri", "android", "--help"]);
  if (androidHelp.ok) ok("Tauri Android subcommand is available");
  else warn("Tauri Android subcommand is unavailable", true);

  const iosHelp = run("bunx", ["tauri", "ios", "--help"]);
  if (iosHelp.ok) ok("Tauri iOS subcommand is available");
  else warn("Tauri iOS subcommand is unavailable on this host/CLI build", true);
}

function checkNativeEnvironment() {
  const java = run("java", ["-version"]);
  if (java.ok) ok("Java is available for Android target init");
  else warn("Java is missing; tauri android init/build cannot run", true);

  if (process.env.JAVA_HOME) ok("JAVA_HOME is set");
  else warn("JAVA_HOME is not set", true);

  if (process.env.ANDROID_HOME) ok("ANDROID_HOME is set");
  else warn("ANDROID_HOME is not set", true);

  if (process.env.NDK_HOME) ok("NDK_HOME is set");
  else warn("NDK_HOME is not set", true);

  if (process.platform === "darwin") {
    const xcodebuild = run("xcodebuild", ["-version"]);
    if (xcodebuild.ok) ok("Xcode command line tools are available");
    else
      warn("Xcode command line tools are missing; tauri ios cannot run", true);

    const simctl = run("xcrun", ["simctl", "help"]);
    if (simctl.ok) ok("xcrun simctl is available for iOS simulators");
    else warn("xcrun simctl is missing; iOS simulator dev cannot run", true);
  } else {
    warn("iOS native builds require macOS with Xcode", true);
  }

  const rustTargets = run("rustup", ["target", "list", "--installed"]);
  if (!rustTargets.ok) {
    warn("rustup target list is unavailable", true);
    return;
  }
  const installed = new Set(rustTargets.output.trim().split(/\s+/));
  checkRustTargets("Android", installed, [
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "i686-linux-android",
    "x86_64-linux-android",
  ]);
  checkRustTargets("iOS", installed, [
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
    "x86_64-apple-ios",
  ]);
}

function checkRustTargets(platform, installed, targets) {
  for (const target of targets) {
    if (installed.has(target))
      ok(`${platform} Rust target installed: ${target}`);
    else warn(`${platform} Rust target missing: ${target}`, true);
  }
}

function checkFile(relativePath) {
  if (existsSync(path.join(appDir, relativePath))) ok(`${relativePath} exists`);
  else error(`${relativePath} is missing`);
}

function readJson(relativePath) {
  const text = readText(relativePath);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (cause) {
    error(`${relativePath} is not valid JSON: ${cause.message}`);
    return {};
  }
}

function readText(relativePath) {
  const filePath = path.join(appDir, relativePath);
  if (!existsSync(filePath)) return "";
  return readFileSync(filePath, "utf8");
}

function expectDependency(pkg, name) {
  expect(Boolean(pkg.dependencies?.[name]), `dependency ${name} is declared`);
}

function expectDevDependency(pkg, name) {
  expect(
    Boolean(pkg.devDependencies?.[name]),
    `devDependency ${name} is declared`,
  );
}

function expectScript(pkg, name) {
  expect(Boolean(pkg.scripts?.[name]), `script ${name} is declared`);
}

function expect(condition, message) {
  if (condition) ok(message);
  else error(message);
}

function ok(message) {
  results.push({ kind: "ok", message });
}

function warn(message, native = false) {
  results.push({ kind: "warn", message, native });
}

function error(message) {
  results.push({ kind: "error", message });
}

function printResults() {
  console.log(`Tauri mobile doctor: ${productName} (${appDir})`);
  for (const result of results) {
    const label =
      result.kind === "ok" ? "OK" : result.kind === "warn" ? "WARN" : "FAIL";
    console.log(`${label} ${result.message}`);
  }
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: appDir,
    encoding: "utf8",
  });
  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

function requireArg(value, name) {
  if (value) return value;
  console.error(`Missing required ${name}`);
  process.exit(2);
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg
      .slice(2)
      .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    if (key === "strictNativeEnv") {
      parsed.strictNativeEnv = true;
      continue;
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
