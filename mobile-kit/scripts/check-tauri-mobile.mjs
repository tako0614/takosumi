#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

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
const mobileKitTauriBridgeTs = readFileSync(
  new URL("../src/tauri-bridge.ts", import.meta.url),
  "utf8",
);

checkPackage(packageJson);
checkTauriConfig(tauriConfig);
checkCapabilities(defaultCapability, mobileCapability);
checkCargoToml(cargoToml);
checkRustEntry(libRs);
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
    pkg.scripts?.["release:check"]?.includes(
      "check-mobile-full-release.mjs",
    ),
    "script release:check runs native and evidence release checks",
  );
  expectScript(pkg, "tauri:native-push:apply");
  expectScript(pkg, "tauri:native-push:verify");
  expect(
    pkg.scripts?.["tauri:native-push:verify"]?.includes("--dry-run") &&
      pkg.scripts?.["tauri:native-push:verify"]?.includes("--strict"),
    "script tauri:native-push:verify checks generated native push wiring without mutation",
  );
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
    cargoToml.includes("tauri-plugin-keystore"),
    "Cargo.toml registers mobile keystore dependency",
  );
  expect(
    cargoToml.includes('cfg(any(target_os = "android", target_os = "ios"))'),
    "mobile native dependencies are mobile-target scoped",
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
    "native bridge keeps a product-scoped Store fallback for Stronghold password migration",
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
  { packageJson, mobileCapability, cargoToml, libRs, nativeTs },
) {
  if (!plugin) return;
  if (plugin !== "mobile-push") {
    error(`unsupported --remote-push-plugin value: ${plugin}`);
    return;
  }

  ok("remote push plugin profile: mobile-push");
  expectDependency(packageJson, "tauri-plugin-mobile-push-api");
  expect(
    new Set(mobileCapability.permissions ?? []).has("mobile-push:default"),
    "mobile capability includes mobile-push:default",
  );
  expect(
    cargoToml.includes("tauri-plugin-mobile-push"),
    "Cargo.toml registers mobile-push plugin dependency",
  );
  expect(
    libRs.includes("tauri_plugin_mobile_push::init"),
    "Rust entry registers mobile-push plugin",
  );
  expect(
    nativeTs.includes("onNotificationReceived") &&
      nativeTs.includes("onNotificationTapped") &&
      nativeTs.includes("onTokenRefresh"),
    "native bridge wires mobile-push event listeners",
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

  const hasPushEntitlement = entitlementFiles.some((filePath) =>
    readFileSync(filePath, "utf8").includes("aps-environment"),
  );
  if (hasPushEntitlement) ok("iOS aps-environment entitlement is present");
  else warn("iOS aps-environment entitlement is missing", true);
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
      "Android Firebase Gradle and FCM service wiring must be added after tauri android init; run tauri:native-push:apply after init",
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
    gradleText.includes("firebase-messaging")
  ) {
    ok("Android Firebase Messaging Gradle wiring is present");
  } else {
    warn("Android Firebase Messaging Gradle wiring is missing", true);
  }

  const manifest = androidFiles.find((filePath) =>
    filePath.endsWith("AndroidManifest.xml"),
  );
  if (
    manifest &&
    readFileSync(manifest, "utf8").includes("app.tauri.mobilepush.FCMService")
  ) {
    ok("Android FCM service manifest entry is present");
  } else {
    warn("Android FCM service manifest entry is missing", true);
  }
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
