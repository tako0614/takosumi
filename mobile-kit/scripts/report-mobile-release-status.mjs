#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inspectMobileReleaseVersions } from "./mobile-release-versions.mjs";
import { validateMobileReleaseEvidence } from "./mobile-release-evidence-validation.mjs";

const args = parseArgs(process.argv.slice(2));
const appDir = path.resolve(args.appDir ?? process.cwd());
const product = requireArg(args.product, "--product");
const productName = requireArg(args.productName, "--product-name");
const bundleId = requireArg(args.bundleId, "--bundle-id");
const evidenceFile = path.resolve(
  appDir,
  args.file ??
    process.env.MOBILE_RELEASE_EVIDENCE_FILE ??
    "release/mobile-release-evidence.json",
);
const jsonOutput = Boolean(args.json);
const failOnBlockers = Boolean(args.failOnBlockers);
const failOnRepoBlockers = Boolean(args.failOnRepoBlockers);
const skipToolchainProbe = Boolean(args.skipToolchainProbe);
const requireSecureKeystore = Boolean(args.requireSecureKeystore);
const requireRemotePush = Boolean(args.requireRemotePush);

const blockers = [];
const facts = {
  appDir,
  product,
  productName,
  bundleId,
  evidenceFile,
};

const REPO_ACTION = {
  actionability: "repo",
  owner: "product-maintainer",
};
const RELEASE_ENVIRONMENT_ACTION = {
  actionability: "release-environment",
  owner: "release-engineer",
};
const OPERATOR_CONFIG_ACTION = {
  actionability: "operator-config",
  owner: "mobile-operator",
};
const STORE_EVIDENCE_ACTION = {
  actionability: "store-evidence",
  owner: "store-release-operator",
};

const tauriConfig = readJson(
  path.join(appDir, "src-tauri/tauri.conf.json"),
  REPO_ACTION,
);
checkTauriConfig(tauriConfig);
checkReleaseVersionSources();
if (requireSecureKeystore) checkSecureKeystoreImplementation();
if (requireRemotePush) checkRemotePushImplementation();
checkGeneratedNativeProjects();
if (!skipToolchainProbe) checkLocalToolchain();
checkEvidenceFile();

const report = {
  schema: "takos.mobile-release-status.v1",
  product,
  productName,
  bundleId,
  appDir,
  ready: blockers.length === 0,
  blockers,
  facts,
};

if (jsonOutput) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printTextReport(report);
}

if (failOnBlockers && blockers.length > 0) process.exit(1);
if (
  failOnRepoBlockers &&
  blockers.some((item) => item.actionability === "repo")
) {
  process.exit(1);
}

function checkTauriConfig(config) {
  if (!config) return;
  if (config.productName !== productName) {
    blocker(
      "tauri.product_name_mismatch",
      "Tauri productName does not match the release product.",
      `Expected ${productName}, found ${String(config.productName ?? "")}.`,
      "Fix src-tauri/tauri.conf.json productName before release.",
    );
  }
  if (config.identifier !== bundleId) {
    blocker(
      "tauri.bundle_id_mismatch",
      "Tauri bundle identifier does not match the release bundle id.",
      `Expected ${bundleId}, found ${String(config.identifier ?? "")}.`,
      "Fix src-tauri/tauri.conf.json identifier before release.",
    );
  }
  const version = optionalText(config.version);
  facts.tauriVersion = version;
  if (!version) {
    blocker(
      "tauri.version_missing",
      "Tauri release version is missing.",
      "src-tauri/tauri.conf.json has no version.",
      "Set a product release version before store packaging.",
    );
    return;
  }
  if (version === "0.0.0") {
    blocker(
      "tauri.version_placeholder",
      "Tauri release version is still 0.0.0.",
      "Store evidence must match a real semver-like release version.",
      "Set src-tauri/tauri.conf.json version to the release version.",
    );
    return;
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    blocker(
      "tauri.version_invalid",
      "Tauri release version is not semver-like.",
      `Found ${version}.`,
      "Use a semver-like release version.",
    );
  }
}

