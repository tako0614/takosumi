#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
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
const results = [];

const tauriVersion = checkTauriConfig();
checkReleaseVersionSources(tauriVersion);
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

function checkReleaseVersionSources(tauriVersion) {
  const inspection = inspectMobileReleaseVersions(appDir, tauriVersion);
  for (const issue of inspection.issues) {
    fail(`${issue.id}: ${issue.detail}`);
  }
  if (tauriVersion && inspection.packageVersion === tauriVersion) {
    ok("package.json version matches tauri.conf version");
  }
  if (tauriVersion && inspection.cargoVersion === tauriVersion) {
    ok("Cargo.toml package version matches tauri.conf version");
  }
  if (tauriVersion && inspection.cargoLockVersion === tauriVersion) {
    ok("Cargo.lock package version matches tauri.conf version");
  }
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
  const validation = validateMobileReleaseEvidence({
    evidence: value,
    product,
    productName,
    bundleId,
    releaseVersion: tauriVersion,
  });
  for (const result of validation.results) {
    results.push({ kind: result.kind, message: result.message });
  }
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

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function ok(message) {
  results.push({ kind: "ok", message });
}

function fail(message) {
  results.push({ kind: "fail", message });
}

function expect(condition, message) {
  if (condition) ok(message);
  else fail(message);
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
