#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

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
const skipToolchainProbe = Boolean(args.skipToolchainProbe);

const blockers = [];
const facts = {
  appDir,
  product,
  productName,
  bundleId,
  evidenceFile,
};

const tauriConfig = readJson(path.join(appDir, "src-tauri/tauri.conf.json"));
checkTauriConfig(tauriConfig);
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
      "Run the product tauri:ios:init script on macOS/Xcode, then apply native push wiring.",
    );
  }
  if (!existsSync(androidProject)) {
    blocker(
      "native.android.generated_project_missing",
      "Generated Android project is missing.",
      `${relative(androidProject)} does not exist.`,
      "Run the product tauri:android:init script, then apply native push wiring.",
    );
    return;
  }
  if (!existsSync(googleServices)) {
    blocker(
      "native.android.google_services_missing",
      "Android Firebase configuration is missing.",
      `${relative(googleServices)} does not exist.`,
      "Add product-owned Firebase/FCM google-services.json outside shared mobile-kit.",
    );
  }
}

function checkLocalToolchain() {
  facts.platform = process.platform;
  if (!commandAvailable("java", ["-version"])) {
    blocker(
      "toolchain.java_missing",
      "Java is unavailable for Android builds.",
      "The java command is not available in this environment.",
      "Install a JDK supported by the Tauri Android toolchain.",
    );
  }
  for (const name of ["JAVA_HOME", "ANDROID_HOME", "NDK_HOME"]) {
    if (!process.env[name]) {
      blocker(
        `toolchain.${name.toLowerCase()}_missing`,
        `${name} is not set.`,
        `${name} is required for Android release builds.`,
        `Set ${name} in the native release environment.`,
      );
    }
  }
  if (process.platform !== "darwin") {
    blocker(
      "toolchain.ios_host_missing",
      "iOS release builds require macOS with Xcode.",
      `Current platform is ${process.platform}.`,
      "Run iOS init/build/signing on a macOS/Xcode release machine.",
    );
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
    );
    return;
  }
  const evidence = readJson(evidenceFile);
  if (!evidence) return;
  if (evidence.product !== product) {
    blocker(
      "evidence.product_mismatch",
      "Release evidence product does not match.",
      `Expected ${product}, found ${String(evidence.product ?? "")}.`,
      "Use the evidence file for this product shell.",
    );
  }
  if (evidence.bundleId !== bundleId) {
    blocker(
      "evidence.bundle_id_mismatch",
      "Release evidence bundle id does not match.",
      `Expected ${bundleId}, found ${String(evidence.bundleId ?? "")}.`,
      "Update release evidence to match the Tauri identifier.",
    );
  }
  if (facts.tauriVersion && evidence.releaseVersion !== facts.tauriVersion) {
    blocker(
      "evidence.version_mismatch",
      "Release evidence version does not match Tauri version.",
      `Evidence ${String(evidence.releaseVersion ?? "")}, Tauri ${facts.tauriVersion}.`,
      "Update evidence.releaseVersion or src-tauri/tauri.conf.json version.",
    );
  }
  const zeroDigestPaths = [];
  collectZeroDigestPaths(evidence, [], zeroDigestPaths);
  for (const digestPath of zeroDigestPaths) {
    blocker(
      "evidence.zero_digest",
      "Release evidence still uses an example zero digest.",
      `${digestPath} is sha256:0000...`,
      "Replace example digest values with real artifact, screenshot, or upload sha256 digests.",
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
  }
}

function collectZeroDigestPaths(value, pathParts, output) {
  if (typeof value === "string") {
    if (/^sha256:0{64}$/i.test(value)) output.push(pathParts.join("."));
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectZeroDigestPaths(item, [...pathParts, String(index)], output),
    );
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    collectZeroDigestPaths(nested, [...pathParts, key], output);
  }
}

function commandAvailable(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { stdio: "ignore" });
  return result.status === 0;
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    blocker(
      "file.missing",
      "Required JSON file is missing.",
      `${relative(filePath)} does not exist.`,
      "Create the required file before release.",
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
    );
    return undefined;
  }
}

function blocker(id, label, detail, action) {
  blockers.push({ id, label, detail, action });
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