function checkReleaseVersionSources() {
  const inspection = inspectMobileReleaseVersions(appDir, facts.tauriVersion);
  facts.packageVersion = inspection.packageVersion;
  facts.cargoVersion = inspection.cargoVersion;
  facts.cargoLockVersion = inspection.cargoLockVersion;
  for (const issue of inspection.issues) {
    blocker(issue.id, issue.label, issue.detail, issue.action);
  }
}

function checkSecureKeystoreImplementation() {
  const cargoTomlPath = path.join(appDir, "src-tauri/Cargo.toml");
  const cargoToml = readText(cargoTomlPath);
  const pluginRoot = path.join(appDir, "src-tauri/plugins/keystore");
  facts.secureKeystore = {
    dependency: "plugins/keystore",
    pluginRoot: relative(pluginRoot),
  };
  if (
    !cargoToml ||
    !/tauri-plugin-keystore\s*=\s*\{\s*path\s*=\s*["']plugins\/keystore["']\s*\}/.test(
      cargoToml,
    )
  ) {
    blocker(
      "security.keystore_product_owned_dependency_missing",
      "Product-owned native keystore dependency is missing.",
      "src-tauri/Cargo.toml must use the audited plugins/keystore path dependency.",
      "Use the product-owned Android Keystore / iOS Keychain plugin; do not ship the alpha community package.",
    );
  }
  for (const nativeFile of [
    "Cargo.toml",
    "android/src/main/java/KeystorePlugin.kt",
    "ios/Sources/KeystorePlugin.swift",
  ]) {
    const filePath = path.join(pluginRoot, nativeFile);
    if (!existsSync(filePath)) {
      blocker(
        "security.keystore_native_source_missing",
        "Product-owned native keystore source is incomplete.",
        `${relative(filePath)} does not exist.`,
        "Restore the audited Android and iOS secure-storage implementation before release.",
      );
    }
  }
  if (/tauri-plugin-keystore\s*=\s*["'][^"']*alpha/i.test(cargoToml ?? "")) {
    blocker(
      "security.keystore_alpha_dependency",
      "Unsafe alpha keystore dependency is still enabled.",
      "The alpha package has unrelated hard-coded identifiers and can report success before persistence.",
      "Remove the alpha dependency and use the product-owned native keystore.",
    );
  }
}

function checkRemotePushImplementation() {
  const cargoToml = readText(path.join(appDir, "src-tauri/Cargo.toml")) ?? "";
  const productPluginRoot = path.join(appDir, "src-tauri/plugins/mobile-push");
  const backendFile = args.remotePushBackendFile
    ? path.resolve(appDir, args.remotePushBackendFile)
    : undefined;
  const productOwnedDependency =
    /tauri-plugin-mobile-push\s*=\s*\{\s*path\s*=\s*["']plugins\/mobile-push["']\s*\}/.test(
      cargoToml,
    );
  facts.remotePush = {
    required: true,
    enabled: productOwnedDependency,
    pluginRoot: relative(productPluginRoot),
    providers: ["apns", "fcm"],
    backendFile: backendFile ? relative(backendFile) : undefined,
  };
  if (/tauri-plugin-mobile-push\s*=\s*["']0\.1\.4["']/.test(cargoToml)) {
    blocker(
      "remote_push.community_plugin_unverified",
      "Community remote-push plugin is not a GA implementation.",
      "The locked plugin does not provide a verified Android command path or complete lifecycle events.",
      "Replace it with a product-owned APNs/FCM plugin and physical-device evidence.",
    );
  } else if (!productOwnedDependency || !hasProductOwnedPushSources()) {
    blocker(
      "remote_push.native_implementation_missing",
      "Product-owned APNs/FCM native implementation is missing.",
      "Remote push is intentionally feature-off in the shipping bridge.",
      "Implement the product-owned native plugin, token rotation, and iOS/Android device tests before enabling it.",
    );
  }
  if (!backendFile || !existsSync(backendFile)) {
    blocker(
      "remote_push.delivery_backend_missing",
      "Remote-push delivery backend is missing.",
      backendFile
        ? `${relative(backendFile)} does not exist.`
        : "No --remote-push-backend-file was configured.",
      "Implement event-id-only gateway dispatch, rejected-pushkey cleanup, bounded retries, and retention handling; provider credentials stay in the gateway.",
    );
  } else {
    const backendSource = readText(backendFile) ?? "";
    const requiredGatewayMarkers = [
      "NOTIFICATION_PUSH_DELIVERY_BACKEND",
      "createNotificationPushGatewayRequest",
      "deliverNotificationToPushers",
      "pruneStaleNotificationPushers",
      "TAKOS_EGRESS",
    ];
    const missingMarkers = requiredGatewayMarkers.filter(
      (marker) => !backendSource.includes(marker),
    );
    facts.remotePush.deliveryBackend = "takos.notification-pusher-gateway.v1";
    if (missingMarkers.length > 0) {
      blocker(
        "remote_push.delivery_backend_incomplete",
        "Remote-push gateway dispatcher is incomplete.",
        `${relative(backendFile)} is missing required implementation markers: ${missingMarkers.join(", ")}.`,
        "Restore event-id-only gateway dispatch, rejected-pushkey cleanup, SSRF-gated egress, and retention handling.",
      );
    }
  }

  function hasProductOwnedPushSources() {
    return [
      "Cargo.toml",
      "android/src/main/AndroidManifest.xml",
      "android/src/main/java/MobilePushPlugin.kt",
      "android/src/main/java/TakosFirebaseMessagingService.kt",
      "ios/Sources/MobilePushPlugin.swift",
    ].every((relativePath) =>
      existsSync(path.join(productPluginRoot, relativePath)),
    );
  }
}

function checkGeneratedNativeProjects() {
  const appleProject = path.join(appDir, "src-tauri/gen/apple");
  const androidProject = path.join(appDir, "src-tauri/gen/android");
  const googleServices = path.join(
    appDir,
    "src-tauri/gen/android/app/google-services.json",
  );
  facts.appleProject = relative(appleProject);
  facts.androidProject = relative(androidProject);
  facts.googleServices = relative(googleServices);
  if (!existsSync(appleProject)) {
    blocker(
      "native.apple.generated_project_missing",
      "Generated iOS project is missing.",
      `${relative(appleProject)} does not exist.`,
      "Run the product tauri:ios:init script on macOS/Xcode, then run native integration checks.",
      RELEASE_ENVIRONMENT_ACTION,
    );
  } else {
    checkAppleProductionEnvironment(appleProject);
  }
  if (!existsSync(androidProject)) {
    blocker(
      "native.android.generated_project_missing",
      "Generated Android project is missing.",
      `${relative(androidProject)} does not exist.`,
      "Run the product tauri:android:init script, then run native integration checks.",
      RELEASE_ENVIRONMENT_ACTION,
    );
    return;
  }
  if (!existsSync(googleServices)) {
    blocker(
      "native.android.google_services_missing",
      "Android Firebase configuration is missing.",
      `${relative(googleServices)} does not exist.`,
      "Add product-owned Firebase/FCM google-services.json outside shared mobile-kit.",
      OPERATOR_CONFIG_ACTION,
    );
    return;
  }
  checkAndroidFirebaseConfiguration(androidProject, googleServices);
}

function checkAndroidFirebaseConfiguration(androidProject, googleServices) {
  let config;
  try {
    config = JSON.parse(readFileSync(googleServices, "utf8"));
  } catch (cause) {
    blocker(
      "native.android.google_services_invalid_json",
      "Android Firebase configuration is invalid JSON.",
      `${relative(googleServices)}: ${cause.message}`,
      "Replace google-services.json with the product's Firebase Android app configuration.",
      OPERATOR_CONFIG_ACTION,
    );
    return;
  }

  const projectInfo = config?.project_info;
  const clients = Array.isArray(config?.client) ? config.client : [];
  const matchingClient = clients.find(
    (client) =>
      client?.client_info?.android_client_info?.package_name === bundleId,
  );
  const projectNumber = optionalText(projectInfo?.project_number);
  const appId = optionalText(matchingClient?.client_info?.mobilesdk_app_id);
  const apiKeys = Array.isArray(matchingClient?.api_key)
    ? matchingClient.api_key
        .map((entry) => optionalText(entry?.current_key))
        .filter(Boolean)
    : [];
  const invalidFields = [];
  if (!projectNumber || /^0+$/.test(projectNumber)) {
    invalidFields.push("project_info.project_number");
  }
  if (!matchingClient) {
    invalidFields.push(`client package ${bundleId}`);
  }
  if (!appId || /:0+$/.test(appId)) {
    invalidFields.push("client_info.mobilesdk_app_id");
  }
  if (
    apiKeys.length === 0 ||
    apiKeys.some((key) =>
      key.includes("ci-preflight-not-a-provider-credential"),
    )
  ) {
    invalidFields.push("api_key.current_key");
  }
  if (String(config?.configuration_version ?? "") !== "1") {
    invalidFields.push("configuration_version");
  }
  facts.googleServicesPackageNames = clients
    .map((client) =>
      optionalText(client?.client_info?.android_client_info?.package_name),
    )
    .filter(Boolean);
  if (invalidFields.length > 0) {
    blocker(
      "native.android.google_services_invalid",
      "Android Firebase configuration is not release-usable.",
      `${relative(googleServices)} has missing, mismatched, or CI-only fields: ${invalidFields.join(", ")}.`,
      "Use the real Firebase Android app configuration for the release bundle id; CI compile fixtures are not release configuration.",
      OPERATOR_CONFIG_ACTION,
    );
  }

  const gradleText = collectFiles(androidProject)
    .filter(
      (filePath) =>
        filePath.endsWith("build.gradle") ||
        filePath.endsWith("build.gradle.kts"),
    )
    .map((filePath) => readText(filePath) ?? "")
    .join("\n");
  const missingGradleMarkers = [
    "com.google.gms.google-services",
    "firebase-messaging",
    "firebase-installations",
  ].filter((marker) => !gradleText.includes(marker));
  if (missingGradleMarkers.length > 0) {
    blocker(
      "native.android.firebase_gradle_wiring_missing",
      "Generated Android Firebase wiring is incomplete.",
      `Generated Gradle files are missing: ${missingGradleMarkers.join(", ")}.`,
      "Rerun the integrated tauri:android:init script or tauri:native-push:apply before release packaging.",
      RELEASE_ENVIRONMENT_ACTION,
    );
  }
}

function checkAppleProductionEnvironment(appleProject) {
  const entitlementFiles = collectFiles(appleProject).filter((filePath) =>
    filePath.endsWith(".entitlements"),
  );
  const environments = entitlementFiles
    .map((filePath) => readApsEnvironment(readText(filePath) ?? ""))
    .filter((value) => value !== undefined);
  facts.appleApsEnvironments = [...new Set(environments)];
  if (environments.length === 0) {
    blocker(
      "native.apple.aps_entitlement_missing",
      "iOS APNs entitlement is missing.",
      "No generated .entitlements file declares aps-environment.",
      "Enable Push Notifications and apply the production native-push wiring before a release build.",
      RELEASE_ENVIRONMENT_ACTION,
    );
    return;
  }
  if (environments.some((environment) => environment !== "production")) {
    blocker(
      "native.apple.aps_environment_not_production",
      "iOS release APNs entitlement is not production.",
      `Found aps-environment values: ${[...new Set(environments)].join(", ")}.`,
      "Run tauri:native-push:apply:release and verify the signed release entitlement is production.",
      RELEASE_ENVIRONMENT_ACTION,
    );
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

function readApsEnvironment(xml) {
  return xml.match(
    /<key>\s*aps-environment\s*<\/key>\s*<string>\s*([^<]+?)\s*<\/string>/,
  )?.[1];
}

function checkLocalToolchain() {
  facts.platform = process.platform;
  if (!commandAvailable("java", ["-version"])) {
    blocker(
      "toolchain.java_missing",
      "Java is unavailable for Android builds.",
      "The java command is not available in this environment.",
      "Install a JDK supported by the Tauri Android toolchain.",
      RELEASE_ENVIRONMENT_ACTION,
    );
  }
  const requiredDirectories = [
    ["JAVA_HOME", "bin/java"],
    ["ANDROID_HOME", undefined],
    ["NDK_HOME", undefined],
  ];
  for (const [name, requiredChild] of requiredDirectories) {
    const value = process.env[name];
    if (!value) {
      blocker(
        `toolchain.${name.toLowerCase()}_missing`,
        `${name} is not set.`,
        `${name} is required for Android release builds.`,
        `Set ${name} in the native release environment.`,
        RELEASE_ENVIRONMENT_ACTION,
      );
      continue;
    }
    const requiredPath = requiredChild
      ? path.join(value, requiredChild)
      : value;
    if (!existsSync(requiredPath)) {
      blocker(
        `toolchain.${name.toLowerCase()}_invalid`,
        `${name} does not point to a usable toolchain path.`,
        `${requiredPath} does not exist.`,
        `Set ${name} to the native release toolchain path.`,
        RELEASE_ENVIRONMENT_ACTION,
      );
    }
  }
  if (process.platform !== "darwin") {
    blocker(
      "toolchain.ios_host_missing",
      "iOS release builds require macOS with Xcode.",
      `Current platform is ${process.platform}.`,
      "Run iOS init/build/signing on a macOS/Xcode release machine.",
      RELEASE_ENVIRONMENT_ACTION,
    );
  } else {
    for (const [id, command, commandArgs, label, action] of [
      [
        "xcode_missing",
        "xcodebuild",
        ["-version"],
        "Xcode command line tools are unavailable.",
        "Install and select the release Xcode toolchain.",
      ],
      [
        "simctl_missing",
        "xcrun",
        ["simctl", "help"],
        "xcrun simctl is unavailable.",
        "Install the Xcode simulator tooling used by iOS preflight.",
      ],
      [
        "cocoapods_missing",
        "pod",
        ["--version"],
        "CocoaPods is unavailable.",
        "Install CocoaPods in the hosted iOS build environment.",
      ],
    ]) {
      if (!commandAvailable(command, commandArgs)) {
        blocker(
          `toolchain.${id}`,
          label,
          `${command} ${commandArgs.join(" ")} failed.`,
          action,
          RELEASE_ENVIRONMENT_ACTION,
        );
      }
    }
  }

  const rustTargets = spawnSync("rustup", ["target", "list", "--installed"], {
    encoding: "utf8",
  });
  if (rustTargets.status !== 0) {
    blocker(
      "toolchain.rustup_targets_unavailable",
      "Installed Rust mobile targets cannot be inspected.",
      "rustup target list --installed failed in this environment.",
      "Install rustup and the Android/iOS Rust targets in the native release environment.",
      RELEASE_ENVIRONMENT_ACTION,
    );
    return;
  }
  const installedTargets = new Set(
    String(rustTargets.stdout ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean),
  );
  facts.installedRustTargets = [...installedTargets].sort();
  for (const target of [
    "aarch64-linux-android",
    "armv7-linux-androideabi",
    "i686-linux-android",
    "x86_64-linux-android",
    "aarch64-apple-ios",
    "aarch64-apple-ios-sim",
    "x86_64-apple-ios",
  ]) {
    if (!installedTargets.has(target)) {
      blocker(
        `toolchain.rust_target_${target.replaceAll("-", "_")}_missing`,
        `Rust mobile target ${target} is missing.`,
        `${target} is not installed for the selected Rust toolchain.`,
        `Run rustup target add ${target} in the native release environment.`,
        RELEASE_ENVIRONMENT_ACTION,
      );
    }
  }
}

function checkEvidenceFile() {
  facts.evidenceFile = relative(evidenceFile);
  if (!existsSync(evidenceFile)) {
    blocker(
      "evidence.file_missing",
      "Release evidence file is missing.",
      `${relative(evidenceFile)} does not exist.`,
      "Create release/mobile-release-evidence.json from the example or set MOBILE_RELEASE_EVIDENCE_FILE.",
      STORE_EVIDENCE_ACTION,
    );
    return;
  }
  const evidence = readJson(evidenceFile, STORE_EVIDENCE_ACTION);
  if (!evidence) return;
  const validation = validateMobileReleaseEvidence({
    evidence,
    product,
    productName,
    bundleId,
    releaseVersion: facts.tauriVersion,
  });
  facts.evidenceSchema = evidence.schema;
  facts.evidenceValid = validation.valid;
  for (const issue of validation.issues) {
    blocker(
      issue.id,
      "Release evidence is incomplete or invalid.",
      issue.message,
      issue.action,
      STORE_EVIDENCE_ACTION,
    );
  }
}

function printTextReport(report) {
  console.log(`Mobile release status: ${report.productName}`);
  console.log(`App: ${relative(appDir)}`);
  console.log(`Bundle: ${bundleId}`);
  if (facts.tauriVersion) console.log(`Version: ${facts.tauriVersion}`);
  console.log(`State: ${report.ready ? "READY" : "BLOCKED"}`);
  if (report.blockers.length === 0) {
    console.log("No release blockers detected by the status reporter.");
    return;
  }
  console.log(`Blockers: ${report.blockers.length}`);
  for (const item of report.blockers) {
    console.log(`- ${item.id}: ${item.label}`);
    console.log(`  detail: ${item.detail}`);
    console.log(`  next: ${item.action}`);
    console.log(`  owner: ${item.owner} (${item.actionability})`);
  }
}

function commandAvailable(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  return result.status === 0;
}

function readJson(filePath, classification) {
  if (!existsSync(filePath)) {
    blocker(
      "file.missing",
      "Required JSON file is missing.",
      `${relative(filePath)} does not exist.`,
      "Create the required file before release.",
      classification,
    );
    return undefined;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    blocker(
      "file.invalid_json",
      "Required JSON file is invalid.",
      `${relative(filePath)}: ${cause.message}`,
      "Fix the JSON syntax before release.",
      classification,
    );
    return undefined;
  }
}

function readText(filePath) {
  if (!existsSync(filePath)) return undefined;
  return readFileSync(filePath, "utf8");
}

function blocker(id, label, detail, action, classification) {
  const resolvedClassification = classification ?? classifyBlocker(id);
  blockers.push({
    id,
    label,
    detail,
    action,
    ...resolvedClassification,
  });
}

function classifyBlocker(id) {
  if (id.startsWith("tauri.") || id.startsWith("version.")) {
    return REPO_ACTION;
  }
  if (id.startsWith("toolchain.") || id.startsWith("native.")) {
    return RELEASE_ENVIRONMENT_ACTION;
  }
  if (id.startsWith("evidence.")) return STORE_EVIDENCE_ACTION;
  return REPO_ACTION;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function relative(filePath) {
  const base = appDir;
  const value = path.relative(base, filePath).split(path.sep).join("/");
  return value || ".";
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
    if (argv[index + 1]?.startsWith("--") || argv[index + 1] === undefined) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
