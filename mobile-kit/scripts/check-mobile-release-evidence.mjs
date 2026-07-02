#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

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
const results = [];

const tauriVersion = checkTauriConfig();
const evidence = readEvidence();
if (evidence) checkEvidence(evidence, tauriVersion);

printResults();
if (results.some((result) => result.kind === "fail")) {
  process.exit(1);
}

function checkTauriConfig() {
  const tauriConfig = readJson(path.join(appDir, "src-tauri/tauri.conf.json"));
  expect(
    tauriConfig.productName === productName,
    "tauri.conf productName matches release evidence product name",
  );
  expect(
    tauriConfig.identifier === bundleId,
    "tauri.conf identifier matches release evidence bundle id",
  );
  const version = optionalText(tauriConfig.version);
  if (!version) {
    fail("tauri.conf version is missing");
    return undefined;
  }
  if (version === "0.0.0") {
    fail("tauri.conf version must be a real release version, not 0.0.0");
    return version;
  }
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`tauri.conf version is not semver-like: ${version}`);
    return version;
  }
  ok(`tauri.conf release version: ${version}`);
  return version;
}

function readEvidence() {
  if (!existsSync(evidenceFile)) {
    fail(
      `release evidence file is missing: ${relative(evidenceFile)}. Set MOBILE_RELEASE_EVIDENCE_FILE or create release/mobile-release-evidence.json from the example.`,
    );
    return undefined;
  }
  return readJson(evidenceFile);
}

function checkEvidence(value, tauriVersion) {
  const evidence = record(value);
  if (!evidence) {
    fail("release evidence must be a JSON object");
    return;
  }

  expect(
    evidence.schema === "takos.mobile-release-evidence.v1",
    "release evidence schema is takos.mobile-release-evidence.v1",
  );
  expect(evidence.product === product, "release evidence product matches");
  expect(
    evidence.productName === productName,
    "release evidence productName matches",
  );
  expect(evidence.bundleId === bundleId, "release evidence bundleId matches");
  expectIsoTimestamp(evidence.generatedAt, "generatedAt");
  if (tauriVersion) {
    expect(
      evidence.releaseVersion === tauriVersion,
      "release evidence releaseVersion matches tauri.conf version",
    );
  }

  const artifacts = record(evidence.artifacts);
  checkPrivateRefDigest(
    record(artifacts?.iosArchive),
    "artifacts.iosArchive",
  );
  checkPrivateRefDigest(
    record(artifacts?.androidAab),
    "artifacts.androidAab",
  );

  const signing = record(evidence.signing);
  const iosSigning = record(signing?.ios);
  expectPrivateRef(iosSigning?.teamRef, "signing.ios.teamRef");
  expectPrivateRef(
    iosSigning?.provisioningProfileRef,
    "signing.ios.provisioningProfileRef",
  );
  const androidSigning = record(signing?.android);
  expectPrivateRef(androidSigning?.keystoreRef, "signing.android.keystoreRef");
  expect(
    androidSigning?.playAppSigning === true,
    "signing.android.playAppSigning is true",
  );

  const store = record(evidence.store);
  checkAppStore(record(store?.appStore));
  checkGooglePlay(record(store?.googlePlay));
  checkDeviceSmoke(evidence.deviceSmoke);
}

function checkAppStore(appStore) {
  expectPrivateRef(appStore?.appRef, "store.appStore.appRef");
  expectPrivateRef(
    appStore?.uploadedBuildRef,
    "store.appStore.uploadedBuildRef",
  );
  expect(
    appStore?.listingReviewed === true,
    "store.appStore.listingReviewed is true",
  );
  expect(
    appStore?.privacyNutritionReviewed === true,
    "store.appStore.privacyNutritionReviewed is true",
  );
  checkScreenshots(appStore?.screenshots, "store.appStore.screenshots");
}

function checkGooglePlay(googlePlay) {
  expect(
    googlePlay?.packageName === bundleId,
    "store.googlePlay.packageName matches bundle id",
  );
  expectPrivateRef(
    googlePlay?.uploadedArtifactRef,
    "store.googlePlay.uploadedArtifactRef",
  );
  expect(
    googlePlay?.listingReviewed === true,
    "store.googlePlay.listingReviewed is true",
  );
  expect(
    googlePlay?.dataSafetyReviewed === true,
    "store.googlePlay.dataSafetyReviewed is true",
  );
  checkScreenshots(googlePlay?.screenshots, "store.googlePlay.screenshots");
}

function checkScreenshots(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`${label} must include at least one screenshot evidence entry`);
    return;
  }
  ok(`${label} includes ${value.length} screenshot evidence entry`);
  for (const [index, screenshot] of value.entries()) {
    const item = record(screenshot);
    const prefix = `${label}[${index}]`;
    expectText(item?.locale, `${prefix}.locale`);
    expectText(item?.device, `${prefix}.device`);
    checkPrivateRefDigest(item, prefix);
  }
}

function checkDeviceSmoke(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail("deviceSmoke must include iOS and Android passed smoke evidence");
    return;
  }
  const platforms = new Set();
  for (const [index, entry] of value.entries()) {
    const item = record(entry);
    const prefix = `deviceSmoke[${index}]`;
    const platform = optionalText(item?.platform);
    if (platform === "ios" || platform === "android") platforms.add(platform);
    else fail(`${prefix}.platform must be ios or android`);
    expect(item?.result === "passed", `${prefix}.result is passed`);
    expectText(item?.device, `${prefix}.device`);
    expectText(item?.osVersion, `${prefix}.osVersion`);
    expectIsoTimestamp(item?.capturedAt, `${prefix}.capturedAt`);
    expectPrivateRef(item?.evidenceRef, `${prefix}.evidenceRef`);
  }
  expect(platforms.has("ios"), "deviceSmoke includes iOS passed smoke evidence");
  expect(
    platforms.has("android"),
    "deviceSmoke includes Android passed smoke evidence",
  );
}

function checkPrivateRefDigest(value, label) {
  expectPrivateRef(value?.evidenceRef, `${label}.evidenceRef`);
  expectSha256(value?.sha256, `${label}.sha256`);
}

function expectPrivateRef(value, label) {
  const text = optionalText(value);
  if (!text) {
    fail(`${label} is required`);
    return;
  }
  if (!text.startsWith("private:")) {
    fail(`${label} must be a public-safe private: evidence reference`);
    return;
  }
  ok(`${label} is a private evidence reference`);
}

function expectSha256(value, label) {
  const text = optionalText(value);
  if (!text) {
    fail(`${label} is required`);
    return;
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(text)) {
    fail(`${label} must be sha256:<64 hex chars>`);
    return;
  }
  if (/^sha256:0{64}$/i.test(text)) {
    fail(`${label} must not use the example zero digest`);
    return;
  }
  ok(`${label} is a sha256 digest`);
}

function expectIsoTimestamp(value, label) {
  const text = optionalText(value);
  if (!text) {
    fail(`${label} is required`);
    return;
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail(`${label} must be an ISO timestamp`);
    return;
  }
  ok(`${label} is an ISO timestamp`);
}

function expectText(value, label) {
  if (optionalText(value)) ok(`${label} is present`);
  else fail(`${label} is required`);
}

function expect(condition, message) {
  if (condition) ok(message);
  else fail(message);
}

function readJson(filePath) {
  if (!existsSync(filePath)) {
    fail(`${relative(filePath)} is missing`);
    return {};
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    fail(`${relative(filePath)} is not valid JSON: ${cause.message}`);
    return {};
  }
}

function record(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(message) {
  results.push({ kind: "ok", message });
}

function fail(message) {
  results.push({ kind: "fail", message });
}

function printResults() {
  console.log(`Mobile release evidence check: ${productName} (${appDir})`);
  console.log(`Evidence file: ${relative(evidenceFile)}`);
  for (const result of results) {
    console.log(`${result.kind === "ok" ? "OK" : "FAIL"} ${result.message}`);
  }
}

function relative(filePath) {
  return path.relative(appDir, filePath).split(path.sep).join("/");
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
    parsed[key] = argv[index + 1];
    index += 1;
  }
  return parsed;
}
